import { sql, type Kysely, type Selectable } from 'kysely'

import type { MasterEncounterRepositoryPort } from '../../../application/ports/MasterEncounterRepositoryPort'
import type { MasterEncounterRecord } from '../../../domain/entities/MasterEncounterRecord'
import type { Database, MissionMasterEncountersTable } from './schema'

const recordOf = (row: Selectable<MissionMasterEncountersTable>): MasterEncounterRecord => ({
  enrollmentId: row.enrollment_id,
  sequence: row.sequence,
  afterEncounter: row.after_encounter,
  masterRef: row.master_ref,
  status: row.status,
  epicRef: row.epic_ref,
  levelOffset: row.level_offset,
  turns: row.turns,
  grant:
    row.grant_operation_id === null || row.grant_status === null
      ? null
      : {
          operationId: row.grant_operation_id,
          status: row.grant_status,
          attempts: row.grant_attempts,
          nextAttemptAt: row.grant_next_attempt_at,
          lastError: row.grant_last_error,
          grantedAt: row.granted_at,
          rewardLineNo: row.reward_line_no,
          productId: row.grant_product_id,
        },
})

/**
 * Escribe la evidencia del Master. Lo llama el cierre de HU-72 DENTRO de su
 * transaccion (P-X7). Repetirlo no cambia nada: una fila ya escrita se conserva.
 */
export const insertMasterEncounters = async (
  db: Kysely<Database>,
  records: readonly MasterEncounterRecord[],
): Promise<void> => {
  if (records.length === 0) {
    return
  }

  await db
    .insertInto('mission_master_encounters')
    .values(
      records.map((encounter) => ({
        enrollment_id: encounter.enrollmentId,
        sequence: encounter.sequence,
        after_encounter: encounter.afterEncounter,
        master_ref: encounter.masterRef,
        status: encounter.status,
        epic_ref: encounter.epicRef,
        level_offset: encounter.levelOffset,
        turns: encounter.turns,
        grant_operation_id: encounter.grant?.operationId ?? null,
        grant_status: encounter.grant?.status ?? null,
        grant_attempts: encounter.grant?.attempts ?? 0,
        grant_next_attempt_at: encounter.grant?.nextAttemptAt ?? null,
        grant_last_error: encounter.grant?.lastError ?? null,
        granted_at: encounter.grant?.grantedAt ?? null,
        reward_line_no: encounter.grant?.rewardLineNo ?? null,
        grant_product_id: encounter.grant?.productId ?? null,
      })),
    )
    .onConflict((conflict) => conflict.columns(['enrollment_id', 'sequence']).doNothing())
    .execute()
}

/**
 * Evidencia del Master en PostgreSQL (HU-73). Despues del cierre solo cambia la
 * entrega de la epica, y con ella la linea `EPIC` del reporte de HU-74, en la
 * misma transaccion.
 */
export class PostgresMasterEncounterRepository implements MasterEncounterRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async pendingGrants(now: Date, limit: number): Promise<readonly MasterEncounterRecord[]> {
    const rows = await this.db
      .selectFrom('mission_master_encounters')
      .selectAll()
      .where('grant_status', '=', 'PENDING')
      .where('grant_next_attempt_at', '<=', now)
      .orderBy('grant_next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(recordOf)
  }

  async listByEnrollment(enrollmentId: string): Promise<readonly MasterEncounterRecord[]> {
    const rows = await this.db
      .selectFrom('mission_master_encounters')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('sequence')
      .execute()

    return rows.map(recordOf)
  }

  async saveGrant(
    next: MasterEncounterRecord,
    expectedAttempts: number,
    at: Date,
  ): Promise<boolean> {
    const grant = next.grant

    if (grant === null) {
      return false
    }

    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mission_master_encounters')
        .set({
          grant_status: grant.status,
          grant_attempts: grant.attempts,
          grant_next_attempt_at: grant.nextAttemptAt,
          grant_last_error: grant.lastError,
          granted_at: grant.grantedAt,
          // Un producto congelado no se borra ni se cambia.
          grant_product_id: sql<string | null>`coalesce(grant_product_id, ${grant.productId})`,
        })
        .where('enrollment_id', '=', next.enrollmentId)
        .where('sequence', '=', next.sequence)
        .where('grant_status', '=', 'PENDING')
        .where('grant_attempts', '=', expectedAttempts)
        .returning('sequence')
        .executeTakeFirst()

      if (updated === undefined) {
        return false
      }

      if (grant.status !== 'PENDING' && grant.rewardLineNo !== null) {
        await trx
          .updateTable('mission_report_rewards')
          .set({ status: grant.status === 'GRANTED' ? 'CREDITED' : 'FAILED', updated_at: at })
          .where('enrollment_id', '=', next.enrollmentId)
          .where('line_no', '=', grant.rewardLineNo)
          .execute()
      }

      return true
    })
  }

  async freezeProduct(next: MasterEncounterRecord, expectedAttempts: number): Promise<boolean> {
    const productId = next.grant?.productId ?? null

    if (productId === null) {
      return false
    }

    const frozen = await this.db
      .updateTable('mission_master_encounters')
      .set({ grant_product_id: productId })
      .where('enrollment_id', '=', next.enrollmentId)
      .where('sequence', '=', next.sequence)
      .where('grant_status', '=', 'PENDING')
      .where('grant_attempts', '=', expectedAttempts)
      .where('grant_product_id', 'is', null)
      .returning('sequence')
      .executeTakeFirst()

    return frozen !== undefined
  }
}
