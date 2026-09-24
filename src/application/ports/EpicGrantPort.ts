/**
 * Entrega de la epica de un Master en Player/Inventory (HU-73, P-X6). Usa el
 * contrato de entregas de HU-59 (`POST /api/internal/v1/inventory/grants`), que
 * existe pero **todavia no acepta a `missions`**: hasta que Team Alfa lo abra
 * (ADR-019), cada entrega queda pendiente y se reintenta.
 *
 * La solicitud es IDENTICA en cada reintento: Player/Inventory responde lo mismo
 * ante el mismo `operationId` y no entrega dos veces.
 */
export interface EpicGrantRequest {
  readonly operationId: string
  readonly playerId: string
  /** El producto de Catalog que representa la epica. */
  readonly productId: string
}

export type EpicGrantOutcome =
  | { readonly kind: 'GRANTED' }
  /** `422` o `400`: reintentar no cambia nada; queda para revision. */
  | { readonly kind: 'REJECTED'; readonly reason: string }
  /**
   * `409`, `5xx`, `401`, ruta inexistente, tiempo agotado o error de red. No
   * autoriza a suponer que la entrega no ocurrio: se reintenta.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface EpicGrantPort {
  grant(request: EpicGrantRequest): Promise<EpicGrantOutcome>
}

export const EPIC_GRANTS = Symbol('EpicGrantPort')
