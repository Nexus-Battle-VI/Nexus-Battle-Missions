import type { MissionDefinition, RewardLabel } from '../../domain/entities/MissionDefinition'
import {
  FINISHED_MISSION_STATUSES,
  isActiveEnrollment,
  type EnrollmentStatus,
  type MissionEnrollment,
} from '../../domain/entities/MissionEnrollment'
import {
  derivePlayerMissionStatus,
  type PlayerMissionContext,
  type PlayerMissionView,
} from '../../domain/policies/EnrollmentPolicy'
import {
  toIsoDuration,
  type MissionCategory,
  type PlayerMissionStatus,
} from '../../domain/value-objects/mission-category'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface MissionCardView {
  readonly missionId: string
  readonly name: string
  readonly category: MissionCategory
  readonly summary: string
  readonly imageRef: string | null
  readonly estimatedDuration: string
  readonly recommendedPower: number | null
  readonly highlightedRewards: readonly RewardLabel[]
  readonly playerStatus: PlayerMissionStatus
  readonly canEnroll: boolean
  readonly lockReason: string | null
  readonly activeEnrollmentId: string | null
}

export interface MissionBoardFilters {
  readonly category: MissionCategory | null
  readonly status: PlayerMissionStatus | null
}

/** Lo que el jugador ya hizo con UNA mision: matricula activa y ultimo resultado. */
export const playerContextFor = (
  missionId: string,
  enrollments: readonly MissionEnrollment[],
  completedMissionIds: ReadonlySet<string>,
  missionNames: ReadonlyMap<string, string>,
): PlayerMissionContext => {
  let activeEnrollmentId: string | null = null
  let lastFinishedStatus: EnrollmentStatus | null = null
  let lastFinishedAt = Number.NEGATIVE_INFINITY

  for (const enrollment of enrollments) {
    if (enrollment.missionId !== missionId) {
      continue
    }

    if (isActiveEnrollment(enrollment.status)) {
      activeEnrollmentId = enrollment.enrollmentId
      continue
    }

    // `REJECTED` y `EXPIRED` no son resultados de la mision: no cuentan.
    const finishedAt = enrollment.finishedAt?.getTime()

    if (
      FINISHED_MISSION_STATUSES.includes(enrollment.status) &&
      finishedAt !== undefined &&
      finishedAt > lastFinishedAt
    ) {
      lastFinishedAt = finishedAt
      lastFinishedStatus = enrollment.status
    }
  }

  return { completedMissionIds, missionNames, activeEnrollmentId, lastFinishedStatus }
}

export const namesOf = (definitions: readonly MissionDefinition[]): ReadonlyMap<string, string> =>
  new Map(definitions.map((definition) => [definition.missionId, definition.name]))

const toCard = (definition: MissionDefinition, view: PlayerMissionView): MissionCardView => ({
  missionId: definition.missionId,
  name: definition.name,
  category: definition.category,
  summary: definition.summary,
  imageRef: definition.imageRef,
  estimatedDuration: toIsoDuration(definition.estimatedDurationMinutes),
  recommendedPower: definition.recommendedPower,
  highlightedRewards: definition.highlightedRewards,
  playerStatus: view.status,
  canEnroll: view.canEnroll,
  lockReason: view.lockReason,
  activeEnrollmentId: view.activeEnrollmentId,
})

/**
 * `GET /api/v1/missions` (Task HU-70.2, contrato hu-70-mission-enrollment-v1).
 *
 * El jugador lo fija quien invoca, a partir de la identidad verificada. El
 * estado de cada tarjeta se deriva para ESE jugador: la definicion de la mision
 * no tiene estado propio.
 */
export class ListMissionBoard {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly clears: DifficultyClearRepositoryPort,
  ) {}

  async execute(
    playerId: string,
    filters: MissionBoardFilters,
  ): Promise<{ readonly items: readonly MissionCardView[] }> {
    const [definitions, enrollments, completed] = await Promise.all([
      this.catalog.listActive(),
      this.enrollments.listByPlayer(playerId),
      this.clears.completedMissions(playerId),
    ])
    const names = namesOf(definitions)

    const items = definitions
      .filter((definition) => filters.category === null || definition.category === filters.category)
      .map((definition) =>
        toCard(
          definition,
          derivePlayerMissionStatus(
            definition,
            playerContextFor(definition.missionId, enrollments, completed, names),
          ),
        ),
      )
      .filter((card) => filters.status === null || card.playerStatus === filters.status)

    return { items }
  }
}

export const LIST_MISSION_BOARD = Symbol('ListMissionBoard')
