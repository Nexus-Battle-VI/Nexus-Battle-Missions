import type {
  HeroAbilitiesOutcome,
  HeroAbilitiesPort,
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
 */
export class InMemoryHeroAbilities implements HeroAbilitiesPort {
  private readonly abilityIds: ReadonlySet<string>

  constructor(abilityIds: readonly string[] = EXAMPLE_HERO_ABILITIES) {
    this.abilityIds = new Set(abilityIds)
  }

  abilitiesOf(): Promise<HeroAbilitiesOutcome> {
    return Promise.resolve({ kind: 'FOUND', abilityIds: this.abilityIds })
  }
}
