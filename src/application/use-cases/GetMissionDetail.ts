import type {
  MasterCandidate,
  MissionEnemy,
  MissionObjective,
  MissionRewards,
} from '../../domain/entities/MissionDefinition'
import { MissionNotFoundError } from '../../domain/errors/mission-errors'
import { derivePlayerMissionStatus } from '../../domain/policies/EnrollmentPolicy'
import { isRecord } from '../../domain/policies/SettlementPolicy'
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
  /** Sin `rule`: como se evalua es interno del cierre de HU-72. */
  readonly objectives: readonly Omit<MissionObjective, 'rule'>[]
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
    /**
     * La mayor probabilidad configurada. La que aplica depende del subtipo del
     * heroe que se matricule (HU-73, P-X2): el detalle aun no lo conoce.
     */
    readonly probability: number
    readonly candidates: readonly {
      readonly name: string
      readonly heroType: string
      /** Por subtipo del heroe; `"*"` vale para cualquiera (HU-73). */
      readonly probabilityByHeroType: Readonly<Record<string, number>>
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

/** Las probabilidades del candidato; un contenido sin ellas no rompe el detalle. */
const probabilitiesOf = (candidate: MasterCandidate): Readonly<Record<string, number>> => {
  const table: unknown = candidate.probabilityByHeroType

  return isRecord(table)
    ? Object.fromEntries(
        Object.entries(table).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      )
    : {}
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
      objectives: definition.objectives.map(({ id, text, primary }) => ({ id, text, primary })),
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
        probability: Math.max(
          0,
          ...(master?.candidates ?? []).flatMap((candidate) =>
            Object.values(probabilitiesOf(candidate)),
          ),
        ),
        candidates: (master?.candidates ?? []).map((candidate) => ({
          name: candidate.name,
          heroType: candidate.subtype,
          probabilityByHeroType: probabilitiesOf(candidate),
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
