import { DomainError } from '../errors/DomainError'
import { retryDelayMs } from './MissionExecution'

/**
 * Entrega del botin del jefe en Player/Inventory (diseno «misiones jugables»,
 * P-J1). Hasta ahora el reporte mostraba el botin y nada lo entregaba. Sigue el
 * mismo ciclo que la epica de HU-73: nace PENDING en la transaccion del cierre,
 * con su linea `PRODUCT` en el reporte, y se pide con un `operationId`
 * determinista hasta tener respuesta definitiva.
 */
export const LOOT_GRANT_STATUSES = ['PENDING', 'GRANTED', 'REJECTED'] as const

export type LootGrantStatus = (typeof LOOT_GRANT_STATUSES)[number]

export interface LootGrantRecord {
  readonly enrollmentId: string
  /** La linea `PRODUCT` del reporte de HU-74 que refleja la entrega. */
  readonly lineNo: number
  /** El nombre del botin en el contenido; es por donde se busca su producto. */
  readonly label: string
  readonly quantity: number
  readonly operationId: string
  readonly status: LootGrantStatus
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar. */
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
  readonly grantedAt: Date | null
  /**
   * El producto de Catalog con que se pidio la entrega la primera vez. Queda
   * congelado: cada reintento lleva el mismo cuerpo aunque cambie el contenido,
   * o Player/Inventory responderia `409` para siempre. `null` hasta que exista.
   */
  readonly productId: string | null
}

export class InvalidLootTransitionError extends DomainError {
  constructor(enrollmentId: string, lineNo: number) {
    super(`La entrega del botin de ${enrollmentId}#${String(lineNo)} ya no esta pendiente.`)
    this.name = 'InvalidLootTransitionError'
  }
}

const pending = (grant: LootGrantRecord): LootGrantRecord => {
  if (grant.status !== 'PENDING') {
    throw new InvalidLootTransitionError(grant.enrollmentId, grant.lineNo)
  }

  return grant
}

/** `200` de Player/Inventory: el botin esta en el inventario. */
export const lootConfirmed = (grant: LootGrantRecord, now: Date): LootGrantRecord => ({
  ...pending(grant),
  status: 'GRANTED',
  attempts: grant.attempts + 1,
  nextAttemptAt: null,
  lastError: null,
  grantedAt: now,
})

/** Rechazo definitivo: se registra y queda para revision. */
export const lootRejected = (grant: LootGrantRecord, reason: string): LootGrantRecord => ({
  ...pending(grant),
  status: 'REJECTED',
  attempts: grant.attempts + 1,
  nextAttemptAt: null,
  lastError: reason,
})

/**
 * Sin respuesta definitiva, o sin producto que entregar todavia: se reintenta
 * con el mismo `operationId` y el escalonado de HU-72.
 */
export const lootDeferred = (
  grant: LootGrantRecord,
  reason: string,
  now: Date,
): LootGrantRecord => {
  const attempts = pending(grant).attempts + 1

  return {
    ...grant,
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
    lastError: reason,
  }
}
