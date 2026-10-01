import { randomUUID } from 'node:crypto'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  insertCompletionRewardDeliveries,
  PostgresMissionCompletionRewardRepository,
} from '../../src/adapters/outbound/persistence/PostgresMissionCompletionRewardRepository'
import { insertReport } from '../../src/adapters/outbound/persistence/PostgresReportRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'
import type { MissionCompletionRewardDelivery } from '../../src/domain/entities/MissionCompletionRewardDelivery'
import type { ReportRecord, ReportRewardLine } from '../../src/domain/entities/MissionReport'

/**
 * HU-10 (Task HU-10.5): el estado de la entrega de finalizacion contra
 * PostgreSQL de verdad.
 *
 * Lo que un doble no puede demostrar: que la migracion `013` crea la tabla con
 * sus invariantes EN EL MOTOR -- la union discriminada por `kind`, el estado
 * conocido, `credited_at` solo con `CREDITED`, `last_error` obligatorio en
 * `FAILED` --, que `(enrollment_id, reward_key)` impide una segunda entrega para
 * el mismo derecho aunque el cierre se repita, y que el avance es una escritura
 * condicionada por los intentos leidos -- igual que HU-09 y el botin de HU-72.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')
const HERO_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const PRODUCT_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f61'
const TEMPLO = EXAMPLE_MISSIONS[0]!
const MISSION_ID = TEMPLO.missionId

const line = (overrides: Partial<ReportRewardLine>): ReportRewardLine => ({
  lineNo: 1,
  kind: 'EXPERIENCE',
  reference: 'completion:xp',
  name: 'Experiencia de finalización',
  rarity: null,
  quantity: 11,
  status: 'PENDING',
  source: 'HU-10',
  progression: null,
  updatedAt: NOW,
  ...overrides,
})

const reportFor = (enrollmentId: string, rewards: readonly ReportRewardLine[]): ReportRecord => ({
  report: {
    schemaVersion: 1,
    enrollmentId,
    playerId: 'sub-1',
    mission: {
      missionId: MISSION_ID,
      name: TEMPLO.name,
      category: TEMPLO.category,
      difficulty: 'NORMAL',
    },
    summary: {
      outcome: 'COMPLETED',
      outcomeReason: null,
      hero: { heroId: HERO_ID, name: null, subtype: null },
      startedAt: NOW,
      finishedAt: NOW,
      simulatedDuration: null,
    },
    combatStats: {
      encountersCompleted: 1,
      encountersTotal: 1,
      totalTurns: 1,
      damageDealt: 1,
      damageTaken: 0,
      criticalEffects: 0,
      skillsUsed: [],
    },
    enemies: {
      defeated: [],
      boss: { enemyRef: 'boss', name: 'Jefe', defeated: true },
      masters: [],
    },
    objectives: [],
    generatedAt: NOW,
  },
  rewards,
})

const delivery = (
  overrides: Partial<MissionCompletionRewardDelivery> & { readonly enrollmentId: string },
): MissionCompletionRewardDelivery =>
  ({
    playerId: 'sub-1',
    heroId: HERO_ID,
    missionId: MISSION_ID,
    simulationId: 'sim-01',
    difficulty: 'NORMAL',
    missionOutcome: 'COMPLETED',
    rewardKey: 'completion:xp',
    settledAt: NOW,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: NOW,
    lastError: null,
    creditedAt: null,
    reportLineNo: 1,
    kind: 'EXPERIENCE',
    amount: 11,
    ...overrides,
  }) as MissionCompletionRewardDelivery

describe('Entregas de finalizacion de mision en PostgreSQL (HU-10.5)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresMissionCompletionRewardRepository

  const enroll = async (enrollmentId: string): Promise<void> => {
    await db
      .insertInto('mission_enrollments')
      .values({
        enrollment_id: enrollmentId,
        // Un jugador y un heroe propios por matricula: el motor impide dos
        // matriculas IN_PROGRESS del MISMO jugador+mision o del MISMO heroe a la vez.
        player_id: `sub-${randomUUID()}`,
        hero_id: randomUUID(),
        mission_id: MISSION_ID,
        difficulty: 'NORMAL',
        status: 'IN_PROGRESS',
        operation_id: `op-${enrollmentId}`,
        idempotency_key: `idem-${enrollmentId}`,
        request_fingerprint: 'fp',
        requested_at: NOW,
        commitment_id: `cmt-${enrollmentId}`,
        started_at: NOW,
        ends_at: new Date(NOW.getTime() + 3_600_000),
        version: 1,
      })
      .execute()
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO)
    repository = new PostgresMissionCompletionRewardRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('la migracion 013 crea la tabla con sus invariantes', async () => {
    const constraints = await sql<{ constraint_name: string }>`
      select constraint_name from information_schema.table_constraints
      where table_name = 'mission_completion_reward_deliveries'`.execute(db)
    const names = constraints.rows.map((row) => row.constraint_name)

    expect(names).toContain('mission_completion_reward_deliveries_pk')
    expect(names).toContain('mission_completion_reward_deliveries_tipo_conocido')
    expect(names).toContain('mission_completion_reward_deliveries_estado_conocido')
    expect(names).toContain('mission_completion_reward_deliveries_forma_por_tipo')
    expect(names).toContain('mission_completion_reward_deliveries_acreditada_con_fecha')
    expect(names).toContain('mission_completion_reward_deliveries_fallo_con_motivo')
    expect(names).toContain('mission_completion_reward_deliveries_linea_del_reporte')
  })

  it('el motor rechaza una union mal formada: EXPERIENCE con producto, o PRODUCT con amount', async () => {
    const enrollmentId = 'enr_hu10_check_1'
    await enroll(enrollmentId)
    await insertReport(db, reportFor(enrollmentId, [line({ lineNo: 1 })]))
    const direct = db as unknown as Kysely<unknown>

    await expect(
      sql`insert into mission_completion_reward_deliveries
          (enrollment_id, reward_key, report_line_no, kind, player_id, hero_id, mission_id,
           simulation_id, difficulty, mission_outcome, amount, product_id, quantity, operation_id,
           status, settled_at)
          values (${enrollmentId}, 'completion:xp', 1, 'EXPERIENCE', 'sub-1', ${HERO_ID}, ${MISSION_ID},
                  'sim-01', 'NORMAL', 'COMPLETED', 11, ${PRODUCT_ID}, 1, 'op-mal-1', 'PENDING', ${NOW})`.execute(
        direct,
      ),
    ).rejects.toThrow()

    await expect(
      sql`insert into mission_completion_reward_deliveries
          (enrollment_id, reward_key, report_line_no, kind, player_id, hero_id, mission_id,
           simulation_id, difficulty, mission_outcome, amount, product_id, quantity, operation_id,
           status, settled_at)
          values (${enrollmentId}, 'guaranteed:sello', 1, 'PRODUCT', 'sub-1', ${HERO_ID}, ${MISSION_ID},
                  'sim-01', 'NORMAL', 'COMPLETED', 11, ${PRODUCT_ID}, 1, 'op-mal-2', 'PENDING', ${NOW})`.execute(
        direct,
      ),
    ).rejects.toThrow()
  })

  it.each([
    ['una entrega CREDITED sin credited_at', { status: 'CREDITED', credited_at: null }],
    ['una entrega FAILED sin last_error', { status: 'FAILED', last_error: null }],
    ['un importe cero', { amount: 0 }],
  ])('el motor rechaza %s', async (_label: string, overrides: Record<string, unknown>) => {
    const enrollmentId = `enr_hu10_check_2_${randomUUID()}`
    await enroll(enrollmentId)
    await insertReport(db, reportFor(enrollmentId, [line({ lineNo: 1 })]))
    const direct = db as unknown as Kysely<unknown>
    const row: Record<string, unknown> = {
      enrollment_id: enrollmentId,
      reward_key: `k-${JSON.stringify(overrides)}`,
      report_line_no: 1,
      kind: 'EXPERIENCE',
      player_id: 'sub-1',
      hero_id: HERO_ID,
      mission_id: MISSION_ID,
      simulation_id: 'sim-01',
      difficulty: 'NORMAL',
      mission_outcome: 'COMPLETED',
      amount: 11,
      operation_id: `op-${JSON.stringify(overrides)}`,
      status: 'PENDING',
      settled_at: NOW,
      credited_at: null,
      last_error: null,
      ...overrides,
    }

    await expect(
      sql`insert into mission_completion_reward_deliveries
          (enrollment_id, reward_key, report_line_no, kind, player_id, hero_id, mission_id,
           simulation_id, difficulty, mission_outcome, amount, operation_id, status, settled_at,
           credited_at, last_error)
          values (${row.enrollment_id}, ${row.reward_key}, ${row.report_line_no}, ${row.kind},
                  ${row.player_id}, ${row.hero_id}, ${row.mission_id}, ${row.simulation_id},
                  ${row.difficulty}, ${row.mission_outcome}, ${row.amount}, ${row.operation_id},
                  ${row.status}, ${row.settled_at}, ${row.credited_at ?? null}, ${row.last_error ?? null})`.execute(
        direct,
      ),
    ).rejects.toThrow()
  })

  it('el cierre inserta una entrega PENDING por derecho; repetirlo no duplica nada', async () => {
    const enrollmentId = 'enr_hu10_insert_1'
    await enroll(enrollmentId)
    await insertReport(
      db,
      reportFor(enrollmentId, [
        line({ lineNo: 1, kind: 'EXPERIENCE', reference: 'completion:xp', quantity: 11 }),
        line({
          lineNo: 2,
          kind: 'CREDITS',
          reference: 'guaranteed:credits-base',
          name: 'Créditos de finalización',
          quantity: 5,
        }),
      ]),
    )
    const deliveries = [
      delivery({
        enrollmentId,
        rewardKey: 'completion:xp',
        reportLineNo: 1,
        kind: 'EXPERIENCE',
        amount: 11,
      }),
      delivery({
        enrollmentId,
        rewardKey: 'guaranteed:credits-base',
        reportLineNo: 2,
        kind: 'CREDITS',
        amount: 5,
      }),
    ]

    await insertCompletionRewardDeliveries(db, deliveries)
    // Repetir la insercion (un cierre reintentado) no duplica nada.
    await insertCompletionRewardDeliveries(db, deliveries)

    const stored = await repository.listByEnrollment(enrollmentId)
    expect(stored.map((d) => d.rewardKey).sort()).toEqual([
      'completion:xp',
      'guaranteed:credits-base',
    ])
    expect(stored.every((d) => d.status === 'PENDING')).toBe(true)

    const due = await repository.dueDeliveries(new Date(NOW.getTime() + 1_000), 10)
    expect(due.length).toBeGreaterThanOrEqual(2)
  })

  it('save() avanza la entrega Y su linea del reporte en la misma transaccion', async () => {
    const enrollmentId = 'enr_hu10_save_1'
    await enroll(enrollmentId)
    await insertReport(db, reportFor(enrollmentId, [line({ lineNo: 1 })]))
    await insertCompletionRewardDeliveries(db, [delivery({ enrollmentId })])

    const [pending] = await repository.listByEnrollment(enrollmentId)
    const credited = { ...pending!, status: 'CREDITED' as const, attempts: 1, creditedAt: NOW }

    await expect(
      repository.save(credited, pending!.attempts, {
        status: 'CREDITED',
        quantity: 11,
        progression: { level: 2, currentXp: 61, maxLevel: 8, levelsGained: 1 },
        at: NOW,
      }),
    ).resolves.toBe(true)

    const stored = (await repository.listByEnrollment(enrollmentId))[0]
    expect(stored).toMatchObject({ status: 'CREDITED', creditedAt: NOW })

    const reportLine = await sql<{ status: string; hero_level: number | null }>`
      select status, hero_level from mission_report_rewards
      where enrollment_id = ${enrollmentId} and line_no = 1`.execute(db)
    expect(reportLine.rows[0]).toMatchObject({ status: 'CREDITED', hero_level: 2 })
  })

  it('el avance exige los intentos leidos: dos procesos a la vez, exactamente uno gana', async () => {
    const enrollmentId = 'enr_hu10_race_1'
    await enroll(enrollmentId)
    await insertReport(db, reportFor(enrollmentId, [line({ lineNo: 1 })]))
    await insertCompletionRewardDeliveries(db, [delivery({ enrollmentId })])

    const [pending] = await repository.listByEnrollment(enrollmentId)
    const first = { ...pending!, status: 'CREDITED' as const, attempts: 1, creditedAt: NOW }
    const second = { ...pending!, status: 'FAILED' as const, attempts: 1, lastError: 'x' }

    const results = await Promise.all([
      repository.save(first, pending!.attempts),
      repository.save(second, pending!.attempts),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    const stored = (await repository.listByEnrollment(enrollmentId))[0]
    expect(['CREDITED', 'FAILED']).toContain(stored?.status)
    expect(stored?.attempts).toBe(1)
  })

  it('una entrega CREDITED o FAILED ya no aparece en el barrido', async () => {
    const enrollmentId = 'enr_hu10_sweep_1'
    await enroll(enrollmentId)
    await insertReport(
      db,
      reportFor(enrollmentId, [
        line({ lineNo: 1, reference: 'completion:xp' }),
        line({ lineNo: 2, kind: 'CREDITS', reference: 'guaranteed:credits-base', quantity: 5 }),
      ]),
    )
    await insertCompletionRewardDeliveries(db, [
      delivery({ enrollmentId, rewardKey: 'completion:xp', reportLineNo: 1 }),
      delivery({
        enrollmentId,
        rewardKey: 'guaranteed:credits-base',
        reportLineNo: 2,
        kind: 'CREDITS',
        amount: 5,
      }),
    ])

    const [xp, credits] = await repository.listByEnrollment(enrollmentId)
    await repository.save(
      { ...xp!, status: 'CREDITED', attempts: 1, creditedAt: NOW },
      xp!.attempts,
    )
    await repository.save(
      { ...credits!, status: 'FAILED', attempts: 1, lastError: 'OPERATION_CONFLICT' },
      credits!.attempts,
    )

    const due = await repository.dueDeliveries(new Date(NOW.getTime() + 86_400_000), 100)
    expect(due.map((d) => d.enrollmentId)).not.toContain(enrollmentId)
  })

  it('las entregas de DOS matriculas no se mezclan', async () => {
    const a = 'enr_hu10_aislado_a'
    const b = 'enr_hu10_aislado_b'
    await enroll(a)
    await enroll(b)
    await insertReport(db, reportFor(a, [line({ lineNo: 1 })]))
    await insertCompletionRewardDeliveries(db, [delivery({ enrollmentId: a })])

    expect((await repository.listByEnrollment(a)).length).toBeGreaterThan(0)
    expect(await repository.listByEnrollment(b)).toEqual([])
  })
})
