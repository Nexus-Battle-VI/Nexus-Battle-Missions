import { DomainError } from '../errors/DomainError'
import {
  DIFFICULTY_LEVELS,
  displayNameOf,
  previousLevelOf,
  type DifficultyLevel,
} from '../value-objects/difficulty-level'

/**
 * Politica de desbloqueo de HU-75 (RF-75, CA-02 y CA-03).
 *
 * Regla literal de la HU y del documento del curso (7.8.11): para acceder a un
 * nivel hay que haber completado AL MENOS UNA VEZ el nivel INMEDIATAMENTE
 * inferior. Normal esta siempre disponible (propuesta P-D2 del diseno).
 *
 * `clears` son los niveles que ESTE jugador completo en ESTA mision. La politica
 * no conoce jugadores ni misiones: quien la invoca le pasa solo los hechos que
 * corresponden, y por eso un nivel completado en otra mision o por otro jugador
 * no puede desbloquear nada aqui.
 *
 * Funciones puras: sin reloj, sin persistencia y sin aleatoriedad.
 */
export interface DifficultyAvailability {
  readonly difficulty: DifficultyLevel
  readonly unlocked: boolean
  /** Nivel que falta completar. `null` cuando el nivel esta disponible. */
  readonly required: DifficultyLevel | null
  /** Motivo para el jugador. `null` cuando el nivel esta disponible. */
  readonly lockReason: string | null
}

export const evaluateDifficulty = (
  requested: DifficultyLevel,
  clears: ReadonlySet<DifficultyLevel>,
): DifficultyAvailability => {
  const required = previousLevelOf(requested)

  if (required === null || clears.has(required)) {
    return { difficulty: requested, unlocked: true, required: null, lockReason: null }
  }

  return {
    difficulty: requested,
    unlocked: false,
    required,
    lockReason: `Debes completar esta misión en ${displayNameOf(required)} al menos una vez.`,
  }
}

/** Los cuatro niveles, en orden de desbloqueo, evaluados contra los mismos hechos. */
export const evaluateAllDifficulties = (
  clears: ReadonlySet<DifficultyLevel>,
): readonly DifficultyAvailability[] =>
  DIFFICULTY_LEVELS.map((level) => evaluateDifficulty(level, clears))

/** Progresion insuficiente (`PROGRESSION_LOCKED` en el contrato). */
export class ProgressionLockedError extends DomainError {
  constructor(
    readonly missionId: string,
    readonly requested: DifficultyLevel,
    readonly required: DifficultyLevel,
  ) {
    super(
      `No puedes iniciar esta misión en ${displayNameOf(requested)}: ` +
        `primero complétala en ${displayNameOf(required)}.`,
    )
    this.name = 'ProgressionLockedError'
  }
}

/**
 * Validacion que la matricula de HU-70 debe invocar ANTES de escribir nada: si
 * el nivel no esta desbloqueado, rechaza y la matricula no se persiste.
 */
export const assertDifficultyUnlocked = (
  missionId: string,
  requested: DifficultyLevel,
  clears: ReadonlySet<DifficultyLevel>,
): void => {
  const { required } = evaluateDifficulty(requested, clears)

  if (required !== null) {
    throw new ProgressionLockedError(missionId, requested, required)
  }
}
