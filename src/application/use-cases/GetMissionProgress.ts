import { isActiveEnrollment, type EnrollmentStatus } from '../../domain/entities/MissionEnrollment'
import { EnrollmentNotFoundError } from '../../domain/errors/mission-errors'
import {
  heroOfRequest,
  progressNamesOf,
  progressPercentOf,
  remainingSecondsOf,
  revealedProgressOf,
  type ProgressEntry,
} from '../../domain/policies/ProgressPolicy'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ExecutionRepositoryPort } from '../ports/ExecutionRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface MissionProgressView {
  readonly enrollmentId: string
  readonly missionId: string
  readonly missionName: string
  readonly difficulty: DifficultyLevel
  readonly status: EnrollmentStatus
  readonly startedAt: string | null
  readonly endsAt: string | null
  readonly serverTime: string
  readonly progressPercent: number
  readonly remainingSeconds: number | null
  /** Si Combat ya simulo la mision; antes no hay bitacora que mostrar. */
  readonly simulated: boolean
  /** Si ya termino: se ve la bitacora entera y el desenlace. */
  readonly finished: boolean
  /** Si ya hay reporte que abrir (terminada con exito, fallida o abandonada). */
  readonly reportAvailable: boolean
  readonly hero: {
    readonly heroId: string
    readonly name: string | null
    readonly maxHealth: number | null
    /** La vida del heroe en lo ultimo que se ve; `null` si aun no hay golpes. */
    readonly health: number | null
  }
  /** Solo lo revelado y posterior a `after`. */
  readonly entries: readonly ProgressEntry[]
  /** La ultima entrada revelada: el `after` de la proxima consulta. */
  readonly lastSeq: number
  /** Cuando se revela lo siguiente; `null` si ya se ve todo. */
  readonly nextRevealAt: string | null
}

const REPORTED = new Set<EnrollmentStatus>(['COMPLETED', 'FAILED', 'ABANDONED'])

/**
 * `GET /api/v1/missions/me/progress/{enrollmentId}` (diseno «misiones jugables»,
 * P-J6): lo que el jugador ya puede ver de su mision. Solo el dueno la ve; para
 * los demas no existe (404), como el reporte de HU-74 (P-T8).
 */
export class GetMissionProgress {
  constructor(
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly executions: ExecutionRepositoryPort,
    private readonly catalog: MissionCatalogPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(playerId: string, enrollmentId: string, after = 0): Promise<MissionProgressView> {
    const enrollment = await this.enrollments.findById(enrollmentId)

    if (enrollment?.playerId !== playerId) {
      throw new EnrollmentNotFoundError(enrollmentId)
    }

    const now = this.clock.now()
    const execution = await this.executions.findById(enrollmentId)
    const request = execution?.request ?? null
    const definition =
      request?.contentSnapshot ?? (await this.catalog.findById(enrollment.missionId))
    const log = execution?.result?.combatLog ?? []
    const finished = !isActiveEnrollment(enrollment.status)
    const { startedAt, endsAt } = enrollment
    const revealed =
      startedAt === null || endsAt === null
        ? { entries: [], total: 0, nextRevealAt: null }
        : revealedProgressOf({
            log,
            startedAt,
            endsAt,
            now,
            finished,
            after: 0,
            names: progressNamesOf(request, definition),
          })
    const withHealth = revealed.entries.filter((entry) => entry.heroHealth !== undefined)
    const hero = heroOfRequest(request)

    return {
      enrollmentId,
      missionId: enrollment.missionId,
      missionName: definition?.name ?? enrollment.missionId,
      difficulty: enrollment.difficulty,
      status: enrollment.status,
      startedAt: startedAt?.toISOString() ?? null,
      endsAt: endsAt?.toISOString() ?? null,
      serverTime: now.toISOString(),
      progressPercent:
        startedAt === null || endsAt === null
          ? finished
            ? 100
            : 0
          : finished
            ? 100
            : progressPercentOf(startedAt, endsAt, now),
      remainingSeconds: endsAt === null || finished ? null : remainingSecondsOf(endsAt, now),
      simulated: (execution?.result ?? null) !== null,
      finished,
      reportAvailable: REPORTED.has(enrollment.status),
      hero: {
        heroId: enrollment.heroId,
        name: hero.name,
        maxHealth: hero.maxHealth,
        health: withHealth.at(-1)?.heroHealth ?? null,
      },
      entries: revealed.entries.filter((entry) => entry.seq > after),
      lastSeq: revealed.entries.at(-1)?.seq ?? 0,
      nextRevealAt: revealed.nextRevealAt?.toISOString() ?? null,
    }
  }
}

export const GET_MISSION_PROGRESS = Symbol('GetMissionProgress')
