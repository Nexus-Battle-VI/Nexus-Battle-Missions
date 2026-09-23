import type {
  HeroAbilitiesOutcome,
  HeroAbilitiesPort,
  HeroProfileOutcome,
  HeroProfilePort,
} from '../../../application/ports/HeroAbilitiesPort'

/**
 * Habilidades del ejemplo del curso (Guerrero Armas, seccion 7.8.5). Los ids son
 * legibles solo para desarrollo: los reales son `productId` de Catalog.
 */
export const EXAMPLE_HERO_ABILITIES: readonly string[] = [
  'golpe-de-tormenta',
  'embate-sangriento',
  'lanza-de-los-dioses',
]

/**
 * Doble de desarrollo (`HERO_ABILITIES_DRIVER=memory`): todo heroe es del
 * jugador y tiene las mismas habilidades. Prohibido en produccion, donde la
 * validacion la da Player/Inventory.
 *
 * Su perfil (HU-72) solo trae el heroe y esas habilidades: el doble de Combat
 * no lo lee.
 */
export class InMemoryHeroAbilities implements HeroAbilitiesPort, HeroProfilePort {
  private readonly abilityIds: ReadonlySet<string>

  constructor(abilityIds: readonly string[] = EXAMPLE_HERO_ABILITIES) {
    this.abilityIds = new Set(abilityIds)
  }

  abilitiesOf(): Promise<HeroAbilitiesOutcome> {
    return Promise.resolve({ kind: 'FOUND', abilityIds: this.abilityIds })
  }

  profileOf(_playerId: string, heroId: string): Promise<HeroProfileOutcome> {
    return Promise.resolve({
      kind: 'FOUND',
      profile: {
        heroId,
        abilities: [...this.abilityIds].map((abilityId) => ({ abilityId })),
      },
    })
  }
}
