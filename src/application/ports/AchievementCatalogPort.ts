import type { AchievementDefinition } from '../../domain/entities/Achievement'

/**
 * Catalogo de logros de misiones (HU-76). Hoy vive en codigo y se valida al
 * arrancar; es asincrono para poder cargarlo despues de una tabla sin tocar los
 * casos de uso (P-L1). El catalogo definitivo lo decide el PO (decision 1).
 */
export interface AchievementCatalogPort {
  /** Las definiciones vigentes, en el orden en que se muestran. */
  list(): Promise<readonly AchievementDefinition[]>
}

export const ACHIEVEMENT_CATALOG = Symbol('AchievementCatalogPort')
