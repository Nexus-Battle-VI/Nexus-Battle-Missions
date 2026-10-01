import type { HeroProgressionSnapshot } from '../../domain/value-objects/hero-progression'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'

/**
 * XP de FINALIZACION en Player/Inventory (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §8). Es la MISMA ruta que HU-09 con un
 * origen distinto (`source.kind = MISSION_COMPLETION`), pero un puerto PROPIO:
 * la clasificacion de errores difiere de HU-09 en `401` (aqui es reintentable,
 * en HU-09 es rechazo terminal, contrato §13) y mezclar los dos puertos habria
 * obligado a tocar esa clasificacion o a bifurcarla con un parametro. `HU-09 NO SE
 * TOCA`.
 */
export interface CompletionExperienceCreditRequest {
  /** `mission:{enrollmentId}:reward:completion:xp`. Determinista: un reintento no acredita dos veces. */
  readonly operationId: string
  readonly playerId: string
  readonly heroId: string
  /** Entero no negativo, ya congelado por `CompletionRewardPolicy`. */
  readonly amount: number
  readonly source: {
    readonly kind: 'MISSION_COMPLETION'
    readonly enrollmentId: string
    readonly missionId: string
    readonly simulationId: string
    readonly difficulty: DifficultyLevel
    readonly missionOutcome: 'COMPLETED' | 'FAILED'
  }
}

export type CompletionExperienceCreditOutcome =
  /**
   * `200` (`applied: true` o replay `applied: false`): acreditada. Con ella llega
   * la progresion del heroe que Player/Inventory devuelve; `null` si el cuerpo no
   * la trae en condiciones, y la acreditacion sigue siendo `CREDITED` de todos
   * modos (contrato §8.1: un `200` con progresion ilegible es igual que en HU-09).
   */
  | { readonly kind: 'CREDITED'; readonly progression: HeroProgressionSnapshot | null }
  /**
   * `400` (cuerpo fuera del contrato), `409` (mismo `operationId` con otro
   * contenido, que con un derecho congelado indica un defecto) o `422` (importe
   * invalido o heroe no acreditable): rechazo definitivo.
   */
  | { readonly kind: 'REJECTED'; readonly reason: string }
  /**
   * `503`, `401` (firma/servicio no valido -- de despliegue, no del derecho),
   * tiempo agotado, error de red o respuesta que no cumple el contrato: resultado
   * incierto. NO autoriza a suponer que no se acredito.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface CompletionExperienceCreditPort {
  credit(request: CompletionExperienceCreditRequest): Promise<CompletionExperienceCreditOutcome>
}

export const COMPLETION_EXPERIENCE_CREDITS = Symbol('CompletionExperienceCreditPort')
