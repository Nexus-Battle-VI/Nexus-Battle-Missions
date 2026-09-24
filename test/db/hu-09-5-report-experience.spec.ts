import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  insertExperienceRewards,
  PostgresExperienceRewardRepository,
} from '../../src/adapters/outbound/persistence/PostgresExperienceRewardRepository'
import { insertReport } from '../../src/adapters/outbound/persistence/PostgresReportRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import {
  pendingReward,
  rewardCredited,
  rewardRolled,
  withReportLine,
  type ExperienceReward,
} from '../../src/domain/entities/ExperienceReward'
import type {
  MissionReport,
  ReportLineUpdate,
  ReportRecord,
  ReportRewardLine,
} from '../../src/domain/entities/MissionReport'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * HU-09 (Task HU-09.5): la experiencia en el reporte, contra PostgreSQL de verdad.
 *
 * Lo que un doble no puede demostrar:
 *
 * 1. que la migracion `008` afloja lo justo -- el origen `HU-09` y la cantidad cero
 *    de una linea que todavia no tiene importe -- sin dejar de rechazar lo que
 *    sigue siendo invalido;
 * 2. que la progresion del heroe es un dato ENTERO o ninguno, y que solo existe en
 *    una linea acreditada;
 * 3. que una recompensa no puede apuntar a una linea que no existe;
 * 4. y, sobre todo, que el avance de la recompensa y su linea son UNA SOLA
 *    TRANSACCION: si la linea no se puede escribir, la recompensa no se mueve.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')
/** hero_id es uuid en el motor: la matricula exige un identificador canonico. */
const HERO_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const TEMPLO = EXAMPLE_MISSIONS[0]!
const ENROLLMENT = 'enr-01'

const PROGRESSION = { level: 3, currentXp: 640, maxLevel: 8, levelsGained: 1 }

/** El avance de una entrega, tal como lo arma el ciclo de coordinacion. */
const creditedLine = (overrides: Partial<ReportLineUpdate> = {}): ReportLineUpdate => ({
  status: 'CREDITED',
  quantity: 12,
  progression: PROGRESSION,
  at: NOW,
  ...overrides,
})

/**
 * El cierre de HU-72 en lo que toca a esta tarea: cuatro derrotas, cuatro
 * recompensas y cuatro lineas, cada prueba sobre la suya. Repetirlo no escribe
 * nada: tanto la foto como las recompensas se insertan sin reemplazar.
 */
const DEFEATS = [
  'sombra-corrompida#1',
  'guardian-eterno#1',
  'unico#1',
  'espectro-ancestral#1',
] as const

