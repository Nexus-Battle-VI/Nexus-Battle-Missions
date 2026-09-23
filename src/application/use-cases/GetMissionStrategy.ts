import type { MissionStrategy } from '../../domain/entities/MissionStrategy'
import { MissionNotFoundError } from '../../domain/errors/mission-errors'
import { StrategyNotFoundError } from '../../domain/errors/strategy-errors'
import type { Rotation } from '../../domain/value-objects/rotation'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { StrategyRepositoryPort } from '../ports/StrategyRepositoryPort'

export interface StrategyView {
  readonly missionId: string
  readonly heroId: string
  readonly version: number
  readonly rotations: readonly Rotation[]
  readonly updatedAt: string
}

export const toStrategyView = (strategy: MissionStrategy): StrategyView => ({
  missionId: strategy.missionId,
  heroId: strategy.heroId,
  version: strategy.version,
  rotations: strategy.rotations,
  updatedAt: strategy.updatedAt.toISOString(),
})

/**
 * `GET /api/v1/missions/{missionId}/strategies/{heroId}` (Task HU-71.2, CU-71.2).
 * El jugador sale del testimonio: solo ve sus propias estrategias.
 */
export class GetMissionStrategy {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly strategies: StrategyRepositoryPort,
  ) {}

  async execute(playerId: string, missionId: string, heroId: string): Promise<StrategyView> {
    if ((await this.catalog.findActive(missionId)) === null) {
      throw new MissionNotFoundError(missionId)
    }

    const strategy = await this.strategies.find(playerId, heroId, missionId)

    if (strategy === null) {
      throw new StrategyNotFoundError(missionId, heroId)
    }

    return toStrategyView(strategy)
  }
}

export const GET_MISSION_STRATEGY = Symbol('GetMissionStrategy')
