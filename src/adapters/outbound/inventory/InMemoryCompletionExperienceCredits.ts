import type {
  CompletionExperienceCreditOutcome,
  CompletionExperienceCreditPort,
  CompletionExperienceCreditRequest,
} from '../../../application/ports/CompletionExperienceCreditPort'

/**
 * Doble de desarrollo de la XP de finalizacion (HU-10, Task HU-10.5;
 * `EXPERIENCE_REWARDS_DRIVER=memory`... no: `MISSION_COMPLETION_REWARDS_DRIVER`).
 *
 * Acumula por heroe y es idempotente por `operationId`, como el real. NO conoce
 * la tabla de niveles de HU-08 (eso es de Player/Inventory): por eso NO devuelve
 * progresion, igual que `InMemoryExperienceCredits` de HU-09. Prohibido en
 * produccion.
 */
export class InMemoryCompletionExperienceCredits implements CompletionExperienceCreditPort {
  private readonly byOperationId = new Map<string, number>()
  private readonly totals = new Map<string, number>()

  credit(request: CompletionExperienceCreditRequest): Promise<CompletionExperienceCreditOutcome> {
    const key = `${request.playerId}::${request.heroId}`
    const applied = this.byOperationId.get(request.operationId)

    if (applied !== undefined) {
      return Promise.resolve({ kind: 'CREDITED', progression: null })
    }

    this.byOperationId.set(request.operationId, request.amount)
    this.totals.set(key, (this.totals.get(key) ?? 0) + request.amount)

    return Promise.resolve({ kind: 'CREDITED', progression: null })
  }

  /** Experiencia de finalizacion acumulada de un heroe. Para pruebas y demos. */
  totalOf(playerId: string, heroId: string): number {
    return this.totals.get(`${playerId}::${heroId}`) ?? 0
  }
}
