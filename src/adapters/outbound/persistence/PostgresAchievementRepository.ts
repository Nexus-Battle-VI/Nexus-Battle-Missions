import { sql, type Insertable, type Kysely, type Selectable } from 'kysely'

import type {
  AchievementRepositoryPort,
  EvaluationCheckpoint,
  EvaluationRetry,
  PlayerToEvaluate,
} from '../../../application/ports/AchievementRepositoryPort'
import type { AchievementUnlock } from '../../../domain/entities/Achievement'
import type { Database, MissionAchievementUnlocksTable } from './schema'

const unlockOf = (row: Selectable<MissionAchievementUnlocksTable>): AchievementUnlock => ({
  playerId: row.player_id,
  achievementId: row.achievement_id,
  achievementVersion: row.achievement_version,
  criterion: row.criterion,
  name: row.name,
  progress: { current: row.progress_current, target: row.progress_target },
  proof: row.proof,
  unlockedAt: row.unlocked_at,
  recognition: {
    kind: row.recognition_kind,
    name: row.recognition_name,
    status: row.recognition_status,
  },
  grant:
    row.grant_operation_id === null
      ? null
      : {
          operationId: row.grant_operation_id,
          attempts: row.grant_attempts,
          nextAttemptAt: row.grant_next_attempt_at,
          lastError: row.grant_last_error,
          productId: row.grant_product_id,
          creditedAt: row.credited_at,
        },
})

const rowOf = (unlock: AchievementUnlock): Insertable<MissionAchievementUnlocksTable> => ({
  player_id: unlock.playerId,
  achievement_id: unlock.achievementId,
  achievement_version: unlock.achievementVersion,
  criterion: unlock.criterion,
  name: unlock.name,
  progress_current: unlock.progress.current,
  progress_target: unlock.progress.target,
  // Los `jsonb` se escriben como texto JSON.
  proof: JSON.stringify(unlock.proof),
  unlocked_at: unlock.unlockedAt,
  recognition_kind: unlock.recognition.kind,
  recognition_name: unlock.recognition.name,
  recognition_status: unlock.recognition.status,
  grant_operation_id: unlock.grant?.operationId ?? null,
  grant_attempts: unlock.grant?.attempts ?? 0,
  grant_next_attempt_at: unlock.grant?.nextAttemptAt ?? null,
  grant_last_error: unlock.grant?.lastError ?? null,
  grant_product_id: unlock.grant?.productId ?? null,
  credited_at: unlock.grant?.creditedAt ?? null,
})

/**
 * Logros de HU-76 en PostgreSQL. Las lecturas no bloquean filas y las
 * escrituras son idempotentes o condicionales, como en HU-72: dos evaluaciones
 * del mismo jugador a la vez dejan un solo desbloqueo por logro (la clave
 * primaria) y una sola entrega por cosmetico.
 */
