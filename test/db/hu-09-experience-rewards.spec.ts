import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import {
  insertExperienceRewards,
  PostgresExperienceRewardRepository,
} from '../../src/adapters/outbound/persistence/PostgresExperienceRewardRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  pendingReward,
  rewardCredited,
  rewardRolled,
  type ExperienceReward,
} from '../../src/domain/entities/ExperienceReward'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * HU-09 (Task HU-09.4): el estado de la recompensa de experiencia contra
 * PostgreSQL de verdad.
 *
 * Lo que un doble no puede demostrar: que la migracion `007` cree la tabla con
 * sus invariantes EN EL MOTOR -- una recompensa sin tirar no puede tener cara, ni
 * una tirada sin importe, ni un fallo sin motivo --, que la clave por instancia
 * impide duplicar una derrota, y que el avance es una escritura condicionada por
 * los intentos leidos.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')
/** hero_id es uuid en el motor: la matricula exige un identificador canonico. */
const HERO_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const TEMPLO = EXAMPLE_MISSIONS[0]!
const MISSION_ID = TEMPLO.missionId

describe('Recompensas de experiencia en PostgreSQL (HU-09)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresExperienceRewardRepository

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
        enrollment_id: 'enr-01',
        player_id: 'sub-1',
        hero_id: HERO_ID,
        mission_id: MISSION_ID,
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

  const rewardOf = (enemyInstanceId: string, enrollmentId = 'enr-01'): ExperienceReward =>
    pendingReward({
      enrollmentId,
      playerId: 'sub-1',
      heroId: HERO_ID,
      simulationId: 'sim-01',
      defeat: { encounterId: '1', enemyInstanceId, rivalRef: enemyInstanceId.split('#')[0] ?? 'r' },
      now: NOW,
    })

  it('la migracion 007 crea la tabla con sus invariantes', async () => {
    const constraints = await sql<{ constraint_name: string }>`
      select constraint_name from information_schema.table_constraints
      where table_name = 'mission_experience_rewards'`.execute(db)
    const names = constraints.rows.map((row) => row.constraint_name)

    expect(names).toContain('mission_experience_rewards_pk')
    expect(names).toContain('mission_experience_rewards_estado_conocido')
    expect(names).toContain('mission_experience_rewards_pendiente_sin_tirada')
    expect(names).toContain('mission_experience_rewards_rodada_con_tirada')
    expect(names).toContain('mission_experience_rewards_fallo_con_motivo')
  })

  it('el motor rechaza una recompensa PENDING con tirada, y una ROLLED sin ella', async () => {
    const direct = db as unknown as Kysely<unknown>

    await expect(
      sql`insert into mission_experience_rewards
          (enrollment_id, encounter_id, enemy_instance_id, player_id, hero_id, simulation_id,
           rival_ref, status, roll, amount, attempts, next_attempt_at)
          values ('enr-01', '9', 'a#1', 'sub-1', ${HERO_ID}, 'sim-01', 'a', 'PENDING', 3, 17, 0, now())`.execute(
        direct,
      ),
    ).rejects.toThrow()

    await expect(
      sql`insert into mission_experience_rewards
          (enrollment_id, encounter_id, enemy_instance_id, player_id, hero_id, simulation_id,
           rival_ref, status, roll, amount, attempts, next_attempt_at)
          values ('enr-01', '9', 'a#2', 'sub-1', ${HERO_ID}, 'sim-01', 'a', 'ROLLED', null, null, 0, now())`.execute(
        direct,
      ),
    ).rejects.toThrow()
  })

  it.each([
    ['una cara fuera del dado', 9],
    ['una cara cero', 0],
  ])('el motor rechaza %s', async (_label, roll) => {
    const direct = db as unknown as Kysely<unknown>

    await expect(
      sql`insert into mission_experience_rewards
          (enrollment_id, encounter_id, enemy_instance_id, player_id, hero_id, simulation_id,
           rival_ref, status, roll, amount, attempts, next_attempt_at)
          values ('enr-01', '9', ${`a#${String(roll)}`}, 'sub-1', ${HERO_ID}, 'sim-01', 'a', 'ROLLED',
                  ${roll}, 17, 0, now())`.execute(direct),
    ).rejects.toThrow()
  })

  it('guarda una recompensa por derrota y las devuelve listas para su primer intento', async () => {
    await insertExperienceRewards(db, [rewardOf('sombra#1'), rewardOf('sombra#2')])

    // Repetir la insercion (un cierre reintentado) no duplica ni reinicia nada.
    await insertExperienceRewards(db, [rewardOf('sombra#1')])

    const stored = await repository.listByEnrollment('enr-01')
    const pendientes = stored.filter((reward) => reward.status === 'PENDING')

    expect(pendientes).toHaveLength(2)
    expect(stored.every((reward) => reward.roll === null && reward.amount === null)).toBe(true)

    const due = await repository.dueRewards(new Date(NOW.getTime() + 1_000), 10)
    expect(due.length).toBeGreaterThanOrEqual(2)
  })

  it('guarda tirada e importe, y la recompensa deja de estar pendiente de tirar', async () => {
    const [pending] = (await repository.listByEnrollment('enr-01')).filter(
      (reward) => reward.status === 'PENDING',
    )

    const rolled = rewardRolled(pending!, 5, 25, new Date(NOW.getTime() + 1_000))
    await expect(repository.save(rolled, pending!.attempts)).resolves.toBe(true)

    const stored = (await repository.listByEnrollment('enr-01')).find(
      (reward) => reward.defeat.enemyInstanceId === pending!.defeat.enemyInstanceId,
    )
    expect(stored).toMatchObject({ status: 'ROLLED', roll: 5, amount: 25 })
  })

  it('el avance exige los intentos leidos: el que pierde la carrera no escribe', async () => {
    const [pending] = (await repository.listByEnrollment('enr-01')).filter(
      (reward) => reward.status === 'PENDING',
    )

    const first = rewardRolled(pending!, 1, 12, NOW)
    const second = rewardRolled(pending!, 8, 43, NOW)

    expect(await repository.save(first, pending!.attempts)).toBe(true)
    // El segundo llego con los mismos intentos: ya no coinciden.
    expect(await repository.save(second, pending!.attempts)).toBe(false)

    const stored = (await repository.listByEnrollment('enr-01')).find(
      (reward) => reward.defeat.enemyInstanceId === pending!.defeat.enemyInstanceId,
    )
    expect(stored).toMatchObject({ roll: 1, amount: 12 })
  })

  it('una recompensa acreditada deja de aparecer en el barrido', async () => {
    const rolled = (await repository.listByEnrollment('enr-01')).find(
      (reward) => reward.status === 'ROLLED',
    )!

    await expect(repository.save(rewardCredited(rolled, NOW), rolled.attempts)).resolves.toBe(true)

    const stored = (await repository.listByEnrollment('enr-01')).find(
      (reward) => reward.defeat.enemyInstanceId === rolled.defeat.enemyInstanceId,
    )
    expect(stored).toMatchObject({ status: 'CREDITED', creditedAt: NOW })

    const due = await repository.dueRewards(new Date(NOW.getTime() + 86_400_000), 100)
    expect(due.map((reward) => reward.defeat.enemyInstanceId)).not.toContain(
      rolled.defeat.enemyInstanceId,
    )
  })

  it('la clave por INSTANCIA impide duplicar una derrota', async () => {
    await insertExperienceRewards(db, [rewardOf('unico#1')])
    await insertExperienceRewards(db, [rewardOf('unico#1')])

    const stored = (await repository.listByEnrollment('enr-01')).filter(
      (reward) => reward.defeat.enemyInstanceId === 'unico#1',
    )
    expect(stored).toHaveLength(1)
  })

  it('las recompensas de DOS matriculas no se mezclan', async () => {
    const stored = await repository.listByEnrollment('enr-01')
    const other = await repository.listByEnrollment('enr-02')

    expect(stored.length).toBeGreaterThan(0)
    expect(other).toEqual([])
  })
})
