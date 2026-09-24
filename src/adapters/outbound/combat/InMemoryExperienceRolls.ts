import type {
  ExperienceRollOutcome,
  ExperienceRollPort,
  ExperienceRollRequest,
  ExperienceRollResult,
} from '../../../application/ports/ExperienceRollPort'

/**
 * Doble de desarrollo de Combat para las tiradas de experiencia
 * (`EXPERIENCE_REWARDS_DRIVER=memory`).
 *
 * REPARTO DETERMINISTA, NO ALEATORIO: asigna caras ciclicas `1..8` en el orden de
 * las derrotas, de modo que una prueba o una demo obtiene siempre el mismo
 * resultado y no se introduce azar en el proceso -- la aleatoriedad es autoridad
 * exclusiva de Combat (`ADR-021`), y este doble no la simula.
 *
 * Es idempotente como el real: el mismo `operationId` devuelve las MISMAS caras.
 * Prohibido en produccion.
 */
export class InMemoryExperienceRolls implements ExperienceRollPort {
  private readonly byOperationId = new Map<string, readonly ExperienceRollResult[]>()
  private next = 1

  rollDefeats(request: ExperienceRollRequest): Promise<ExperienceRollOutcome> {
    const stored = this.byOperationId.get(request.operationId)

    if (stored !== undefined) {
      return Promise.resolve({ kind: 'ROLLED', rolls: stored })
    }

    const rolls = request.defeats.map((defeat) => {
      const roll = this.next
      this.next = roll === 8 ? 1 : roll + 1

      return {
        encounterId: defeat.encounterId,
        enemyInstanceId: defeat.enemyInstanceId,
        roll,
      }
    })

    this.byOperationId.set(request.operationId, rolls)

    return Promise.resolve({ kind: 'ROLLED', rolls })
  }
}
