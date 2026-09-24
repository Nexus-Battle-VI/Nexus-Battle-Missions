import type { ClockPort } from '../../../application/ports/ClockPort'
import type {
  CombatEstimate,
  EstimateCallOutcome,
  EstimatedAbility,
  MissionEstimatePort,
} from '../../../application/ports/MissionEstimatePort'
import type { SimulationRequest } from '../../../domain/entities/MissionExecution'
import {
  canonicalBody,
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'
import { isRecord, readJson } from '../inventory/json'

export interface CombatEstimateClientOptions {
  /** Sin barra final, p. ej. `http://combat:3004`. */
  readonly baseUrl: string
  readonly secret: string
  readonly clock: ClockPort
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
  /** Registro de fallos: solo ruta, estado y motivo, nunca el cuerpo. */
  readonly onFailure?: (
    event: string,
    detail: Readonly<Record<string, string | number | null>>,
  ) => void
}

const SERVICE = 'missions'
const PATH = '/api/internal/v1/combat/simulations/estimates'

const COUNT_FIELDS = ['runs', 'victories', 'defeats', 'timeouts'] as const
const AVERAGE_FIELDS = ['averageTurns', 'averageDamageTaken', 'averageMinHealthPercent'] as const
const RATE_FIELDS = ['winRate', 'masterAppearanceRate'] as const

const isCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isAverage = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isRate = (value: unknown): boolean => isAverage(value) && (value as number) <= 1

const abilityOf = (value: unknown): EstimatedAbility | null =>
  isRecord(value) &&
  typeof value.abilityId === 'string' &&
  typeof value.name === 'string' &&
  typeof value.usable === 'boolean' &&
  (value.reason === null || typeof value.reason === 'string')
    ? {
        abilityId: value.abilityId,
        name: value.name,
        usable: value.usable,
        reason: value.reason,
      }
    : null

/** La estimacion del cuerpo, o `null` si no cumple el contrato: no se muestra. */
const estimateOf = (body: unknown): CombatEstimate | null => {
  if (
    !isRecord(body) ||
    !COUNT_FIELDS.every((field) => isCount(body[field])) ||
    !AVERAGE_FIELDS.every((field) => isAverage(body[field])) ||
    !RATE_FIELDS.every((field) => isRate(body[field])) ||
    body.runs === 0 ||
    !Array.isArray(body.abilities)
  ) {
    return null
  }

  const abilities: EstimatedAbility[] = []
  for (const raw of body.abilities as unknown[]) {
    const ability = abilityOf(raw)
    if (ability === null) {
      return null
    }
    abilities.push(ability)
  }

  return {
    runs: body.runs as number,
    victories: body.victories as number,
    defeats: body.defeats as number,
    timeouts: body.timeouts as number,
    winRate: body.winRate as number,
    averageTurns: body.averageTurns as number,
    averageDamageTaken: body.averageDamageTaken as number,
    averageMinHealthPercent: body.averageMinHealthPercent as number,
    masterAppearanceRate: body.masterAppearanceRate as number,
    abilities,
  }
}

/**
 * Estimacion de exito en Combat (diseno «misiones jugables», P-J7). Envia la MISMA
 * solicitud que una simulacion, sin `contentSnapshot`, con las corridas que se
 * piden; Combat no guarda nada. Se firma igual que la simulacion.
 *
 * Solo el `200` con el cuerpo del contrato es una estimacion. Cualquier otra
 * respuesta, un tiempo agotado o un error de red la dejan sin mostrar: no se
 * reintenta, porque el jugador puede pedirla otra vez o matricular sin ella.
 */
export class CombatEstimateClient implements MissionEstimatePort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CombatEstimateClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async estimate(request: SimulationRequest, runs: number): Promise<EstimateCallOutcome> {
    const combatRequest = { ...request }
    Reflect.deleteProperty(combatRequest, 'contentSnapshot')
    const payload = { runs, request: combatRequest }
    const timestamp = String(this.options.clock.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: SERVICE,
      method: 'POST',
      path: PATH,
      timestamp,
      body: payload,
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
        body: canonicalBody(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'
      this.fail('combat_estimacion_inalcanzable', { path: PATH, reason })
      return { kind: 'UNAVAILABLE', reason }
    }

    const body = await readJson(response)
    if (response.status === 200) {
      const estimate = estimateOf(body)
      if (estimate !== null) {
        return { kind: 'ESTIMATED', estimate }
      }
      this.fail('combat_estimacion_invalida', { path: PATH, status: 200 })
      return { kind: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' }
    }

    const code =
      isRecord(body) && typeof body.code === 'string' && body.code !== '' ? body.code : null
    this.fail('combat_sin_estimacion', { path: PATH, status: response.status, code })
    return { kind: 'UNAVAILABLE', reason: code ?? `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: Readonly<Record<string, string | number | null>>): void {
    this.options.onFailure?.(event, detail)
  }
}
