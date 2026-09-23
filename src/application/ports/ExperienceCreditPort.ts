/**
 * Acreditacion de experiencia en Player/Inventory (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §7).
 *
 * Missions NO escribe el estado del heroe: `ADR-019` se lo reserva a
 * Player/Inventory. Esta operacion es el unico camino por el que la experiencia
 * entra en un heroe, y se invoca UNA VEZ POR CADA DERROTA, con la clave de esa
 * derrota concreta -- nunca una sola vez con la suma, que perderia la traza y la
 * idempotencia por derrota.
 *
 * EL IMPORTE VA YA CALCULADO Y ENTERO. Player/Inventory no redondea: si recibiera
 * un decimal, lo rechaza. El redondeo ocurre en `ExperienceRewardPolicy`, antes
 * de cruzar la frontera.
 */
export interface ExperienceCreditRequest {
  /**
   * `mission:{enrollmentId}:encounter:{encounterId}:enemy:{enemyInstanceId}:hero:{heroId}:xp`.
   * Determinista: un reintento lleva la MISMA clave y no acredita dos veces.
   */
  readonly operationId: string
  readonly playerId: string
  readonly heroId: string
  /** Entero no negativo, ya redondeado por la politica de Missions. */
  readonly amount: number
  readonly source: {
    readonly kind: 'MISSION_RIVAL_DEFEAT'
    readonly enrollmentId: string
    readonly simulationId: string
    readonly encounterId: string
    readonly enemyInstanceId: string
    readonly rivalRef: string
    /** Cara del dado que produjo el importe. Trazabilidad. */
    readonly roll: number
  }
}

export type ExperienceCreditOutcome =
  /** `200`: acreditada, o repetida con el mismo `operationId` y el mismo cuerpo. */
  | { readonly kind: 'CREDITED' }
  /**
   * `400` (cuerpo fuera del contrato), `401` (firma), `409` (mismo `operationId`
   * con otro contenido) o `422` (importe invalido o heroe no acreditable):
   * reintentar con el MISMO cuerpo no cambia nada. El contrato manda marcarlas
   * `FAILED` con su motivo y alertar, SIN arrastrar a las demas derrotas.
   */
  | { readonly kind: 'REJECTED'; readonly reason: string }
  /**
   * `503`, tiempo agotado, error de red o respuesta que no cumple el contrato.
   * NO autoriza a suponer que no se acredito: se reintenta con el MISMO
   * `operationId`, y el replay de Player/Inventory devuelve el mismo resultado.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export interface ExperienceCreditPort {
  credit(request: ExperienceCreditRequest): Promise<ExperienceCreditOutcome>
}

export const EXPERIENCE_CREDITS = Symbol('ExperienceCreditPort')
