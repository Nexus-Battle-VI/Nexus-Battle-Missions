/**
 * Progresion del heroe que Player/Inventory devuelve con la acreditacion de
 * experiencia (HU-09, Task HU-09.5; `hu-09-experience-reward-v1` §7).
 *
 * MISSIONS NO CALCULA NIVELES. La tabla de HU-08 y su redondeo viven en
 * Player/Inventory, que es su dueno (`ADR-019`); aqui solo se GUARDA lo que la
 * acreditacion devuelve, para que el reporte de HU-74 pueda contar la subida de
 * nivel sin volver a preguntar por ella ni recalcularla.
 *
 * `leveledUp` NO SE GUARDA. Se deduce de `levelsGained` (> 0), y guardar un dato
 * que se deduce es abrir la puerta a que los dos se contradigan.
 */
export interface HeroProgressionSnapshot {
  /** Nivel del heroe DESPUES de esta acreditacion. */
  readonly level: number
  /** Experiencia ACUMULADA del heroe; solo crece, nunca se descuenta. */
  readonly currentXp: number
  /** Tope de nivel vigente: el reporte lo publica sin fijarlo en el codigo. */
  readonly maxLevel: number
  /** Niveles cruzados con ESTA acreditacion; `0` si no subio. */
  readonly levelsGained: number
}
