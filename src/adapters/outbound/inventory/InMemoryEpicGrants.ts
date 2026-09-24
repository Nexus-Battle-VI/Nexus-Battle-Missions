import type {
  EpicGrantOutcome,
  EpicGrantPort,
  EpicGrantRequest,
} from '../../../application/ports/EpicGrantPort'

/**
 * Doble de desarrollo de la entrega de epicas (`EPIC_GRANTS_DRIVER=memory`).
 * Imita la idempotencia de Player/Inventory: la misma operacion con el mismo
 * cuerpo responde igual, y con otro cuerpo, `409`. No acredita nada de verdad,
 * asi que no demuestra CA-01. Prohibido en produccion.
 */
export class InMemoryEpicGrants implements EpicGrantPort {
  private readonly operations = new Map<string, EpicGrantRequest>()

  grant(request: EpicGrantRequest): Promise<EpicGrantOutcome> {
    const previous = this.operations.get(request.operationId)

    if (
      previous !== undefined &&
      (previous.playerId !== request.playerId ||
        previous.productId !== request.productId ||
        (previous.quantity ?? 1) !== (request.quantity ?? 1))
    ) {
      return Promise.resolve({ kind: 'UNKNOWN', reason: 'HTTP_409' })
    }

    this.operations.set(request.operationId, request)

    return Promise.resolve({ kind: 'GRANTED' })
  }

  /** Las entregas distintas que registro: una por `operationId` (M-7). */
  granted(): readonly EpicGrantRequest[] {
    return [...this.operations.values()]
  }
}
