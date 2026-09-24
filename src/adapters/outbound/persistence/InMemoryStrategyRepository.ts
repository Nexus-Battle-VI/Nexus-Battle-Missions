import type {
  SaveStrategyResult,
  StrategyRepositoryPort,
} from '../../../application/ports/StrategyRepositoryPort'
import type { MissionStrategy } from '../../../domain/entities/MissionStrategy'

const keyOf = (playerId: string, heroId: string, missionId: string): string =>
  JSON.stringify([playerId, heroId, missionId])

/**
 * Doble en memoria de `mission_strategies` (HU-71) para desarrollo y pruebas.
 * Reproduce el bloqueo optimista del motor: solo guarda sobre la version
 * esperada, y `null` solo crea.
 */
export class InMemoryStrategyRepository implements StrategyRepositoryPort {
  private readonly strategies = new Map<string, MissionStrategy>()

  find(playerId: string, heroId: string, missionId: string): Promise<MissionStrategy | null> {
    return Promise.resolve(this.strategies.get(keyOf(playerId, heroId, missionId)) ?? null)
  }

  save(strategy: MissionStrategy, expectedVersion: number | null): Promise<SaveStrategyResult> {
    const key = keyOf(strategy.playerId, strategy.heroId, strategy.missionId)
    const currentVersion = this.strategies.get(key)?.version ?? null

    if (currentVersion !== expectedVersion) {
      return Promise.resolve({ kind: 'VERSION_CONFLICT', currentVersion })
    }

    this.strategies.set(key, strategy)

    return Promise.resolve({ kind: 'SAVED' })
  }
}
