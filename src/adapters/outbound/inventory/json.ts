/** Utilidades de los clientes de Player/Inventory para leer cuerpos que no controlamos. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** El cuerpo JSON de la respuesta, o `null` si no lo es: nunca lanza. */
export const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}
