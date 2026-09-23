import type { Kysely, Selectable } from 'kysely'

import type {
  EnrollmentRepositoryPort,
  InsertPendingResult,
} from '../../../application/ports/EnrollmentRepositoryPort'
import {
  ACTIVE_ENROLLMENT_STATUSES,
  type MissionEnrollment,
  type MissionFact,
} from '../../../domain/entities/MissionEnrollment'
import type { Database, MissionEnrollmentsTable } from './schema'

/** Restricciones unicas de la migracion 002 y el conflicto que significa cada una. */
const CONFLICT_BY_CONSTRAINT: Readonly<
  Record<string, 'HERO_ACTIVE' | 'PLAYER_MISSION_ACTIVE' | 'IDEMPOTENCY_KEY'>
> = {
  mission_enrollments_heroe_activo: 'HERO_ACTIVE',
  mission_enrollments_jugador_mision_activa: 'PLAYER_MISSION_ACTIVE',
  mission_enrollments_clave_idempotencia: 'IDEMPOTENCY_KEY',
}

const UNIQUE_VIOLATION = '23505'

const uniqueViolationOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown }

  return code === UNIQUE_VIOLATION && typeof constraint === 'string' ? constraint : null
}

const toEnrollment = (row: Selectable<MissionEnrollmentsTable>): MissionEnrollment => ({
  enrollmentId: row.enrollment_id,
  playerId: row.player_id,
  missionId: row.mission_id,
  heroId: row.hero_id,
  difficulty: row.difficulty,
  status: row.status,
  operationId: row.operation_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  strategyVersion: row.strategy_version,
  rotations: row.rotations,
  commitmentId: row.commitment_id,
  rejection: row.rejection,
  requestedAt: row.requested_at,
  startedAt: row.started_at,
  endsAt: row.ends_at,
  finishedAt: row.finished_at,
  version: row.version,
})

/**
 * Matriculas en PostgreSQL (HU-70). Las invariantes las impone el MOTOR con los
 * indices unicos parciales de la migracion 002: aqui solo se traduce la
 * restriccion violada al conflicto que entiende el caso de uso. No se lee antes
 * de escribir para «comprobar»: bajo concurrencia esa lectura mentiria.
 */
export class PostgresEnrollmentRepository implements EnrollmentRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async findById(enrollmentId: string): Promise<MissionEnrollment | null> {
    const row = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirst()

    return row === undefined ? null : toEnrollment(row)
  }

  async findByIdempotencyKey(
    playerId: string,
    idempotencyKey: string,
  ): Promise<MissionEnrollment | null> {
    const row = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('player_id', '=', playerId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst()

    return row === undefined ? null : toEnrollment(row)
  }

  async findActiveByHero(heroId: string): Promise<MissionEnrollment | null> {
    const row = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('hero_id', '=', heroId)
      .where('status', 'in', ACTIVE_ENROLLMENT_STATUSES)
      .executeTakeFirst()

    return row === undefined ? null : toEnrollment(row)
  }

  async findActiveByPlayerAndMission(
    playerId: string,
    missionId: string,
  ): Promise<MissionEnrollment | null> {
    const row = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('player_id', '=', playerId)
      .where('mission_id', '=', missionId)
      .where('status', 'in', ACTIVE_ENROLLMENT_STATUSES)
      .executeTakeFirst()

    return row === undefined ? null : toEnrollment(row)
  }

  async listByPlayer(playerId: string): Promise<readonly MissionEnrollment[]> {
    const rows = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('player_id', '=', playerId)
      .orderBy('requested_at')
      .execute()

    return rows.map(toEnrollment)
  }

  async insertPending(enrollment: MissionEnrollment): Promise<InsertPendingResult> {
    try {
      await this.db
        .insertInto('mission_enrollments')
        .values({
          enrollment_id: enrollment.enrollmentId,
          player_id: enrollment.playerId,
          mission_id: enrollment.missionId,
          hero_id: enrollment.heroId,
          difficulty: enrollment.difficulty,
          status: enrollment.status,
          operation_id: enrollment.operationId,
          idempotency_key: enrollment.idempotencyKey,
          request_fingerprint: enrollment.requestFingerprint,
          strategy_version: enrollment.strategyVersion,
          rotations: JSON.stringify(enrollment.rotations),
          commitment_id: enrollment.commitmentId,
          rejection: enrollment.rejection === null ? null : JSON.stringify(enrollment.rejection),
          requested_at: enrollment.requestedAt,
          started_at: enrollment.startedAt,
          ends_at: enrollment.endsAt,
          finished_at: enrollment.finishedAt,
          version: enrollment.version,
        })
        .execute()

      return { kind: 'INSERTED' }
    } catch (error: unknown) {
      const reason = CONFLICT_BY_CONSTRAINT[uniqueViolationOf(error) ?? '']

      if (reason === undefined) {
        throw error
      }

      return { kind: 'CONFLICT', reason }
    }
  }

  async saveTransition(
    next: MissionEnrollment,
    expectedVersion: number,
    fact: MissionFact | null,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('mission_enrollments')
        .set({
          status: next.status,
          commitment_id: next.commitmentId,
          rejection: next.rejection === null ? null : JSON.stringify(next.rejection),
          started_at: next.startedAt,
          ends_at: next.endsAt,
          finished_at: next.finishedAt,
          version: next.version,
        })
        .where('enrollment_id', '=', next.enrollmentId)
        .where('version', '=', expectedVersion)
        .returning('enrollment_id')
        .executeTakeFirst()

      if (updated === undefined) {
        return false
      }

      if (fact !== null) {
        await trx
          .insertInto('mission_facts')
          .values({
            type: fact.type,
            enrollment_id: fact.enrollmentId,
            payload: JSON.stringify(fact.payload),
            created_at: fact.createdAt,
          })
          .onConflict((conflict) => conflict.columns(['type', 'enrollment_id']).doNothing())
          .execute()
      }

      return true
    })
  }

  async listPendingRequestedBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly MissionEnrollment[]> {
    const rows = await this.db
      .selectFrom('mission_enrollments')
      .selectAll()
      .where('status', '=', 'PENDING')
      .where('requested_at', '<', cutoff)
      .orderBy('requested_at')
      .limit(limit)
      .execute()

    return rows.map(toEnrollment)
  }
}
