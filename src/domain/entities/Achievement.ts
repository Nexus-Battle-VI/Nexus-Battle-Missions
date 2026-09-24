import { DomainError } from '../errors/DomainError'
import type { DifficultyLevel } from '../value-objects/difficulty-level'
import type { MissionCategory } from '../value-objects/mission-category'
import { retryDelayMs } from './MissionExecution'

/**
 * Logros de misiones (HU-76, contrato hu-76-mission-achievements-v1). Un logro
 * se desbloquea UNA sola vez por jugador cuando su criterio se cumple con
 * evidencia (CA-01 y CA-02), y nunca con progreso parcial (CA-03).
 *
 * El progreso no se guarda: se calcula cada vez con lo que ya guardan HU-72,
 * HU-73, HU-74 y HU-75 (`AchievementPolicy.progressOf`). Solo se guarda el
 * desbloqueo, con su progreso congelado, y su reconocimiento.
 */
export const ACHIEVEMENT_CRITERIA = [
  'ALL_CATEGORY_MISSIONS',
  'ALL_MASTERS_DEFEATED',
  'FLAWLESS_MISSION',
  'RECORD_TIME',
  'ALL_MASTER_EPICS',
] as const

export type AchievementCriterion = (typeof ACHIEVEMENT_CRITERIA)[number]

export const ACHIEVEMENT_STATUSES = ['LOCKED', 'IN_PROGRESS', 'UNLOCKED'] as const

export type AchievementStatus = (typeof ACHIEVEMENT_STATUSES)[number]

export const RECOGNITION_KINDS = ['TITLE', 'BADGE', 'COSMETIC_PRODUCT'] as const

export type RecognitionKind = (typeof RECOGNITION_KINDS)[number]

/**
 * `RECORDED`: un titulo o una insignia, que se registran en Missions al
 * desbloquear. Los demas son la entrega de un cosmetico en Player/Inventory.
 */
export const RECOGNITION_STATUSES = ['RECORDED', 'PENDING', 'CREDITED', 'FAILED'] as const

export type RecognitionStatus = (typeof RECOGNITION_STATUSES)[number]

/**
 * Que epica cuenta para la coleccion (decision 6 del diseno): la entregada en el
 * inventario (`CREDITED`, la propuesta) o la ganada al Master aunque su entrega
 * siga pendiente (`WON`).
 */
export const EPIC_STATES = ['CREDITED', 'WON'] as const

export type EpicState = (typeof EPIC_STATES)[number]

/**
 * El criterio de un logro con sus parametros. Los opcionales del contrato llevan
 * su valor por defecto: asi, lo que decida el PO se cambia en el catalogo y no
 * en el codigo.
 */
export type AchievementRule =
  | { readonly criterion: 'ALL_CATEGORY_MISSIONS'; readonly category: MissionCategory }
  | { readonly criterion: 'ALL_MASTERS_DEFEATED' }
  /** `count` misiones distintas sin dano; el contrato usa 1 y el curso habla en plural. */
  | { readonly criterion: 'FLAWLESS_MISSION'; readonly count: number }
  | {
      readonly criterion: 'RECORD_TIME'
      readonly missionId: string
      /** ISO-8601; `null` mientras el PO no fije el umbral (decision 3): no se evalua. */
      readonly maxSimulatedDuration: string | null
      /** `null`: cualquier dificultad. */
      readonly difficulty: DifficultyLevel | null
    }
  | { readonly criterion: 'ALL_MASTER_EPICS'; readonly epicState: EpicState }

export type Recognition =
  | { readonly kind: 'TITLE' | 'BADGE'; readonly name: string }
  | {
      readonly kind: 'COSMETIC_PRODUCT'
      readonly name: string
      /** El producto de Catalog; `null` mientras no exista: la entrega espera. */
      readonly productId: string | null
    }

