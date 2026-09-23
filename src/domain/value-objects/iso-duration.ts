/**
 * Duraciones ISO-8601 que informa Combat (`simulatedDuration`, HU-72). Solo se
 * admiten dias, horas, minutos y segundos: anos, meses y semanas no tienen una
 * duracion fija en segundos y Combat no los usa.
 */
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

/** Segundos de una duracion como `PT9H40M`, o `null` si no tiene esa forma. */
export const isoDurationSeconds = (value: string): number | null => {
  const match = ISO_DURATION.exec(value)

  // `P` y `PT` a secas casan con el patron, pero no dicen ninguna duracion.
  if (match === null || value === 'P' || value.endsWith('T')) {
    return null
  }

  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match

  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
}
