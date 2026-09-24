import { DomainError } from './DomainError'

/**
 * Errores de la estrategia de rotaciones (HU-71, contrato
 * hu-71-mission-strategy-v1). La traduccion a HTTP vive en
 * `missions-error.mapper.ts`. Los mensajes son los que ve el jugador.
 */

export type RotationViolationReason =
  | 'NO_ROTATIONS'
  | 'PRIORITY_REPEATED'
  | 'PRIORITY_GAP'
  | 'PRIORITY_ORDER'
  | 'EMPTY_ROTATION'
  | 'TOO_MANY_STEPS'

export interface RotationViolation {
  /** Campo del cuerpo recibido, p. ej. `rotations[1].priority`. */
  readonly field: string
  readonly reason: RotationViolationReason
}

/** `422 TOO_MANY_ROTATIONS` (CA-04). */
export class TooManyRotationsError extends DomainError {
  constructor(
    readonly max: number,
    readonly received: number,
  ) {
    super('Puedes configurar hasta tres rotaciones.')
    this.name = 'TooManyRotationsError'
  }
}

/** `422 INVALID_ROTATION`: prioridades repetidas, con huecos o desordenadas, o acciones de mas o de menos. */
export class InvalidRotationError extends DomainError {
  constructor(
    readonly violations: readonly RotationViolation[],
    message: string,
  ) {
    super(message)
    this.name = 'InvalidRotationError'
  }
}

/** `422 UNKNOWN_ABILITY`: habilidades que el heroe no tiene segun Player/Inventory (P-R4). */
export class UnknownAbilityError extends DomainError {
  constructor(
    readonly abilityIds: readonly string[],
    message: string,
  ) {
    super(message)
    this.name = 'UnknownAbilityError'
  }
}

/** `409 VERSION_CONFLICT`: otra sesion guardo la estrategia antes. */
export class StrategyVersionConflictError extends DomainError {
  constructor(
    readonly expectedVersion: number | null,
    readonly currentVersion: number | null,
  ) {
    super('Otra sesión cambió esta estrategia. Recárgala antes de guardar.')
    this.name = 'StrategyVersionConflictError'
  }
}

/** `404 STRATEGY_NOT_FOUND`. */
export class StrategyNotFoundError extends DomainError {
  constructor(
    readonly missionId: string,
    readonly heroId: string,
  ) {
    super('Todavía no guardaste una estrategia para este héroe en esta misión.')
    this.name = 'StrategyNotFoundError'
  }
}

/**
 * `503 DEPENDENCY_UNAVAILABLE`: Player/Inventory no respondio con las
 * habilidades del heroe. No se guarda sin validarlas.
 */
export class HeroAbilitiesUnavailableError extends DomainError {
  constructor() {
    super('No pudimos consultar las habilidades de tu héroe. Vuelve a intentarlo en unos segundos.')
    this.name = 'HeroAbilitiesUnavailableError'
  }
}
