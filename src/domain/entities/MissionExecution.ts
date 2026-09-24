import { DomainError } from '../errors/DomainError'
import type { DifficultyLevel } from '../value-objects/difficulty-level'
import type { Rotation } from '../value-objects/rotation'
import type { MissionCombatRules, MissionDefinition, ObjectiveRule } from './MissionDefinition'

/**
 * Ejecucion de la simulacion de una matricula (HU-72, agregado `MissionExecution`,
 * propuesta P-S2): una por matricula, con su propio `operationId` hacia Combat.
 * Separa el ciclo tecnico de la simulacion del ciclo funcional de la matricula.
 *
 *   QUEUED -> REQUESTED -> SIMULATED -> SETTLED
 *   QUEUED | REQUESTED -> VOIDED     (Combat rechaza o se agota el plazo, P-S7)
 *   SIMULATED -> VOIDED              (el cierre no tiene con que decidir)
 */
export const EXECUTION_STATUSES = ['QUEUED', 'REQUESTED', 'SIMULATED', 'SETTLED', 'VOIDED'] as const

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

export const COMBAT_OUTCOMES = [
  'HERO_VICTORIOUS',
  'HERO_DEFEATED',
  'TIME_BUDGET_EXHAUSTED',
] as const

export type CombatOutcome = (typeof COMBAT_OUTCOMES)[number]

export interface SimulationEnemy {
  readonly enemyRef: string
  readonly name: string
  readonly count: number
  /** Perfil base: contenido pendiente (decision 7 del diseno); `null` si el curso no lo da. */
  readonly profile: Readonly<Record<string, unknown>> | null
}

export interface SimulationEncounter {
  readonly index: number
  readonly kind: 'REGULAR' | 'BOSS'
  readonly powerStep: number | null
  readonly enemies: readonly SimulationEnemy[]
}

/**
 * Solicitud a Combat (contrato hu-72-mission-simulation-v1, propuesta P-S4):
 * todo lo que Combat necesita, porque Combat no consulta a Missions. Se congela
 * al primer envio y cada reintento manda exactamente la misma (P-S3).
 */
export interface SimulationRequest {
  readonly schemaVersion: 1
  readonly operationId: string
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  /** HU-75; el contenido editable puede ajustar el factor de cada dificultad. */
  readonly enemyStatMultiplier: number | null
  /** Duracion de la mision en ISO-8601 (decision 1 del diseno). */
  readonly timeBudget: string
  readonly hero: {
    readonly heroId: string
    /** Perfil de combate de Player/Inventory; Missions no lo interpreta (decision 10). */
    readonly profile: Readonly<Record<string, unknown>>
  }
  readonly strategy: {
    readonly version: number | null
    /** La copia congelada en la matricula (HU-71); vacia: solo el respaldo. */
    readonly rotations: readonly Rotation[]
    readonly fallback: 'BASIC_ATTACK'
  }
  readonly encounters: readonly SimulationEncounter[]
  readonly rules?: MissionCombatRules
  readonly bossDrops?: readonly {
    readonly label: string
    readonly probability: number
    readonly rolls: number
    readonly productId?: string | null
  }[]
  /** Copia local para el cierre; el cliente HTTP no la envia a Combat. */
  readonly contentSnapshot?: MissionDefinition
  /**
   * HU-73: `null` si la mision no tiene Master o ningun candidato tiene
   * probabilidad para el subtipo del heroe (P-X2).
   */
  readonly master: SimulationMaster | null
}

/** Un candidato tal como lo recibe Combat: la probabilidad ya resuelta para el heroe (P-X2). */
export interface SimulationMasterCandidate {
  readonly masterRef: string
  readonly subtype: string
  readonly probability: number
  readonly levelOffset: number
  readonly profile: Readonly<Record<string, unknown>> | null
  readonly epicRef: string
}

/** Bloque `master` de la solicitud (contrato hu-73-master-encounter-v1). Combat tira los dados. */
export interface SimulationMaster {
  /** En orden de encuentro. */
  readonly evaluationPoints: readonly { readonly afterEncounter: number }[]
  readonly maxAppearances: number
  readonly candidates: readonly SimulationMasterCandidate[]
}

/** Los hechos del resumen con los que Missions decide el resultado (P-S5). */
export interface SimulationFacts {
  readonly encountersCompleted: number
  readonly encountersTotal: number
  readonly bossDefeated: boolean
  readonly minHealthPercent: number
  readonly master: { readonly appeared: boolean; readonly defeated: boolean }
  readonly loot?: readonly { readonly label: string; readonly quantity: number }[]
}

/** Resultado de Combat tal como se guarda, sellado hasta `endsAt` (P-S9). */
export interface SimulationResult {
  readonly simulationId: string
  /** Referencia opaca para auditoria: la semilla nunca sale de Combat. */
  readonly seedRef: string | null
  readonly combatOutcome: CombatOutcome
  /** El resumen completo; HU-74 lo presenta. */
  readonly summary: Readonly<Record<string, unknown>>
  readonly combatLog: readonly unknown[]
}

export type MissionOutcome = 'COMPLETED' | 'FAILED' | 'VOIDED'

export interface ObjectiveResult {
  readonly id: string
  readonly type: ObjectiveRule['type'] | null
  readonly primary: boolean
  /** `null`: no aplica (el Master no aparecio) o no es evaluable en esta version. */
  readonly met: boolean | null
}

export interface Settlement {
  readonly outcome: MissionOutcome
  /** Motivo del fallo o de la anulacion; `null` si la mision se completo. */
  readonly reason: string | null
  readonly objectives: readonly ObjectiveResult[]
}

