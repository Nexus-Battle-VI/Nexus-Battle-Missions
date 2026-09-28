import { randomUUID } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { MissionContentController } from '../../src/adapters/inbound/http/mission-content.controller'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresExecutionRepository } from '../../src/adapters/outbound/persistence/PostgresExecutionRepository'
import { PostgresMissionCatalog } from '../../src/adapters/outbound/persistence/PostgresMissionCatalog'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { simulationRequestFor } from '../../src/application/use-cases/RunMissionExecutions'
import type {
  CompletionRewards,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import {
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import { queueExecution, requestSimulation } from '../../src/domain/entities/MissionExecution'
import {
  completionRewardsOf,
  frozenContentOf,
} from '../../src/domain/policies/CompletionRewardPolicy'
import { playerRewardsOf } from '../../src/domain/policies/DeliverableRewardsPolicy'
import { missionDefinitionOf } from '../../src/domain/policies/MissionContentPolicy'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * HU-10, Task HU-10.4, contra PostgreSQL REAL: `rewards.completion` se guarda y se
 * lee de `jsonb` SIN migracion (el contenido es un documento y el bloque es
 * aditivo), el contenido historico sigue cargando, el administrador no lo pierde
 * al guardar, y la ejecucion conserva SU copia congelada aunque el catalogo cambie.
 *
 * Los montos son valores de PRUEBA: ninguna mision real lleva `completion`.
 */
const [TEMPLO] = EXAMPLE_MISSIONS as [MissionDefinition]
const AT = new Date('2026-10-01T15:00:00.000Z')
const PRODUCT = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

const configA: CompletionRewards = {
  schemaVersion: 1,
  experience: { amountByDifficulty: { NORMAL: 11, HEROIC: 22 } },
  entries: [
    {
      key: 'credits-base',
      group: 'GUARANTEED',
      grantOn: ['COMPLETED', 'FAILED'],
      reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5 } },
    },
    {
      key: 'sello-x',
      group: 'GUARANTEED',
      grantOn: ['COMPLETED'],
      reward: { kind: 'PRODUCT', productId: PRODUCT, quantityByDifficulty: { NORMAL: 2 } },
    },
    {
      key: 'vida-alta',
      group: 'OBJECTIVE_BONUS',
      grantOn: ['COMPLETED'],
      objectiveId: 'obj_vida',
      reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 3 } },
    },
    {
      key: 'primera-vez',
      group: 'FIRST_TIME',
      grantOn: ['COMPLETED'],
      reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 1 } },
    },
  ],
}

const configB: CompletionRewards = {
  schemaVersion: 1,
  experience: { amountByDifficulty: { NORMAL: 9999 } },
}

const withCompletion = (
  definition: MissionDefinition,
  completion: CompletionRewards | undefined,
): MissionDefinition => ({
  ...definition,
  rewards: completion === undefined ? definition.rewards : { ...definition.rewards, completion },
})

