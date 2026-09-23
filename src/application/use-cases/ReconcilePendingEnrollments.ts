import { expireEnrollment, type MissionEnrollment } from '../../domain/entities/MissionEnrollment'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { HeroCommitmentPort } from '../ports/HeroCommitmentPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import { applyCommitOutcome, commitmentRequestFor, PENDING_DEADLINE_MS } from './EnrollInMission'

export interface ReconcileOptions {
  /** No toca matriculas mas nuevas: su peticion puede estar resolviendolas ahora. */
  readonly retryAfterMs: number
  /** Pasado este plazo sin confirmacion, se libera y se marca `EXPIRED` (P-M8). */
  readonly deadlineMs: number
  readonly batchSize: number
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  retryAfterMs: 10_000,
  deadlineMs: PENDING_DEADLINE_MS,
  batchSize: 50,
}

export interface ReconcileSummary {
  readonly confirmed: number
  readonly rejected: number
  readonly expired: number
  readonly stillPending: number
  readonly failed: number
}

/**
 * Reconciliador de matriculas `PENDING` (diseno de HU-70, «Secuencia», paso 4).
 *
 * Reintenta la reserva con el MISMO `operationId`: si Player/Inventory ya la
 * habia concedido, devuelve el mismo compromiso y la matricula termina
 * `IN_PROGRESS` sin reservar dos veces. Si vence el plazo, libera (idempotente) y
 * marca `EXPIRED`. Nunca marca `EXPIRED` sin una liberacion confirmada: el heroe
 * no puede quedar comprometido sin matricula.
 */
export class ReconcilePendingEnrollments {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly commitments: HeroCommitmentPort,
    private readonly clock: ClockPort,
    private readonly options: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
  ) {}

  async execute(): Promise<ReconcileSummary> {
    const now = this.clock.now()
    const pending = await this.enrollments.listPendingRequestedBefore(
      new Date(now.getTime() - this.options.retryAfterMs),
      this.options.batchSize,
    )
    const summary = { confirmed: 0, rejected: 0, expired: 0, stillPending: 0, failed: 0 }

    for (const enrollment of pending) {
      try {
        summary[await this.reconcile(enrollment, now)] += 1
      } catch {
        // Una matricula que falla no detiene a las demas; queda PENDING y el
        // siguiente ciclo la vuelve a intentar.
        summary.failed += 1
      }
    }

    return summary
  }

  private async reconcile(
    enrollment: MissionEnrollment,
    now: Date,
  ): Promise<'confirmed' | 'rejected' | 'expired' | 'stillPending'> {
    const definition = await this.catalog.findById(enrollment.missionId)

    if (definition !== null) {
      const outcome = await this.commitments.commit(
        commitmentRequestFor(enrollment, definition.estimatedDurationMinutes),
      )
      const applied = await applyCommitOutcome(
        this.enrollments,
        now,
        enrollment,
        outcome,
        definition.estimatedDurationMinutes,
      )

      if (applied.kind === 'CONFIRMED') {
        return 'confirmed'
      }

      if (applied.kind === 'REJECTED') {
        return 'rejected'
      }

      if (applied.kind === 'RACE') {
        return 'stillPending'
      }
    }

    // Sin respuesta, o con la mision borrada del catalogo (no hay duracion con
    // la que confirmar): solo se compensa al vencer el plazo.
    if (now.getTime() - enrollment.requestedAt.getTime() < this.options.deadlineMs) {
      return 'stillPending'
    }

    if ((await this.commitments.release(enrollment.operationId)) !== 'RELEASED') {
      return 'stillPending'
    }

    const saved = await this.enrollments.saveTransition(
      expireEnrollment(enrollment, now),
      enrollment.version,
      null,
    )

    return saved ? 'expired' : 'stillPending'
  }
}

export const RECONCILE_PENDING_ENROLLMENTS = Symbol('ReconcilePendingEnrollments')
