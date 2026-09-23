/**
 * Habilidades de un heroe concreto segun Player/Inventory (HU-71, P-R4 y
 * decision 7 del diseno). `NOT_OWNED`: el heroe no es de ese jugador.
 * `UNKNOWN`: no hubo respuesta definitiva, y una estrategia no se guarda sin
 * validar sus habilidades.
 */
export type HeroAbilitiesOutcome =
  | { readonly kind: 'FOUND'; readonly abilityIds: ReadonlySet<string> }
  | { readonly kind: 'NOT_OWNED' }
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface HeroAbilitiesPort {
  abilitiesOf(playerId: string, heroId: string): Promise<HeroAbilitiesOutcome>
}

export const HERO_ABILITIES = Symbol('HeroAbilitiesPort')

/**
 * Perfil de combate del mismo heroe (HU-72, decision 10 del diseno): se congela
 * en la solicitud de simulacion y Missions no lo interpreta. Lo sirve la misma
 * ruta propuesta a Player/Inventory que las habilidades.
 */
export type HeroProfileOutcome =
  | { readonly kind: 'FOUND'; readonly profile: Readonly<Record<string, unknown>> }
  | { readonly kind: 'NOT_OWNED' }
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface HeroProfilePort {
  profileOf(playerId: string, heroId: string): Promise<HeroProfileOutcome>
}

export const HERO_PROFILES = Symbol('HeroProfilePort')