export class PostgresAchievementRepository implements AchievementRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Compara, por jugador, sus `MissionSettled` y sus epicas `GRANTED` con los
   * conteos del punto de control. No mira `processed_at`: esa columna es de HU-72.
   * El conteo usa el UNIQUE `(type, enrollment_id)` de `mission_facts`.
   */
  async playersToEvaluate(
    now: Date,
    fingerprint: string,
    limit: number,
  ): Promise<readonly PlayerToEvaluate[]> {
    const { rows } = await sql<{
      player_id: string
      settled: number
      granted: number
      attempts: number
    }>`
      with liquidadas as (
        select e.player_id, count(*)::int as settled
        from mission_facts f
        join mission_enrollments e on e.enrollment_id = f.enrollment_id
        where f.type = 'MissionSettled'
        group by e.player_id
      ), epicas as (
        select e.player_id, count(*)::int as granted
        from mission_master_encounters m
        join mission_enrollments e on e.enrollment_id = m.enrollment_id
        where m.grant_status = 'GRANTED'
        group by e.player_id
      )
      select l.player_id, l.settled, coalesce(g.granted, 0) as granted,
        coalesce(v.attempts, 0) as attempts
      from liquidadas l
      left join epicas g on g.player_id = l.player_id
      left join mission_achievement_evaluations v on v.player_id = l.player_id
      where (
          v.player_id is null
          or v.settled_seen <> l.settled
          or v.epics_granted_seen <> coalesce(g.granted, 0)
          or v.catalog_fingerprint is distinct from ${fingerprint}::uuid
        )
        and (v.next_attempt_at is null or v.next_attempt_at <= ${now})
      order by v.evaluated_at asc nulls first, l.player_id
      limit ${limit}
    `.execute(this.db)

    return rows.map((row) => ({
      playerId: row.player_id,
      settled: row.settled,
      epicsGranted: row.granted,
      attempts: row.attempts,
    }))
  }

  async unlocksOf(playerId: string): Promise<readonly AchievementUnlock[]> {
    const rows = await this.db
      .selectFrom('mission_achievement_unlocks')
      .selectAll()
      .where('player_id', '=', playerId)
      .orderBy('unlocked_at')
      .orderBy('achievement_id')
      .execute()

    return rows.map(unlockOf)
  }

  async recordEvaluation(
    playerId: string,
    unlocks: readonly AchievementUnlock[],
    checkpoint: EvaluationCheckpoint,
  ): Promise<readonly AchievementUnlock[]> {
    return this.db.transaction().execute(async (trx) => {
      const inserted =
        unlocks.length === 0
          ? []
          : await trx
              .insertInto('mission_achievement_unlocks')
              .values(unlocks.map(rowOf))
              // Sin objetivo: la clave primaria y el operationId unico hacen de
              // arbitros. El operationId sale del jugador y del logro, asi que un
              // conflicto en cualquiera de los dos es el mismo desbloqueo; con solo
              // la clave primaria, un cosmetico insertado a la vez por otro proceso
              // fallaria en el segundo indice en lugar de ignorarse.
              .onConflict((conflict) => conflict.doNothing())
              .returning('achievement_id')
              .execute()
      const evaluation = {
        settled_seen: checkpoint.settledSeen,
        epics_granted_seen: checkpoint.epicsGrantedSeen,
        catalog_fingerprint: checkpoint.fingerprint,
        evaluated_at: checkpoint.evaluatedAt,
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
      }

      await trx
        .insertInto('mission_achievement_evaluations')
        .values({ player_id: playerId, ...evaluation })
        .onConflict((conflict) => conflict.column('player_id').doUpdateSet(evaluation))
        .execute()

      const ids = new Set(inserted.map((row) => row.achievement_id))

      return unlocks.filter((unlock) => ids.has(unlock.achievementId))
    })
  }

  async deferEvaluation(playerId: string, retry: EvaluationRetry): Promise<void> {
    const values = {
      attempts: retry.attempts,
      next_attempt_at: retry.nextAttemptAt,
      last_error: retry.lastError,
    }

    // Sin fila previa, los conteos en 0 y sin huella: volvera a elegirse.
    await this.db
      .insertInto('mission_achievement_evaluations')
      .values({
        player_id: playerId,
        settled_seen: 0,
        epics_granted_seen: 0,
        catalog_fingerprint: null,
        evaluated_at: null,
        ...values,
      })
      .onConflict((conflict) => conflict.column('player_id').doUpdateSet(values))
      .execute()
  }

  async pendingRecognitionGrants(now: Date, limit: number): Promise<readonly AchievementUnlock[]> {
    const rows = await this.db
      .selectFrom('mission_achievement_unlocks')
      .selectAll()
      .where('recognition_status', '=', 'PENDING')
      .where('grant_next_attempt_at', '<=', now)
      .orderBy('grant_next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(unlockOf)
  }

  async saveRecognitionGrant(next: AchievementUnlock, expectedAttempts: number): Promise<boolean> {
    const grant = next.grant

    if (grant === null) {
      return false
    }

    const updated = await this.db
      .updateTable('mission_achievement_unlocks')
      .set({
        recognition_status: next.recognition.status,
        grant_attempts: grant.attempts,
        grant_next_attempt_at: grant.nextAttemptAt,
        grant_last_error: grant.lastError,
        credited_at: grant.creditedAt,
        // Un producto congelado no se borra ni se cambia.
        grant_product_id: sql<string | null>`coalesce(grant_product_id, ${grant.productId}::uuid)`,
      })
      .where('player_id', '=', next.playerId)
      .where('achievement_id', '=', next.achievementId)
      .where('recognition_status', '=', 'PENDING')
      .where('grant_attempts', '=', expectedAttempts)
      .returning('achievement_id')
      .executeTakeFirst()

    return updated !== undefined
  }

  async freezeRecognitionProduct(
    next: AchievementUnlock,
    expectedAttempts: number,
  ): Promise<boolean> {
    const productId = next.grant?.productId ?? null

    if (productId === null) {
      return false
    }

    const frozen = await this.db
      .updateTable('mission_achievement_unlocks')
      .set({ grant_product_id: productId })
      .where('player_id', '=', next.playerId)
      .where('achievement_id', '=', next.achievementId)
      .where('recognition_status', '=', 'PENDING')
      .where('grant_attempts', '=', expectedAttempts)
      .where('grant_product_id', 'is', null)
      .returning('achievement_id')
      .executeTakeFirst()

    return frozen !== undefined
  }
}
