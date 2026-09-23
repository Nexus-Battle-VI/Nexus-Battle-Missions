import type {
  EpicGrantOutcome,
  EpicGrantPort,
  EpicGrantRequest,
} from '../../../application/ports/EpicGrantPort'
import { isRecord, readJson } from './json'
import type { FailureDetail, PlayerInventoryClientOptions } from './PlayerInventoryCommitmentClient'
import { signedPost } from './signed-post'

const PATH = '/api/internal/v1/inventory/grants'

/**
 * Cliente de entregas de Player/Inventory para la epica del Master (HU-73,
 * P-X6). Usa el contrato EXISTENTE de HU-59 sin cambiarlo: un lote con un solo
 * producto y cantidad 1. **Player/Inventory todavia no autoriza a `missions`**
 * en esa ruta (ADR-019 lo decide, sin implementar): hasta entonces responde
 * `401` y la entrega queda pendiente. No se inventa una respuesta.
 *
 * - `200` con la misma operacion y `applied: true`: entregada;
 * - `422` (inventario lo rechaza) y `400` (cuerpo invalido): rechazo definitivo;
 * - `409`, `401`, `404`, `5xx`, tiempo agotado o red: desconocido. Player/Inventory
 *   usa `409` tambien para una escritura concurrente, asi que se reintenta con el
 *   mismo `operationId` en lugar de darla por perdida.
 */
export class PlayerInventoryEpicGrantClient implements EpicGrantPort {
  constructor(private readonly options: PlayerInventoryClientOptions) {}

  async grant(request: EpicGrantRequest): Promise<EpicGrantOutcome> {
    const response = await signedPost(this.options, PATH, {
      operationId: request.operationId,
      playerId: request.playerId,
      items: [{ productId: request.productId, quantity: 1 }],
    })

    if (response === null) {
      return { kind: 'UNKNOWN', reason: 'NETWORK' }
    }

    const body = await readJson(response)

    if (response.status === 200) {
      if (isRecord(body) && body.applied === true && body.operationId === request.operationId) {
        return { kind: 'GRANTED' }
      }

      this.fail('player_inventory_respuesta_invalida', { path: PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (response.status === 422 || response.status === 400) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null

      this.fail('player_inventory_entrega_rechazada', {
        path: PATH,
        status: response.status,
        code,
      })

      return { kind: 'REJECTED', reason: code ?? `HTTP_${String(response.status)}` }
    }

    this.fail('player_inventory_entrega_sin_confirmar', { path: PATH, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: FailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
