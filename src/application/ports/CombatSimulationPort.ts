import type { SimulationRequest, SimulationResult } from '../../domain/entities/MissionExecution'

/**
 * Simulacion en Combat (HU-72, contrato hu-72-mission-simulation-v1). Solo el
 * `200` y los rechazos con codigo son definitivos; lo demas es un resultado
 * desconocido y se reintenta con el mismo `operationId` (P-S3).
 */
export type SimulationCallOutcome =
  | { readonly kind: 'SIMULATED'; readonly result: SimulationResult }
  /** `422`, o `400`/`409` (error de programacion): la mision se anula (P-S7). */
  | { readonly kind: 'REJECTED'; readonly code: string }
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface CombatSimulationPort {
  simulate(request: SimulationRequest): Promise<SimulationCallOutcome>
}

export const COMBAT_SIMULATION = Symbol('CombatSimulationPort')
