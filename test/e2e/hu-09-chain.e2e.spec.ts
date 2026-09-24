import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { TestingModuleBuilder } from '@nestjs/testing'
import type { StartedMongoDBContainer } from '@testcontainers/mongodb'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { EXPERIENCE_CREDITS } from '../../src/application/ports/ExperienceCreditPort'
import {
  COMBAT_SIMULATION,
  type CombatSimulationPort,
  type SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import {
  EXPERIENCE_ROLLS,
  type ExperienceRollOutcome,
  type ExperienceRollPort,
  type ExperienceRollRequest,
  type ExperienceRollResult,
} from '../../src/application/ports/ExperienceRollPort'
import { EXPERIENCE_REWARD_REPOSITORY } from '../../src/application/ports/ExperienceRewardRepositoryPort'
import { REPORT_REPOSITORY } from '../../src/application/ports/ReportRepositoryPort'
import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { SimulationRequest } from '../../src/domain/entities/MissionExecution'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

import {
  clearPlayerInventory,
  closeAndSweep,
  connectChainDatabases,
  countGrants,
  creditOperationId,
  DEFEATS_IN_TEMPLO,
  enroll,
  expectedLevel,
  HERO_ID,
  insertDefinition,
  makeRewardsDue,
  readGrants,
  readProgression,
  readRollBatch,
  ROLL_AMOUNTS,
  rollsOperationId,
  seedClear,
  seedProgression,
  shiftEnrollmentWindow,
  signedPost,
  sumOf,
  TEMPLO,
  type ChainDatabases,
  type Enrollment,
} from './support/fixtures'
import {
  commitOf,
  INTERNAL_SECRET,
  isDirty,
  nestedIn,
  runNpmScript,
  siblingDir,
  startMongo,
  startSibling,
  type Sibling,
} from './support/harness'
import {
  bootMissions,
  restoreChainEnv,
  truncateMissionTables,
  useChainEnv,
  type MissionsApp,
} from './support/missions-app'
import { recordCase, writeRunReport, type ReportRepository } from './support/run-report'

/**
 * CADENA DE EXTREMO A EXTREMO DE HU-09 (Task HU-09.6).
 *
 * Recorre lo que ninguna Task probo por separado: que la tirada que produjo
 * COMBAT es la que uso MISSIONS, que el importe que calculo MISSIONS es el que
 * acredito PLAYER/INVENTORY, y que un reintento en cualquier punto no duplica
 * nada.
 *
 * LAS TRES PIEZAS SON REALES: la app de Missions en este proceso con PostgreSQL
 * real, y Combat y Player/Inventory como PROCESOS reales (`node dist/main.js`)
 * sobre un MongoDB real en replica. Se sustituye solo lo que todavia no existe
 * -- el resultado de la simulacion de Combat -- y todo lo sustituido esta en la
 * tabla de limites del reporte de ejecucion.
 *
 * NO SUSTITUYE LA ACEPTACION DE LA HU: esto es verificacion tecnica, y el
 * documento de evidencia no declara la HU aceptada.
 */
const COMBAT_DIR = siblingDir('HU09_E2E_COMBAT_DIR', 'Nexus-Battle-Combat')
const INVENTORY_DIR = siblingDir('HU09_E2E_PLAYER_INVENTORY_DIR', 'Nexus-Battle-Player-Inventory')

const SUBJECT = 'sub-cadena-hu-09'

/** Los identificadores de los casos, para que el reporte note lo que falte. */
const CASES = [
  'S-00',
  'S-01',
  'S-02',
  'S-03',
  'S-04',
  'S-05',
  'S-06',
  'S-07',
  'S-08',
  'S-09',
  'S-10',
  'S-11',
] as const

interface RewardRow {
  readonly encounter_id: string
  readonly enemy_instance_id: string
  readonly status: string
  readonly roll: number | null
  readonly amount: number | null
  readonly attempts: number
  readonly last_error: string | null
  readonly reward_line_no: number | null
}

interface LineRow {
  readonly line_no: number
  readonly reference: string | null
  readonly status: string
  readonly quantity: number
  readonly source: string
  readonly hero_level: number | null
  readonly hero_current_xp: number | null
  readonly levels_gained: number | null
}

interface ReportBody {
  readonly rewards: readonly { readonly kind: string; readonly status: string }[]
  readonly experience: {
    readonly defeats: number
    readonly totalXp: number
    readonly credited: number
    readonly pending: number
    readonly failed: number
    readonly level: number | null
    readonly currentXp: number | null
    readonly maxLevel: number | null
    readonly levelsGained: number
    readonly leveledUp: boolean
  }
}

/** Tiradas guionizadas: caras deterministas para cubrir los ocho valores. */
class ScriptedRolls implements ExperienceRollPort {
  private readonly byOperationId = new Map<string, readonly ExperienceRollResult[]>()

  constructor(private readonly faceOf: (index: number) => number) {}

  rollDefeats(request: ExperienceRollRequest): Promise<ExperienceRollOutcome> {
    const stored = this.byOperationId.get(request.operationId)

    if (stored !== undefined) {
      return Promise.resolve({ kind: 'ROLLED', rolls: stored })
    }

    const rolls = request.defeats.map((defeat, index) => ({
      encounterId: defeat.encounterId,
      enemyInstanceId: defeat.enemyInstanceId,
      roll: this.faceOf(index),
    }))

    this.byOperationId.set(request.operationId, rolls)

    return Promise.resolve({ kind: 'ROLLED', rolls })
  }
}

/** Una simulacion que el heroe pierde y en la que no muere ningun NPC (CA-08). */
class LosingSimulation implements CombatSimulationPort {
  private readonly inner = new ScriptedCombatSimulation()

  async simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    const outcome = await this.inner.simulate(request)

    if (outcome.kind !== 'SIMULATED') {
      return outcome
    }

    return {
      kind: 'SIMULATED',
      result: { ...outcome.result, combatOutcome: 'HERO_DEFEATED', combatLog: [] },
    }
  }
}

