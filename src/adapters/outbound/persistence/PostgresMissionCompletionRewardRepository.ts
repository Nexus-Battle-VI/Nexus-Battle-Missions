import type { Kysely, Selectable } from 'kysely'

import type { MissionCompletionRewardRepositoryPort } from '../../../application/ports/MissionCompletionRewardRepositoryPort'
import {
  completionOperationIdOf,
  type MissionCompletionRewardDelivery,
} from '../../../domain/entities/MissionCompletionRewardDelivery'
import type { ReportLineUpdate } from '../../../domain/entities/MissionReport'
import type { Database, MissionCompletionRewardDeliveriesTable } from './schema'

/**
 * Las columnas de producto son `null` para `EXPERIENCE`/`CREDITS` a proposito (es
 * la union discriminada del `CHECK` de la migracion 013): este helper documenta
 * POR QUE una fila `PRODUCT` las tiene garantizadas, en vez de una asercion `!`
 * silenciosa que ocultaria el supuesto si el `CHECK` cambiara.
 */
const columnOf = <T>(value: T | null, column: string): T => {
  if (value === null) {
    throw new Error(`Fila PRODUCT sin ${column}: viola el CHECK de la migracion 013.`)
  }

  return value
}

const deliveryOf = (
  row: Selectable<MissionCompletionRewardDeliveriesTable>,
): MissionCompletionRewardDelivery => {
  const base = {
    enrollmentId: row.enrollment_id,
    playerId: row.player_id,
    heroId: row.hero_id,
    missionId: row.mission_id,
    simulationId: row.simulation_id,
    difficulty: row.difficulty,
    missionOutcome: row.mission_outcome,
    rewardKey: row.reward_key,
    settledAt: row.settled_at,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    creditedAt: row.credited_at,
    reportLineNo: row.report_line_no,
  }

  if (row.kind === 'PRODUCT') {
    // El `CHECK` de la migracion 013 garantiza que aqui `product_id`/`quantity`
    // no son nulos: es la mitad de la union discriminada que le corresponde.
    return {
      ...base,
      kind: 'PRODUCT',
      productId: columnOf(row.product_id, 'product_id'),
      quantity: columnOf(row.quantity, 'quantity'),
    }
  }

  return { ...base, kind: row.kind, amount: columnOf(row.amount, 'amount') }
}

/**
 * Escribe las entregas de una mision cerrada (HU-10, Task HU-10.5). Lo llama el
 * cierre DENTRO de su transaccion: cada derecho de `CompletionRewardPolicy` nace
 * `PENDING` con su importe ya congelado, junto con su linea del reporte.
 *
 * Repetirlo no cambia nada: `on conflict do nothing` conserva las filas ya
 * escritas, de modo que un cierre reintentado no crea una segunda entrega ni una
 * segunda linea para el mismo derecho.
 */
export const insertCompletionRewardDeliveries = async (
  db: Kysely<Database>,
  deliveries: readonly MissionCompletionRewardDelivery[],
): Promise<void> => {
  if (deliveries.length === 0) {
    return
  }

  await db
    .insertInto('mission_completion_reward_deliveries')
    .values(
      deliveries.map((delivery) => ({
        enrollment_id: delivery.enrollmentId,
        reward_key: delivery.rewardKey,
        // No nulo: una entrega nunca nace sin su linea (contrato §7).
        report_line_no: columnOf(delivery.reportLineNo, 'reportLineNo'),
        kind: delivery.kind,
        player_id: delivery.playerId,
        hero_id: delivery.heroId,
        mission_id: delivery.missionId,
        simulation_id: delivery.simulationId,
        difficulty: delivery.difficulty,
        mission_outcome: delivery.missionOutcome,
        amount: delivery.kind === 'PRODUCT' ? null : delivery.amount,
        product_id: delivery.kind === 'PRODUCT' ? delivery.productId : null,
        quantity: delivery.kind === 'PRODUCT' ? delivery.quantity : null,
        operation_id: completionOperationIdOf(delivery),
        status: delivery.status,
        attempts: delivery.attempts,
        next_attempt_at: delivery.nextAttemptAt,
        last_error: delivery.lastError,
        credited_at: delivery.creditedAt,
        settled_at: delivery.settledAt,
      })),
    )
    .onConflict((conflict) => conflict.columns(['enrollment_id', 'reward_key']).doNothing())
    .execute()
}

/**
 * Estado de las entregas de finalizacion en PostgreSQL (HU-10, Task HU-10.5).
 *
 * Despues del cierre solo cambia el estado de cada entrega, y cada avance es una
 * escritura condicionada por los intentos leidos: dos procesos no se pisan, y el
 * que pierde no escribe nada -- el mismo patron de `PostgresExperienceRewardRepository`.
 */
export class PostgresMissionCompletionRewardRepository implements MissionCompletionRewardRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async dueDeliveries(
    now: Date,
    limit: number,
  ): Promise<readonly MissionCompletionRewardDelivery[]> {
    const rows = await this.db
      .selectFrom('mission_completion_reward_deliveries')
      .selectAll()
      .where('status', '=', 'PENDING')
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(deliveryOf)
  }

  async listByEnrollment(
    enrollmentId: string,
  ): Promise<readonly MissionCompletionRewardDelivery[]> {
    const rows = await this.db
      .selectFrom('mission_completion_reward_deliveries')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('reward_key')
      .execute()

    return rows.map(deliveryOf)
  }

  /**
   * Guarda el avance si la entrega seguia con los intentos leidos, y CON EL, la
   * linea del reporte que la refleja -- en la MISMA transaccion, por la misma
   * razon que HU-09: son el mismo hecho, y ninguna mitad se reconstruye sola.
   *
   * La linea la escribe solo quien gana el bloqueo; si el avance no encontro la
   * entrega en los intentos leidos, otro proceso se adelanto y no se escribe nada.
   */
  async save(
    next: MissionCompletionRewardDelivery,
    expectedAttempts: number,
    line: ReportLineUpdate | null = null,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mission_completion_reward_deliveries')
        .set({
          status: next.status,
          attempts: next.attempts,
          next_attempt_at: next.nextAttemptAt,
          last_error: next.lastError,
          credited_at: next.creditedAt,
        })
        .where('enrollment_id', '=', next.enrollmentId)
        .where('reward_key', '=', next.rewardKey)
        .where('status', '=', 'PENDING')
        .where('attempts', '=', expectedAttempts)
        .returning('reward_key')
        .executeTakeFirst()

      if (updated === undefined) {
        return false
      }

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