describe('La experiencia en el reporte, en PostgreSQL (HU-09.5)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresExperienceRewardRepository
  const direct = (): Kysely<unknown> => db as unknown as Kysely<unknown>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO)
    await db
      .insertInto('mission_enrollments')
      .values({
        enrollment_id: ENROLLMENT,
        player_id: 'sub-1',
        hero_id: HERO_ID,
        mission_id: TEMPLO.missionId,
        difficulty: 'NORMAL',
        status: 'IN_PROGRESS',
        operation_id: 'op-enr-01',
        idempotency_key: 'idem-enr-01',
        request_fingerprint: 'fp',
        requested_at: NOW,
        // `IN_PROGRESS` exige compromiso confirmado y una ventana con fin posterior.
        commitment_id: 'cmt-01',
        started_at: NOW,
        ends_at: new Date(NOW.getTime() + 3_600_000),
        version: 1,
      })
      .execute()
    repository = new PostgresExperienceRewardRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const lineOf = (lineNo: number): ReportRewardLine => ({
    lineNo,
    kind: 'EXPERIENCE',
    reference: DEFEATS[lineNo - 1] ?? 'desconocido#1',
    name: 'Sombra Corrompida',
    rarity: null,
    quantity: 0,
    status: 'PENDING',
    source: 'HU-09',
    progression: null,
    updatedAt: NOW,
  })

  const reportOf = (rewards: readonly ReportRewardLine[]): ReportRecord => {
    const report: MissionReport = {
      schemaVersion: 1,
      enrollmentId: ENROLLMENT,
      playerId: 'sub-1',
      mission: {
        missionId: TEMPLO.missionId,
        name: TEMPLO.name,
        category: TEMPLO.category,
        difficulty: 'NORMAL',
      },
      summary: {
        outcome: 'COMPLETED',
        outcomeReason: null,
        hero: { heroId: HERO_ID, name: 'Heroe', subtype: 'GUERRERO' },
        startedAt: NOW,
        finishedAt: NOW,
        simulatedDuration: null,
      },
      combatStats: {
        encountersCompleted: null,
        encountersTotal: null,
        totalTurns: null,
        damageDealt: null,
        damageTaken: null,
        criticalEffects: null,
        skillsUsed: [],
      },
      enemies: {
        defeated: [],
        boss: { enemyRef: TEMPLO.finalBoss.enemyRef, name: TEMPLO.finalBoss.name, defeated: true },
        masters: [],
      },
      objectives: [],
      generatedAt: NOW,
    }

    return { report, rewards }
  }

  const rewardOf = (enemyInstanceId: string, lineNo: number): ExperienceReward =>
    withReportLine(
      pendingReward({
        enrollmentId: ENROLLMENT,
        playerId: 'sub-1',
        heroId: HERO_ID,
        simulationId: 'sim-01',
        defeat: {
          encounterId: '1',
          enemyInstanceId,
          rivalRef: enemyInstanceId.split('#')[0] ?? 'r',
        },
        now: NOW,
      }),
      lineNo,
    )

  beforeEach(async () => {
    await insertReport(db, reportOf(DEFEATS.map((_, index) => lineOf(index + 1))))
    await insertExperienceRewards(
      db,
      DEFEATS.map((enemyInstanceId, index) => rewardOf(enemyInstanceId, index + 1)),
    )
  })

  const rewardInDb = async (enemyInstanceId: string): Promise<Record<string, unknown>> => {
    const result = await sql<Record<string, unknown>>`
      select * from mission_experience_rewards
      where enrollment_id = ${ENROLLMENT} and enemy_instance_id = ${enemyInstanceId}`.execute(db)

    return result.rows[0] ?? {}
  }

  const lineInDb = async (lineNo: number): Promise<Record<string, unknown>> => {
    const result = await sql<Record<string, unknown>>`
      select * from mission_report_rewards
      where enrollment_id = ${ENROLLMENT} and line_no = ${lineNo}`.execute(db)

    return result.rows[0] ?? {}
  }

  const storedReward = async (enemyInstanceId: string): Promise<ExperienceReward> => {
    const reward = (await repository.listByEnrollment(ENROLLMENT)).find(
      (candidate) => candidate.defeat.enemyInstanceId === enemyInstanceId,
    )

    if (reward === undefined) {
      throw new Error(`Falta la recompensa ${enemyInstanceId}.`)
    }

    return reward
  }

  it('la migracion 008 afloja el origen y la cantidad, y estrecha la progresion', async () => {
    const constraints = await sql<{ constraint_name: string }>`
      select constraint_name from information_schema.table_constraints
      where table_name in ('mission_report_rewards', 'mission_experience_rewards')`.execute(db)
    const names = constraints.rows.map((row) => row.constraint_name)

    expect(names).toContain('mission_report_rewards_origen_conocido')
    expect(names).toContain('mission_report_rewards_cantidad_no_negativa')
    expect(names).toContain('mission_report_rewards_progresion_completa')
    expect(names).toContain('mission_report_rewards_nivel_en_rango')
    expect(names).toContain('mission_report_rewards_progresion_al_acreditar')
    expect(names).toContain('mission_experience_rewards_linea_del_reporte')
    expect(names).not.toContain('mission_report_rewards_cantidad_positiva')
  })

  it('la linea nace PENDING, con el origen HU-09 y sin importe', async () => {
    expect(await lineInDb(1)).toMatchObject({
      line_no: 1,
      kind: 'EXPERIENCE',
      reference: 'sombra-corrompida#1',
      quantity: 0,
      status: 'PENDING',
      source: 'HU-09',
      hero_level: null,
      hero_current_xp: null,
      hero_max_level: null,
      levels_gained: null,
    })
    expect(await rewardInDb('sombra-corrompida#1')).toMatchObject({
      status: 'PENDING',
      reward_line_no: 1,
    })
    // La recompensa se lee con su linea, que es lo que permite moverlas juntas.
    expect((await storedReward('sombra-corrompida#1')).reportLineNo).toBe(1)
  })

  it.each([
    ['un origen que nadie declaro', `source = 'HU-99'`],
    ['una cantidad negativa', `quantity = -1`],
    ['una progresion a medias', `hero_level = 3`],
    [
      'un nivel por encima del tope',
      `hero_level = 9, hero_current_xp = 1, hero_max_level = 8, levels_gained = 1`,
    ],
    [
      'una progresion en una linea sin acreditar',
      `hero_level = 3, hero_current_xp = 640, hero_max_level = 8, levels_gained = 1`,
    ],
  ])('el motor rechaza %s', async (_label, assignment) => {
    await expect(
      sql`update mission_report_rewards set ${sql.raw(assignment)}
          where enrollment_id = ${ENROLLMENT} and line_no = 1`.execute(direct()),
    ).rejects.toThrow()
  })

  it('una recompensa no puede apuntar a una linea que no existe', async () => {
    await expect(
      insertExperienceRewards(db, [rewardOf('espectro-ancestral#2', 99)]),
    ).rejects.toThrow()
  })

  it('acreditar mueve la recompensa y su linea en la misma transaccion', async () => {
    const pending = await storedReward('sombra-corrompida#1')
    const rolled = rewardRolled(pending, 1, 12, NOW)
    const credited = rewardCredited(rolled, NOW)

    expect(await repository.save(credited, pending.attempts, creditedLine())).toBe(true)

    expect(await rewardInDb('sombra-corrompida#1')).toMatchObject({
      status: 'CREDITED',
      roll: 1,
      amount: 12,
      credited_at: NOW,
    })
    // La linea del reporte dice lo mismo: acreditada, con su importe y con el nivel
    // en que quedo el heroe.
    expect(await lineInDb(1)).toMatchObject({
      status: 'CREDITED',
      quantity: 12,
      hero_level: 3,
      hero_current_xp: 640,
      hero_max_level: 8,
      levels_gained: 1,
    })
  })

  it('si la linea no se puede escribir, la recompensa TAMPOCO se mueve', async () => {
    const pending = await storedReward('guardian-eterno#1')
    const rolled = rewardRolled(pending, 2, 14, NOW)

    // Un nivel por encima del tope: el `check` de la linea aborta la transaccion
    // entera, asi que la recompensa se queda donde estaba.
    await expect(
      repository.save(
        rolled,
        pending.attempts,
        creditedLine({ progression: { ...PROGRESSION, level: 9 } }),
      ),
    ).rejects.toThrow()

    expect(await rewardInDb('guardian-eterno#1')).toMatchObject({
      status: 'PENDING',
      roll: null,
      amount: null,
      attempts: pending.attempts,
    })
    expect(await lineInDb(2)).toMatchObject({ status: 'PENDING', quantity: 0, hero_level: null })
  })

  it('un rechazo definitivo deja la linea FAILED y sin importe', async () => {
    const pending = await storedReward('unico#1')
    const rolled = rewardRolled(pending, 3, 17, NOW)
    expect(await repository.save(rolled, pending.attempts)).toBe(true)

    expect(
      await repository.save(
        { ...rolled, attempts: rolled.attempts + 1 },
        rolled.attempts,
        creditedLine({ status: 'FAILED', quantity: 0, progression: null }),
      ),
    ).toBe(true)

    expect(await lineInDb(3)).toMatchObject({ status: 'FAILED', quantity: 0, hero_level: null })
  })

  it('el avance que pierde la carrera no escribe la linea', async () => {
    const pending = await storedReward('espectro-ancestral#1')
    const rolled = rewardRolled(pending, 4, 21, NOW)

    expect(await repository.save(rolled, pending.attempts)).toBe(true)
    // El segundo llego con los mismos intentos y su escritura incluiria la linea.
    expect(await repository.save(rolled, pending.attempts, creditedLine({ quantity: 21 }))).toBe(
      false,
    )

    expect(await lineInDb(4)).toMatchObject({ status: 'PENDING', quantity: 0 })
  })

  it('una recompensa sin linea no tiene nada que reflejar', async () => {
    // La de una mision anulada: no hay reporte, asi que no hay linea que mover.
    await insertExperienceRewards(db, [{ ...rewardOf('sin-linea#1', 1), reportLineNo: null }])
    const orphan = await storedReward('sin-linea#1')

    expect(orphan.reportLineNo).toBeNull()
    expect(await repository.save(rewardRolled(orphan, 5, 25, NOW), orphan.attempts)).toBe(true)
    expect(await rewardInDb('sin-linea#1')).toMatchObject({ status: 'ROLLED', amount: 25 })
  })
})
