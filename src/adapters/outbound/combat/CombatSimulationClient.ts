import type { ClockPort } from '../../../application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../../application/ports/CombatSimulationPort'
import type { SimulationRequest, SimulationResult } from '../../../domain/entities/MissionExecution'
import { isCombatOutcome, simulationFactsOf } from '../../../domain/policies/SettlementPolicy'
import {
  canonicalBody,
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'
import { isRecord, readJson } from '../inventory/json'

export interface CombatClientOptions {
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
const PATH = '/api/internal/v1/combat/simulations'
/** Errores de programacion segun el contrato: la mision se anula y se avisa. */
const PROGRAMMING_ERRORS = new Set([400, 409])

/** El resultado del cuerpo, o `null` si no cumple el contrato: no se da por bueno. */
const resultOf = (body: unknown, operationId: string): SimulationResult | null => {
  if (
    !isRecord(body) ||
    typeof body.simulationId !== 'string' ||
    body.simulationId === '' ||
    body.operationId !== operationId ||
    !isCombatOutcome(body.combatOutcome) ||
    !isRecord(body.summary) ||
    simulationFactsOf(body.summary) === null ||
    !Array.isArray(body.combatLog)
  ) {
    return null
  }

  return {
    simulationId: body.simulationId,
    seedRef: typeof body.seedRef === 'string' ? body.seedRef : null,
    combatOutcome: body.combatOutcome,
    summary: body.summary,
    combatLog: body.combatLog as unknown[],
  }
}

/**
 * Simulacion en Combat (HU-72, contrato hu-72-mission-simulation-v1).
 * **Propuesta para Team Alfa: la ruta todavia no existe.** Hasta que exista,
 * cada llamada es un resultado desconocido y la ejecucion se reintenta hasta su
 * plazo, en el que se anula (P-S7). No se inventa un resultado.
 *
 * - `200` con el cuerpo del contrato: resultado. Uno que no cumple (sin resumen,
 *   con otro `operationId`...) es desconocido.
 * - `422`, `400` o `409` con `code`: rechazo definitivo; los dos ultimos son un
 *   error de programacion y se avisan. `401` tambien es definitivo aunque el
 *   guard HMAC de Combat no devuelva `code`: reintentar la misma firma no ayuda.
 * - Cualquier otra respuesta, un tiempo agotado o un error de red: desconocido.
 *
 * El cuerpo va en JSON canonico: la solicitud congelada puede volver de `jsonb`
 * con otro orden de claves, y cada reintento debe ser identico (P-S3).
 */
export class CombatSimulationClient implements CombatSimulationPort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CombatClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    const combatRequest = { ...request }
    Reflect.deleteProperty(combatRequest, 'contentSnapshot')
    const timestamp = String(this.options.clock.now().getTime())
    const signature = signInternalRequest(this.options.secret, {
      service: SERVICE,
      method: 'POST',
      path: PATH,
      timestamp,
      body: combatRequest,
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
        body: canonicalBody(combatRequest),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'
      this.fail('combat_inalcanzable', { path: PATH, reason })

      return { kind: 'UNKNOWN', reason }
    }

    const body = await readJson(response)

    if (response.status === 401) {
      this.fail('combat_autorizacion_rechazada', { path: PATH, status: 401 })
      return { kind: 'REJECTED', code: 'INTERNAL_SIGNATURE_INVALID' }
    }

    if (response.status === 200) {
      const result = resultOf(body, request.operationId)

      if (result !== null) {
        return { kind: 'SIMULATED', result }
      }

      this.fail('combat_respuesta_invalida', { path: PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    const code =
      isRecord(body) && typeof body.code === 'string' && body.code !== '' ? body.code : null

    if (code !== null && (response.status === 422 || PROGRAMMING_ERRORS.has(response.status))) {
      if (PROGRAMMING_ERRORS.has(response.status)) {
        this.fail('combat_rechazo_de_programacion', { path: PATH, status: response.status, code })
      }

      return { kind: 'REJECTED', code }
    }

    this.fail('combat_sin_resultado', { path: PATH, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: Readonly<Record<string, string | number | null>>): void {
    this.options.onFailure?.(event, detail)
  }
}
