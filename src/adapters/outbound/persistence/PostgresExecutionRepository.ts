import type { Kysely, Selectable } from 'kysely'

import type {
  ExecutionRepositoryPort,
  MissionClosure,
  StartedMission,
} from '../../../application/ports/ExecutionRepositoryPort'
import type { MissionExecution } from '../../../domain/entities/MissionExecution'
import { insertMasterEncounters } from './PostgresMasterEncounterRepository'
import { insertReport } from './PostgresReportRepository'
import type { Database, MissionExecutionsTable } from './schema'

/** `jsonb` se escribe como texto JSON: el driver convertiria un arreglo en un arreglo de PostgreSQL. */
const json = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value)

const toExecution = (row: Selectable<MissionExecutionsTable>): MissionExecution => ({
  enrollmentId: row.enrollment_id,
  operationId: row.operation_id,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  deadlineAt: row.deadline_at,
  request: row.request,
  lastError: row.last_error,
  result:
    row.simulation_id === null ||
    row.combat_outcome === null ||
    row.summary === null ||
    row.combat_log === null
      ? null
      : {
          simulationId: row.simulation_id,
          seedRef: row.seed_ref,
          combatOutcome: row.combat_outcome,
          summary: row.summary,
          combatLog: row.combat_log,
        },
  simulatedAt: row.simulated_at,
  settlement:
    row.outcome === null
      ? null
      : { outcome: row.outcome, reason: row.outcome_reason, objectives: row.objectives ?? [] },
  settledAt: row.settled_at,
  heroReleasedAt: row.hero_released_at,
  version: row.version,
})

/** Columnas que cambian con cada transicion (todas salvo la clave). */
const toChanges = (execution: MissionExecution) => ({
  operation_id: execution.operationId,
  status: execution.status,
  attempts: execution.attempts,
  next_attempt_at: execution.nextAttemptAt,
  deadline_at: execution.deadlineAt,
  request: json(execution.request),
  last_error: execution.lastError,
  simulation_id: execution.result?.simulationId ?? null,
  seed_ref: execution.result?.seedRef ?? null,
  combat_outcome: execution.result?.combatOutcome ?? null,
  summary: json(execution.result?.summary),
  combat_log: json(execution.result?.combatLog),
  simulated_at: execution.simulatedAt,
  outcome: execution.settlement?.outcome ?? null,
  outcome_reason: execution.settlement?.reason ?? null,
  objectives: json(execution.settlement?.objectives),
  settled_at: execution.settledAt,
  hero_released_at: execution.heroReleasedAt,
  version: execution.version,
})

/** Otro proceso cambio la matricula o la ejecucion: se deshace todo el cierre. */
class ClosureConflict extends Error {}

/**
 * Ejecuciones en PostgreSQL (HU-72). Cada transicion exige la version leida, asi
 * que dos planificadores a la vez no pisan un resultado: el segundo no escribe.
 * El cierre escribe matricula, ejecucion, clear y hecho en UNA transaccion; el
 * clear y el hecho no se duplican aunque el cierre se repita (T-03).
 */
export class PostgresExecutionRepository implements ExecutionRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async pendingStarts(limit: number): Promise<readonly StartedMission[]> {
    const rows = await this.db
      .selectFrom('mission_facts')
      .select(['fact_id', 'enrollment_id'])
      .where('type', '=', 'MissionEnrollmentStarted')
      .where('processed_at', 'is', null)
      .orderBy('fact_id')
      .limit(limit)
      .execute()