export interface MissionExecution {
  readonly enrollmentId: string
  readonly operationId: string
  readonly status: ExecutionStatus
  /** Llamadas a Combat hechas o en curso. */
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar a Combat. */
  readonly nextAttemptAt: Date | null
  /** Plazo de reintentos: `endsAt + 30 min` (P-S8). Pasado, la mision se anula. */
  readonly deadlineAt: Date
  readonly request: SimulationRequest | null
  readonly lastError: string | null
  readonly result: SimulationResult | null
  readonly simulatedAt: Date | null
  readonly settlement: Settlement | null
  readonly settledAt: Date | null
  readonly heroReleasedAt: Date | null
  /** Bloqueo optimista: cada transicion lo incrementa. */
  readonly version: number
}

export class InvalidExecutionTransitionError extends DomainError {
  constructor(
    readonly from: ExecutionStatus,
    readonly to: string,
  ) {
    super(`La ejecucion no puede pasar de ${from} a ${to}.`)
    this.name = 'InvalidExecutionTransitionError'
  }
}

const requireStatus = (
  execution: MissionExecution,
  allowed: readonly ExecutionStatus[],
  to: string,
): void => {
  if (!allowed.includes(execution.status)) {
    throw new InvalidExecutionTransitionError(execution.status, to)
  }
}

/** Margen de reintentos tras `endsAt` (P-S8): el mismo del compromiso de HU-70. */
export const SIMULATION_GRACE_MS = 30 * 60_000

/** 5 s, 30 s, 2 min y 10 min; despues, cada 10 min (seccion «Reintentos» del diseno). */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000]

/** Espera antes del intento siguiente, dado cuantos se hicieron ya. */
export const retryDelayMs = (attempts: number): number =>
  RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1] ?? 600_000

export interface NewExecution {
  readonly enrollmentId: string
  readonly operationId: string
  readonly endsAt: Date
  readonly now: Date
}

/** Nace al consumirse el hecho `MissionEnrollmentStarted` (CU-72.1, paso 1). */
export const queueExecution = (input: NewExecution): MissionExecution => ({
  enrollmentId: input.enrollmentId,
  operationId: input.operationId,
  status: 'QUEUED',
  attempts: 0,
  nextAttemptAt: input.now,
  deadlineAt: new Date(input.endsAt.getTime() + SIMULATION_GRACE_MS),
  request: null,
  lastError: null,
  result: null,
  simulatedAt: null,
  settlement: null,
  settledAt: null,
  heroReleasedAt: null,
  version: 0,
})

/**
 * Se envia la solicitud. La primera queda congelada: los reintentos mandan la
 * misma con el mismo `operationId` (P-S3). `nextAttemptAt` queda como plazo: si
 * el proceso cae durante la llamada, la ejecucion vuelve a tocar.
 */
export const requestSimulation = (
  execution: MissionExecution,
  request: SimulationRequest,
  now: Date,
): MissionExecution => {
  requireStatus(execution, ['QUEUED', 'REQUESTED'], 'REQUESTED')
  const attempts = execution.attempts + 1

  return {
    ...execution,
    status: 'REQUESTED',
    request: execution.request ?? request,
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
    version: execution.version + 1,
  }
}

/** Sin respuesta definitiva: se reintenta con el escalonado (alternativa A1 de CU-72.1). */
export const retryLater = (
  execution: MissionExecution,
  error: string,
  now: Date,
): MissionExecution => {
  requireStatus(execution, ['QUEUED', 'REQUESTED'], execution.status)

  return {
    ...execution,
    lastError: error,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(execution.attempts)),
    version: execution.version + 1,
  }
}

/** `200` de Combat: el resultado se guarda y queda sellado hasta `endsAt`. */
export const recordSimulation = (
  execution: MissionExecution,
  result: SimulationResult,
  now: Date,
): MissionExecution => {
  requireStatus(execution, ['REQUESTED'], 'SIMULATED')

  return {
    ...execution,
    status: 'SIMULATED',
    result,
    simulatedAt: now,
    nextAttemptAt: null,
    lastError: null,
    version: execution.version + 1,
  }
}

/** Cierre al vencer la duracion (CU-72.2). */
export const settleExecution = (
  execution: MissionExecution,
  settlement: Settlement,
  now: Date,
): MissionExecution => {
  requireStatus(execution, ['SIMULATED'], 'SETTLED')

  return {
    ...execution,
    status: 'SETTLED',
    settlement,
    settledAt: now,
    version: execution.version + 1,
  }
}

/** Anulacion tecnica (CU-72.3): sin penalizacion, sin clear y sin recompensas. */
export const voidedSettlement = (reason: string): Settlement => ({
  outcome: 'VOIDED',
  reason,
  objectives: [],
})

/**
 * Un resultado guardado tambien se anula si el cierre no tiene con que decidir:
 * la mision desaparecio del catalogo o el resumen no trae los hechos. Si no, el
 * heroe quedaria reservado para siempre. El resultado se conserva para auditoria.
 */
export const voidExecution = (
  execution: MissionExecution,
  reason: string,
  now: Date,
): MissionExecution => {
  requireStatus(execution, ['QUEUED', 'REQUESTED', 'SIMULATED'], 'VOIDED')

  return {
    ...execution,
    status: 'VOIDED',
    settlement: voidedSettlement(reason),
    settledAt: now,
    nextAttemptAt: null,
    version: execution.version + 1,
  }
}

/** La liberacion del heroe se confirma una sola vez, despues del cierre (P-S10). */
export const markHeroReleased = (execution: MissionExecution, now: Date): MissionExecution => {
  requireStatus(execution, ['SETTLED', 'VOIDED'], 'HERO_RELEASED')

  if (execution.heroReleasedAt !== null) {
    throw new InvalidExecutionTransitionError(execution.status, 'HERO_RELEASED')
  }

  return { ...execution, heroReleasedAt: now, version: execution.version + 1 }
}
