import { DomainError } from '../errors/DomainError'

/**
 * Formula de la recompensa de experiencia por derrota de un NPC (HU-09,
 * `hu-09-experience-reward-v1` §6). Task HU-09.4.
 *
 * VIVE AQUI Y EN NINGUN OTRO SITIO. El contrato lo dice de forma explicita: el
 * dueno unico de la formula es Missions, y no se reproduce en Combat ni en
 * Player/Inventory. Combat devuelve la cara del dado; Player/Inventory recibe el
 * importe ya calculado. Una prueba estatica comprueba que la expresion no
 * aparece en ningun otro fichero.
 *
 * ES UNA FUNCION PURA: no lee, no escribe, no conoce el reloj, la red ni la base
 * de datos, no muta su entrada y no guarda estado. La misma cara produce siempre
 * el mismo importe.
 *
 * EL REDONDEO ES PROVISIONAL Y ESTA AISLADO A PROPOSITO. `P-2` del contrato
 * sigue abierto: el PO describio el redondeo al entero mas proximo y ofrecio el
 * truncamiento como alternativa. Mientras no haya decision escrita, la regla vive
 * en esta unica funcion -- `Math.round` -- para que confirmarla no toque nada
 * mas. Los dos juegos de valores, para que la diferencia se vea:
 *
 *   cara        1   2   3    4      5      6       7       8
 *   exacto     12  14,4 17,28 20,736 24,8832 29,85984 35,831808 42,9981696
 *   al proximo 12  14  17   21     25     30      36      43      <- esta funcion
 *   truncado   12  14  17   20     24     29      35      42
 *
 * LA EXPERIENCIA QUE CRUZA LA FRONTERA ES SIEMPRE ENTERA. La tabla de umbrales de
 * HU-08 esta en enteros y comparar un acumulado fraccionario con ella seria una
 * fuente de errores de frontera imposible de justificar. Por eso se redondea
 * AQUI, antes de llamar a Player/Inventory, y no alli.
 */

/** Caras del dado: `1d8`. */
export const EXPERIENCE_ROLL_FACES = 8

/** Base de la formula: `10 x 1,2^(1d8)`. */
export const EXPERIENCE_REWARD_BASE = 10

/** Razon de crecimiento de la formula. */
export const EXPERIENCE_REWARD_GROWTH = 1.2

/** `true` solo si el valor es una cara posible del dado. */
export const isExperienceRoll = (roll: unknown): roll is number =>
  typeof roll === 'number' && Number.isInteger(roll) && roll >= 1 && roll <= EXPERIENCE_ROLL_FACES

/**
 * Experiencia que otorga una cara del dado, redondeada a entero.
 *
 * `roll` es `unknown` a proposito: obliga a validar en la frontera, donde el
 * dato viene de la respuesta de otro servicio. Una cara fuera de `1..8` es un
 * error de quien llama -- no un valor que se pueda normalizar en silencio -- y
 * se rechaza diciendo cual.
 */
export const experienceForRoll = (roll: unknown): number => {
  if (!isExperienceRoll(roll)) {
    throw new DomainError(
      `La tirada de experiencia debe ser un entero entre 1 y ${String(EXPERIENCE_ROLL_FACES)}. Se recibio ${describe(roll)}.`,
    )
  }

  return Math.round(EXPERIENCE_REWARD_BASE * EXPERIENCE_REWARD_GROWTH ** roll)
}

/**
 * Clave del lote de tiradas de una mision: `mission:{enrollmentId}:xp-rolls`.
 *
 * Es determinista y la calcula Missions, que es quien conoce la matriculacion.
 * Combat no la inventa: la recibe. Repetir el cierre de una mision, o reintentar
 * tras una caida, reutiliza la MISMA clave y por tanto no produce tiradas nuevas.
 */
export const experienceRollsOperationId = (enrollmentId: string): string =>
  `mission:${requireText(enrollmentId, 'El lote de tiradas necesita una matriculacion.')}:xp-rolls`

/**
 * Clave de la acreditacion de UNA derrota:
 * `mission:{enrollmentId}:encounter:{encounterId}:enemy:{enemyInstanceId}:hero:{heroId}:xp`.
 *
 * Lleva la INSTANCIA real de la derrota (encuentro + enemigo concreto), nunca el
 * arquetipo: una mision puede enfrentar dos veces al mismo tipo de enemigo y cada
 * una es una recompensa. Lleva tambien el heroe porque la misma derrota acreditada
 * a otro heroe seria otra acreditacion.
 */
export const experienceCreditOperationId = (parts: {
  readonly enrollmentId: string
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly heroId: string
}): string =>
  [
    'mission',
    requireText(parts.enrollmentId, 'La acreditacion necesita una matriculacion.'),
    'encounter',
    requireText(parts.encounterId, 'La acreditacion necesita un encuentro.'),
    'enemy',
    requireText(parts.enemyInstanceId, 'La acreditacion necesita un enemigo.'),
    'hero',
    requireText(parts.heroId, 'La acreditacion necesita un heroe.'),
    'xp',
  ].join(':')

/**
 * Identidad de una derrota dentro de una mision: encuentro + instancia. Es la
 * clave con la que se pide la tirada a Combat y la que hace unica a la recompensa.
 */
export const defeatKeyOf = (defeat: {
  readonly encounterId: string
  readonly enemyInstanceId: string
}): string => `${defeat.encounterId}:${defeat.enemyInstanceId}`

/** Rechaza cadenas vacias o en blanco sin recortar el valor por sorpresa. */
const requireText = (raw: unknown, message: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError(message)
  }

  return raw.trim()
}

/** Representacion legible de un valor rechazado, sin volcar objetos enteros. */
const describe = (raw: unknown): string => {
  if (typeof raw === 'number') return String(raw)
  if (typeof raw === 'string') return `"${raw}"`
  if (raw === null) return 'null'
  return typeof raw
}
