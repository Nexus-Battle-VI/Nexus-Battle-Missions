import type {
  WalletCreditOutcome,
  WalletCreditPort,
  WalletCreditRequest,
} from '../../../application/ports/WalletCreditPort'

/**
 * Doble de desarrollo de los creditos de mision en Wallet (HU-10, Task HU-10.5;
 * `MISSION_COMPLETION_REWARDS_DRIVER=memory`).
 *
 * Acumula por jugador y es idempotente por `operationId`. NO evalua progreso de
 * victoria ni cofres -- no existen aqui -- y por eso reproduce sin esfuerzo la
 * regla de que un credito de mision no es una victoria JcJ. Prohibido en
 * produccion.
 */
export class InMemoryWalletCredits implements WalletCreditPort {
  private readonly byOperationId = new Set<string>()
  private readonly balances = new Map<string, number>()

  credit(request: WalletCreditRequest): Promise<WalletCreditOutcome> {
    if (this.byOperationId.has(request.operationId)) {
      return Promise.resolve({ kind: 'CREDITED' })
    }

    this.byOperationId.add(request.operationId)
    this.balances.set(
      request.playerId,
      (this.balances.get(request.playerId) ?? 0) + request.creditsAmount,
    )

    return Promise.resolve({ kind: 'CREDITED' })
  }

  /** Saldo de creditos de mision acumulado. Para pruebas y demos. */
  balanceOf(playerId: string): number {
    return this.balances.get(playerId) ?? 0
  }
}
