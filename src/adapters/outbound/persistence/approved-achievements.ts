import type { AchievementDefinition } from '../../../domain/entities/Achievement'

/**
 * El catalogo APROBADO de logros de misiones (HU-76), el que se carga fuera del
 * ejemplo, tambien en produccion. Esta vacio hasta que el PO fije el catalogo
 * (decision 1 del diseno): mientras tanto no se evalua ni se muestra ningun logro
 * y `GET /api/v1/missions/me/achievements` responde `{ items: [] }`.
 *
 * Al rellenarlo cambia la huella y se evalua a todos los jugadores: lo que ya se
 * cumplia se otorga de forma retroactiva y nada se revoca (P-L5). Se recomienda
 * empezar solo con titulos e insignias: Player/Inventory aun no acepta a
 * `missions` y Catalog no tiene un tipo cosmetico.
 */
export const APPROVED_ACHIEVEMENTS: readonly AchievementDefinition[] = []
