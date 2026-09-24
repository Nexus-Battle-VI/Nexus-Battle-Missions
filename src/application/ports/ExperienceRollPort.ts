/**
 * Tirada autoritativa de experiencia en Combat (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §5.2).
 *
 * Missions NO tira el dado. `ADR-021` da la exclusiva de la aleatoriedad a
 * Combat, y esta operacion es la unica puerta por la que Missions la pide: no
 * acepta rango, no devuelve el indice ni la semilla, y es idempotente por
 * `operationId`.
 *
 * SE PIDE UN LOTE POR MISION, con la clave `mission:{enrollmentId}:xp-rolls`, y
 * dentro van TODAS las derrotas de esa mision: la respuesta trae una cara por
 * cada una, en el mismo orden. Una tirada por NPC derrotado, no una por mision.
 *
 * LA RESPUESTA NO SE INTERPRETA COMO IMPORTE. Combat devuelve la cara del dado;
 * la formula `10 x 1,2^(1d8)` es de Missions (`ExperienceRewardPolicy`).
 */
export interface ExperienceRollDefeatRequest {
  /** Encuentro dentro de la mision, tal como lo registra la bitacora de HU-72. */
  readonly encounterId: string
  /** Instancia concreta del enemigo: `<enemyRef>#<n>`. */
  readonly enemyInstanceId: string
  /** Arquetipo del enemigo. Trazabilidad; no identifica la derrota. */
  readonly rivalRef: string
}

export interface ExperienceRollRequest {
  readonly operationId: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly ExperienceRollDefeatRequest[]
}

/** La cara que Combat persistio para una derrota. */
export interface ExperienceRollResult {
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly roll: number
}

export type ExperienceRollOutcome =
  | { readonly kind: 'ROLLED'; readonly rolls: readonly ExperienceRollResult[] }
  /**
   * `400`, `401`, `409` o `422`: reintentar con el MISMO cuerpo no cambia nada.
   * El contrato manda marcarlas `FAILED` y alertar; no se reintentan solas.
   */
  | { readonly kind: 'REJECTED'; readonly reason: string }
  /**
   * `503`, tiempo agotado, error de red o respuesta que no cumple el contrato.
   * NO autoriza a suponer que no hubo tirada: se reintenta con el MISMO
   * `operationId`, y el replay de Combat devuelve las mismas caras.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface ExperienceRollPort {
  rollDefeats(request: ExperienceRollRequest): Promise<ExperienceRollOutcome>
}

export const EXPERIENCE_ROLLS = Symbol('ExperienceRollPort')
