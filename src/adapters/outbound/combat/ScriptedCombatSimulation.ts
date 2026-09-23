import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../../application/ports/CombatSimulationPort'
import type { SimulationRequest } from '../../../domain/entities/MissionExecution'

/**
 * Doble de desarrollo de Combat (`COMBAT_SIMULATION_DRIVER=memory`). Devuelve un
 * resultado FIJO: el heroe vence todos los encuentros sin recibir dano. No
 * simula ni genera aleatoriedad, asi que no acredita CA-02 ni CA-03, como
 * advierte el diseno de HU-72. Prohibido en produccion.
 */
export class ScriptedCombatSimulation implements CombatSimulationPort {
  simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    const defeated = new Map<string, number>()

    for (const encounter of request.encounters) {
      for (const enemy of encounter.enemies) {
        defeated.set(enemy.enemyRef, (defeated.get(enemy.enemyRef) ?? 0) + enemy.count)
      }
    }

    const total = request.encounters.length
    const events = [
      ...request.encounters.flatMap((encounter) => [
        { type: 'encounterStarted', encounter: encounter.index },
        { type: 'encounterFinished', encounter: encounter.index },
      ]),
      { type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' },
    ]

    return Promise.resolve({
      kind: 'SIMULATED',
      result: {
        simulationId: `sim_${request.operationId}`,
        seedRef: null,
        combatOutcome: 'HERO_VICTORIOUS',
        summary: {
          encountersCompleted: total,
          encountersTotal: total,
          totalTurns: 0,
          damageDealt: 0,
          damageTaken: 0,
          minHealthPercent: 100,
          skillsUsed: [],
          criticalEffects: 0,
          enemiesDefeated: [...defeated].map(([enemyRef, count]) => ({ enemyRef, count })),
          bossDefeated: request.encounters.some((encounter) => encounter.kind === 'BOSS'),
          master: { appeared: false, masterRef: null, defeated: false },
          simulatedDuration: request.timeBudget,
        },
        combatLog: events.map((event, index) => ({ seq: index + 1, ...event })),
      },
    })
  }
}
