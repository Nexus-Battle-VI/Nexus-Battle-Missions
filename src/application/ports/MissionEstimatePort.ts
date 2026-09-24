import type { SimulationRequest } from '../../domain/entities/MissionExecution'

/** Si una habilidad del heroe sirve en misiones, y por que no (P-J4). */
export interface EstimatedAbility {
  readonly abilityId: string
  readonly name: string
  readonly usable: boolean
  readonly reason: string | null
}

/**
 * Lo que Combat responde a `POST /api/internal/v1/combat/simulations/estimates`
 * (diseno «misiones jugables», P-J7). Las tasas van entre 0 y 1.
 */
export interface CombatEstimate {
  readonly runs: number
  readonly victories: number
  readonly defeats: number
  readonly timeouts: number
  readonly winRate: number
  readonly averageTurns: number
  readonly averageDamageTaken: number
  readonly averageMinHealthPercent: number
  readonly masterAppearanceRate: number
  readonly abilities: readonly EstimatedAbility[]
}

/**
 * Una estimacion no decide nada ni se guarda: si Combat no responde, o rechaza el
 * contenido, el jugador simplemente no ve la probabilidad y puede matricular igual.
 */
export type EstimateCallOutcome =
  | { readonly kind: 'ESTIMATED'; readonly estimate: CombatEstimate }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string }

export interface MissionEstimatePort {
  estimate(request: SimulationRequest, runs: number): Promise<EstimateCallOutcome>
}

export const MISSION_ESTIMATES = Symbol('MissionEstimatePort')