export interface AchievementDefinition {
  readonly achievementId: string
  /** Sube cuando cambia la regla del logro; el desbloqueo guarda la suya. */
  readonly version: number
  readonly name: string
  readonly rule: AchievementRule
  readonly recognition: Recognition
}

/**
 * Por que se desbloqueo: las referencias que cuentan (misiones, Master o
 * epicas) y las matriculas que lo prueban, para que CA-02 sea auditable.
 */
export interface AchievementProof {
  readonly refs: readonly string[]
  readonly enrollmentIds: readonly string[]
}

/**
 * Entrega de un cosmetico en Player/Inventory, calcada de la epica de HU-73: un
 * `operationId` determinista, el producto congelado antes del primer envio y el
 * reintento escalonado. El estado vive en `recognition.status`.
 */
export interface RecognitionGrant {
  readonly operationId: string
  /** Llamadas hechas; cada reintento espera un poco mas. */
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar. */
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
  /** Congelado en el primer envio; `null` hasta entonces. */
  readonly productId: string | null
  readonly creditedAt: Date | null
}

export interface AchievementUnlock {
  readonly playerId: string
  readonly achievementId: string
  readonly achievementVersion: number
  readonly criterion: AchievementCriterion
  readonly name: string
  /** Congelado al desbloquear: no cambia aunque cambie el catalogo (P-L5). */
  readonly progress: { readonly current: number; readonly target: number }
  readonly proof: AchievementProof
  /** El momento de la evaluacion que lo desbloqueo. */
  readonly unlockedAt: Date
  readonly recognition: {
    readonly kind: RecognitionKind
    readonly name: string
    readonly status: RecognitionStatus
  }
  /** Solo con `COSMETIC_PRODUCT`. */
  readonly grant: RecognitionGrant | null
}

export class InvalidRecognitionTransitionError extends DomainError {
  constructor(playerId: string, achievementId: string) {
    super(`El reconocimiento de ${achievementId} para ${playerId} ya no esta pendiente.`)
    this.name = 'InvalidRecognitionTransitionError'
  }
}

const pendingGrant = (unlock: AchievementUnlock): RecognitionGrant => {
  if (unlock.recognition.status !== 'PENDING' || unlock.grant === null) {
    throw new InvalidRecognitionTransitionError(unlock.playerId, unlock.achievementId)
  }

  return unlock.grant
}

/** `200` de Player/Inventory: el cosmetico esta en el inventario (CA-01). */
export const recognitionCredited = (unlock: AchievementUnlock, now: Date): AchievementUnlock => {
  const grant = pendingGrant(unlock)

  return {
    ...unlock,
    recognition: { ...unlock.recognition, status: 'CREDITED' },
    grant: {
      ...grant,
      attempts: grant.attempts + 1,
      nextAttemptAt: null,
      lastError: null,
      creditedAt: now,
    },
  }
}

/**
 * Rechazo definitivo (`422` o `400`): Player/Inventory responde lo mismo a ese
 * `operationId` para siempre, asi que queda visible y para revision, como la
 * epica en la decision 7 de HU-73.
 */
export const recognitionFailed = (unlock: AchievementUnlock, reason: string): AchievementUnlock => {
  const grant = pendingGrant(unlock)

  return {
    ...unlock,
    recognition: { ...unlock.recognition, status: 'FAILED' },
    grant: { ...grant, attempts: grant.attempts + 1, nextAttemptAt: null, lastError: reason },
  }
}

/**
 * Sin respuesta definitiva, o sin producto que entregar todavia: se reintenta
 * con el mismo `operationId` y el escalonado de HU-72.
 */
export const recognitionDeferred = (
  unlock: AchievementUnlock,
  reason: string,
  now: Date,
): AchievementUnlock => {
  const grant = pendingGrant(unlock)
  const attempts = grant.attempts + 1

  return {
    ...unlock,
    grant: {
      ...grant,
      attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      lastError: reason,
    },
  }
}
