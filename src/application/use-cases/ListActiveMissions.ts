import { isActiveEnrollment, type EnrollmentStatus } from '../../domain/entities/MissionEnrollment'
import {
  heroOfRequest,
  progressPercentOf,
  remainingSecondsOf,
} from '../../domain/policies/ProgressPolicy'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'
import type { MissionCategory } from '../../domain/value-objects/mission-category'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ExecutionRepositoryPort } from '../ports/ExecutionRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface ActiveMissionView {
  readonly enrollmentId: string
  readonly missionId: string
  readonly missionName: string
  readonly category: MissionCategory | null
  readonly imageRef: string | null
  readonly heroId: string
  /** El nombre enviado a Combat; `null` mientras la mision no se haya simulado. */
  readonly heroName: string | null
  readonly difficulty: DifficultyLevel
  readonly status: EnrollmentStatus
  readonly startedAt: string | null
  readonly endsAt: string | null
  /** Del 0 al 100, calculado por el servidor. */
  readonly progressPercent: number
  /** Segundos que faltan segun el reloj del servidor; `null` si aun no empezo. */
  readonly remainingSeconds: number | null
}

export interface ActiveMissionsView {
  /** La hora del servidor, para que el cliente cuente sin fiarse de su reloj. */
  readonly serverTime: string
  readonly items: readonly ActiveMissionView[]
}

const byEnd = (item: ActiveMissionView): string => item.endsAt ?? '9999'

/**
 * `GET /api/v1/missions/me/active` (diseno «misiones jugables», P-J6; curso 7.8.9,
 * «Panel de misiones activas»): las misiones en curso del jugador, con su progreso
 * y el tiempo que falta, las que terminan antes primero.
 */
export class ListActiveMissions {
  constructor(
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly catalog: MissionCatalogPort,
    private readonly executions: ExecutionRepositoryPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(playerId: string): Promise<ActiveMissionsView> {
    const now = this.clock.now()
    const active = (await this.enrollments.listByPlayer(playerId)).filter((enrollment) =>
      isActiveEnrollment(enrollment.status),
    )

    const items = await Promise.all(
      active.map(async (enrollment): Promise<ActiveMissionView> => {
        const [definition, execution] = await Promise.all([
          this.catalog.findById(enrollment.missionId),
          this.executions.findById(enrollment.enrollmentId),
        ])
        const { startedAt, endsAt } = enrollment

        return {
          enrollmentId: enrollment.enrollmentId,
          missionId: enrollment.missionId,
          missionName: definition?.name ?? enrollment.missionId,
          category: definition?.category ?? null,
          imageRef: definition?.imageRef ?? null,
          heroId: enrollment.heroId,
          heroName: heroOfRequest(execution?.request ?? null).name,
          difficulty: enrollment.difficulty,
          status: enrollment.status,
          startedAt: startedAt?.toISOString() ?? null,
          endsAt: endsAt?.toISOString() ?? null,
          progressPercent:
            startedAt === null || endsAt === null ? 0 : progressPercentOf(startedAt, endsAt, now),
          remainingSeconds: endsAt === null ? null : remainingSecondsOf(endsAt, now),
        }
      }),
    )

    return {
      serverTime: now.toISOString(),
      items: [...items].sort((a, b) => byEnd(a).localeCompare(byEnd(b))),
    }
  }
}

export const LIST_ACTIVE_MISSIONS = Symbol('ListActiveMissions')
