import type {
  ExperienceCreditOutcome,
  ExperienceCreditPort,
  ExperienceCreditRequest,
} from '../../../application/ports/ExperienceCreditPort'

/**
 * Doble de desarrollo de Player/Inventory para la acreditacion de experiencia
 * (`EXPERIENCE_REWARDS_DRIVER=memory`).
 *
 * Acumula por (jugador, heroe) y es idempotente por `operationId`, como el real:
 * repetir la misma acreditacion no suma dos veces. No recalcula niveles ni
 * conoce la tabla de HU-08 -- eso es de Player/Inventory --, asi que solo lleva
 * el acumulado y el numero de acreditaciones aplicadas.
 *
 * POR ESO NO DEVUELVE PROGRESION (Task HU-09.5). Inventar un nivel aqui seria
 * duplicar la tabla de HU-08 en el doble y, peor, hacer que el reporte de una demo
 * ensenara un nivel que ningun servicio calculo: `progression: null` es la verdad
 * de este doble, y el reporte sale con la experiencia acreditada y sin nivel.
 *
 * Prohibido en produccion: en produccion el driver `memory` no arranca.
 */
export class InMemoryExperienceCredits implements ExperienceCreditPort {
  private readonly byOperationId = new Map<string, number>()
  private readonly totals = new Map<string, number>()

  credit(request: ExperienceCreditRequest): Promise<ExperienceCreditOutcome> {
    const key = `${request.playerId}::${request.heroId}`
    const applied = this.byOperationId.get(request.operationId)

    if (applied !== undefined) {
      return Promise.resolve({ kind: 'CREDITED', progression: null })
    }

    this.byOperationId.set(request.operationId, request.amount)
    this.totals.set(key, (this.totals.get(key) ?? 0) + request.amount)

    return Promise.resolve({ kind: 'CREDITED', progression: null })
  }

  /** Experiencia acumulada de un heroe. Para las pruebas y las demos. */
  totalOf(playerId: string, heroId: string): number {
    return this.totals.get(`${playerId}::${heroId}`) ?? 0
  }
}
