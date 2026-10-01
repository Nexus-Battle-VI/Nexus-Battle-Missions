import type {
  WalletCreditOutcome,
  WalletCreditPort,
  WalletCreditRequest,
} from '../../../application/ports/WalletCreditPort'
import { isRecord, readJson } from '../inventory/json'
import {
  signedWalletPost,
  type WalletClientOptions,
  type WalletFailureDetail,
} from './wallet-signed-post'

const PATH = '/api/internal/v1/wallet/credits/mission-reward'

/**
 * Creditos de mision en Wallet (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §9). Ruta PROPIA de Missions -> Wallet
 * (Wallet #20), acotada a `missions`; NO es `battle-reward` (HU-22, JcJ).
 *
 * `occurredAt` viaja EXACTAMENTE como llega en la peticion (el `settledAt`
 * congelado de la liquidacion): nunca la hora de este intento, o un reintento
 * legitimo se veria como otra operacion.
 *
 * Clasificacion (contrato §9.3 y §13):
 *  - `200` (`applied: true` o replay `applied: false`): `CREDITED`;
 *  - `400`, `409 OPERATION_CONFLICT`, `422 MISSION_REWARD_INVALID`: rechazo
 *    terminal, `REJECTED`;
 *  - `503`, `401` (firma/servicio no valido o sin secreto: de despliegue, no del
 *    derecho), tiempo agotado, red o cuerpo ilegible: incierto, `UNKNOWN`.
 */
export class WalletMissionRewardClient implements WalletCreditPort {
  constructor(private readonly options: WalletClientOptions) {}

  async credit(request: WalletCreditRequest): Promise<WalletCreditOutcome> {
    const response = await signedWalletPost(this.options, PATH, {
      schemaVersion: 1,
      operationId: request.operationId,
      playerId: request.playerId,
      reason: 'MISSION_REWARD',
      enrollmentId: request.enrollmentId,
      missionId: request.missionId,
      difficulty: request.difficulty,
      rewardKey: request.rewardKey,
      creditsAmount: request.creditsAmount,
      occurredAt: request.occurredAt.toISOString(),
    })

    if (response === null) {
      return { kind: 'UNKNOWN', reason: 'NETWORK' }
    }

    const body = await readJson(response)

    if (response.status === 200) {
      if (isRecord(body) && body.operationId === request.operationId) {
        return { kind: 'CREDITED' }
      }

      this.fail('wallet_respuesta_invalida', { path: PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (response.status === 400 || response.status === 409 || response.status === 422) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null

      this.fail('wallet_credito_rechazado', { path: PATH, status: response.status, code })

      return { kind: 'REJECTED', reason: code ?? `HTTP_${String(response.status)}` }
    }

    this.fail('wallet_credito_sin_confirmar', { path: PATH, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: WalletFailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
