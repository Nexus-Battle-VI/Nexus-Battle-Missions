import { sql, type Kysely, type Selectable } from 'kysely'

import type { LootGrantRepositoryPort } from '../../../application/ports/LootGrantRepositoryPort'
import type { LootGrantRecord } from '../../../domain/entities/LootGrantRecord'
import type { Database, MissionLootGrantsTable } from './schema'

const recordOf = (row: Selectable<MissionLootGrantsTable>): LootGrantRecord => ({
  enrollmentId: row.enrollment_id,
  lineNo: row.line_no,
  label: row.label,
  quantity: row.quantity,
  operationId: row.operation_id,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  grantedAt: row.granted_at,
  productId: row.product_id,
})

/**
 * Escribe las entregas del botin. Lo llama el cierre de HU-72 DENTRO de su
 * transaccion y DESPUES del reporte, porque cada entrega apunta a su linea.
 * Repetirlo no cambia nada: una fila ya escrita se conserva.
 */
export const insertLootGrants = async (
  db: Kysely<Database>,
  records: readonly LootGrantRecord[],
): Promise<void> => {
  if (records.length === 0) {
    return
  }

  await db
    .insertInto('mission_loot_grants')
    .values(
      records.map((grant) => ({
        enrollment_id: grant.enrollmentId,
        line_no: grant.lineNo,
        label: grant.label,
        quantity: grant.quantity,
        operation_id: grant.operationId,
        status: grant.status,
        attempts: grant.attempts,
        next_attempt_at: grant.nextAttemptAt,
        last_error: grant.lastError,
        granted_at: grant.grantedAt,
        product_id: grant.productId,
      })),
    )
    .onConflict((conflict) => conflict.columns(['enrollment_id', 'line_no']).doNothing())
    .execute()
}

/**
 * Entregas del botin en PostgreSQL (P-J1). Despues del cierre solo cambia la
 * entrega, y con ella la linea `PRODUCT` del reporte, en la misma transaccion.
 */
export class PostgresLootGrantRepository implements LootGrantRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async pendingGrants(now: Date, limit: number): Promise<readonly LootGrantRecord[]> {
    const rows = await this.db
      .selectFrom('mission_loot_grants')
      .selectAll()
      .where('status', '=', 'PENDING')
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(recordOf)
  }

  async listByEnrollment(enrollmentId: string): Promise<readonly LootGrantRecord[]> {
    const rows = await this.db
      .selectFrom('mission_loot_grants')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('line_no')
      .execute()

    return rows.map(recordOf)
  }

  saveGrant(next: LootGrantRecord, expectedAttempts: number, at: Date): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mission_loot_grants')
        .set({
          status: next.status,
          attempts: next.attempts,
          next_attempt_at: next.nextAttemptAt,
          last_error: next.lastError,
          granted_at: next.grantedAt,
          // Un producto congelado no se borra ni se cambia.
          product_id: sql<string | null>`coalesce(product_id, ${next.productId})`,
        })
        .where('enrollment_id', '=', next.enrollmentId)
        .where('line_no', '=', next.lineNo)
        .where('status', '=', 'PENDING')
        .where('attempts', '=', expectedAttempts)
        .returning('line_no')
        .executeTakeFirst()

      if (updated === undefined) {
        return false
      }

      if (next.status !== 'PENDING') {
        await trx
          .updateTable('mission_report_rewards')
          .set({ status: next.status === 'GRANTED' ? 'CREDITED' : 'FAILED', updated_at: at })
          .where('enrollment_id', '=', next.enrollmentId)
          .where('line_no', '=', next.lineNo)
          .execute()
      }

      return true
    })
  }

  async freezeProduct(next: LootGrantRecord, expectedAttempts: number): Promise<boolean> {
    if (next.productId === null) {
      return false
    }

    const frozen = await this.db
      .updateTable('mission_loot_grants')
      .set({ product_id: next.productId })
      .where('enrollment_id', '=', next.enrollmentId)
      .where('line_no', '=', next.lineNo)
      .where('status', '=', 'PENDING')
      .where('attempts', '=', expectedAttempts)
      .where('product_id', 'is', null)
      .returning('line_no')
      .executeTakeFirst()

    return frozen !== undefined
  }
}