/** Una simulacion que Combat rechaza: la mision se anula y no devenga nada. */
const rejectedSimulation: CombatSimulationPort = {
  simulate: () => Promise.resolve({ kind: 'REJECTED', code: 'INVALID_STRATEGY' }),
}

const cyclesOf = (faces: readonly number[]): Readonly<Record<number, number>> =>
  Object.fromEntries(faces.map((face) => [face, ROLL_AMOUNTS[face] ?? 0]))

/** La mision de una sola derrota, con su requisito previo. */
const CAMARA = EXAMPLE_MISSIONS[1]!

describe('Cadena de experiencia de HU-09 (Task HU-09.6)', () => {
  const startedAt = new Date()

  let postgres: StartedPostgreSqlContainer
  let mongo: StartedMongoDBContainer
  let databases: ChainDatabases
  let combat: Sibling
  let inventory: Sibling
  let db: Kysely<Database>

  /**
   * Todo lo que hay que devolver como estaba, en orden inverso.
   *
   * Si el arranque falla a mitad, `afterAll` sigue ejecutandose: sin esta lista,
   * un fallo al levantar un servicio hermano se convertiria en un segundo error
   * confuso al intentar parar lo que nunca arranco.
   */
  const cleanups: (() => Promise<void>)[] = []
  const reported: ReportRepository[] = []

  const rewardsOf = async (enrollmentId: string): Promise<readonly RewardRow[]> =>
    (
      await sql<RewardRow>`select * from mission_experience_rewards
        where enrollment_id = ${enrollmentId}
        order by encounter_id, enemy_instance_id`.execute(db)
    ).rows

  const linesOf = async (enrollmentId: string): Promise<readonly LineRow[]> =>
    (
      await sql<LineRow>`select * from mission_report_rewards
        where enrollment_id = ${enrollmentId}
        order by line_no`.execute(db)
    ).rows

  const reportOf = async (missions: MissionsApp, enrollmentId: string): Promise<ReportBody> => {
    const response = await missions.get(`/api/v1/missions/me/reports/${enrollmentId}`)

    expect(response.status).toBe(200)

    return response.body as ReportBody
  }

  /** Matricula, cierra y barre: la cadena entera en una llamada. */
  const runChain = async (
    missions: MissionsApp,
    options: { readonly missionId?: string } = {},
  ): Promise<Enrollment> => {
    const enrollment = await enroll(missions, { ...options, key: randomUUID() })

    await shiftEnrollmentWindow(db, enrollment.enrollmentId)
    await closeAndSweep(missions)

    return enrollment
  }

  /** Un escenario: base limpia, app real y sustituciones declaradas. */
  const scenario = async (
    overrides: ((builder: TestingModuleBuilder) => TestingModuleBuilder) | undefined,
    work: (missions: MissionsApp) => Promise<void>,
  ): Promise<void> => {
    await truncateMissionTables(db)
    await clearPlayerInventory(databases)

    const missions = await bootMissions({
      databaseUrl: postgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: inventory.baseUrl,
      secret: INTERNAL_SECRET,
      subject: SUBJECT,
      ...(overrides === undefined ? {} : { overrides }),
    })

    try {
      await work(missions)
    } finally {
      await missions.close()
    }
  }

  /** El nombre del adaptador que el contenedor resolvio para un token. */
  const providerName = (missions: MissionsApp, token: symbol): string =>
    missions.app.get<{ constructor: { name: string } }>(token).constructor.name

  beforeAll(async () => {
    reported.push(
      {
        repository: 'Nexus-Battle-Missions',
        commit: commitOf(process.cwd()),
        // En CI los dos hermanos se clonan DENTRO de este repositorio, asi que sus
        // directorios sin seguir no son un cambio del codigo que se prueba.
        dirty: isDirty(
          process.cwd(),
          [nestedIn(process.cwd(), COMBAT_DIR), nestedIn(process.cwd(), INVENTORY_DIR)].filter(
            (entry): entry is string => entry !== null,
          ),
        ),
      },
      {
        repository: 'Nexus-Battle-Combat',
        commit: commitOf(COMBAT_DIR),
        dirty: isDirty(COMBAT_DIR),
      },
      {
        repository: 'Nexus-Battle-Player-Inventory',
        commit: commitOf(INVENTORY_DIR),
        dirty: isDirty(INVENTORY_DIR),
      },
    )

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
    await insertDefinition(db, CAMARA)
    databases = await connectChainDatabases(mongo.getConnectionString())
    cleanups.push(() => databases.close())

    combat = await startSibling({
      name: 'combat',
      dir: COMBAT_DIR,
      mongoUri: mongo.getConnectionString(),
      // La semilla de HU-24 hace reproducible la secuencia del proceso; el
      // escenario NO la usa para afirmar caras concretas, solo para que el
      // reporte de ejecucion sea repetible.
      extraEnv: { COMBAT_RANDOM_SEED: '3000000' },
    })
    cleanups.push(() => combat.stop())
    inventory = await startSibling({
      name: 'player-inventory',
      dir: INVENTORY_DIR,
      mongoUri: mongo.getConnectionString(),
    })
    cleanups.push(() => inventory.stop())

    await combat.start()
    await inventory.start()

    useChainEnv({
      databaseUrl: postgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: inventory.baseUrl,
      secret: INTERNAL_SECRET,
    })
  }, 900_000)

  afterAll(async () => {
    for (const work of [...cleanups].reverse()) {
      try {
        await work()
      } catch (error: unknown) {
        process.stderr.write(`Fallo al limpiar el escenario: ${String(error)}\n`)
      }
    }

    restoreChainEnv()

    const report = writeRunReport({
      startedAt,
      expectedCaseIds: [...CASES],
      repositories: reported,
      environment: {
        node: process.version,
        platform: process.platform,
        postgres: 'postgres:17-alpine (Testcontainers)',
        mongo: 'mongo:8.0 (Testcontainers, replica)',
        combatSeed: '3000000',
        internalSecret: 'secreto del escenario, no un secreto real',
        // Con que ref de cada repositorio hermano se ejecuto la cadena. En CI los
        // pone el workflow; en local son el arbol de trabajo de quien ejecuta, y el
        // commit exacto ya viaja en `repositories`.
        siblingRefs: {
          combat: process.env.HU09_E2E_COMBAT_REF ?? 'arbol local',
          playerInventory: process.env.HU09_E2E_INVENTORY_REF ?? 'arbol local',
        },
      },
    })

    // El reporte queda en el registro del trabajo ademas de en el fichero: es lo
    // que se copia a la evidencia de Infrastructure.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }, 300_000)

  it('S-00 · las tres piezas son reales y estan arriba', async () => {
    expect(combat.isUp()).toBe(true)
    expect(inventory.isUp()).toBe(true)

    // Un control de que no se esta probando contra dobles: los adaptadores que la
    // cadena ejerce son los de produccion.
    await scenario(undefined, (missions) => {
      expect(providerName(missions, EXPERIENCE_CREDITS)).toBe('PlayerInventoryExperienceClient')
      expect(providerName(missions, EXPERIENCE_ROLLS)).toBe('CombatExperienceRollClient')
      expect(providerName(missions, EXPERIENCE_REWARD_REPOSITORY)).toBe(
        'PostgresExperienceRewardRepository',
      )
      expect(providerName(missions, REPORT_REPOSITORY)).toBe('PostgresReportRepository')

      return Promise.resolve()
    })

    expect(combat.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(inventory.commit).toMatch(/^[0-9a-f]{40}$/u)

    recordCase({
      id: 'S-00',
      name: 'Las tres piezas reales y arriba',
      result: 'PASS',
      observed: {
        combat: { commit: combat.commit, dirty: combat.dirty },
        playerInventory: { commit: inventory.commit, dirty: inventory.dirty },
        missionsDrivers: 'postgres + http + http',
      },
    })
  })

  it('S-01 · la cadena completa: 19 derrotas, 19 tiradas reales y 19 acreditaciones', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const rewards = await rewardsOf(enrollment.enrollmentId)
      const batch = await readRollBatch(databases, enrollment.enrollmentId)
      const grants = await readGrants(databases, enrollment.enrollmentId)
      const lines = await linesOf(enrollment.enrollmentId)
      const report = await reportOf(missions, enrollment.enrollmentId)
      const progression = await readProgression(databases, SUBJECT, HERO_ID)

      // Una recompensa por NPC derrotado, y todas acreditadas.
      expect(rewards).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(rewards.every((reward) => reward.status === 'CREDITED')).toBe(true)

      // UNA tirada por derrota, en UN lote, dentro del dado.
      expect(batch).not.toBeNull()
      expect(batch?.defeats).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(batch?.defeats.every((defeat) => defeat.roll >= 1 && defeat.roll <= 8)).toBe(true)
      expect(batch?._id).toBe(rollsOperationId(enrollment.enrollmentId))

      // El importe de cada recompensa es el del contrato para LA CARA QUE COMBAT
      // DEVOLVIO: la formula no se reimplementa aqui, se contrasta.
      const byDefeat = new Map(
        (batch?.defeats ?? []).map((defeat) => [
          `${defeat.encounterId}#${defeat.enemyInstanceId}`,
          defeat.roll,
        ]),
      )

      for (const reward of rewards) {
        const roll = byDefeat.get(`${reward.encounter_id}#${reward.enemy_instance_id}`)

        expect(roll).toBeDefined()
        expect(reward.roll).toBe(roll)
        expect(reward.amount).toBe(ROLL_AMOUNTS[roll ?? 0])
      }

      // Una acreditacion por derrota, con SU clave, y todas en Player/Inventory.
      expect(grants).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(new Set(grants.map((grant) => grant._id)).size).toBe(DEFEATS_IN_TEMPLO)
      expect(grants.map((grant) => grant._id).sort()).toEqual(
        rewards
          .map((reward) =>
            creditOperationId({
              enrollmentId: enrollment.enrollmentId,
              encounterId: reward.encounter_id,
              enemyInstanceId: reward.enemy_instance_id,
              heroId: HERO_ID,
            }),
          )
          .sort(),
      )

      const totalXp = sumOf(rewards.map((reward) => reward.amount ?? 0))

      expect(progression?.currentXp).toBe(totalXp)
      expect(progression?.level).toBe(expectedLevel(totalXp))

      // Las lineas del informe son el reflejo de las recompensas.
      expect(lines).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(lines.every((line) => line.status === 'CREDITED' && line.source === 'HU-09')).toBe(
        true,
      )
      expect(sumOf(lines.map((line) => line.quantity))).toBe(totalXp)

      // Y el jugador lo ve.
      expect(report.experience).toMatchObject({
        defeats: DEFEATS_IN_TEMPLO,
        credited: DEFEATS_IN_TEMPLO,
        pending: 0,
        failed: 0,
        totalXp,
        level: expectedLevel(totalXp),
        currentXp: totalXp,
      })
      expect(report.experience.leveledUp).toBe(expectedLevel(totalXp) > 1)

      observed = {
        defeats: rewards.length,
        faces: (batch?.defeats ?? []).map((defeat) => defeat.roll),
        amounts: rewards.map((reward) => reward.amount),
        totalXp,
        level: progression?.level ?? null,
        grants: grants.length,
      }
    })

    recordCase({ id: 'S-01', name: 'Cadena completa con Combat real', result: 'PASS', observed })
  })

  it('S-02 · los ocho valores de 1d8 producen el importe del contrato y se acreditan', async () => {
    let observed: Record<string, unknown> = {}

    // Se sustituye SOLO el puerto de tirada (caras 1..8 en ciclo): la acreditacion
    // sigue siendo la de Player/Inventory de verdad.
    await scenario(
      (builder) =>
        builder
          .overrideProvider(EXPERIENCE_ROLLS)
          .useValue(new ScriptedRolls((index) => (index % 8) + 1)),
      async (missions) => {
        const enrollment = await runChain(missions)
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const grants = await readGrants(databases, enrollment.enrollmentId)
        const report = await reportOf(missions, enrollment.enrollmentId)
        const covered = new Map<number, number>()

        for (const reward of rewards) {
          const roll = reward.roll ?? 0

          expect(reward.status).toBe('CREDITED')
          expect(reward.amount).toBe(ROLL_AMOUNTS[roll])
          covered.set(roll, reward.amount ?? 0)
        }

        // Las OCHO caras aparecen, cada una con el importe del contrato.
        expect([...covered.keys()].sort((left, right) => left - right)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8,
        ])
        expect(cyclesOf([1, 2, 3, 4, 5, 6, 7, 8])).toEqual(Object.fromEntries(covered))

        // Y quedaron acreditadas: el ledger lleva exactamente esos importes.
        expect(grants).toHaveLength(DEFEATS_IN_TEMPLO)
        expect(new Set(grants.map((grant) => grant.amount))).toEqual(new Set([...covered.values()]))
        expect(report.experience.totalXp).toBe(sumOf(rewards.map((reward) => reward.amount ?? 0)))

        observed = {
          defeats: rewards.length,
          amountsByFace: Object.fromEntries([...covered.entries()].sort()),
          totalXp: report.experience.totalXp,
        }
      },
    )

    recordCase({
      id: 'S-02',
      name: 'Los ocho valores de 1d8 con acreditacion real',
      result: 'PASS',
      observed,
    })
  })

  it('S-03 · sube uno, sube varios y el nivel maximo no descarta experiencia', async () => {
    const observed: Record<string, unknown> = {}

    // (a) Desde 195, y con todas las caras en 1 (12 XP): la PRIMERA acreditacion
    // cruza el umbral de 200 y sube EXACTAMENTE un nivel. La camara sellada exige
    // el templo como requisito, y el requisito es un dato de partida.
    //
    // NO se afirma cuantas derrotas tiene la camara. La version anterior daba por
    // hecho que era UNA, y el contenido v2 la dejo en siete: el caso fallaba por
    // el contenido, no por la cadena. Lo que se comprueba es la ARITMETICA --que
    // la primera acreditacion es la que cruza, y que el nivel final es el que la
    // tabla de HU-08 asigna al acumulado--, y eso vale con cualquier contenido.
    await scenario(
      (builder) => builder.overrideProvider(EXPERIENCE_ROLLS).useValue(new ScriptedRolls(() => 1)),
      async (missions) => {
        await seedProgression(databases, SUBJECT, HERO_ID, 195)
        await seedClear(db, SUBJECT, TEMPLO.missionId)

        const enrollment = await runChain(missions, { missionId: CAMARA.missionId })
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const grants = await readGrants(databases, enrollment.enrollmentId)
        const progression = await readProgression(databases, SUBJECT, HERO_ID)
        const report = await reportOf(missions, enrollment.enrollmentId)
        const totalXp = 195 + sumOf(rewards.map((reward) => reward.amount ?? 0))

        expect(grants).toHaveLength(rewards.length)
        expect(grants.every((grant) => grant.amount === ROLL_AMOUNTS[1])).toBe(true)

        // La primera es la que cruza: 195 + 12 = 207, que es el nivel 2.
        expect(grants[0]?.result).toMatchObject({ currentXp: 207, level: 2, levelsGained: 1 })
        expect(progression).toMatchObject({ currentXp: totalXp, level: expectedLevel(totalXp) })
        expect(report.experience).toMatchObject({
          defeats: rewards.length,
          totalXp: totalXp - 195,
          level: expectedLevel(totalXp),
          currentXp: totalXp,
          levelsGained: expectedLevel(totalXp) - 1,
          leveledUp: expectedLevel(totalXp) > 1,
        })

        observed.single = {
          before: 195,
          after: progression?.currentXp,
          level: progression?.level,
          defeats: rewards.length,
        }
      },
    )

    // (b) La mision completa (19 derrotas) desde 190: cruza varios niveles.
    await scenario(
      (builder) =>
        builder
          .overrideProvider(EXPERIENCE_ROLLS)
          .useValue(new ScriptedRolls((index) => (index % 8) + 1)),
      async (missions) => {
        await seedProgression(databases, SUBJECT, HERO_ID, 190)

        const enrollment = await runChain(missions)
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const progression = await readProgression(databases, SUBJECT, HERO_ID)
        const report = await reportOf(missions, enrollment.enrollmentId)
        const totalXp = 190 + sumOf(rewards.map((reward) => reward.amount ?? 0))

        expect(progression?.currentXp).toBe(totalXp)
        expect(progression?.level).toBe(expectedLevel(totalXp))
        expect(report.experience.level).toBe(expectedLevel(totalXp))
        expect(report.experience.levelsGained).toBeGreaterThan(1)
        expect(report.experience.levelsGained).toBe(expectedLevel(totalXp) - 1)

        observed.multiple = {
          before: 190,
          after: progression?.currentXp,
          level: progression?.level,
          levelsGained: report.experience.levelsGained,
        }
      },
    )

    // (c) Desde el nivel maximo: la experiencia sigue acumulandose y el nivel se
    // queda en 8, sin descartar nada.
    await scenario(
      (builder) =>
        builder
          .overrideProvider(EXPERIENCE_ROLLS)
          .useValue(new ScriptedRolls((index) => (index % 8) + 1)),
      async (missions) => {
        await seedProgression(databases, SUBJECT, HERO_ID, 12_800)

        const enrollment = await runChain(missions)
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const progression = await readProgression(databases, SUBJECT, HERO_ID)
        const report = await reportOf(missions, enrollment.enrollmentId)
        const totalXp = 12_800 + sumOf(rewards.map((reward) => reward.amount ?? 0))

        expect(progression?.currentXp).toBe(totalXp)
        expect(progression?.level).toBe(8)
        expect(report.experience).toMatchObject({ level: 8, maxLevel: 8, currentXp: totalXp })
        expect(report.experience.levelsGained).toBe(0)
        expect(report.experience.leveledUp).toBe(false)

        observed.maxLevel = { after: progression?.currentXp, level: progression?.level }
      },
    )

    recordCase({
      id: 'S-03',
      name: 'Subida de uno, de varios y nivel maximo',
      result: 'PASS',
      observed,
    })
  })

  it('S-04 · repetir el cierre no vuelve a tirar ni a crear recompensas', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const before = await readRollBatch(databases, enrollment.enrollmentId)

      // El mismo cierre, otra vez: la ejecucion ya esta resuelta y no hay nada que
      // cerrar; el lote de Combat no se toca.
      await missions.run()
      await missions.tick()

      const after = await readRollBatch(databases, enrollment.enrollmentId)
      const rewards = await rewardsOf(enrollment.enrollmentId)
      const lines = await linesOf(enrollment.enrollmentId)
      const grants = await readGrants(databases, enrollment.enrollmentId)

      expect(after?.defeats).toEqual(before?.defeats)
      expect(after?.createdAt).toEqual(before?.createdAt)
      expect(rewards).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(lines).toHaveLength(DEFEATS_IN_TEMPLO)
      expect(grants).toHaveLength(DEFEATS_IN_TEMPLO)

      observed = {
        defeats: after?.defeats.length ?? 0,
        rewards: rewards.length,
        grants: grants.length,
      }
    })

    recordCase({
      id: 'S-04',
      name: 'Idempotencia del cierre',
      result: 'PASS',
      observed,
    })
  })

  it('S-05 · el replay de una acreditacion no duplica experiencia', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const grantsBefore = await readGrants(databases, enrollment.enrollmentId)
      const progressionBefore = await readProgression(databases, SUBJECT, HERO_ID)
      const grant = grantsBefore[0]

      expect(grant).toBeDefined()

      // La MISMA peticion, firmada a mano y reconstruida del ASIENTO guardado: el
      // cuerpo tiene que coincidir campo a campo o no seria un replay, seria otro
      // contenido (y entonces la respuesta correcta seria `409`).
      const replay = await signedPost({
        baseUrl: inventory.baseUrl,
        path: `/api/internal/v1/players/${SUBJECT}/heroes/${HERO_ID}/experience`,
        secret: INTERNAL_SECRET,
        body: {
          schemaVersion: 1,
          operationId: grant?._id,
          amount: grant?.amount,
          source: {
            kind: 'MISSION_RIVAL_DEFEAT',
            enrollmentId: grant?.enrollmentId,
            simulationId: grant?.simulationId,
            encounterId: grant?.encounterId,
            enemyInstanceId: grant?.enemyInstanceId,
            rivalRef: grant?.rivalRef,
            roll: grant?.roll,
          },
        },
      })
      const grantsAfter = await readGrants(databases, enrollment.enrollmentId)
      const progressionAfter = await readProgression(databases, SUBJECT, HERO_ID)

      expect(replay.status).toBe(200)
      expect(replay.body).toMatchObject({ applied: false, operationId: grant?._id })
      expect(grantsAfter).toHaveLength(grantsBefore.length)
      expect(progressionAfter).toEqual(progressionBefore)

      observed = { replay: 'applied:false', grants: grantsAfter.length }
    })

    recordCase({
      id: 'S-05',
      name: 'Replay de la acreditacion',
      result: 'PASS',
      observed,
    })
  })

  it('S-06 · la misma clave con otro contenido es 409 en las dos fronteras', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const batch = await readRollBatch(databases, enrollment.enrollmentId)
      const grantsBefore = await readGrants(databases, enrollment.enrollmentId)
      const first = grantsBefore[0]

      expect(batch).not.toBeNull()
      expect(first).toBeDefined()

      // Combat: el mismo operationId del lote con OTRA lista de derrotas.
      const combatConflict = await signedPost({
        baseUrl: combat.baseUrl,
        path: '/api/internal/v1/combat/experience-rolls',
        secret: INTERNAL_SECRET,
        body: {
          schemaVersion: 1,
          operationId: rollsOperationId(enrollment.enrollmentId),
          enrollmentId: enrollment.enrollmentId,
          simulationId: batch?.simulationId,
          heroId: HERO_ID,
          defeats: [{ encounterId: '99', enemyInstanceId: 'otro#1', rivalRef: 'otro' }],
        },
      })

      expect(combatConflict.status).toBe(409)
      expect(combatConflict.body).toMatchObject({ code: 'OPERATION_ID_REUSED' })

      // Player/Inventory: la misma clave de una derrota con OTRO importe.
      const creditConflict = await signedPost({
        baseUrl: inventory.baseUrl,
        path: `/api/internal/v1/players/${SUBJECT}/heroes/${HERO_ID}/experience`,
        secret: INTERNAL_SECRET,
        body: {
          schemaVersion: 1,
          operationId: first?._id,
          amount: (first?.amount ?? 0) + 1,
          source: {
            kind: 'MISSION_RIVAL_DEFEAT',
            enrollmentId: first?.enrollmentId,
            simulationId: first?.simulationId,
            encounterId: first?.encounterId,
            enemyInstanceId: first?.enemyInstanceId,
            rivalRef: first?.rivalRef,
            roll: first?.roll,
          },
        },
      })

      expect(creditConflict.status).toBe(409)
      expect(creditConflict.body).toMatchObject({ code: 'EXPERIENCE_GRANT_CONFLICT' })

      // Y nada se sobrescribio.
      const batchAfter = await readRollBatch(databases, enrollment.enrollmentId)
      const grantsAfter = await readGrants(databases, enrollment.enrollmentId)
      const target = grantsAfter.find((entry) => entry.enemyInstanceId === first?.enemyInstanceId)

      expect(batchAfter?.defeats).toEqual(batch?.defeats)
      expect(target?.amount).toBe(first?.amount)

      observed = {
        combat: '409 OPERATION_ID_REUSED',
        playerInventory: '409 EXPERIENCE_GRANT_CONFLICT',
        overwritten: false,
      }
    })

    recordCase({
      id: 'S-06',
      name: '409 con la misma clave y otro contenido',
      result: 'PASS',
      observed,
    })
  })

  it('S-07 · sin victoria valida no hay tirada, ni recompensa, ni acreditacion', async () => {
    const observed: Record<string, unknown> = {}

    // (a) El heroe pierde y no muere ningun NPC.
    await scenario(
      (builder) => builder.overrideProvider(COMBAT_SIMULATION).useValue(new LosingSimulation()),
      async (missions) => {
        const enrollment = await runChain(missions)
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const lines = await linesOf(enrollment.enrollmentId)
        const grants = await readGrants(databases, enrollment.enrollmentId)
        const batch = await readRollBatch(databases, enrollment.enrollmentId)
        const report = await reportOf(missions, enrollment.enrollmentId)

        expect(rewards).toEqual([])
        expect(lines).toEqual([])
        expect(grants).toEqual([])
        // Ni siquiera se pidio el lote: no hay tirada que reclamar.
        expect(batch).toBeNull()
        expect(report.experience).toMatchObject({ defeats: 0, totalXp: 0, level: null })
        expect(report.rewards).toEqual([])

        observed.defeat = { rewards: 0, rolls: 0, grants: 0 }
      },
    )

    // (b) Combat rechaza la simulacion: la mision se anula y no deja informe.
    await scenario(
      (builder) => builder.overrideProvider(COMBAT_SIMULATION).useValue(rejectedSimulation),
      async (missions) => {
        const enrollment = await enroll(missions, { key: randomUUID() })

        await shiftEnrollmentWindow(db, enrollment.enrollmentId)
        await missions.run()

        const response = await missions.get(
          `/api/v1/missions/me/reports/${enrollment.enrollmentId}`,
        )
        const rewards = await rewardsOf(enrollment.enrollmentId)
        const grants = await readGrants(databases, enrollment.enrollmentId)

        expect(response.status).toBe(404)
        expect(rewards).toEqual([])
        expect(grants).toEqual([])
        expect(await readRollBatch(databases, enrollment.enrollmentId)).toBeNull()

        const enrollmentRow = await sql<{ status: string }>`
          select status from mission_enrollments where enrollment_id = ${enrollment.enrollmentId}`.execute(
          db,
        )

        expect(enrollmentRow.rows[0]?.status).toBe('VOIDED')

        observed.voided = { report: 404, rewards: 0, grants: 0 }
      },
    )

    recordCase({
      id: 'S-07',
      name: 'CA-08: sin victoria valida no se devenga nada',
      result: 'PASS',
      observed,
    })
  })

  it('S-08 · dos derrotas del mismo arquetipo son dos recompensas distintas', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const rewards = await rewardsOf(enrollment.enrollmentId)
      const batch = await readRollBatch(databases, enrollment.enrollmentId)
      const archetype = rewards.filter(
        (reward) => reward.enemy_instance_id.split('#')[0] === 'sombra-corrompida',
      )

      // El mismo arquetipo aparece en DOS encuentros, y con varias instancias.
      expect(archetype).toHaveLength(10)
      expect(new Set(archetype.map((reward) => reward.encounter_id)).size).toBe(2)

      // Dos derrotas con el MISMO nombre de instancia en encuentros distintos son
      // dos derrotas: si la identidad fuera el arquetipo, se habrian fundido.
      const first = archetype.filter((reward) => reward.enemy_instance_id === 'sombra-corrompida#1')

      expect(first).toHaveLength(2)
      expect(new Set(first.map((reward) => reward.encounter_id)).size).toBe(2)
      expect(new Set(first.map((reward) => reward.reward_line_no)).size).toBe(2)

      const keys = (batch?.defeats ?? [])
        .filter((defeat) => defeat.rivalRef === 'sombra-corrompida')
        .map((defeat) => `${defeat.encounterId}#${defeat.enemyInstanceId}`)

      expect(new Set(keys).size).toBe(keys.length)
      expect(keys).toHaveLength(10)

      observed = {
        sameArchetype: archetype.length,
        encounters: 2,
        distinctKeys: new Set(keys).size,
      }
    })

    recordCase({
      id: 'S-08',
      name: 'Dos derrotas del mismo arquetipo',
      result: 'PASS',
      observed,
    })
  })

  it('S-09 · una tirada sin acreditar la termina el barrido, sin volver a tirar', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await enroll(missions, { key: randomUUID() })

      await shiftEnrollmentWindow(db, enrollment.enrollmentId)
      await missions.run()

      // Player/Inventory se cae DESPUES de la tirada: la recompensa queda rodada
      // y sin acreditar, que el contrato §9.1 declara aceptable.
      await inventory.stop()
      await missions.tick()

      const rolled = await rewardsOf(enrollment.enrollmentId)
      const batchBefore = await readRollBatch(databases, enrollment.enrollmentId)

      expect(rolled.every((reward) => reward.status === 'ROLLED')).toBe(true)
      expect(rolled.every((reward) => reward.amount !== null)).toBe(true)
      expect(await readGrants(databases, enrollment.enrollmentId)).toEqual([])
      expect(
        (await linesOf(enrollment.enrollmentId)).every((line) => line.status === 'PENDING'),
      ).toBe(true)

      // Vuelve el servicio y se vence el escalonado (5 s): el barrido acredita con
      // la MISMA clave e importe, y NO vuelve a tirar.
      await inventory.start()
      await makeRewardsDue(db, enrollment.enrollmentId)
      await missions.tick()

      const credited = await rewardsOf(enrollment.enrollmentId)
      const batchAfter = await readRollBatch(databases, enrollment.enrollmentId)
      const grants = await readGrants(databases, enrollment.enrollmentId)

      // Si alguna no se acredito, el fallo ensena la fila con su motivo.
      expect(credited.filter((reward) => reward.status !== 'CREDITED')).toEqual([])
      expect(credited.map((reward) => reward.amount)).toEqual(rolled.map((reward) => reward.amount))
      // El lote es EL MISMO documento: mismas caras, mismas fechas de persistencia.
      expect(batchAfter?.defeats).toEqual(batchBefore?.defeats)
      expect(batchAfter?.createdAt).toEqual(batchBefore?.createdAt)
      // Distingue "no se acredito" de "se acredito a otra matricula".
      expect({
        deEstaMatricula: grants.length,
        enLaBase: await countGrants(databases),
      }).toEqual({ deEstaMatricula: DEFEATS_IN_TEMPLO, enLaBase: DEFEATS_IN_TEMPLO })

      observed = {
        afterFailure: 'ROLLED sin acreditar',
        afterRecovery: 'CREDITED',
        rerolled: false,
        grants: grants.length,
      }
    })

    recordCase({
      id: 'S-09',
      name: 'Recuperacion de una tirada sin acreditar',
      result: 'PASS',
      observed,
    })
  })

  it('S-10 · auditoria cruzada: no queda ninguna tirada huerfana', async () => {
    let observed: Record<string, unknown> = {}

    await scenario(undefined, async (missions) => {
      const enrollment = await runChain(missions)
      const rewards = await rewardsOf(enrollment.enrollmentId)
      const lines = await linesOf(enrollment.enrollmentId)
      const grants = await readGrants(databases, enrollment.enrollmentId)
      const batch = await readRollBatch(databases, enrollment.enrollmentId)

      // Toda cara tiene recompensa acreditada, linea acreditada y asiento...
      for (const defeat of batch?.defeats ?? []) {
        const key = `${defeat.encounterId}#${defeat.enemyInstanceId}`
        const reward = rewards.find(
          (entry) => `${entry.encounter_id}#${entry.enemy_instance_id}` === key,
        )

        expect(reward?.status).toBe('CREDITED')
        expect(lines.find((line) => line.line_no === reward?.reward_line_no)?.status).toBe(
          'CREDITED',
        )
        expect(grants.some((grant) => grant.enemyInstanceId === defeat.enemyInstanceId)).toBe(true)
      }

      // ...y todo asiento tiene su cara: ninguna tirada huerfana en los dos
      // sentidos.
      expect(grants).toHaveLength(batch?.defeats.length ?? -1)
      expect(rewards).toHaveLength(batch?.defeats.length ?? -1)

      // Controles del informe: ajena y en curso.
      const unknown = await missions.get('/api/v1/missions/me/reports/enr_inexistente')
      const running = await enroll(missions, { key: randomUUID() })
      const notAvailable = await missions.get(`/api/v1/missions/me/reports/${running.enrollmentId}`)

      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ code: 'REPORT_NOT_FOUND' })
      expect(notAvailable.status).toBe(404)
      expect(notAvailable.body).toMatchObject({ code: 'REPORT_NOT_AVAILABLE' })

      observed = {
        rolls: batch?.defeats.length ?? 0,
        rewards: rewards.length,
        lines: lines.length,
        grants: grants.length,
        orphanRolls: 0,
        reportsWithoutExperience: 1,
      }
    })

    recordCase({
      id: 'S-10',
      name: 'Auditoria cruzada y controles del informe',
      result: 'PASS',
      observed,
    })
  })

  it('S-11 · las guardas de no-duplicacion estan en verde y son capaces de fallar', () => {
    // Las guardas viven en las suites unitarias de cada repositorio. Se ejecutan
    // AQUI, sobre el commit que se esta probando, y su capacidad de fallar la
    // demuestran sus controles negativos (`... no es un colador`), que forman
    // parte de la misma suite: el aserto sobre ese nombre es lo que impide que la
    // guarda se quede en verde por vacia.
    //
    // El filtro es `--testPathPatterns` porque Jest 30 ya no interpreta el
    // argumento suelto: con el, estas dos ordenes corrian los proyectos unitarios
    // ENTEROS y el caso afirmaba "la guarda esta verde" sin haberla ejecutado.
    const missionsGuard = runNpmScript(process.cwd(), [
      'run',
      'test:unit',
      '--',
      '--testPathPatterns',
      'hu-09-reward-policy',
    ])
    const combatGuard = runNpmScript(COMBAT_DIR, [
      'run',
      'test:unit',
      '--',
      '--testPathPatterns',
      'hu-09-no-alternative-randomness',
    ])

    // El mensaje de fallo lleva la cola de la salida: si una guarda se pone roja,
    // se ve cual y por que sin abrir el registro del proceso hijo.
    if (!missionsGuard.ok) {
      throw new Error(`${missionsGuard.command} fallo:\n${missionsGuard.tail}`)
    }

    if (!combatGuard.ok) {
      throw new Error(`${combatGuard.command} fallo:\n${combatGuard.tail}`)
    }

    // Una sola suite por guarda: si el filtro dejara de aplicarse se veria aqui, y
    // si no seleccionara nada, Jest saldria con error antes de llegar.
    const singleSuite = /Test Suites:\s+1 passed/
    const guards = [
      { name: 'Missions (hu-09-reward-policy)', result: missionsGuard },
      { name: 'Combat (hu-09-no-alternative-randomness)', result: combatGuard },
    ]
    const withoutSingleSuite = guards
      .filter(({ result }) => !singleSuite.test(result.output))
      .map(({ name }) => name)

    expect(withoutSingleSuite).toEqual([])

    // Y el control negativo -- el que demuestra que la guarda sabe fallar -- se
    // ejecuto de verdad en las dos.
    //
    // SI ESTE ASERTO ES EL QUE FALLA, casi siempre es lo mismo y conviene decirlo:
    // la guarda de Combat vive en OTRO repositorio y la cadena clona su `develop`
    // por defecto. Hasta que el control negativo no este en ese `develop`, el
    // conjunto que se esta probando no esta completo -- y eso es un rojo honesto,
    // no un fallo de la cadena. Para probar el conjunto antes de mergear, se lanza
    // el workflow a mano con `combat_ref` (o `inventory_ref`) apuntando a la rama.
    const negativeControl = 'no es un colador'
    const withoutNegativeControl = guards
      .filter(({ result }) => !result.output.includes(negativeControl))
      .map(({ name }) => name)

    if (withoutNegativeControl.length > 0) {
      throw new Error(
        `La guarda de ${withoutNegativeControl.join(' y ')} no ejecuto su control negativo ` +
          `("${negativeControl}"): el ref del repositorio hermano que la cadena clona todavia no lo trae. ` +
          'El workflow clona `develop` salvo que se indique otro ref con `workflow_dispatch`.',
      )
    }

    recordCase({
      id: 'S-11',
      name: 'Guardas de no-duplicacion (formula y azar)',
      result: 'PASS',
      observed: {
        missions: missionsGuard.command,
        combat: combatGuard.command,
        controlNegativo: 'ejecutado en las dos guardas',
      },
    })
  })
})
