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
 * El perfil de desarrollo incluye estadisticas jugables para el motor real.
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
        name: 'Guerrero de prueba',
        subtype: 'GUERRERO_ARMAS',
        effectiveStats: {
          health: 40,
          power: 5,
          attack: 10,
          defense: 8,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          healing: null,
        },
        abilities: [...this.abilityIds].map((abilityId) => ({
          abilityId,
          name: abilityId.replaceAll('-', ' '),
          powerCost: { mode: 'FIXED', amount: 2 },
          chargeTurns: 2,
          effects: [
            {
              kind: 'STAT_MODIFIER',
              target: 'SELF',
              statistic: 'DAMAGE',
              operation: 'INCREASE',
              magnitude: { mode: 'FIXED', amount: 2 },
              hasActivationCondition: false,
            },
          ],
        })),
      },
    })
  }
}
