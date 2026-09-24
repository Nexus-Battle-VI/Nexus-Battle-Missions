import type { Kysely, Selectable } from 'kysely'

import type { ExperienceRewardRepositoryPort } from '../../../application/ports/ExperienceRewardRepositoryPort'
import type { ExperienceReward } from '../../../domain/entities/ExperienceReward'
import type { ReportLineUpdate } from '../../../domain/entities/MissionReport'
import type { Database, MissionExperienceRewardsTable } from './schema'

const rewardOf = (row: Selectable<MissionExperienceRewardsTable>): ExperienceReward => ({
  enrollmentId: row.enrollment_id,
  playerId: row.player_id,
  heroId: row.hero_id,
  simulationId: row.simulation_id,
  defeat: {
    encounterId: row.encounter_id,
    enemyInstanceId: row.enemy_instance_id,
    rivalRef: row.rival_ref,
  },
  status: row.status,
  roll: row.roll,
  amount: row.amount,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  creditedAt: row.credited_at,
  reportLineNo: row.reward_line_no,
})

/**
 * Escribe las recompensas de una mision cerrada. Lo llama el cierre de HU-72
 * DENTRO de su transaccion: es la primera mitad de la regla de orden del
 * contrato §9.1 -- se persiste `PENDING` ANTES de pedir ninguna tirada -- y es lo
 * que hace imposible la tirada huerfana.
 *
 * Repetirlo no cambia nada: `on conflict do nothing` conserva la fila ya escrita,
 * de modo que un cierre reintentado no reinicia el avance de una recompensa que ya
 * se habia acreditado.
 */
export const insertExperienceRewards = async (
  db: Kysely<Database>,
  rewards: readonly ExperienceReward[],
): Promise<void> => {
  if (rewards.length === 0) {
    return
  }

  await db
    .insertInto('mission_experience_rewards')
    .values(
      rewards.map((reward) => ({
        enrollment_id: reward.enrollmentId,
        encounter_id: reward.defeat.encounterId,
        enemy_instance_id: reward.defeat.enemyInstanceId,
        player_id: reward.playerId,
        hero_id: reward.heroId,
        simulation_id: reward.simulationId,
        rival_ref: reward.defeat.rivalRef,
        status: reward.status,
        roll: reward.roll,
        amount: reward.amount,
        attempts: reward.attempts,
        next_attempt_at: reward.nextAttemptAt,
        last_error: reward.lastError,
        credited_at: reward.creditedAt,
        // HU-09 (Task HU-09.5): la linea del reporte que refleja ESTA derrota. Es
        // la clave con la que el avance mueve las dos filas a la vez.
        reward_line_no: reward.reportLineNo,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['enrollment_id', 'encounter_id', 'enemy_instance_id']).doNothing(),
    )
    .execute()
}

/**
 * Estado de las recompensas de experiencia en PostgreSQL (HU-09, Task HU-09.4).
 *
 * Despues del cierre solo cambia el estado de cada recompensa, y cada avance es
 * una escritura condicionada por los intentos leidos: dos procesos no se pisan, y
 * el que pierde no escribe nada. No lleva bloqueo de version aparte porque los
 * intentos ya son un contador monotono que solo cambia quien gana.
 */
export class PostgresExperienceRewardRepository implements ExperienceRewardRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async dueRewards(now: Date, limit: number): Promise<readonly ExperienceReward[]> {
    const rows = await this.db
      .selectFrom('mission_experience_rewards')
      .selectAll()
      .where('status', 'in', ['PENDING', 'ROLLED'])
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(rewardOf)
  }

  async listByEnrollment(enrollmentId: string): Promise<readonly ExperienceReward[]> {
    const rows = await this.db
      .selectFrom('mission_experience_rewards')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('encounter_id')
      .orderBy('enemy_instance_id')
      .execute()

    return rows.map(rewardOf)
  }

  /**
   * Guarda el avance si la recompensa seguia con los intentos leidos, y CON EL, la
   * linea del reporte que la refleja (HU-09, Task HU-09.5).
   *
   * LAS DOS FILAS VAN EN UNA TRANSACCION porque son el mismo hecho: una derrota
   * acreditada y su linea diciendo `CREDITED` con su importe. Escribirlas por
   * separado dejaria al jugador con una recompensa entregada que su reporte sigue
   * dando por pendiente -- o al reves --, y ninguna de las dos mitades se puede
   * reconstruir despues por si sola.
   *
   * LA LINEA LA ESCRIBE SOLO QUIEN GANA EL BLOQUEO. Si el avance no encontro la
   * recompensa en los intentos leidos, otro proceso se adelanto: no se escribe nada
   * mas, ni la recompensa ni su linea.
   */
  async save(
    next: ExperienceReward,
    expectedAttempts: number,
    line: ReportLineUpdate | null = null,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mission_experience_rewards')
        .set({
          status: next.status,
          roll: next.roll,
          amount: next.amount,
          attempts: next.attempts,
          next_attempt_at: next.nextAttemptAt,
          last_error: next.lastError,
          credited_at: next.creditedAt,
        })
        .where('enrollment_id', '=', next.enrollmentId)
        .where('encounter_id', '=', next.defeat.encounterId)
        .where('enemy_instance_id', '=', next.defeat.enemyInstanceId)
        .where('status', 'in', ['PENDING', 'ROLLED'])
        .where('attempts', '=', expectedAttempts)
        .returning('encounter_id')
        .executeTakeFirst()

      if (updated === undefined) {
        return false
      }

      // Una recompensa sin linea -- la de una mision anulada, que no tiene reporte
      // (P-T3) -- no tiene nada que reflejar.
      if (line !== null && next.reportLineNo !== null) {
        await trx
          .updateTable('mission_report_rewards')
          .set({
            status: line.status,
            quantity: line.quantity,
            hero_level: line.progression?.level ?? null,
            hero_current_xp: line.progression?.currentXp ?? null,
            hero_max_level: line.progression?.maxLevel ?? null,
            levels_gained: line.progression?.levelsGained ?? null,
            updated_at: line.at,
          })
          .where('enrollment_id', '=', next.enrollmentId)
          .where('line_no', '=', next.reportLineNo)
          .execute()
      }

      return true
    })
  }
}
