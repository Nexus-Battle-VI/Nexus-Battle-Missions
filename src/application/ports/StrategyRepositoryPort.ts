import type { MissionStrategy } from '../../domain/entities/MissionStrategy'

export type SaveStrategyResult =
  | { readonly kind: 'SAVED' }
  | { readonly kind: 'VERSION_CONFLICT'; readonly currentVersion: number | null }

/**
 * Estrategias guardadas (HU-71). `save` aplica el bloqueo optimista en la misma
 * escritura: con `expectedVersion` `null` solo crea la primera; con un numero
 * solo reemplaza esa version. Cualquier otro caso es `VERSION_CONFLICT`, con la
 * version que hay ahora (`null` si no hay ninguna).
 */
export interface StrategyRepositoryPort {
  find(playerId: string, heroId: string, missionId: string): Promise<MissionStrategy | null>
  save(strategy: MissionStrategy, expectedVersion: number | null): Promise<SaveStrategyResult>
}

export const STRATEGY_REPOSITORY = Symbol('StrategyRepositoryPort')
