import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'
import type { ClockPort } from '../../../application/ports/ClockPort'

const SERVICE = 'missions'

/** Solo ruta, estado y motivo: nunca el cuerpo, que puede llevar datos del jugador. */
export type WalletFailureDetail = Readonly<Record<string, string | number | null>>

export interface WalletClientOptions {
  /** Sin barra final, p. ej. `http://wallet:3009`. */
  readonly baseUrl: string
  readonly secret: string
  readonly clock: ClockPort
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  readonly onFailure?: (event: string, detail: WalletFailureDetail) => void
}

/**
 * `POST` interno a Wallet con el HMAC de ADR-019 (HU-10, Task HU-10.5). Misma
 * mecanica que `signedPost` de los clientes de Player/Inventory (firma sobre la
 * ruta COMPLETA con el prefijo `/api`, sello y firma nuevos en cada llamada, el
 * cuerpo no), en un fichero propio porque el destino es otro servicio con su
 * propia URL y no hay que renombrar `PlayerInventoryClientOptions` para que sirva
 * para dos cosas distintas.
 */
export const signedWalletPost = async (
  options: WalletClientOptions,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response | null> => {
  const timestamp = String(options.clock.now().getTime())
  const signature = signInternalRequest(options.secret, {
    service: SERVICE,
    method: 'POST',
    path,
    timestamp,
    body,
  })

  try {
    return await (options.fetchImpl ?? fetch)(`${options.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_SERVICE_HEADER]: SERVICE,
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: signature,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error: unknown) {
    options.onFailure?.('wallet_inalcanzable', {
      path,
      reason: error instanceof Error ? error.name : 'desconocido',
    })

    return null
  }
}
