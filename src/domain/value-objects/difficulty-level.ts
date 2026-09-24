import { DomainError } from '../errors/DomainError'

/**
 * Niveles de dificultad escalonada de una mision (HU-75, RF-75; seccion 7.8.11
 * del documento del curso).
 *
 * El orden de la lista ES el orden de desbloqueo. Es un vocabulario cerrado: la
 * base de datos lo repite en un CHECK para que un valor desconocido no pueda
 * persistirse aunque la aplicacion tuviera un error.
 *
 * No se usa la escala Facil/Normal/Dificil/Extremo del filtro del tablon (7.8.9):
 * el documento del curso usa las dos, y decidir su equivalencia corresponde al
 * PO, no al codigo.
 */
export const DIFFICULTY_LEVELS = ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'] as const

export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number]

/**
 * Nivel inmediatamente inferior: el que hay que haber completado para acceder a
 * cada uno. Tabla explicita en lugar de aritmetica sobre indices, para que la
 * matriz de transicion del diseno se lea aqui tal cual.
 */
const PREVIOUS_LEVEL: Readonly<Record<DifficultyLevel, DifficultyLevel | null>> = {
  NORMAL: null,
  HEROIC: 'NORMAL',
  LEGENDARY: 'HEROIC',
  MYTHIC: 'LEGENDARY',
}

/** Nombre que ve el jugador. Los codigos del contrato no se traducen. */
const DISPLAY_NAME: Readonly<Record<DifficultyLevel, string>> = {
  NORMAL: 'Normal',
  HEROIC: 'Heroico',
  LEGENDARY: 'Legendario',
  MYTHIC: 'Mítico',
}

/**
 * Valor fuera del vocabulario (`UNKNOWN_DIFFICULTY` en el contrato).
 *
 * El mensaje no repite lo recibido: es entrada del cliente y acabaria en la
 * respuesta. Queda en `received` para quien lo necesite registrar.
 */
export class UnknownDifficultyError extends DomainError {
  constructor(readonly received: string) {
    super(`La dificultad solicitada no existe. Valores admitidos: ${DIFFICULTY_LEVELS.join(', ')}.`)
    this.name = 'UnknownDifficultyError'
  }
}

export const isDifficultyLevel = (value: string): value is DifficultyLevel =>
  (DIFFICULTY_LEVELS as readonly string[]).includes(value)

export const parseDifficultyLevel = (value: string): DifficultyLevel => {
  if (!isDifficultyLevel(value)) {
    throw new UnknownDifficultyError(value)
  }

  return value
}

export const previousLevelOf = (level: DifficultyLevel): DifficultyLevel | null =>
  PREVIOUS_LEVEL[level]

export const displayNameOf = (level: DifficultyLevel): string => DISPLAY_NAME[level]
