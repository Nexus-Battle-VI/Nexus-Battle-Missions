import 'reflect-metadata'

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'

import type { TestingModuleBuilder } from '@nestjs/testing'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool } from 'pg'
import { sql, type Kysely } from 'kysely'

import {
  COMBAT_SIMULATION,
  type CombatSimulationPort,
  type SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import type { SimulationRequest } from '../../src/domain/entities/MissionExecution'
import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'

import {
  HERO_ID,
  TEMPLO,
  clearPlayerInventory,
  connectChainDatabases,
  enroll,
  expectedLevel,
  insertDefinition,
  makeRewardsDue,
  readRollBatch,
  readProgression,
  seedClear,
  seedProgression,
  shiftEnrollmentWindow,
  type ChainDatabases,
  type Enrollment,
} from './support/fixtures'
import {
  INTERNAL_SECRET,
  commitOf,
  isDirty,
  nestedIn,
  siblingDir,
  startPostgresSibling,
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
import { recordHu10Scenario, writeHu10RunReport, type Hu10Repository } from './support/hu-10-report'

/**
 * HU-10.7: cadena de liquidacion con Missions, Player-Inventory y Wallet reales.
 *
 * Combat no participa como fuente de verdad en los casos de liquidacion: se usa
 * su doble de desarrollo solo para producir desenlaces reproducibles mientras el
 * perfil real de heroe siga requiriendo Catalog. Esa limitacion sale tanto en el
 * JSON generado como en la evidencia humana; los puertos HU-10 nunca se doblan.
 */
const localSibling = (area: string, repository: string): string =>
  `${process.cwd()}/../../${area}/${repository}`

const INVENTORY_DIR = siblingDir(
  'HU10_E2E_PLAYER_INVENTORY_DIR',
  'Nexus-Battle-Player-Inventory',
  localSibling('Player-Inventory', 'Nexus-Battle-Player-Inventory'),
)
const WALLET_DIR = siblingDir(
  'HU10_E2E_WALLET_DIR',
  'Nexus-Battle-Wallet',
  localSibling('Wallet', 'Nexus-Battle-Wallet'),
)
const COMBAT_DIR = siblingDir(
  'HU10_E2E_COMBAT_DIR',
  'Nexus-Battle-Combat',
  localSibling('Combat', 'Nexus-Battle-Combat'),
)

const CASES = [
  'T-00',
  'T-01',
  'T-02',
  'T-03',
  'T-04',
  'T-05',
  'T-06',
  'T-07',
  'T-08',
  'T-09',
  'T-10',
  'T-11',
  'T-12',
  'T-13',
  'T-14',
  'T-15',
  'T-16',
  'T-17',
  'T-18',
  'T-19',
] as const

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
const PLAYER_A = 'e2e-hu10-player-a'
const PLAYER_B = 'e2e-hu10-player-b'

const missionOf = (
  input: {
    readonly id?: string
    readonly normalXp?: number
    readonly heroicXp?: number
    readonly creditsOn?: readonly ('COMPLETED' | 'FAILED')[]
    readonly productOn?: readonly ('COMPLETED' | 'FAILED')[]
  } = {},
): MissionDefinition => ({
  ...TEMPLO,
  missionId: input.id ?? 'e2e_hu_10_settlement',
  name: 'Fixture técnico HU-10',
  masterEncounter: null,
  finalBoss: { ...TEMPLO.finalBoss, drops: [] },
  rewards: {
    ...TEMPLO.rewards,
    completion: {
      schemaVersion: 1,
      experience: {
        amountByDifficulty: { NORMAL: input.normalXp ?? 21, HEROIC: input.heroicXp ?? 34 },
      },
      entries: [
        {
          key: 'creditos-tecnicos',
          group: 'GUARANTEED',
          grantOn: input.creditsOn ?? ['COMPLETED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 7, HEROIC: 9 } },
        },
        {
          key: 'producto-tecnico',
          group: 'GUARANTEED',
          grantOn: input.productOn ?? ['COMPLETED'],
          reward: {
            kind: 'PRODUCT',
            productId: PRODUCT_ID,
            quantityByDifficulty: { NORMAL: 2, HEROIC: 3 },
          },
        },
      ],
    },
  },
})

/** Fuerza FAILED sin pretender verificar la simulacion de Combat. */
class FailedSimulation implements CombatSimulationPort {
  private readonly inner = new ScriptedCombatSimulation()

  async simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    const outcome = await this.inner.simulate(request)

    if (outcome.kind !== 'SIMULATED') return outcome

    return {
      kind: 'SIMULATED',
      result: {
        ...outcome.result,
        combatOutcome: 'HERO_DEFEATED',
        summary: {
          ...outcome.result.summary,
          bossDefeated: false,
          encountersCompleted: 0,
          enemiesDefeated: [],
          loot: [],
          master: {
            appeared: false,
            masterRef: null,
            defeated: false,
            evaluations: [],
            encounters: [],
          },
        },
        combatLog: [],
      },
    }
  }
}

const rejectedSimulation: CombatSimulationPort = {
  simulate: () => Promise.resolve({ kind: 'REJECTED', code: 'FIXTURE_REJECTED' }),
}

interface DeliveryRow {
  readonly reward_key: string
  readonly kind: string
  readonly status: string
  readonly amount: number | null
  readonly product_id: string | null
  readonly quantity: number | null
  readonly operation_id: string
}

interface WalletAccount {
  readonly balance: string
  readonly victory_progress: number
  readonly weekly_chest_count: number
}

const startCatalogNotFound = async (): Promise<{
  readonly baseUrl: string
  readonly stop: () => Promise<void>
}> => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 'NOT_FOUND' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
  }
}

