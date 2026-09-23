import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'
import type { PlayerInventoryClientOptions } from './PlayerInventoryCommitmentClient'

const SERVICE = 'missions'

/**
 * `POST` interno a Player/Inventory con el HMAC de ADR-019. La ruta firmada es
 * la COMPLETA, con el prefijo `/api`, porque Player/Inventory verifica
 * `originalUrl`. Cada llamada lleva sello y firma nuevos; el cuerpo, no.
 * `null` si no hubo respuesta: tiempo agotado o error de red.
 */
export const signedPost = async (
  options: PlayerInventoryClientOptions,
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
    options.onFailure?.('player_inventory_inalcanzable', {
      path,
      reason: error instanceof Error ? error.name : 'desconocido',
    })

    return null
  }
}
