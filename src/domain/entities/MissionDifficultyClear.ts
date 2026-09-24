import type { DifficultyLevel } from '../value-objects/difficulty-level'

/**
 * Hecho de HU-75: ESTE jugador completo ESTA mision en ESTE nivel al menos una
 * vez. Es lo unico que desbloquea el nivel siguiente; matricularse no lo hace.
 *
 * Lo registrara HU-72 cuando una simulacion termine con exito (propuesta P-D1:
 * solo `SUCCESS` cuenta; un fallo o un abandono no dejan hecho).
 *
 * `playerId` es el `sub` del proveedor de identidad y `missionId` la clave de la
 * mision del tablon de HU-70. Ninguno es clave foranea (ADR-005).
 */
export interface MissionDifficultyClear {
  readonly playerId: string
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  readonly completedAt: Date
}