describe('Cadena de liquidacion HU-10 (Task HU-10.7)', () => {
  const startedAt = new Date()
  const repositories: Hu10Repository[] = []
  const cleanups: (() => Promise<void>)[] = []

  let missionPostgres: StartedPostgreSqlContainer
  let walletPostgres: StartedPostgreSqlContainer
  let mongo: StartedMongoDBContainer
  let missionDb: Kysely<Database>
  let walletDb: Pool
  let databases: ChainDatabases
  let combat: Sibling
  let inventory: Sibling
  let wallet: Sibling
  let catalog: Awaited<ReturnType<typeof startCatalogNotFound>>

  const deliveriesOf = async (enrollmentId: string): Promise<readonly DeliveryRow[]> =>
    (
      await sql<DeliveryRow>`select reward_key, kind, status, amount, product_id, quantity, operation_id
        from mission_completion_reward_deliveries
        where enrollment_id = ${enrollmentId}
        order by reward_key`.execute(missionDb)
    ).rows

  const walletOf = async (playerId: string): Promise<WalletAccount | null> => {
    const result = await walletDb.query<WalletAccount>(
      'select balance::text, victory_progress, weekly_chest_count from wallet_accounts where player_id = $1',
      [playerId],
    )

    return result.rows[0] ?? null
  }

  const walletLedgerCount = async (enrollmentId: string): Promise<number> => {
    const result = await walletDb.query<{ readonly count: string }>(
      'select count(*)::text as count from wallet_mission_reward_credits where enrollment_id = $1',
      [enrollmentId],
    )

    return Number(result.rows[0]?.count ?? 0)
  }

  const productQuantity = async (playerId: string): Promise<number> => {
    const inventoryDocument = await databases.playerInventory
      .collection<{
        readonly _id: string
        readonly slots?: readonly { readonly itemId: string; readonly quantity: number }[]
      }>('inventories')
      .findOne({ _id: playerId })

    return inventoryDocument?.slots?.find((slot) => slot.itemId === PRODUCT_ID)?.quantity ?? 0
  }

  const completionGrantCount = async (enrollmentId: string): Promise<number> =>
    databases.playerInventory.collection('experience_grants').countDocuments({
      'source.enrollmentId': enrollmentId,
      'source.kind': 'MISSION_COMPLETION',
    })

  const completionGrant = async (enrollmentId: string): Promise<{ readonly _id: string } | null> =>
    databases.playerInventory.collection<{ readonly _id: string }>('experience_grants').findOne({
      _id: `mission:${enrollmentId}:reward:completion:xp`,
    })

  const resetScenario = async (): Promise<void> => {
    await truncateMissionTables(missionDb)
    await clearPlayerInventory(databases)
  }

  const withMissions = async (
    subject: string,
    work: (missions: MissionsApp) => Promise<void>,
    overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  ): Promise<void> => {
    const missions = await bootMissions({
      databaseUrl: missionPostgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: inventory.baseUrl,
      walletBaseUrl: wallet.baseUrl,
      completionRewards: true,
      secret: INTERNAL_SECRET,
      subject,
      ...(overrides === undefined ? {} : { overrides }),
    })

    try {
      await work(missions)
    } finally {
      await missions.close()
    }
  }

  const finish = async (
    missions: MissionsApp,
    definition: MissionDefinition,
    difficulty = 'NORMAL',
    settleHu09 = true,
  ): Promise<Enrollment> => {
    await insertDefinition(missionDb, definition)
    const enrollment = await enroll(missions, {
      missionId: definition.missionId,
      difficulty,
      key: randomUUID(),
    })
    await shiftEnrollmentWindow(missionDb, enrollment.enrollmentId)
    await missions.run()
    if (settleHu09) {
      await missions.tick()
    }
    return enrollment
  }

  beforeAll(async () => {
    repositories.push(
      {
        repo: 'Nexus-Battle-Missions',
        sha: commitOf(process.cwd()),
        dirty: isDirty(
          process.cwd(),
          [nestedIn(process.cwd(), INVENTORY_DIR), nestedIn(process.cwd(), WALLET_DIR)].filter(
            (entry): entry is string => entry !== null,
          ),
        ),
      },
      {
        repo: 'Nexus-Battle-Player-Inventory',
        sha: commitOf(INVENTORY_DIR),
        dirty: isDirty(INVENTORY_DIR),
      },
      { repo: 'Nexus-Battle-Wallet', sha: commitOf(WALLET_DIR), dirty: isDirty(WALLET_DIR) },
      { repo: 'Nexus-Battle-Combat', sha: commitOf(COMBAT_DIR), dirty: isDirty(COMBAT_DIR) },
    )

    mongo = await new MongoDBContainer('mongo:8.0').start()
    cleanups.push(async () => {
      await mongo.stop()
    })
    missionPostgres = await new PostgreSqlContainer('postgres:17-alpine').start()
    cleanups.push(async () => {
      await missionPostgres.stop()
    })
    walletPostgres = await new PostgreSqlContainer('postgres:17-alpine').start()
    cleanups.push(async () => {
      await walletPostgres.stop()
    })
    catalog = await startCatalogNotFound()
    cleanups.push(catalog.stop)

    missionDb = (await import('../../src/infrastructure/persistence/database')).createDatabase({
      connectionString: missionPostgres.getConnectionUri(),
    })
    cleanups.push(async () => {
      await missionDb.destroy()
    })
    const migrated = await (
      await import('../../src/infrastructure/persistence/database')
    ).migrateToLatest(missionDb)
    if (migrated.error !== undefined) {
      throw migrated.error instanceof Error
        ? migrated.error
        : new Error('La migración de Missions falló.')
    }

    walletDb = new Pool({ connectionString: walletPostgres.getConnectionUri() })
    cleanups.push(async () => {
      await walletDb.end()
    })
    databases = await connectChainDatabases(mongo.getConnectionString())
    cleanups.push(async () => {
      await databases.close()
    })

    combat = await startSibling({
      name: 'combat',
      dir: COMBAT_DIR,
      mongoUri: mongo.getConnectionString(),
      extraEnv: { COMBAT_RANDOM_SEED: '3000000' },
    })
    inventory = await startSibling({
      name: 'player-inventory',
      dir: INVENTORY_DIR,
      mongoUri: mongo.getConnectionString(),
      extraEnv: { CATALOG_BASE_URL: catalog.baseUrl },
    })
    wallet = await startPostgresSibling({
      name: 'wallet',
      dir: WALLET_DIR,
      databaseUrl: walletPostgres.getConnectionUri(),
    })
    cleanups.push(() => combat.stop())
    cleanups.push(() => inventory.stop())
    cleanups.push(() => wallet.stop())
    await combat.start()
    await inventory.start()
    await wallet.start()

    useChainEnv({
      databaseUrl: missionPostgres.getConnectionUri(),
      combatBaseUrl: combat.baseUrl,
      playerInventoryBaseUrl: inventory.baseUrl,
      walletBaseUrl: wallet.baseUrl,
      completionRewards: true,
      secret: INTERNAL_SECRET,
    })
  }, 900_000)

  afterAll(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error: unknown) {
        process.stderr.write(`Fallo al limpiar HU-10: ${String(error)}\n`)
      }
    }
    restoreChainEnv()

    const report = writeHu10RunReport({
      startedAt,
      expectedScenarioIds: CASES,
      repositories,
      services: [
        { name: 'Missions', mode: 'REAL', persistence: 'PostgreSQL 17 (Testcontainers)' },
        {
          name: 'Player-Inventory',
          mode: 'REAL',
          persistence: 'MongoDB 8 replica (Testcontainers)',
        },
        { name: 'Wallet', mode: 'REAL', persistence: 'PostgreSQL 17 (Testcontainers)' },
        { name: 'HMAC interno Missions→Player-Inventory', mode: 'REAL', persistence: 'sin estado' },
        { name: 'HMAC interno Missions→Wallet', mode: 'REAL', persistence: 'sin estado' },
        {
          name: 'Combat XP rolls (HU-09)',
          mode: 'REAL',
          persistence: 'MongoDB 8 replica (Testcontainers)',
        },
        {
          name: 'Resultado de simulación Combat',
          mode: 'SUBSTITUTED',
          persistence: 'doble declarado para desenlaces HU-10',
        },
        {
          name: 'Catalog read',
          mode: 'SUBSTITUTED',
          persistence: 'respondedor 404 de prueba, solo para producto no-HEROE',
        },
      ],
      limitations: [
        'Combat no se declara integrado en esta cadena: el perfil real de Player-Inventory consulta Catalog, que no forma parte del runner HU-10. El desenlace se controla con el doble de desarrollo de Combat y los escenarios T-14/T-15 quedan SKIPPED, no PASS.',
        'El respondedor Catalog de prueba devuelve 404 solamente para que Player-Inventory ejecute su adaptador HTTP real y entregue un producto sintético no-HEROE. No representa un Catalog real ni contenido económico aprobado.',
        'El testimonio del jugador se sustituye por un verificador Nest de prueba. Las fronteras internas sí usan HMAC real con un secreto sintético.',
        'Los importes 21/34 XP, 7/9 créditos y 2/3 productos son fixtures técnicos distintivos; no son valores de juego aprobados.',
      ],
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }, 300_000)

  it('T-00..T-04, T-10, T-16, T-18 y T-19 · entrega real completa, reporte e idempotencia', async () => {
    await resetScenario()
    await withMissions(PLAYER_A, async (missions) => {
      await seedProgression(databases, PLAYER_A, HERO_ID, 10)
      // El caso mide exclusivamente el delta de XP de HU-10; HU-09 se ejerce
      // en T-13 con su propio barrido y sus propios asertos.
      const enrollment = await finish(missions, missionOf(), 'NORMAL', false)
      const pending = await deliveriesOf(enrollment.enrollmentId)
      const pendingReport = await missions.get(
        `/api/v1/missions/me/reports/${enrollment.enrollmentId}`,
      )

      expect(pending).toHaveLength(3)
      expect(pending.every((delivery) => delivery.status === 'PENDING')).toBe(true)
      expect(pendingReport.status).toBe(200)
      expect(
        (pendingReport.body.rewards as readonly { source: string; status: string }[])
          .filter((line) => line.source === 'HU-10')
          .every((line) => line.status === 'PENDING'),
      ).toBe(true)

      const beforeWallet = await walletOf(PLAYER_A)
      expect(beforeWallet).toBeNull()
      await missions.completionTick()

      const deliveries = await deliveriesOf(enrollment.enrollmentId)
      const progression = await readProgression(databases, PLAYER_A, HERO_ID)
      const walletAccount = await walletOf(PLAYER_A)
      const report = await missions.get(`/api/v1/missions/me/reports/${enrollment.enrollmentId}`)

      expect(deliveries.map((delivery) => delivery.status)).toEqual([
        'CREDITED',
        'CREDITED',
        'CREDITED',
      ])
      expect(progression).toMatchObject({ currentXp: 31, level: expectedLevel(31) })
      expect(await completionGrantCount(enrollment.enrollmentId)).toBe(1)
      expect(await completionGrant(enrollment.enrollmentId)).not.toBeNull()
      expect(walletAccount).toMatchObject({
        balance: '7',
        victory_progress: 0,
        weekly_chest_count: 0,
      })
      expect(await walletLedgerCount(enrollment.enrollmentId)).toBe(1)
      expect(await productQuantity(PLAYER_A)).toBe(2)
      expect(deliveries.find((delivery) => delivery.kind === 'PRODUCT')?.operation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      )
      expect(report.status).toBe(200)

      const lines = (report.body.rewards as readonly Record<string, unknown>[]).filter(
        (line) => line.source === 'HU-10',
      )
      expect(lines).toHaveLength(3)
      expect(lines.every((line) => line.status === 'CREDITED')).toBe(true)
      expect(lines.find((line) => line.kind === 'EXPERIENCE')?.progression).toMatchObject({
        currentXp: 31,
      })
      expect(lines.find((line) => line.kind === 'CREDITS')?.quantity).toBe(7)
      expect(lines.find((line) => line.kind === 'PRODUCT')?.quantity).toBe(2)

      await missions.completionTick()
      expect(await completionGrantCount(enrollment.enrollmentId)).toBe(1)
      expect(await walletLedgerCount(enrollment.enrollmentId)).toBe(1)
      expect(await productQuantity(PLAYER_A)).toBe(2)
      expect(await deliveriesOf(enrollment.enrollmentId)).toHaveLength(3)

      expect(await readProgression(databases, PLAYER_B, HERO_ID)).toBeNull()
      expect(await walletOf(PLAYER_B)).toBeNull()
      expect(await productQuantity(PLAYER_B)).toBe(0)

      recordHu10Scenario({
        id: 'T-00',
        title: 'Sanidad del stack real',
        status: 'PASS',
        assertions: [
          'Missions, Player-Inventory y Wallet responden y migran con sus motores reales.',
        ],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-01',
        title: 'COMPLETED acredita XP',
        status: 'PASS',
        assertions: [
          'XP 10→31',
          'ledger MISSION_COMPLETION único',
          'progresión devuelta por Player-Inventory.',
        ],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-02',
        title: 'COMPLETED acredita créditos',
        status: 'PASS',
        assertions: ['saldo 0→7', 'un ledger Wallet.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-03',
        title: 'COMPLETED acredita producto',
        status: 'PASS',
        assertions: ['inventario 0→2', 'operación UUID v5 entregada por la ruta real.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-04',
        title: 'COMPLETED combinado',
        status: 'PASS',
        assertions: ['tres deliveries independientes CREDITED.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-10',
        title: 'Replay completo',
        status: 'PASS',
        assertions: ['no duplica XP, ledger Wallet, inventario ni deliveries.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-16',
        title: 'Integridad de identidad',
        status: 'PASS',
        assertions: ['solo player A recibe XP, créditos y producto.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-18',
        title: 'Reporte PENDING→CREDITED',
        status: 'PASS',
        assertions: ['endpoint real muestra pendiente antes del ciclo y credited después.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-19',
        title: 'Créditos no alteran HU-22',
        status: 'PASS',
        assertions: ['victory_progress y weekly_chest_count permanecen 0.'],
        notes: [],
      })
    })
  })

  it('T-05, T-06, T-07 y T-08 · desenlaces que no deben crear derechos indebidos', async () => {
    await resetScenario()
    await withMissions(
      PLAYER_A,
      async (missions) => {
        const failed = await finish(missions, missionOf({ id: 'e2e_hu10_failed' }))
        await missions.completionTick()
        const failedRows = await deliveriesOf(failed.enrollmentId)
        expect(failedRows).toHaveLength(1)
        expect(failedRows[0]).toMatchObject({ kind: 'EXPERIENCE', status: 'CREDITED', amount: 21 })
        expect(await walletLedgerCount(failed.enrollmentId)).toBe(0)
        expect(await productQuantity(PLAYER_A)).toBe(0)

        // La exclusión anterior no convierte FAILED en una regla global: una
        // entrada que declara explícitamente FAILED sí se crea y se entrega.
        const failedWithCredits = await finish(
          missions,
          missionOf({ id: 'e2e_hu10_failed_with_credits', creditsOn: ['FAILED'] }),
        )
        await missions.completionTick()
        expect(await walletLedgerCount(failedWithCredits.enrollmentId)).toBe(1)
        expect(
          (await deliveriesOf(failedWithCredits.enrollmentId)).find(
            (delivery) => delivery.kind === 'CREDITS',
          )?.status,
        ).toBe('CREDITED')

        const inProgress = await enroll(missions, {
          missionId: 'e2e_hu10_failed',
          difficulty: 'NORMAL',
          key: randomUUID(),
        })
        expect(await deliveriesOf(inProgress.enrollmentId)).toEqual([])

        recordHu10Scenario({
          id: 'T-05',
          title: 'FAILED acredita XP de finalización',
          status: 'PASS',
          assertions: ['delivery XP CREDITED con resultado FAILED.'],
          notes: ['Desenlace Combat sustituido y declarado.'],
        })
        recordHu10Scenario({
          id: 'T-06',
          title: 'FAILED excluye entries no configuradas',
          status: 'PASS',
          assertions: ['no hay créditos ni producto con grantOn=[COMPLETED].'],
          notes: [],
        })
        recordHu10Scenario({
          id: 'T-07',
          title: 'IN_PROGRESS no liquida',
          status: 'PASS',
          assertions: ['matrícula abierta sin deliveries ni efectos externos.'],
          notes: [],
        })
      },
      (builder) => builder.overrideProvider(COMBAT_SIMULATION).useValue(new FailedSimulation()),
    )

    await resetScenario()
    await withMissions(
      PLAYER_A,
      async (missions) => {
        const definition = missionOf({ id: 'e2e_hu10_voided' })
        const enrollment = await finish(missions, definition)
        expect(await deliveriesOf(enrollment.enrollmentId)).toEqual([])
        expect(await completionGrantCount(enrollment.enrollmentId)).toBe(0)
        expect(await walletLedgerCount(enrollment.enrollmentId)).toBe(0)
        expect(await productQuantity(PLAYER_A)).toBe(0)
        recordHu10Scenario({
          id: 'T-08',
          title: 'VOIDED no liquida',
          status: 'PASS',
          assertions: ['no se crean deliveries ni autoridades externas reciben entrega.'],
          notes: ['Rechazo Combat sustituido y declarado.'],
        })
      },
      (builder) => builder.overrideProvider(COMBAT_SIMULATION).useValue(rejectedSimulation),
    )
  })

  it('T-09 y T-17 · snapshot congelado y dificultad efectiva', async () => {
    await resetScenario()
    await withMissions(PLAYER_A, async (missions) => {
      const snapshotA = missionOf({ id: 'e2e_hu10_snapshot', normalXp: 21, heroicXp: 34 })
      await insertDefinition(missionDb, snapshotA)
      const enrollment = await enroll(missions, {
        missionId: snapshotA.missionId,
        difficulty: 'NORMAL',
        key: randomUUID(),
      })
      await shiftEnrollmentWindow(missionDb, enrollment.enrollmentId)
      await missions.queue()
      await missions.simulate()
      await insertDefinition(
        missionDb,
        missionOf({ id: snapshotA.missionId, normalXp: 99, heroicXp: 88 }),
      )
      await missions.closeDue()
      // `closeDue` separa el instante del snapshot; este ciclo siguiente solo
      // libera el héroe ya cerrado antes de matricular el caso HEROIC.
      await missions.run()
      await missions.completionTick()

      const snapshotRows = await deliveriesOf(enrollment.enrollmentId)
      expect(snapshotRows.find((row) => row.kind === 'EXPERIENCE')?.amount).toBe(21)
      expect(snapshotRows.find((row) => row.kind === 'CREDITS')?.amount).toBe(7)
      expect(snapshotRows.find((row) => row.kind === 'PRODUCT')?.quantity).toBe(2)

      const heroicDefinition = missionOf({ id: 'e2e_hu10_heroic' })
      await insertDefinition(missionDb, heroicDefinition)
      await seedClear(missionDb, PLAYER_A, heroicDefinition.missionId)
      const heroic = await finish(missions, heroicDefinition, 'HEROIC')
      await missions.completionTick()
      expect(
        (await deliveriesOf(heroic.enrollmentId)).find((row) => row.kind === 'EXPERIENCE')?.amount,
      ).toBe(34)

      recordHu10Scenario({
        id: 'T-09',
        title: 'Snapshot A→B',
        status: 'PASS',
        assertions: ['liquida XP 21, créditos 7 y producto 2 de A, no los valores B.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-17',
        title: 'Dificultad efectiva',
        status: 'PASS',
        assertions: ['matrícula HEROIC usa XP 34 del snapshot.'],
        notes: [],
      })
    })
  })

  it('T-11 y T-12 · caídas parciales recuperan solo la línea pendiente', async () => {
    await resetScenario()
    await withMissions(PLAYER_A, async (missions) => {
      const walletDown = await finish(missions, missionOf({ id: 'e2e_hu10_wallet_down' }))
      await wallet.stop()
      await missions.completionTick()
      let rows = await deliveriesOf(walletDown.enrollmentId)
      expect(rows.find((row) => row.kind === 'CREDITS')?.status).toBe('PENDING')
      expect(
        rows.filter((row) => row.kind !== 'CREDITS').every((row) => row.status === 'CREDITED'),
      ).toBe(true)
      await wallet.start()
      await sql`update mission_completion_reward_deliveries set next_attempt_at = ${new Date(Date.now() - 60_000)} where enrollment_id = ${walletDown.enrollmentId} and status = 'PENDING'`.execute(
        missionDb,
      )
      await missions.completionTick()
      expect(
        (await deliveriesOf(walletDown.enrollmentId)).every((row) => row.status === 'CREDITED'),
      ).toBe(true)

      const inventoryDown = await finish(missions, missionOf({ id: 'e2e_hu10_inventory_down' }))
      await inventory.stop()
      await missions.completionTick()
      rows = await deliveriesOf(inventoryDown.enrollmentId)
      expect(rows.find((row) => row.kind === 'CREDITS')?.status).toBe('CREDITED')
      expect(
        rows.filter((row) => row.kind !== 'CREDITS').every((row) => row.status === 'PENDING'),
      ).toBe(true)
      await inventory.start()
      await sql`update mission_completion_reward_deliveries set next_attempt_at = ${new Date(Date.now() - 60_000)} where enrollment_id = ${inventoryDown.enrollmentId} and status = 'PENDING'`.execute(
        missionDb,
      )
      await missions.completionTick()
      expect(
        (await deliveriesOf(inventoryDown.enrollmentId)).every((row) => row.status === 'CREDITED'),
      ).toBe(true)

      recordHu10Scenario({
        id: 'T-11',
        title: 'Wallet caída temporal y recovery',
        status: 'PASS',
        assertions: ['XP/producto CREDITED mientras crédito queda PENDING y luego CREDITED.'],
        notes: [],
      })
      recordHu10Scenario({
        id: 'T-12',
        title: 'Player-Inventory caída temporal y recovery',
        status: 'PASS',
        assertions: ['crédito CREDITED mientras XP/producto quedan PENDING y luego CREDITED.'],
        notes: [],
      })
    })
  })

  it('T-13 · HU-09 y HU-10 coexisten sin mezclar sus fuentes', async () => {
    await resetScenario()
    await withMissions(PLAYER_A, async (missions) => {
      const enrollment = await finish(missions, missionOf({ id: 'e2e_hu10_hu09' }))
      // La recompensa HU-09 usa su propia cadencia. Se vence el dato de prueba
      // en vez de esperar el reloj real, igual que la cadena HU-09 existente.
      await makeRewardsDue(missionDb, enrollment.enrollmentId)
      await missions.tick()
      await missions.completionTick()
      const grants = await databases.playerInventory
        .collection<{
          readonly _id: string
          readonly enrollmentId?: string
          readonly source?: { readonly enrollmentId: string; readonly kind: string }
        }>('experience_grants')
        .find({})
        .toArray()
      expect(
        grants.some(
          (grant) =>
            grant.enrollmentId === enrollment.enrollmentId && grant._id.includes(':encounter:'),
        ),
      ).toBe(true)
      expect(await completionGrant(enrollment.enrollmentId)).not.toBeNull()
      expect(await readRollBatch(databases, enrollment.enrollmentId)).not.toBeNull()
      const report = await missions.get(`/api/v1/missions/me/reports/${enrollment.enrollmentId}`)
      const rewards = report.body.rewards as readonly {
        readonly source: string
        readonly kind: string
      }[]
      expect(rewards.some((line) => line.source === 'HU-09' && line.kind === 'EXPERIENCE')).toBe(
        true,
      )
      expect(rewards.some((line) => line.source === 'HU-10' && line.kind === 'EXPERIENCE')).toBe(
        true,
      )
      recordHu10Scenario({
        id: 'T-13',
        title: 'Convivencia HU-09',
        status: 'PASS',
        assertions: ['dos operationIds y líneas con fuentes HU-09/HU-10 separadas.'],
        notes: [],
      })
    })
  })

  it('T-14 y T-15 · no se sobredeclara convivencia Combat', () => {
    recordHu10Scenario({
      id: 'T-14',
      title: 'Convivencia HU-72 loot',
      status: 'SKIPPED',
      assertions: [],
      notes: [
        'Requiere la cadena Combat+perfil Catalog real; no se suplanta con combatLog fabricado.',
      ],
    })
    recordHu10Scenario({
      id: 'T-15',
      title: 'Convivencia HU-73 epic',
      status: 'SKIPPED',
      assertions: [],
      notes: [
        'Requiere una aparición épica real y determinista de Combat; no se usa un doble oculto.',
      ],
    })
  })
})
