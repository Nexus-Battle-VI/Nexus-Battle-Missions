import type { HeroProgressionSnapshot } from '../value-objects/hero-progression'

/**
 * Lectura de la progresion que devuelve Player/Inventory (HU-09, Task HU-09.5;
 * `hu-09-experience-reward-v1` §7).
 *
 * EL `200` ES LA VERDAD Y NO SE CUESTIONA AQUI. Que la acreditacion ocurrio lo
 * deciden el codigo de estado y la clave de la operacion, no la forma del cuerpo;
 * esto solo decide si ADEMAS se puede contar la progresion. Un cuerpo sin ella
 * deja `null`, y el reporte publicara la linea acreditada con su importe y sin
 * nivel, en lugar de inventar un nivel o de dar por fallida una acreditacion que
 * si ocurrio -- darla por fallida seria mentir sobre el inventario del jugador.
 *
 * ENTRADA NO CONFIABLE, como la bitacora de HU-72: se comprueba campo a campo y
 * cualquier incoherencia (un nivel por encima del tope, un decimal, un negativo)
 * invalida la lectura entera. Media progresion no vale: el nivel y la experiencia
 * acumulada se contradirian.
 */
export const readHeroProgression = (body: unknown): HeroProgressionSnapshot | null => {
  if (typeof body !== 'object' || body === null) {
    return null
  }

  const source = body as Record<string, unknown>
  const level = countOf(source.level, 1)
  const currentXp = countOf(source.currentXp, 0)
  const maxLevel = countOf(source.maxLevel, 1)
  const levelsGained = countOf(source.levelsGained, 0)

  if (level === null || currentXp === null || maxLevel === null || levelsGained === null) {
    return null
  }

  // Un nivel por encima del tope que el propio servicio declara es incoherente.
  if (level > maxLevel) {
    return null
  }

  return { level, currentXp, maxLevel, levelsGained }
}

/** Un entero (`min` inclusive) o `null`; un decimal o un texto no valen. */
const countOf = (value: unknown, min: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null
