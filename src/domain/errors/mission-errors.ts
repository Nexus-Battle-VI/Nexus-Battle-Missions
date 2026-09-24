import { DomainError } from './DomainError'

/**
 * Errores de la matricula (HU-70, contrato hu-70-mission-enrollment-v1). Cada
 * uno corresponde a un `code` estable del contrato; la traduccion a HTTP vive en
 * `missions-error.mapper.ts`. Los mensajes son los que ve el jugador.
 */

/** `404 MISSION_NOT_FOUND`: no existe o no esta activa. */
export class MissionNotFoundError extends DomainError {
  constructor(readonly missionId: string) {
    super('La misión no existe o ya no está disponible.')
    this.name = 'MissionNotFoundError'
  }
}

/**
 * `404 ENROLLMENT_NOT_FOUND` (diseno «misiones jugables», P-J6): la matricula no
 * existe o no es del jugador. Son el mismo caso para no revelar las ajenas.
 */
export class EnrollmentNotFoundError extends DomainError {
  constructor(readonly enrollmentId: string) {
    super('Esa misión no existe o no es tuya.')
    this.name = 'EnrollmentNotFoundError'
  }
}

/** `422 MISSION_LOCKED` (CA-07): faltan misiones previas. */
export class MissionLockedError extends DomainError {
  constructor(
    readonly missionId: string,
    readonly missingPrerequisites: readonly string[],
    message: string,
  ) {
    super(message)
    this.name = 'MissionLockedError'
  }
}

/**
 * `409 MISSION_ALREADY_IN_PROGRESS` (propuesta P-M2). `enrollmentId` es `null`
 * si la matricula activa termino entre el conflicto y su lectura.
 */
export class MissionAlreadyInProgressError extends DomainError {
  constructor(
    readonly missionId: string,
    readonly enrollmentId: string | null,
  ) {
    super('Ya tienes esta misión en curso.')
    this.name = 'MissionAlreadyInProgressError'
  }
}

export type BusyWith = 'MISSION' | 'BATTLE' | 'TOURNAMENT' | 'AUCTION'

const BUSY_MESSAGE: Readonly<Record<BusyWith, string>> = {
  MISSION: 'Este héroe ya está en otra misión.',
  BATTLE: 'Este héroe está en una batalla.',
  TOURNAMENT: 'Este héroe está inscrito en un torneo activo.',
  AUCTION: 'Este héroe está comprometido en una subasta.',
}

/** `409 HERO_BUSY` (CA-02, CA-03). `busyWith` es `null` si el dueño no lo informa. */
export class HeroBusyError extends DomainError {
  constructor(
    readonly heroId: string,
    readonly busyWith: BusyWith | null,
  ) {
    super(busyWith === null ? 'Este héroe no está disponible ahora.' : BUSY_MESSAGE[busyWith])
    this.name = 'HeroBusyError'
  }
}

/** `422 HERO_NOT_OWNED`. */
export class HeroNotOwnedError extends DomainError {
  constructor(readonly heroId: string) {
    super('Ese héroe no está en tu inventario.')
    this.name = 'HeroNotOwnedError'
  }
}

export interface ReadinessBlocker {
  readonly code: string
  readonly slot: string | null
}

/** `422 HERO_NOT_READY`: bloqueos de readiness de Player/Inventory. */
export class HeroNotReadyError extends DomainError {
  constructor(readonly blockers: readonly ReadinessBlocker[]) {
    super('Tu héroe no está listo: revisa su equipamiento.')
    this.name = 'HeroNotReadyError'
  }
}

export interface MissingSlot {
  readonly family: string
  readonly missing: number
}

/** `422 LOADOUT_INCOMPLETE` (CA-04). Que es «mazo completo» sigue pendiente del PO. */
export class LoadoutIncompleteError extends DomainError {
  constructor(readonly missingSlots: readonly MissingSlot[]) {
    super('Tu héroe necesita el mazo completo para iniciar la misión.')
    this.name = 'LoadoutIncompleteError'
  }
}

/** `409 IDEMPOTENCY_KEY_REUSED`: misma clave con otro cuerpo u otra mision. */
export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super('Esa clave de solicitud ya se usó para otra matrícula.')
    this.name = 'IdempotencyKeyReusedError'
  }
}

/** `409 ENROLLMENT_EXPIRED`: la matricula de esa clave caduco sin confirmarse. */
export class EnrollmentExpiredError extends DomainError {
  constructor(readonly enrollmentId: string) {
    super('No se pudo reservar al héroe a tiempo. Vuelve a iniciar la misión.')
    this.name = 'EnrollmentExpiredError'
  }
}

/**
 * `503 DEPENDENCY_UNAVAILABLE` con la matricula en `PENDING`: Player/Inventory
 * no confirmo la reserva y el resultado es desconocido (ADR-019).
 */
export class EnrollmentPendingError extends DomainError {
  constructor(readonly enrollmentId: string) {
    super('No pudimos confirmar la reserva del héroe. Vuelve a intentarlo en unos segundos.')
    this.name = 'EnrollmentPendingError'
  }
}

/** `409 STRATEGY_VERSION_MISMATCH` (extension de HU-71). */
export class StrategyVersionMismatchError extends DomainError {
  constructor(
    readonly expectedVersion: number | null,
    readonly currentVersion: number | null,
  ) {
    super('Tu estrategia cambió. Revísala antes de iniciar la misión.')
    this.name = 'StrategyVersionMismatchError'
  }
}

/**
 * `503 ESTIMATE_UNAVAILABLE` (diseno «misiones jugables», P-J7): no hubo
 * estimacion. No bloquea nada: el jugador puede enviar al heroe sin ella.
 */
export class EstimateUnavailableError extends DomainError {
  constructor(readonly reason: string) {
    super('No pudimos calcular la probabilidad de éxito ahora. Puedes enviar al héroe igual.')
    this.name = 'EstimateUnavailableError'
  }
}
