import { DomainError } from './DomainError'

/**
 * Por que no vale un catalogo de logros (HU-76). El catalogo vive en codigo y se
 * valida al arrancar: un logro mal definido impide arrancar el servicio en
 * lugar de otorgarse mal o no otorgarse nunca.
 */
export const ACHIEVEMENT_CATALOG_REASONS = [
  'INVALID_ID',
  'DUPLICATE_ID',
  'INVALID_VERSION',
  'INVALID_NAME',
  'UNKNOWN_CRITERION',
  'INVALID_CATEGORY',
  'INVALID_COUNT',
  'INVALID_RECORD_PARAMS',
  'INVALID_EPIC_STATE',
  'INVALID_RECOGNITION',
] as const

export type AchievementCatalogReason = (typeof ACHIEVEMENT_CATALOG_REASONS)[number]

/** Solo se lanza al cargar el catalogo; no llega a ninguna respuesta HTTP. */
export class InvalidAchievementCatalogError extends DomainError {
  constructor(
    readonly achievementId: string | null,
    readonly reason: AchievementCatalogReason,
  ) {
    super(`El logro ${achievementId ?? '(sin id)'} del catalogo no es valido: ${reason}.`)
    this.name = 'InvalidAchievementCatalogError'
  }
}
