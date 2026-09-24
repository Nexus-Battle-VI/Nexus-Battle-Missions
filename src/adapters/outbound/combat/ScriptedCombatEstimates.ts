import type {
  EstimateCallOutcome,
  MissionEstimatePort,
} from '../../../application/ports/MissionEstimatePort'
import type { SimulationRequest } from '../../../domain/entities/MissionExecution'
import { isRecord } from '../../../domain/policies/SettlementPolicy'

/**
 * Doble de desarrollo de la estimacion (`COMBAT_SIMULATION_DRIVER=memory`). Es
 * coherente con `ScriptedCombatSimulation`, que siempre gana sin recibir dano:
 * todas las corridas son victorias y toda habilidad se da por usable. No estima
 * nada; solo deja recorrer la pantalla en desarrollo. Prohibido en produccion.
 */
export class ScriptedCombatEstimates implements MissionEstimatePort {
  estimate(request: SimulationRequest, runs: number): Promise<EstimateCallOutcome> {
    const abilities = Array.isArray(request.hero.profile.abilities)
      ? (request.hero.profile.abilities as unknown[]).filter(isRecord)
      : []

    return Promise.resolve({
      kind: 'ESTIMATED',
      estimate: {
        runs,
        victories: runs,
        defeats: 0,
        timeouts: 0,
        winRate: 1,
        averageTurns: request.encounters.length,
        averageDamageTaken: 0,
        averageMinHealthPercent: 100,
        masterAppearanceRate: 0,
        abilities: abilities.map((ability) => ({
          abilityId: String(ability.abilityId),
          name: typeof ability.name === 'string' ? ability.name : String(ability.abilityId),
          usable: true,
          reason: null,
        })),
      },
    })
  }
}
