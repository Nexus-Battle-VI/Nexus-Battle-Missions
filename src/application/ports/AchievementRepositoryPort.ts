import type { AchievementUnlock } from '../../domain/entities/Achievement'

/**
 * Un jugador con algo nuevo que evaluar, con los conteos que se vieron AL
 * ELEGIRLO. Se leen antes que la evidencia: como todas las fuentes solo crecen,
 * una evidencia que llegue entre medias provoca, como mucho, una evaluacion de
 * mas en el ciclo siguiente, nunca un desbloqueo perdido.
 */
export interface PlayerToEvaluate {
  readonly playerId: string
  /** Sus hechos `MissionSettled` (HU-72), tambien los de misiones anuladas. */
  readonly settled: number
  /** Sus epicas entregadas (`GRANTED`, HU-73). */
  readonly epicsGranted: number
  /** Evaluaciones fallidas seguidas; 0 si la ultima fue bien. */
  readonly attempts: number
}

/** Lo que se vio al evaluar: si nada cambia, el jugador no se vuelve a evaluar. */
export interface EvaluationCheckpoint {
  readonly settledSeen: number
  readonly epicsGrantedSeen: number
  readonly fingerprint: string
  readonly evaluatedAt: Date
}

export interface EvaluationRetry {
  readonly attempts: number
  readonly nextAttemptAt: Date
  readonly lastError: string
}

/**
 * Desbloqueos y reconocimientos de HU-76 (`mission_achievement_unlocks`) y el
 * punto de control de cada jugador (`mission_achievement_evaluations`). El
 * progreso no se guarda: se calcula con `AchievementPolicy.progressOf`.
 *
 * HU-76 no lee ni escribe `mission_facts.processed_at`, que es solo de HU-72: el
 * aviso de fin de mision y HU-10 siguen viendo los `MissionSettled`. Detecta que
 * hay algo nuevo comparando conteos que solo crecen; **toda fuente nueva de
 * evidencia debe anadir aqui su contador**, o sus cambios no se evaluaran.
 */
export interface AchievementRepositoryPort {
  /**
   * Los jugadores con algun `MissionSettled` cuyo punto de control falta o no
   * coincide en `MissionSettled`, en epicas `GRANTED` o en la huella del
   * catalogo. Excluye a los que esperan un reintento. Primero los que nunca se
   * evaluaron; despues, los evaluados hace mas tiempo.
   */
  playersToEvaluate(
    now: Date,
    fingerprint: string,
    limit: number,
  ): Promise<readonly PlayerToEvaluate[]>

  /** Los desbloqueos del jugador, del mas antiguo al mas reciente. */
  unlocksOf(playerId: string): Promise<readonly AchievementUnlock[]>

  /**
   * En UNA transaccion: guarda los desbloqueos que aun no existian (uno por
   * jugador y logro) y el punto de control, sin reintento pendiente. Devuelve
   * solo los desbloqueos que se guardaron ahora.
   */
  recordEvaluation(
    playerId: string,
    unlocks: readonly AchievementUnlock[],
    checkpoint: EvaluationCheckpoint,
  ): Promise<readonly AchievementUnlock[]>

  /** Aplaza al jugador tras un fallo. Conserva los conteos vistos y la huella. */
  deferEvaluation(playerId: string, retry: EvaluationRetry): Promise<void>

  /** Los cosmeticos `PENDING` con el intento vencido, los mas atrasados primero. */
  pendingRecognitionGrants(now: Date, limit: number): Promise<readonly AchievementUnlock[]>

  /**
   * Guarda el nuevo estado de la entrega si seguia `PENDING` con los intentos
   * leidos. Nunca cambia un producto ya congelado. `false`: otro proceso se
   * adelanto y no se escribe nada.
   */
  saveRecognitionGrant(next: AchievementUnlock, expectedAttempts: number): Promise<boolean>

  /**
   * Congela el producto ANTES del primer envio: solo si la entrega sigue
   * `PENDING`, con esos intentos y sin producto. `false`: no hay que enviar.
   */
  freezeRecognitionProduct(next: AchievementUnlock, expectedAttempts: number): Promise<boolean>
}

export const ACHIEVEMENT_REPOSITORY = Symbol('AchievementRepositoryPort')
