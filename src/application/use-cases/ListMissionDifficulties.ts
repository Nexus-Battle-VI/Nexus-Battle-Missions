import { evaluateAllDifficulties } from '../../domain/policies/DifficultyPolicy'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'
import { scalingOf, type RewardTier } from '../../domain/value-objects/difficulty-scaling'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface MissionDifficultyView {
  readonly difficulty: DifficultyLevel
  readonly unlocked: boolean
  readonly lockReason: string | null
  readonly enemyStatMultiplier: number | null
  readonly rewardTier: RewardTier
}

export interface MissionDifficultiesView {
  readonly missionId: string
  readonly items: readonly MissionDifficultyView[]
}

/**
 * `GET /api/v1/missions/{missionId}/difficulties` (Task HU-75.2, contrato
 * hu-75-mission-difficulty-v1).
 *
 * El jugador lo fija quien invoca, a partir de la identidad verificada: este
 * caso de uso nunca lo recibe del cliente.
 *
 * Pendiente con HU-70: no comprueba que la mision exista, porque el tablon no
 * esta implementado. Para un identificador desconocido responde lo mismo que
 * para una mision sin progreso.
 */
export class ListMissionDifficulties {
  constructor(
    private readonly clears: DifficultyClearRepositoryPort,
    private readonly catalog?: MissionCatalogPort,
  ) {}

  async execute(playerId: string, missionId: string): Promise<MissionDifficultiesView> {
    const [cleared, definition] = await Promise.all([
      this.clears.clearedLevels(playerId, missionId),
      this.catalog?.findById(missionId),
    ])

    return {
      missionId,
      items: evaluateAllDifficulties(cleared).map((availability) => {
        const scaling = scalingOf(availability.difficulty)

        return {
          difficulty: availability.difficulty,
          unlocked: availability.unlocked,
          lockReason: availability.lockReason,
          enemyStatMultiplier:
            definition?.combatRules?.difficultyMultipliers?.[availability.difficulty] ??
            scaling.enemyStatMultiplier,
          rewardTier: scaling.rewardTier,
        }
      }),
    }
  }
}

export const LIST_MISSION_DIFFICULTIES = Symbol('ListMissionDifficulties')
