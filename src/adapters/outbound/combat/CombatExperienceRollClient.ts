import type {
  ExperienceRollOutcome,
  ExperienceRollPort,
  ExperienceRollRequest,
  ExperienceRollResult,
} from '../../../application/ports/ExperienceRollPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  canonicalBody,
  signInternalRequest,
} from '../identity/internal-signature'
import { isRecord, readJson } from '../inventory/json'

const SERVICE = 'missions'
const PATH = '/api/internal/v1/combat/experience-rolls'

export interface CombatExperienceClientOptions {
  /** Sin barra final, p. ej. `http://combat:3006`. */
  readonly baseUrl: string
  readonly secret: string
  readonly clock: { now(): Date }
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  /** Registro de fallos: solo ruta, estado y motivo, nunca el cuerpo. */
  readonly onFailure?: (
    event: string,
    detail: Readonly<Record<string, string | number | null>>,
  ) => void
}

/**
 * Tirada autoritativa de experiencia en Combat (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §5.2).
 *
 * Missions NO tira el dado: lo pide. La operacion de Combat es idempotente por
 * `operationId`, asi que un reintento con la MISMA clave devuelve las mismas
 * caras y no consume azar de nuevo; el cuerpo va en JSON canonico para que
 * tambien sea identico byte a byte.
 *
 * Traduccion de respuestas, tal como la fija el contrato:
 *
 * - `200` con una cara por derrota: `ROLLED`. Si falta alguna, o alguna no es una
 *   cara valida, la respuesta NO sirve y se trata como desconocida: no se
 *   completa a ojo ni se inventa un valor medio.
 * - `400` (cuerpo fuera del contrato), `401` (firma), `409` (misma clave con otro
 *   cuerpo) y `422` (instancia repetida): rechazo definitivo. Reintentar con el
 *   mismo cuerpo no cambia nada.
 * - `503`, tiempo agotado, error de red: desconocido. NO autoriza a suponer que
 *   no hubo tirada; se reintenta con la misma clave.
 */
export class CombatExperienceRollClient implements ExperienceRollPort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CombatExperienceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async rollDefeats(request: ExperienceRollRequest): Promise<ExperienceRollOutcome> {
    const body = {
      schemaVersion: 1,
      operationId: request.operationId,
      enrollmentId: request.enrollmentId,
      simulationId: request.simulationId,
      heroId: request.heroId,
      defeats: request.defeats.map((defeat) => ({
        encounterId: defeat.encounterId,
        enemyInstanceId: defeat.enemyInstanceId,
        rivalRef: defeat.rivalRef,
      })),
    }
    const timestamp = String(this.options.clock.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: SERVICE,
      method: 'POST',
      path: PATH,
      timestamp,
      body,
    })
    let response: Response

    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: SERVICE,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        body: canonicalBody(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'
      this.fail('combat_inalcanzable', { path: PATH, reason })

      return { kind: 'UNKNOWN', reason }
    }

    const parsed = await readJson(response)

    if (response.status === 200) {
      const rolls = rollsOf(parsed, request)

      if (rolls !== null) {
        return { kind: 'ROLLED', rolls }
      }

      this.fail('combat_respuesta_invalida', { path: PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 409 ||
      response.status === 422
    ) {
      const code = isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : null

      this.fail('combat_tirada_rechazada', { path: PATH, status: response.status, code })

      return { kind: 'REJECTED', reason: code ?? `HTTP_${String(response.status)}` }
    }

    this.fail('combat_tirada_sin_confirmar', { path: PATH, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: Readonly<Record<string, string | number | null>>): void {
    this.options.onFailure?.(event, detail)
  }
}

/**
 * Las caras de la respuesta, o `null` si no cumple el contrato.
 *
 * Comprobaciones que importan: la operacion devuelta es la que se pidio, el
 * numero de tiradas coincide con el de derrotas, cada derrota pedida tiene su
 * cara y la cara es un entero `1..8`. Con el cuerpo a medias no se puede saber
 * que se tiro, y suponerlo seria inventar la recompensa.
 */
const rollsOf = (
  body: unknown,
  request: ExperienceRollRequest,
): readonly ExperienceRollResult[] | null => {
  if (!isRecord(body) || body.operationId !== request.operationId || !Array.isArray(body.rolls)) {
    return null
  }

  const rolls: ExperienceRollResult[] = []

  for (const entry of body.rolls as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.encounterId !== 'string' ||
      typeof entry.enemyInstanceId !== 'string' ||
      typeof entry.roll !== 'number' ||
      !Number.isInteger(entry.roll) ||
      entry.roll < 1 ||
      entry.roll > 8
    ) {
      return null
    }

    rolls.push({
      encounterId: entry.encounterId,
      enemyInstanceId: entry.enemyInstanceId,
      roll: entry.roll,
    })
  }

  if (rolls.length !== request.defeats.length) {
    return null
  }

  const keys = new Set(rolls.map((roll) => `${roll.encounterId}#${roll.enemyInstanceId}`))

  for (const defeat of request.defeats) {
    if (!keys.has(`${defeat.encounterId}#${defeat.enemyInstanceId}`)) {
      return null
    }
  }

  return rolls
}