    return rows.map((row) => ({ factId: row.fact_id, enrollmentId: row.enrollment_id }))
  }

  async queue(execution: MissionExecution, factId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('mission_executions')
        .values({ enrollment_id: execution.enrollmentId, ...toChanges(execution) })
        .onConflict((conflict) => conflict.column('enrollment_id').doNothing())
        .execute()
      await trx
        .updateTable('mission_facts')
        .set({ processed_at: execution.nextAttemptAt ?? new Date() })
        .where('fact_id', '=', factId)
        .execute()
    })
  }

  async findById(enrollmentId: string): Promise<MissionExecution | null> {
    const row = await this.db
      .selectFrom('mission_executions')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirst()

    return row === undefined ? null : toExecution(row)
  }

  async due(now: Date, limit: number): Promise<readonly MissionExecution[]> {
    const rows = await this.db
      .selectFrom('mission_executions')
      .selectAll()
      .where('status', 'in', ['QUEUED', 'REQUESTED'])
      .where('next_attempt_at', '<=', now)
      .orderBy('next_attempt_at')
      .limit(limit)
      .execute()

    return rows.map(toExecution)
  }

  async closable(now: Date, limit: number): Promise<readonly MissionExecution[]> {
    const rows = await this.db
      .selectFrom('mission_executions as execution')
      .innerJoin(
        'mission_enrollments as enrollment',
        'enrollment.enrollment_id',
        'execution.enrollment_id',
      )
      .selectAll('execution')
      .where('execution.status', '=', 'SIMULATED')
      // Redundante para el dominio, pero es el predicado del indice parcial
      // `mission_enrollments_vencimiento` (migracion 002): sin el, no se usa.
      .where('enrollment.status', '=', 'IN_PROGRESS')
      .where('enrollment.ends_at', '<=', now)
      .orderBy('enrollment.ends_at')
      .limit(limit)
      .execute()

    return rows.map(toExecution)
  }

  async awaitingRelease(limit: number): Promise<readonly MissionExecution[]> {
    const rows = await this.db
      .selectFrom('mission_executions')
      .selectAll()
      .where('status', 'in', ['SETTLED', 'VOIDED'])
      .where('hero_released_at', 'is', null)
      .orderBy('settled_at')
      .limit(limit)
      .execute()

    return rows.map(toExecution)
  }

  async saveTransition(next: MissionExecution, expectedVersion: number): Promise<boolean> {
    const updated = await this.db
      .updateTable('mission_executions')
      .set(toChanges(next))
      .where('enrollment_id', '=', next.enrollmentId)
      .where('version', '=', expectedVersion)
      .returning('enrollment_id')
      .executeTakeFirst()

    return updated !== undefined
  }

  async close(closure: MissionClosure): Promise<boolean> {
    try {
      await this.db.transaction().execute(async (trx) => {
        const enrollment = await trx
          .updateTable('mission_enrollments')
          .set({
            status: closure.enrollment.status,
            finished_at: closure.enrollment.finishedAt,
            version: closure.enrollment.version,
          })
          .where('enrollment_id', '=', closure.enrollment.enrollmentId)
          .where('version', '=', closure.enrollmentVersion)
          .returning('enrollment_id')
          .executeTakeFirst()

        if (enrollment === undefined) {
          throw new ClosureConflict()
        }

        const execution = await trx
          .updateTable('mission_executions')
          .set(toChanges(closure.execution))
          .where('enrollment_id', '=', closure.execution.enrollmentId)
          .where('version', '=', closure.executionVersion)
          .returning('enrollment_id')
          .executeTakeFirst()

        if (execution === undefined) {
          throw new ClosureConflict()
        }

        if (closure.clear !== null) {
          await trx
            .insertInto('mission_difficulty_clears')
            .values({
              player_id: closure.clear.playerId,
              mission_id: closure.clear.missionId,
              difficulty: closure.clear.difficulty,
              completed_at: closure.clear.completedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(['player_id', 'mission_id', 'difficulty']).doNothing(),
            )
            .execute()
        }

        await trx
          .insertInto('mission_facts')
          .values({
            type: closure.fact.type,
            enrollment_id: closure.fact.enrollmentId,
            payload: JSON.stringify(closure.fact.payload),
            created_at: closure.fact.createdAt,
          })
          .onConflict((conflict) => conflict.columns(['type', 'enrollment_id']).doNothing())
          .execute()

        // HU-74 (P-T1): el reporte nace en la transaccion del cierre.
        if (closure.report !== null) {
          await insertReport(trx, closure.report)
        }

        // HU-73 (P-X7): la evidencia del Master y las entregas pendientes.
        await insertMasterEncounters(trx, closure.masters)
      })

      return true
    } catch (error: unknown) {
      if (error instanceof ClosureConflict) {
        return false
      }

      throw error
    }
  }
}
