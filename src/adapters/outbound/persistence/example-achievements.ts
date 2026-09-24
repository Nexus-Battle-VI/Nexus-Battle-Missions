import type { AchievementDefinition } from '../../../domain/entities/Achievement'
import { APPROVED_ACHIEVEMENTS } from './approved-achievements'

/**
 * Logros para desarrollo (`MISSIONS_EXAMPLE_CATALOG=true`, solo con persistencia
 * en memoria). Desde que el PO aprobo los siete del contrato
 * hu-76-mission-achievements-v1 (2026-09-24), el ejemplo es el mismo catalogo
 * aprobado, en su orden.
 *
 * Con las misiones de ejemplo y el doble de Combat, «Sin un rasguño» se
 * desbloquea en la primera mision porque el doble nunca recibe dano: esa
 * evidencia no acredita CA-02 ni CA-03.
 */
export const EXAMPLE_ACHIEVEMENTS: readonly AchievementDefinition[] = APPROVED_ACHIEVEMENTS
