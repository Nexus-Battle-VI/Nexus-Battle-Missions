import type {
  MissionEnemy,
  MissionObjective,
  MissionRewards,
} from '../../domain/entities/MissionDefinition'
import { MissionNotFoundError } from '../../domain/errors/mission-errors'
import { derivePlayerMissionStatus } from '../../domain/policies/EnrollmentPolicy'
import {
  toIsoDuration,
  type MissionCategory,
  type PlayerMissionStatus,
} from '../../domain/value-objects/mission-category'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import { namesOf, playerContextFor } from './ListMissionBoard'

export interface MissionDetailView {
  readonly missionId: string
  readonly name: string
  readonly category: MissionCategory
  readonly narrative: string
  readonly objectives: readonly MissionObjective[]
  readonly estimatedDuration: string
  readonly recommendedPower: number | null
  readonly prerequisites: readonly string[]
  /** Sin `enemyRef`: es la referencia interna que HU-72 envia a Combat. */
  readonly enemies: readonly Omit<MissionEnemy, 'enemyRef'>[]
  readonly finalBoss: {
    readonly name: string
    readonly heroType: string | null
    readonly description: string | null
    readonly stats: Readonly<Record<string, number>>
  }
  readonly masterEncounter: {
    readonly probability: number
    readonly candidates: readonly {
      readonly name: string
      readonly heroType: string
      readonly epic: {
        readonly name: string
        readonly generalEffect: string | null
        readonly epicEffect: string | null
      }
    }[]
  }
  readonly rewards: MissionRewards
  readonly playerStatus: PlayerMissionStatus
  readonly canEnroll: boolean
  readonly lockReason: string | null
}

/**
 * `GET /api/v1/missions/{missionId}` (Task HU-70.2, CA-06): todo lo que el
 * jugador revisa antes de confirmar. Una mision sin Master configurado muestra
 * probabilidad 0 y ningun candidato.
 */
export class GetMissionDetail {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly clears: DifficultyClearRepositoryPort,
  ) {}

  async execute(playerId: string, missionId: string): Promise<MissionDetailView> {
    const definition = await this.catalog.findActive(missionId)

    if (definition === null) {
      throw new MissionNotFoundError(missionId)
    }

    const [definitions, enrollments, completed] = await Promise.all([
      this.catalog.listActive(),
      this.enrollments.listByPlayer(playerId),
      this.clears.completedMissions(playerId),
    ])
    const view = derivePlayerMissionStatus(
      definition,
      playerContextFor(missionId, enrollments, completed, namesOf(definitions)),
    )
    const master = definition.masterEncounter

    return {
      missionId: definition.missionId,
      name: definition.name,
      category: definition.category,
      narrative: definition.narrative,
      objectives: definition.objectives,
      estimatedDuration: toIsoDuration(definition.estimatedDurationMinutes),
      recommendedPower: definition.recommendedPower,
      prerequisites: definition.prerequisites,
      enemies: definition.enemies.map(({ name, count, description }) => ({
        name,
        count,
        description,
      })),
      finalBoss: {
        name: definition.finalBoss.name,
        heroType: definition.finalBoss.heroType,
        description: definition.finalBoss.description,
        stats: definition.finalBoss.stats,
      },
      masterEncounter: {
        probability: master?.probability ?? 0,
        candidates: (master?.candidates ?? []).map((candidate) => ({
          name: candidate.name,
          heroType: candidate.heroType,
          epic: {
            name: candidate.epic.name,
            generalEffect: candidate.epic.generalEffect,
            epicEffect: candidate.epic.epicEffect,
          },
        })),
      },
      rewards: definition.rewards,
      playerStatus: view.status,
      canEnroll: view.canEnroll,
      lockReason: view.lockReason,
    }
  }
}

export const GET_MISSION_DETAIL = Symbol('GetMissionDetail')
