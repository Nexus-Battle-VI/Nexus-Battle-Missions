/**
 * Vocabulario del tablon de misiones (HU-70, seccion 7.8.2 y 7.8.7 del curso).
 *
 * Son listas cerradas: la base de datos repite las categorias en un CHECK y el
 * contrato hu-70-mission-enrollment-v1 las publica tal cual.
 */
export const MISSION_CATEGORIES = ['STORY', 'CHALLENGE', 'EXPLORATION'] as const

export type MissionCategory = (typeof MISSION_CATEGORIES)[number]

export const isMissionCategory = (value: string): value is MissionCategory =>
  (MISSION_CATEGORIES as readonly string[]).includes(value)

/**
 * Estado de una mision PARA UN JUGADOR. La definicion de la mision no tiene
 * estado propio: se deriva de sus requisitos y de las matriculas del jugador
 * (diseno de HU-70, «Estado de la mision para el jugador»).
 *
 * `FAILED` y `ABANDONED` los producen HU-72 y la cancelacion; HU-70 solo los
 * reserva en el vocabulario.
 */
export const PLAYER_MISSION_STATUSES = [
  'AVAILABLE',
  'LOCKED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'ABANDONED',
] as const

export type PlayerMissionStatus = (typeof PLAYER_MISSION_STATUSES)[number]

/**
 * Duracion estimada en el formato del contrato (ISO-8601, `PT12H`, `PT1H30M`).
 * Se guarda en minutos enteros para no arrastrar redondeos.
 */
export const toIsoDuration = (minutes: number): string => {
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new RangeError('La duracion de una mision debe ser un numero entero positivo de minutos.')
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return `PT${hours > 0 ? `${String(hours)}H` : ''}${rest > 0 ? `${String(rest)}M` : ''}`
}
