import type { ClockPort } from '../../../application/ports/ClockPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  CommitmentRejection,
  HeroCommitmentPort,
} from '../../../application/ports/HeroCommitmentPort'
import type { BusyWith, MissingSlot, ReadinessBlocker } from '../../../domain/errors/mission-errors'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'

export interface PlayerInventoryClientOptions {
  /** Sin barra final, p. ej. `http://player-inventory:3002`. */
  readonly baseUrl: string
  readonly secret: string
  readonly clock: ClockPort
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  /** Registro de fallos; el cliente nunca lanza hacia el caso de uso. */
  readonly onFailure?: (event: string, detail: FailureDetail) => void
}

/** Solo ruta, estado y motivo: nunca el cuerpo, que puede llevar datos del jugador. */
export type FailureDetail = Readonly<Record<string, string | number | null>>

const SERVICE = 'missions'
const BUSY_WITH: readonly BusyWith[] = ['MISSION', 'BATTLE', 'TOURNAMENT', 'AUCTION']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Cliente del compromiso `MISSION` en Player/Inventory (propuesta del contrato
 * hu-70-mission-enrollment-v1). **Player/Inventory todavia no tiene esta ruta**:
 * hasta que Team Alfa la publique, cada llamada termina en `UNKNOWN` y la
 * matricula queda `PENDING` (503 para el jugador). No se inventa una respuesta.
 *
 * Firma con el mismo HMAC de ADR-019. La ruta firmada es la COMPLETA, con el
 * prefijo `/api`, porque Player/Inventory verifica `originalUrl`.
 *
 * Semantica de ADR-019: solo `201`/`200` y `422` son respuestas definitivas.
 * `404` (ruta aun inexistente), `409`, `5xx`, tiempo agotado o error de red NO
 * autorizan a suponer que la reserva no ocurrio.
 */
export class PlayerInventoryCommitmentClient implements HeroCommitmentPort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: PlayerInventoryClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    const path = `/api/internal/v1/inventory/heroes/${encodeURIComponent(request.heroId)}/commitments`
    const response = await this.post(path, {
      operationId: request.operationId,
      playerId: request.playerId,
      purpose: 'MISSION',
      reference: request.reference,
      expiresAt: request.expiresAt.toISOString(),
      requirements: { completeLoadout: request.requireCompleteLoadout },
    })

    if (response === null) {
      return { kind: 'UNKNOWN', reason: 'NETWORK' }
    }

    const body = await readJson(response)

    if (response.status === 201 || response.status === 200) {
      if (isRecord(body) && typeof body.commitmentId === 'string') {
        return { kind: 'GRANTED', commitmentId: body.commitmentId }
      }

      this.fail('player_inventory_respuesta_invalida', { path, status: response.status })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (response.status === 422) {
      const rejection = this.rejectionOf(body)

      if (rejection !== null) {
        return { kind: 'REJECTED', rejection }
      }
    }

    this.fail('player_inventory_sin_confirmacion', { path, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  async release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'> {
    const path = `/api/internal/v1/inventory/commitments/${encodeURIComponent(operationId)}/release`
    const response = await this.post(path, {})

    if (response !== null && (response.status === 204 || response.status === 200)) {
      return 'RELEASED'
    }

    this.fail('player_inventory_liberacion_sin_confirmar', {
      path,
      status: response?.status ?? null,
    })

    return 'UNKNOWN'
  }

  private rejectionOf(body: unknown): CommitmentRejection | null {
    if (!isRecord(body)) {
      return null
    }

    switch (body.code) {
      case 'HERO_NOT_OWNED':
        return { code: 'HERO_NOT_OWNED' }
      case 'HERO_NOT_READY':
        return {
          code: 'HERO_NOT_READY',
          blockers: Array.isArray(body.blockers) ? (body.blockers as ReadinessBlocker[]) : [],
        }
      case 'LOADOUT_INCOMPLETE':
        return {
          code: 'LOADOUT_INCOMPLETE',
          missingSlots: Array.isArray(body.missingSlots)
            ? (body.missingSlots as MissingSlot[])
            : [],
        }
      case 'HERO_COMMITTED':
        return {
          code: 'HERO_COMMITTED',
          busyWith: BUSY_WITH.includes(body.purpose as BusyWith)
            ? (body.purpose as BusyWith)
            : null,
        }
      default:
        return null
    }
  }

  private async post(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Response | null> {
    const timestamp = String(this.options.clock.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: SERVICE,
      method: 'POST',
      path,
      timestamp,
      body,
    })

    try {
      return await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: SERVICE,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      this.fail('player_inventory_inalcanzable', {
        path,
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      return null
    }
  }

  private fail(event: string, detail: FailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
