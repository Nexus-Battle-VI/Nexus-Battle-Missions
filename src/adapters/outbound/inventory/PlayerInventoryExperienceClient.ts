import type {
  ExperienceCreditOutcome,
  ExperienceCreditPort,
  ExperienceCreditRequest,
} from '../../../application/ports/ExperienceCreditPort'
import { readHeroProgression } from '../../../domain/policies/HeroProgressionPolicy'
import { isRecord, readJson } from './json'
import type { FailureDetail, PlayerInventoryClientOptions } from './PlayerInventoryCommitmentClient'
import { signedPost } from './signed-post'

const CREDITS_PATH = '/api/internal/v1/players'

const pathOf = (request: ExperienceCreditRequest): string =>
  `${CREDITS_PATH}/${encodeURIComponent(request.playerId)}/heroes/${encodeURIComponent(request.heroId)}/experience`

/**
 * Acreditacion de experiencia en Player/Inventory (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §7).
 *
 * UNA LLAMADA POR DERROTA, con la clave de esa derrota concreta y su importe ya
 * calculado y entero: Missions no manda la suma, ni un decimal, ni la tirada sin
 * calcular. Player/Inventory no redondea nada.
 *
 * Traduccion de respuestas, tal como la fija el contrato:
 *
 * - `200` con la misma operacion: acreditada (o repetida: `applied: false` da
 *   exactamente el mismo resultado, y para Missions es lo mismo). De ahi se lee
 *   ADEMAS la progresion del heroe -- nivel, experiencia acumulada y niveles
 *   cruzados --, que es lo que el reporte de HU-74 cuenta (Task HU-09.5);
 * - `400` (cuerpo fuera del contrato), `401` (firma), `409` (misma clave con otro
 *   contenido) y `422` (importe invalido o heroe no acreditable): rechazo
 *   definitivo, con su motivo. El contrato manda marcarlas `FAILED` sin reintentar
 *   y sin arrastrar a las demas derrotas;
 * - `404`, `503`, tiempo agotado, error de red o respuesta que no cumple el
 *   contrato: desconocido. NO autoriza a suponer que no se acredito.
 *
 * UN `200` CON LA PROGRESION ILEGIBLE SIGUE SIENDO UNA ACREDITACION. El `200` y la
 * clave dicen que la experiencia entro; que el cuerpo no traiga el nivel solo
 * impide CONTARLO. Por eso el desenlace es `CREDITED` con `progression: null` y se
 * informa del cuerpo raro: dar la acreditacion por fallida seria decir que el
 * inventario del jugador no cambio cuando si cambio.
 */
export class PlayerInventoryExperienceClient implements ExperienceCreditPort {
  constructor(private readonly options: PlayerInventoryClientOptions) {}

  async credit(request: ExperienceCreditRequest): Promise<ExperienceCreditOutcome> {
    const path = pathOf(request)
    const response = await signedPost(this.options, path, {
      schemaVersion: 1,
      operationId: request.operationId,
      amount: request.amount,
      source: { ...request.source },
    })

    if (response === null) {
      return { kind: 'UNKNOWN', reason: 'NETWORK' }
    }

    const body = await readJson(response)

    if (response.status === 200) {
      if (isRecord(body) && body.operationId === request.operationId) {
        const progression = readHeroProgression(body)

        if (progression === null) {
          this.fail('player_inventory_progresion_ilegible', { path: CREDITS_PATH, status: 200 })
        }

        return { kind: 'CREDITED', progression }
      }

      this.fail('player_inventory_respuesta_invalida', { path: CREDITS_PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 409 ||
      response.status === 422
    ) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null

      this.fail('player_inventory_acreditacion_rechazada', {
        path: CREDITS_PATH,
        status: response.status,
        code,
      })

      return { kind: 'REJECTED', reason: code ?? `HTTP_${String(response.status)}` }
    }

    this.fail('player_inventory_acreditacion_sin_confirmar', {
      path: CREDITS_PATH,
      status: response.status,
    })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: FailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
