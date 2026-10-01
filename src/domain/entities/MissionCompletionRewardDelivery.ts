import { DomainError } from '../errors/DomainError'
import { uuidV5 } from '../value-objects/deterministic-uuid'
import type { DifficultyLevel } from '../value-objects/difficulty-level'
import { retryDelayMs } from './MissionExecution'

/**
 * Entrega de una liquidacion de finalizacion de mision (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §7, §12 y §13).
 *
 * UNA FILA POR DERECHO (`rewardKey`), no por mision: la clave es (matricula,
 * rewardKey), igual que HU-09 usa (matricula, encuentro, enemigo). Una entrega que
 * falla no arrastra a las demas de la misma liquidacion.
 *
 * TRES ESTADOS, NO CUATRO. A diferencia de HU-09 (`PENDING -> ROLLED -> CREDITED`),
 * aqui el importe o la cantidad YA estan congelados por `CompletionRewardPolicy`
 * cuando la fila nace: no hay una tirada pendiente. Por eso el contrato §13 solo
 * necesita `PENDING -> CREDITED` y `PENDING -> FAILED`.
 *
 * `PENDING ──► CREDITED`
 *    │
 *    └──► FAILED   (rechazo terminal)
 *
 * NINGUNA FORMULA NI TABLA DE MONTOS VIVE AQUI: el `amount`/`quantity` llega ya
 * decidido por `CompletionRewardPolicy` a partir del contenido congelado.
 */
export const COMPLETION_DELIVERY_STATUSES = ['PENDING', 'CREDITED', 'FAILED'] as const

export type CompletionDeliveryStatus = (typeof COMPLETION_DELIVERY_STATUSES)[number]

export const isTerminalDelivery = (status: CompletionDeliveryStatus): boolean =>
  status === 'CREDITED' || status === 'FAILED'

export type CompletionDeliveryKind = 'EXPERIENCE' | 'CREDITS' | 'PRODUCT'

interface DeliveryBase {
  readonly enrollmentId: string
  readonly playerId: string
  readonly heroId: string
  readonly missionId: string
  readonly simulationId: string
  readonly difficulty: DifficultyLevel
  readonly missionOutcome: 'COMPLETED' | 'FAILED'
  /** `completion:xp` o `{group}:{key}` (contrato §12). Estable e independiente del orden. */
  readonly rewardKey: string
  /**
   * El momento del cierre, congelado. Es el `occurredAt` que se envia a Wallet en
   * CADA intento -- nunca la hora del reintento, o un replay legitimo se volveria
   * un `409` falso.
   */
  readonly settledAt: Date
  readonly status: CompletionDeliveryStatus
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar. */
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
  readonly creditedAt: Date | null
  /** La linea del reporte que refleja ESTA entrega; se mueven en la misma transaccion. */
  readonly reportLineNo: number | null
}

export type MissionCompletionRewardDelivery =
  | (DeliveryBase & { readonly kind: 'EXPERIENCE'; readonly amount: number })
  | (DeliveryBase & { readonly kind: 'CREDITS'; readonly amount: number })
  | (DeliveryBase & {
      readonly kind: 'PRODUCT'
      readonly productId: string
      readonly quantity: number
    })

/** Clave de la entrega: la INSTANCIA del derecho dentro de la liquidacion. */
export const completionDeliveryKey = (delivery: {
  readonly enrollmentId: string
  readonly rewardKey: string
}): string => `${delivery.enrollmentId}::${delivery.rewardKey}`

/**
 * Espacio de nombres propio de HU-10 (contrato §12), distinto del de HU-72
 * (`LOOT_GRANT_NAMESPACE`) y del de HU-73 (`EPIC_GRANT_NAMESPACE`): una colision de
 * `operationId` con otro origen es imposible por construccion.
 */
export const COMPLETION_REWARD_NAMESPACE = '7565c40b-1f2b-4854-bfde-124bf8c7db44'

/** `mission:{enrollmentId}:reward:{rewardKey}` (contrato §12): la clave LOGICA del derecho. */
export const completionRewardLogicalKey = (enrollmentId: string, rewardKey: string): string =>
  `mission:${enrollmentId}:reward:${rewardKey}`

/**
 * El `operationId` EN EL CABLE (contrato §12): la clave logica tal cual para XP y
 * creditos (Player/Inventory y Wallet aceptan cadenas); un UUID v5 de esa MISMA
 * clave para productos, porque `inventory/grants` exige UUID.
 */
export const completionOperationIdOf = (delivery: MissionCompletionRewardDelivery): string => {
  const logical = completionRewardLogicalKey(delivery.enrollmentId, delivery.rewardKey)

  return delivery.kind === 'PRODUCT' ? uuidV5(COMPLETION_REWARD_NAMESPACE, logical) : logical
}

export class InvalidCompletionDeliveryTransitionError extends DomainError {
  constructor(delivery: { readonly enrollmentId: string; readonly rewardKey: string }) {
    super(
      `La entrega de ${completionDeliveryKey(delivery)} ya no esta pendiente y no admite esa transicion.`,
    )
    this.name = 'InvalidCompletionDeliveryTransitionError'
  }
}

const requirePending = <T extends MissionCompletionRewardDelivery>(delivery: T): T => {
  if (delivery.status !== 'PENDING') {
    throw new InvalidCompletionDeliveryTransitionError(delivery)
  }

  return delivery
}

/**
 * `200` (`applied: true` o replay `applied: false`): entregado. Terminal.
 *
 * Un replay se trata IGUAL que la primera aplicacion (contrato §8.2/§9.3/§10):
 * para Missions el resultado es el mismo, `CREDITED`.
 */
export const deliveryCredited = (
  delivery: MissionCompletionRewardDelivery,
  now: Date,
): MissionCompletionRewardDelivery => ({
  ...requirePending(delivery),
  status: 'CREDITED',
  attempts: delivery.attempts + 1,
  nextAttemptAt: null,
  lastError: null,
  creditedAt: now,
})

/**
 * Rechazo terminal (contrato §13, clase TERMINAL): queda visible y NO se
 * reintenta. Una entrega que falla no arrastra a las demas de la misma
 * liquidacion (§16).
 */
export const deliveryRejected = (
  delivery: MissionCompletionRewardDelivery,
  reason: string,
): MissionCompletionRewardDelivery => ({
  ...requirePending(delivery),
  status: 'FAILED',
  attempts: delivery.attempts + 1,
  nextAttemptAt: null,
  lastError: reason,
})

/**
 * Resultado incierto (contrato §13, clase REINTENTABLE): se reintenta con el
 * MISMO `operationId` y el MISMO cuerpo congelado, con el escalonado que ya usan
 * HU-09, HU-72 y el botin.
 */
export const deliveryDeferred = (
  delivery: MissionCompletionRewardDelivery,
  reason: string,
  now: Date,
): MissionCompletionRewardDelivery => {
  const attempts = requirePending(delivery).attempts + 1

  return {
    ...delivery,
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
    lastError: reason,
  }
}

/** Ata la entrega a la linea del reporte que la refleja, en la misma transaccion del cierre. */
export const withDeliveryReportLine = (
  delivery: MissionCompletionRewardDelivery,
  lineNo: number,
): MissionCompletionRewardDelivery => ({ ...delivery, reportLineNo: lineNo })
