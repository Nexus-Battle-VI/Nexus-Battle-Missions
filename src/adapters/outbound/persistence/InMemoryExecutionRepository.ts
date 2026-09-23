import type {
  ExecutionRepositoryPort,
  MissionClosure,
  StartedMission,
} from '../../../application/ports/ExecutionRepositoryPort'
import type { MissionExecution } from '../../../domain/entities/MissionExecution'
import type { InMemoryDifficultyClearRepository } from './InMemoryDifficultyClearRepository'
import type { InMemoryEnrollmentRepository } from './InMemoryEnrollmentRepository'
import { InMemoryMasterEncounterRepository } from './InMemoryMasterEncounterRepository'
import type { InMemoryReportRepository } from './InMemoryReportRepository'

const byTime = (date: Date | null): number => date?.getTime() ?? Number.MAX_SAFE_INTEGER

/**
 * Doble de desarrollo y pruebas de `mission_executions` (HU-72). Comparte estado
 * con los dobles de matriculas, clears, reportes y evidencia del Master porque el
 * cierre los escribe a la vez: `close` comprueba las dos versiones antes de escribir nada y despues
 * aplica todo sin esperas, que es el equivalente en memoria de la transaccion.
 */
export class InMemoryExecutionRepository implements ExecutionRepositoryPort {
  private readonly executions = new Map<string, MissionExecution>()

  constructor(
    private readonly enrollments: InMemoryEnrollmentRepository,
    private readonly clears: InMemoryDifficultyClearRepository,
    private readonly reports: InMemoryReportRepository,
    private readonly masters: InMemoryMasterEncounterRepository = new InMemoryMasterEncounterRepository(
      reports,
    ),
  ) {}

  pendingStarts(limit: number): Promise<readonly StartedMission[]> {
    return Promise.resolve(this.enrollments.pendingStartFacts(limit))
  }

  queue(execution: MissionExecution, factId: string): Promise<void> {
    if (!this.executions.has(execution.enrollmentId)) {
      this.executions.set(execution.enrollmentId, execution)
    }

    this.enrollments.markFactProcessed(factId, execution.nextAttemptAt ?? new Date())

    return Promise.resolve()
  }

  findById(enrollmentId: string): Promise<MissionExecution | null> {
    return Promise.resolve(this.executions.get(enrollmentId) ?? null)
  }

  due(now: Date, limit: number): Promise<readonly MissionExecution[]> {
    return Promise.resolve(
      this.all()
        .filter(
          (execution) =>
            (execution.status === 'QUEUED' || execution.status === 'REQUESTED') &&
            byTime(execution.nextAttemptAt) <= now.getTime(),
        )
        .sort((a, b) => byTime(a.nextAttemptAt) - byTime(b.nextAttemptAt))
        .slice(0, limit),
    )
  }

  closable(now: Date, limit: number): Promise<readonly MissionExecution[]> {
    return Promise.resolve(
      this.all()
        .filter((execution) => {
          const enrollment = this.enrollments.current(execution.enrollmentId)

          return (
            execution.status === 'SIMULATED' &&
            enrollment?.status === 'IN_PROGRESS' &&
            byTime(enrollment.endsAt) <= now.getTime()
          )
        })
        .slice(0, limit),
    )
  }

  awaitingRelease(limit: number): Promise<readonly MissionExecution[]> {
    return Promise.resolve(
      this.all()
        .filter(
          (execution) =>
            (execution.status === 'SETTLED' || execution.status === 'VOIDED') &&
            execution.heroReleasedAt === null,
        )
        .slice(0, limit),
    )
  }

  saveTransition(next: MissionExecution, expectedVersion: number): Promise<boolean> {
    if (this.executions.get(next.enrollmentId)?.version !== expectedVersion) {
      return Promise.resolve(false)
    }

    this.executions.set(next.enrollmentId, next)

    return Promise.resolve(true)
  }

  close(closure: MissionClosure): Promise<boolean> {
    const executionId = closure.execution.enrollmentId

    if (
      this.executions.get(executionId)?.version !== closure.executionVersion ||
      this.enrollments.current(closure.enrollment.enrollmentId)?.version !==
        closure.enrollmentVersion
    ) {
      return Promise.resolve(false)
    }

    this.enrollments.applyTransition(closure.enrollment, closure.enrollmentVersion, closure.fact)
    this.executions.set(executionId, closure.execution)

    if (closure.clear !== null) {
      this.clears.recordNow(closure.clear)
    }

    if (closure.report !== null) {
      this.reports.recordNow(closure.report)
    }

    this.masters.recordNow(closure.masters)

    return Promise.resolve(true)
  }

  private all(): MissionExecution[] {
    return [...this.executions.values()]
  }
}
