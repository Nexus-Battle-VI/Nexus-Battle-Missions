import type {
  HeroAbilitiesOutcome,
  HeroAbilitiesPort,
  HeroProfileOutcome,
  HeroProfilePort,
} from '../../../application/ports/HeroAbilitiesPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../identity/internal-signature'
import { isRecord, readJson } from './json'
import type { FailureDetail, PlayerInventoryClientOptions } from './PlayerInventoryCommitmentClient'

type HeroLookup =
  | {
      readonly kind: 'FOUND'
      readonly abilityIds: ReadonlySet<string>
      readonly profile: Readonly<Record<string, unknown>>
    }
  | { readonly kind: 'NOT_OWNED' }
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

const SERVICE = 'missions'
/** Para el registro: la ruta sin los identificadores del jugador y del heroe. */
const ROUTE = 'GET /api/internal/v1/players/{playerId}/heroes/{heroId}'

/**
 * Las habilidades del cuerpo, o `null` si no cumple el contrato. No se inventa
 * un `[]`: con el cuerpo roto no se sabe que habilidades tiene el heroe.
 */
const abilityIdsOf = (body: unknown, heroId: string): ReadonlySet<string> | null => {
  if (
    !isRecord(body) ||
    typeof body.heroId !== 'string' ||
    body.heroId.toLowerCase() !== heroId.toLowerCase() ||
    !Array.isArray(body.abilities)
  ) {
    return null
  }

  const abilityIds: string[] = []

  for (const ability of body.abilities as unknown[]) {
    if (!isRecord(ability) || typeof ability.abilityId !== 'string' || ability.abilityId === '') {
      return null
    }

    abilityIds.push(ability.abilityId)
  }

  return new Set(abilityIds)
}

/**
 * Habilidades de un heroe por `heroId` en Player/Inventory (HU-71, decision 7
 * del diseno). **Propuesta para Team Alfa: la ruta todavia no existe.** Hoy
 * Player/Inventory solo publica el heroe SELECCIONADO
 * (`GET /api/internal/v1/players/{playerId}/equipped-hero`, para Combat) y
 * `missions` no esta entre sus servicios autorizados. Se propone la misma forma
 * para cualquier heroe del jugador:
 *
 * - `GET /api/internal/v1/players/{playerId}/heroes/{heroId}`
 * - `200`: el cuerpo de `equipped-hero` (se leen `heroId` y `abilities[].abilityId`).
 * - `404` con `code: HERO_NOT_OWNED`: el heroe no es de ese jugador.
 *
 * Cualquier otra respuesta es un resultado desconocido y la estrategia no se
 * guarda (503). En particular, el `404` de la ruta inexistente no trae `code` y
 * no significa «no es suyo». El jugador y el heroe van en la ruta, y no en la
 * consulta, porque Player/Inventory firma la ruta sin la consulta.
 *
 * La misma ruta da el perfil de combate que HU-72 congela en la solicitud de
 * simulacion (decision 10 del diseno de HU-72): Missions no lo interpreta.
 */
export class PlayerInventoryAbilitiesClient implements HeroAbilitiesPort, HeroProfilePort {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: PlayerInventoryClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async abilitiesOf(playerId: string, heroId: string): Promise<HeroAbilitiesOutcome> {
    const hero = await this.lookup(playerId, heroId)

    return hero.kind === 'FOUND' ? { kind: 'FOUND', abilityIds: hero.abilityIds } : hero
  }

  async profileOf(playerId: string, heroId: string): Promise<HeroProfileOutcome> {
    const hero = await this.lookup(playerId, heroId)

    return hero.kind === 'FOUND' ? { kind: 'FOUND', profile: hero.profile } : hero
  }

  private async lookup(playerId: string, heroId: string): Promise<HeroLookup> {
    const path = `/api/internal/v1/players/${encodeURIComponent(playerId)}/heroes/${encodeURIComponent(heroId)}`
    const timestamp = String(this.options.clock.now().getTime())
    // Un GET se firma con cuerpo vacio, como verifica Player/Inventory.
    const signature = signInternalRequest(this.options.secret, {
      service: SERVICE,
      method: 'GET',
      path,
      timestamp,
      body: {},
    })
    let response: Response

    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [INTERNAL_SERVICE_HEADER]: SERVICE,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      this.fail('player_inventory_inalcanzable', {
        route: ROUTE,
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      return { kind: 'UNKNOWN', reason: 'NETWORK' }
    }

    const body = await readJson(response)

    if (response.status === 200) {
      const abilityIds = abilityIdsOf(body, heroId)

      if (abilityIds !== null && isRecord(body)) {
        return { kind: 'FOUND', abilityIds, profile: body }
      }

      this.fail('player_inventory_respuesta_invalida', { route: ROUTE, status: 200 })

      return { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' }
    }

    if (response.status === 404 && isRecord(body) && body.code === 'HERO_NOT_OWNED') {
      return { kind: 'NOT_OWNED' }
    }

    this.fail('player_inventory_sin_habilidades', { route: ROUTE, status: response.status })

    return { kind: 'UNKNOWN', reason: `HTTP_${String(response.status)}` }
  }

  private fail(event: string, detail: FailureDetail): void {
    this.options.onFailure?.(event, detail)
  }
}
