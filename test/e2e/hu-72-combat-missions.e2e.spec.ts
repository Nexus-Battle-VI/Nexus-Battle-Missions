import 'reflect-metadata'

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { StartedMongoDBContainer } from '@testcontainers/mongodb'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

import {
  connectChainDatabases,
  enroll,
  insertDefinition,
  shiftEnrollmentWindow,
  TEMPLO,
  type ChainDatabases,
} from './support/fixtures'
import {
  INTERNAL_SECRET,
  siblingDir,
  startMongo,
  startSibling,
  type Sibling,
} from './support/harness'
import {
  bootMissions,
  restoreChainEnv,
  useChainEnv,
  type MissionsApp,
} from './support/missions-app'

const LOCAL_COMBAT_DIR = path.resolve(process.cwd(), '..', '..', 'Combat', 'Nexus-Battle-Combat')
const COMBAT_DIR = siblingDir(
  'HU72_E2E_COMBAT_DIR',
  'Nexus-Battle-Combat',
  existsSync(path.join(LOCAL_COMBAT_DIR, 'package.json')) ? LOCAL_COMBAT_DIR : undefined,
)
const SUBJECT = 'sub-cadena-hu-72'

interface ExecutionRow {
  readonly operation_id: string
  readonly status: string
  readonly simulation_id: string | null
  readonly combat_outcome: string | null
  readonly combat_log: readonly Record<string, unknown>[] | null
  readonly outcome: string | null
  readonly hero_released_at: Date | null
}

/**
 * Frontera real de HU-72: Missions/PostgreSQL -> HTTP firmado -> Combat/MongoDB.
 * Solo se sustituyen identidad, compromiso y perfil del heroe; el perfil contiene
 * el snapshot completo que exige Combat. No se sustituye el resultado, la IA, las
 * reglas, la aleatoriedad ni la persistencia de ninguno de los dos servicios.
 */
describe('HU-72 · ejecucion real de Missions en Combat', () => {
  let postgres: StartedPostgreSqlContainer
  let mongo: StartedMongoDBContainer
  let combat: Sibling
  let databases: ChainDatabases
  let db: Kysely<Database>
  let missions: MissionsApp
  const cleanups: (() => Promise<void>)[] = []

  beforeAll(async () => {
    mongo = await startMongo()
    cleanups.push(async () => {
      await mongo.stop()
    })

    postgres = await new PostgreSqlContainer('postgres:17-alpine').start()
    cleanups.push(async () => {
      await postgres.stop()
    })

    db = createDatabase({ connectionString: postgres.getConnectionUri() })
    cleanups.push(() => db.destroy())
    const migrated = await migrateToLatest(db)

    if (migrated.error !== undefined) {
      throw migrated.error instanceof Error ? migrated.error : new Error('La migracion fallo.')
    }

    await insertDefinition(db, TEMPLO)
    databases = await connectChainDatabases(mongo.getConnectionString())
    cleanups.push(() => databases.close())

    combat = await startSibling({
      name: 'combat',
      dir: COMBAT_DIR,
      mongoUri: mongo.getConnectionString(),
      extraEnv: { COMBAT_RANDOM_SEED: '720057' },
    })
    cleanups.push(() => combat.stop())
    await combat.start()

    useChainEnv({
      databaseUrl: postgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: 'http://127.0.0.1:1',
      secret: INTERNAL_SECRET,
    })
    process.env.COMBAT_SIMULATION_DRIVER = 'http'

    missions = await bootMissions({
      databaseUrl: postgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: 'http://127.0.0.1:1',
      secret: INTERNAL_SECRET,
      subject: SUBJECT,
    })
    cleanups.push(() => missions.close())
  }, 900_000)

  afterAll(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error: unknown) {
        process.stderr.write(`Fallo al limpiar HU-72 E2E: ${String(error)}\n`)
      }
    }

    restoreChainEnv()
  }, 300_000)

  it('persiste el mismo resultado y telemetria de decisiones sin duplicar al reintentar', async () => {
    const enrollment = await enroll(missions, { key: randomUUID() })

    await shiftEnrollmentWindow(db, enrollment.enrollmentId)
    const firstCycle = await missions.run()
    const execution = (
      await sql<ExecutionRow>`select operation_id, status, simulation_id, combat_outcome,
        combat_log, outcome, hero_released_at
        from mission_executions
        where enrollment_id = ${enrollment.enrollmentId}`.execute(db)
    ).rows[0]

    expect(execution).toBeDefined()
    expect(firstCycle).toMatchObject({ queued: 1, simulated: 1, settled: 1, released: 1 })
    expect(execution).toMatchObject({ status: 'SETTLED' })
    expect(execution?.simulation_id).toBeTruthy()
    expect(execution?.combat_outcome).toMatch(
      /^(HERO_VICTORIOUS|HERO_DEFEATED|TIME_BUDGET_EXHAUSTED)$/u,
    )
    expect(execution?.outcome).toMatch(/^(COMPLETED|FAILED)$/u)
    expect(execution?.combat_log?.length).toBeGreaterThan(0)
    expect(execution?.hero_released_at).toBeInstanceOf(Date)

    const operationId = execution?.operation_id ?? ''
    const stored = await databases.combat
      .collection<{
        readonly _id: string
        readonly result: {
          readonly simulationId: string
          readonly operationId: string
          readonly combatOutcome: string
        }
      }>('mission-simulation-results')
      .findOne({ _id: operationId })
    const decisions = await databases.combat
      .collection<{
        readonly eventType: string
        readonly origin: string
        readonly battleId: string
      }>('combat-decision-events')
      .find({ battleId: operationId, origin: 'MISSION' })
      .toArray()

    expect(stored?.result).toMatchObject({
      simulationId: execution?.simulation_id,
      operationId,
      combatOutcome: execution?.combat_outcome,
    })
    expect(decisions.some((event) => event.eventType === 'COMBAT_DECISION')).toBe(true)
    expect(decisions.filter((event) => event.eventType === 'COMBAT_DECISION_OUTCOME')).toHaveLength(
      1,
    )

    const secondCycle = await missions.run()
    const resultCount = await databases.combat
      .collection<{ readonly _id: string }>('mission-simulation-results')
      .countDocuments({ _id: operationId })
    const decisionCount = await databases.combat
      .collection('combat-decision-events')
      .countDocuments({ battleId: operationId, origin: 'MISSION' })

    expect(secondCycle).toEqual({
      queued: 0,
      simulated: 0,
      retried: 0,
      settled: 0,
      voided: 0,
      released: 0,
      failed: 0,
    })
    expect(resultCount).toBe(1)
    expect(decisionCount).toBe(decisions.length)
  })
})
