import { DomainError } from '../errors/DomainError'
import type { DifficultyLevel } from '../value-objects/difficulty-level'
import type { Rotation } from '../value-objects/rotation'

/**
 * Matricula de un heroe en una mision (HU-70, agregado `MissionEnrollment`).
 *
 * Activos: `PENDING` (el heroe se esta reservando) e `IN_PROGRESS` (reservado y
 * con el temporizador corriendo). La base impone con indices unicos parciales
 * que un heroe no este en dos matriculas activas (invariante de ADR-019).
 */
export const ENROLLMENT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'ABANDONED',
  'REJECTED',
  'EXPIRED',
  // Anulacion tecnica (HU-72, propuesta P-S7): sin penalizacion, sin clear y sin
  // recompensas. No es un resultado de la mision para el jugador.
  'VOIDED',
] as const

export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number]

export const ACTIVE_ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = ['PENDING', 'IN_PROGRESS']

/** Estados finales que cuentan como resultado de la mision para el jugador. */
export const FINISHED_MISSION_STATUSES: readonly EnrollmentStatus[] = [
  'COMPLETED',
  'FAILED',
  'ABANDONED',
]

export const isActiveEnrollment = (status: EnrollmentStatus): boolean =>
  ACTIVE_ENROLLMENT_STATUSES.includes(status)

/** Motivo de un rechazo terminal de Player/Inventory, con su detalle para repetirlo. */
export interface EnrollmentRejection {
  readonly code: 'HERO_NOT_OWNED' | 'HERO_NOT_READY' | 'LOADOUT_INCOMPLETE' | 'HERO_COMMITTED'
  readonly detail: Readonly<Record<string, unknown>>
}

export interface MissionEnrollment {
  readonly enrollmentId: string
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: DifficultyLevel
  readonly status: EnrollmentStatus
  /** Clave de la reserva en Player/Inventory: la misma en cada reintento. */
  readonly operationId: string
  readonly idempotencyKey: string
  /** Huella del cuerpo recibido: detecta una clave reutilizada con otro cuerpo. */
  readonly requestFingerprint: string
  readonly strategyVersion: number | null
  /**
   * Copia congelada de la estrategia al matricular (HU-71, P-R1): es la que
   * recibira la simulacion. Vacia si el jugador no tenia estrategia (P-R9).
   */
  readonly rotations: readonly Rotation[]
  readonly commitmentId: string | null
  readonly rejection: EnrollmentRejection | null
  readonly requestedAt: Date
  readonly startedAt: Date | null
  readonly endsAt: Date | null
  readonly finishedAt: Date | null
  /** Bloqueo optimista: cada transicion lo incrementa. */
  readonly version: number
}

/** Hecho interno de Missions, registrado en la misma transaccion que la transicion. */
export interface MissionFact {
  /**
   * `MissionEnrollmentStarted` lo consume HU-72. `MissionSettled` queda para HU-10 y el
   * aviso de fin de mision; HU-76 solo lo cuenta, sin marcarlo. El reporte de HU-74
   * no lo consume: se escribe en la misma transaccion del cierre.
   */
  readonly type: 'MissionEnrollmentStarted' | 'MissionSettled'
  readonly enrollmentId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdAt: Date
}

export class InvalidEnrollmentTransitionError extends DomainError {
  constructor(
    readonly from: EnrollmentStatus,
    readonly to: EnrollmentStatus,
  ) {
    super(`La matricula no puede pasar de ${from} a ${to}.`)
    this.name = 'InvalidEnrollmentTransitionError'
  }
}

const requirePending = (enrollment: MissionEnrollment, to: EnrollmentStatus): void => {
  if (enrollment.status !== 'PENDING') {
    throw new InvalidEnrollmentTransitionError(enrollment.status, to)
  }
}

export interface NewEnrollment {
  readonly enrollmentId: string
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: DifficultyLevel
  readonly operationId: string
  readonly idempotencyKey: string
  readonly requestFingerprint: string
  readonly strategyVersion: number | null
  /** Sin valor: matricula sin estrategia. */
  readonly rotations?: readonly Rotation[]
  readonly requestedAt: Date
}

export const newPendingEnrollment = (input: NewEnrollment): MissionEnrollment => {
  const rotations = input.rotations ?? []

  // Sin version no hay copia y con version la copia no esta vacia: lo mismo que
  // impone en el motor el CHECK mission_enrollments_estrategia_congelada.
  if ((input.strategyVersion === null) !== (rotations.length === 0)) {
    throw new RangeError('La copia congelada de la estrategia no corresponde a su version.')
  }

  return {
    ...input,
    rotations,
    status: 'PENDING',
    commitmentId: null,
    rejection: null,
    startedAt: null,
    endsAt: null,
    finishedAt: null,
    version: 0,
  }
}

const MINUTE_MS = 60_000

/**
 * El heroe quedo reservado: la mision empieza AHORA, con la hora del servidor, y
 * vence cuando se cumple su duracion (CA-01). El temporizador es este dato.
 */
export const confirmEnrollment = (
  enrollment: MissionEnrollment,
  commitmentId: string,
  now: Date,
  durationMinutes: number,
): MissionEnrollment => {
  requirePending(enrollment, 'IN_PROGRESS')

  return {
    ...enrollment,
    status: 'IN_PROGRESS',
    commitmentId,
    startedAt: now,
    endsAt: new Date(now.getTime() + durationMinutes * MINUTE_MS),
    version: enrollment.version + 1,
  }
}

export const rejectEnrollment = (
  enrollment: MissionEnrollment,
  rejection: EnrollmentRejection,
  now: Date,
): MissionEnrollment => {
  requirePending(enrollment, 'REJECTED')

  return {
    ...enrollment,
    status: 'REJECTED',
    rejection,
    finishedAt: now,
    version: enrollment.version + 1,
  }
}

export const expireEnrollment = (enrollment: MissionEnrollment, now: Date): MissionEnrollment => {
  requirePending(enrollment, 'EXPIRED')

  return { ...enrollment, status: 'EXPIRED', finishedAt: now, version: enrollment.version + 1 }
}

/**
 * Cierre de HU-72: la mision en curso termina con su resultado (CA-04 y CA-06) o
 * se anula por un error tecnico (P-S7). Solo una matricula EN CURSO se cierra.
 */
export const closeEnrollment = (
  enrollment: MissionEnrollment,
  status: 'COMPLETED' | 'FAILED' | 'VOIDED',
  now: Date,
): MissionEnrollment => {
  if (enrollment.status !== 'IN_PROGRESS') {
    throw new InvalidEnrollmentTransitionError(enrollment.status, status)
  }

  return { ...enrollment, status, finishedAt: now, version: enrollment.version + 1 }
}

/** Hecho que HU-72 consumira para arrancar la simulacion. */
export const enrollmentStartedFact = (enrollment: MissionEnrollment): MissionFact => {
  if (enrollment.status !== 'IN_PROGRESS' || enrollment.startedAt === null) {
    throw new InvalidEnrollmentTransitionError(enrollment.status, 'IN_PROGRESS')
  }

  return {
    type: 'MissionEnrollmentStarted',
    enrollmentId: enrollment.enrollmentId,
    payload: {
      enrollmentId: enrollment.enrollmentId,
      missionId: enrollment.missionId,
      playerId: enrollment.playerId,
      heroId: enrollment.heroId,
      difficulty: enrollment.difficulty,
      startedAt: enrollment.startedAt.toISOString(),
      endsAt: enrollment.endsAt?.toISOString() ?? null,
    },
    createdAt: enrollment.startedAt,
  }
}
