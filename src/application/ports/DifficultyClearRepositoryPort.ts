import type { MissionDifficultyClear } from '../../domain/entities/MissionDifficultyClear'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'

export const DIFFICULTY_CLEAR_REPOSITORY = Symbol('DifficultyClearRepositoryPort')

/**
 * Historial de niveles completados por jugador y mision (HU-75). Missions es su
 * unico dueno (ADR-019): ningun otro servicio lo lee ni lo escribe.
 */
export interface DifficultyClearRepositoryPort {
  /** Niveles que ESE jugador completo al menos una vez en ESA mision. */
  clearedLevels(playerId: string, missionId: string): Promise<ReadonlySet<DifficultyLevel>>

  /**
   * Registra un nivel completado. Idempotente: repetir el mismo jugador, mision
   * y nivel no duplica nada y conserva la fecha del primero. Devuelve `true`
   * solo cuando el hecho era nuevo.
   *
   * Lo invocara HU-72 al terminar una simulacion con exito; hasta entonces no
   * tiene llamador de produccion.
   */
  record(clear: MissionDifficultyClear): Promise<boolean>
}
