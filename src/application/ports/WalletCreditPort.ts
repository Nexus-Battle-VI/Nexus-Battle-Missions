import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'

/**
 * Creditos de mision en Wallet (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §9). Operacion PROPIA de Missions -> Wallet:
 * `POST /api/internal/v1/wallet/credits/mission-reward` (Wallet #20), distinta de
 * `battle-reward` (HU-22, JcJ). No devuelve ni altera `victoryProgress`,
 * `weeklyChestCount` ni la semana.
 */
export interface WalletCreditRequest {
  /** `mission:{enrollmentId}:reward:{rewardKey}` (contrato §12). */
  readonly operationId: string
  readonly playerId: string
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  /** `{group}:{key}`, la MISMA clave que forma el `operationId`. */
  readonly rewardKey: string
  /** Entero `>= 1`, ya congelado por `CompletionRewardPolicy`. Wallet no lo calcula. */
  readonly creditsAmount: number
  /** El `settledAt` de la liquidacion, congelado: IDENTICO en cada reintento. */
  readonly occurredAt: Date
}

export type WalletCreditOutcome =
  /** `200` (`applied: true` o replay `applied: false`): acreditado. */
  | { readonly kind: 'CREDITED' }
  /**
   * `409 OPERATION_CONFLICT` (con un derecho congelado indica un defecto), `422
   * MISSION_REWARD_INVALID` o `400 SCHEMA_INVALID`: rechazo definitivo.
   */
  | { readonly kind: 'REJECTED'; readonly reason: string }
  /**
   * `503`, `401` (firma/servicio no valido, o sin secreto: de despliegue, no del
   * derecho), tiempo agotado, error de red o respuesta que no cumple el
   * contrato: resultado incierto.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface WalletCreditPort {
  credit(request: WalletCreditRequest): Promise<WalletCreditOutcome>
}

export const WALLET_CREDITS = Symbol('WalletCreditPort')
