import { DomainError } from '../errors/DomainError'
import { retryDelayMs } from './MissionExecution'

/**
 * Evidencia del Master de una matricula (HU-73, propuesta P-X7): una fila por
 * punto de evaluacion, con su resultado, y la entrega de la epica cuando el
 * heroe derroto al Master. La guarda el cierre de HU-72 en su transaccion.
 */
export const MASTER_ENCOUNTER_STATUSES = [
  'NOT_APPLICABLE',
  'NOT_APPEARED',
  'APPEARED_DEFEATED',
  'APPEARED_HERO_DEFEATED',
  'APPEARED_ESCAPED',
  'SKIPPED_MAX_REACHED',
] as const

export type MasterEncounterStatus = (typeof MASTER_ENCOUNTER_STATUSES)[number]

/** Los estados en los que el Master aparecio: son los que llegan al reporte de HU-74. */
export const isAppearance = (status: MasterEncounterStatus): boolean =>
  status.startsWith('APPEARED_')

export const EPIC_GRANT_STATUSES = ['PENDING', 'GRANTED', 'REJECTED'] as const

export type EpicGrantStatus = (typeof EPIC_GRANT_STATUSES)[number]

/**
 * Entrega de la epica en Player/Inventory (P-X6). El `operationId` es
 * determinista: repetir el cierre o la llamada no entrega dos veces (M-7).
 */
export interface EpicGrant {
  readonly operationId: string
  readonly status: EpicGrantStatus
  /** Llamadas hechas; cada reintento espera un poco mas. */
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar. */
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
  readonly grantedAt: Date | null
  /** La linea `EPIC` del reporte de HU-74 que refleja la entrega. */
  readonly rewardLineNo: number | null
  /**
   * El producto de Catalog con que se pidio la entrega la primera vez. Queda
   * congelado: cada reintento lleva el mismo cuerpo aunque cambie el contenido,
   * o Player/Inventory responderia `409` para siempre. `null` hasta que exista.
   */
  readonly productId: string | null
}

export interface MasterEncounterRecord {
  readonly enrollmentId: string
  /** El punto de evaluacion, empezando en 1; `NOT_APPLICABLE` usa el 1. */
  readonly sequence: number
  /** `null` solo en `NOT_APPLICABLE`: no hubo ningun punto que evaluar. */
  readonly afterEncounter: number | null
  /** El Master que aparecio; `null` si no aparecio ninguno. */
  readonly masterRef: string | null
  readonly status: MasterEncounterStatus
  /** Solo si el heroe derroto al Master: la epica que gano (CA-01). */
  readonly epicRef: string | null
  /** El desfase con que Combat creo al Master (CA-04); `null` si no aparecio. */
  readonly levelOffset: number | null
  readonly turns: number | null
  /** Solo con el Master derrotado. */
  readonly grant: EpicGrant | null
}

export class InvalidGrantTransitionError extends DomainError {
  constructor(enrollmentId: string, sequence: number) {
    super(`La entrega de la epica de ${enrollmentId}#${String(sequence)} ya no esta pendiente.`)
    this.name = 'InvalidGrantTransitionError'
  }
}

const pendingGrant = (encounter: MasterEncounterRecord): EpicGrant => {
  if (encounter.grant?.status !== 'PENDING') {
    throw new InvalidGrantTransitionError(encounter.enrollmentId, encounter.sequence)
  }

  return encounter.grant
}

/** `200` de Player/Inventory: la epica esta en el inventario (CA-01). */
export const grantConfirmed = (
  encounter: MasterEncounterRecord,
  now: Date,
): MasterEncounterRecord => {
  const grant = pendingGrant(encounter)

  return {
    ...encounter,
    grant: {
      ...grant,
      status: 'GRANTED',
      attempts: grant.attempts + 1,
      nextAttemptAt: null,
      lastError: null,
      grantedAt: now,
    },
  }
}

/** Rechazo definitivo: se registra y queda para revision (decision 7 de HU-73). */
export const grantRejected = (
  encounter: MasterEncounterRecord,
  reason: string,
): MasterEncounterRecord => {
  const grant = pendingGrant(encounter)

  return {
    ...encounter,
    grant: {
      ...grant,
      status: 'REJECTED',
      attempts: grant.attempts + 1,
      nextAttemptAt: null,
      lastError: reason,
    },
  }
}

/**
 * Sin respuesta definitiva, o sin producto que entregar todavia: se reintenta
 * con el mismo `operationId` y el escalonado de HU-72.
 */
export const grantDeferred = (
  encounter: MasterEncounterRecord,
  reason: string,
  now: Date,
): MasterEncounterRecord => {
  const grant = pendingGrant(encounter)
  const attempts = grant.attempts + 1

  return {
    ...encounter,
    grant: {
      ...grant,
      attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      lastError: reason,
    },
  }
}
