import type {
  CompletionExperienceCreditOutcome,
  CompletionExperienceCreditPort,
  CompletionExperienceCreditRequest,
} from '../../../application/ports/CompletionExperienceCreditPort'
import { readHeroProgression } from '../../../domain/policies/HeroProgressionPolicy'
import { isRecord, readJson } from './json'
import type { FailureDetail, PlayerInventoryClientOptions } from './PlayerInventoryCommitmentClient'
import { signedPost } from './signed-post'

const PATH = '/api/internal/v1/players'

const pathOf = (request: CompletionExperienceCreditRequest): string =>
  `${PATH}/${encodeURIComponent(request.playerId)}/heroes/${encodeURIComponent(request.heroId)}/experience`

/**
 * XP de finalizacion en Player/Inventory (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §8). MISMA ruta interna que HU-09
 * (`PlayerInventoryExperienceClient`), con `source.kind = MISSION_COMPLETION` y
 * SIN los campos de una derrota (`encounterId`, `enemyInstanceId`, `rivalRef`,
 * `roll`).
 *
 * UNICA DIVERGENCIA DELIBERADA CON EL CLIENTE DE HU-09: `401` aqui es
 * REINTENTABLE (`UNKNOWN`), no un rechazo terminal. Una firma invalida es un
 * problema de despliegue, no una razon para negarle la XP de finalizacion al
 * jugador (contrato §13). El cliente de HU-09 NO se toca.
 *
 * El resto de la clasificacion es la misma que HU-09: `200` acredita (o repite);
 * `400`/`409`/`422` son rechazo terminal; `503`, tiempo agotado, red o cuerpo
 * ilegible son inciertos.
 */
export class PlayerInventoryCompletionExperienceClient implements CompletionExperienceCreditPort {
  constructor(private readonly options: PlayerInventoryClientOptions) {}

  async credit(
    request: CompletionExperienceCreditRequest,
  ): Promise<CompletionExperienceCreditOutcome> {
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
          this.fail('player_inventory_completion_progresion_ilegible', { path: PATH, status: 200 })
        }

        return { kind: 'CREDITED', progression }
      }

      this.fail('player_inventory_completion_respuesta_invalida', { path: PATH, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (response.status === 400 || response.status === 409 || response.status === 422) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null

      this.fail('player_inventory_completion_rechazada', {
        path: PATH,
        status: response.status,
        code,
      })

      return { kind: 'REJECTED', reason: code ?? `HTTP_${String(response.status)}` }
    }

    // `401` incluido a proposito: aqui es reintentable, al reves que HU-09.
    this.fail('player_inventory_completion_sin_confirmar', { path: PATH, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: FailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
