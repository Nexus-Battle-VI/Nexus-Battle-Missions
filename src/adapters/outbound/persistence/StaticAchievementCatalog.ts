import type { AchievementCatalogPort } from '../../../application/ports/AchievementCatalogPort'
import type { AchievementDefinition } from '../../../domain/entities/Achievement'
import { assertAchievementCatalog } from '../../../domain/policies/AchievementPolicy'

/**
 * Catalogo de logros en codigo (HU-76). Construirlo es cargarlo: un logro mal
 * definido falla aqui y el servicio no arranca, en lugar de otorgarse mal. Sin
 * definiciones no hay logros que evaluar ni que mostrar.
 */
export class StaticAchievementCatalog implements AchievementCatalogPort {
  private readonly definitions: readonly AchievementDefinition[]

  constructor(definitions: readonly AchievementDefinition[] = []) {
    assertAchievementCatalog(definitions)
    this.definitions = [...definitions]
  }

  list(): Promise<readonly AchievementDefinition[]> {
    return Promise.resolve([...this.definitions])
  }
}