describe('HU-10.4 — recompensas de finalizacion en PostgreSQL', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let catalog: PostgresMissionCatalog

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    catalog = new PostgresMissionCatalog(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('el contenido historico (sin completion) sigue cargando y no genera derechos', async () => {
    const seeded = await catalog.listAll()

    expect(seeded.length).toBeGreaterThan(0)

    for (const mission of seeded) {
      expect(mission.rewards.completion).toBeUndefined()
      // Y sigue siendo un contenido valido para el editor.
      expect(() =>
        missionDefinitionOf(JSON.parse(JSON.stringify(mission)), mission.missionId),
      ).not.toThrow()
      expect(
        completionRewardsOf({
          content: mission,
          difficulty: 'NORMAL',
          outcome: 'COMPLETED',
          objectives: [],
        }).entitlements,
      ).toEqual([])
    }
  })

  it('una definicion CON completion se guarda y se lee identica, sin migracion', async () => {
    await catalog.save(
      missionDefinitionOf(withCompletion(structuredClone(TEMPLO), configA), TEMPLO.missionId),
    )

    const read = await catalog.findById(TEMPLO.missionId)

    expect(read?.rewards.completion).toEqual(configA)
    // Lo demas del bloque `rewards` (etiquetas y botin) no se toco.
    expect(read?.rewards.guaranteed).toEqual(TEMPLO.rewards.guaranteed)
    expect(read?.rewards.potential).toEqual(TEMPLO.rewards.potential)
  })

  it('lo que ve el jugador NO incluye los montos de completion', async () => {
    const read = await catalog.findById(TEMPLO.missionId)

    expect(JSON.stringify(playerRewardsOf(read!))).not.toContain('amountByDifficulty')
    expect(JSON.stringify(playerRewardsOf(read!))).not.toContain('completion')
  })

  it('ROUND-TRIP del administrador: listar -> guardar lo mismo NO pierde el bloque', async () => {
    const controller = new MissionContentController(catalog)

    const listed = await controller.list()
    const templo = listed.find((mission) => mission.missionId === TEMPLO.missionId)!
    // Como viaja por HTTP: a JSON y de vuelta.
    const body: unknown = JSON.parse(JSON.stringify(templo))

    const saved = await controller.save(TEMPLO.missionId, body)

    expect(saved.rewards.completion).toEqual(configA)
    expect((await catalog.findById(TEMPLO.missionId))?.rewards.completion).toEqual(configA)
  })

  it('un editor que solo conoce los campos viejos y reenvia el bloque tal cual no lo destruye', async () => {
    const controller = new MissionContentController(catalog)
    const templo = (await catalog.findById(TEMPLO.missionId))!
    const body = JSON.parse(JSON.stringify({ ...templo, name: `${templo.name} (editada)` }))

    const saved = await controller.save(TEMPLO.missionId, body)

    expect(saved.name).toContain('(editada)')
    expect(saved.rewards.completion).toEqual(configA)

    await catalog.save(templo)
  })

  it('un bloque invalido se rechaza y NO reemplaza al guardado', async () => {
    const controller = new MissionContentController(catalog)
    const templo = (await catalog.findById(TEMPLO.missionId))!
    const invalid = JSON.parse(
      JSON.stringify({
        ...templo,
        rewards: { ...templo.rewards, completion: { schemaVersion: 2 } },
      }),
    )

    await expect(controller.save(TEMPLO.missionId, invalid)).rejects.toThrow()

    expect((await catalog.findById(TEMPLO.missionId))?.rewards.completion).toEqual(configA)
  })

  it('la ejecucion conserva SU snapshot tras "reiniciar", aunque el catalogo cambie a B', async () => {
    await insertDefinition(db, { ...TEMPLO, missionId: 'msn_snapshot_hu10' })
    const definition = withCompletion({ ...TEMPLO, missionId: 'msn_snapshot_hu10' }, configA)
    await catalog.save(definition)

    const enrollments = new PostgresEnrollmentRepository(db)
    const executions = new PostgresExecutionRepository(db)
    const pending = newPendingEnrollment({
      enrollmentId: `enr_hu10_${randomUUID()}`,
      playerId: `pg-${randomUUID()}`,
      missionId: definition.missionId,
      heroId: randomUUID(),
      difficulty: 'NORMAL',
      operationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    })
    const confirmed = confirmEnrollment(pending, 'cmt-1', AT, 720)
    await enrollments.insertPending(pending)
    await enrollments.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed))

    const start = (await executions.pendingStarts(1_000)).find(
      (candidate) => candidate.enrollmentId === confirmed.enrollmentId,
    )!
    const queued = queueExecution({
      enrollmentId: confirmed.enrollmentId,
      operationId: `sim-${randomUUID()}`,
      endsAt: confirmed.endsAt!,
      now: AT,
    })
    await executions.queue(queued, start.factId)
    const requested = requestSimulation(
      queued,
      simulationRequestFor(queued, confirmed, definition, {
        subtype: 'GUERRERO_ARMAS',
        level: 12,
      }),
      AT,
    )
    await executions.saveTransition(requested, queued.version)

    // El administrador guarda la B en el catalogo vivo.
    await catalog.save(withCompletion(definition, configB))
    expect((await catalog.findById(definition.missionId))?.rewards.completion).toEqual(configB)

    // "Reinicio": repositorio y conexion nuevos sobre la misma base.
    const otherDb = createDatabase({ connectionString: container.getConnectionUri() })

    try {
      const restarted = new PostgresExecutionRepository(otherDb)
      const frozen = frozenContentOf((await restarted.findById(confirmed.enrollmentId))?.request)

      expect(frozen?.rewards.completion).toEqual(configA)

      const rights = completionRewardsOf({
        content: frozen,
        difficulty: 'NORMAL',
        outcome: 'COMPLETED',
        objectives: [{ id: 'obj_vida', met: true }],
      })

      expect(rights.entitlements.map((right) => right.rewardKey)).toEqual([
        'completion:xp',
        'guaranteed:credits-base',
        'guaranteed:sello-x',
        'objective-bonus:vida-alta',
      ])
      // Con B (el catalogo vivo) saldria otro monto: la ejecucion NO lo usa.
      expect(rights.entitlements[0]).toMatchObject({ amount: 11 })
      expect(rights.skipped).toEqual([{ key: 'primera-vez', reason: 'FIRST_TIME_UNDEFINED' }])
    } finally {
      await otherDb.destroy()
    }
  })
})
