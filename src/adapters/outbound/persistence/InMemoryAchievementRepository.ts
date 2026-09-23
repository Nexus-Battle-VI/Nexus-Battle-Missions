import type {
  AchievementRepositoryPort,
  EvaluationCheckpoint,
  EvaluationRetry,
  PlayerToEvaluate,
} from '../../../application/ports/AchievementRepositoryPort'
import type { MasterEncounterRepositoryPort } from '../../../application/ports/MasterEncounterRepositoryPort'
import type { AchievementUnlock } from '../../../domain/entities/Achievement'
import type { InMemoryEnrollmentRepository } from './InMemoryEnrollmentRepository'

/** El punto de control de un jugador, como la fila de `mission_achievement_evaluations`. */
export interface StoredEvaluation {
  readonly settledSeen: number
  readonly epicsGrantedSeen: number
  readonly fingerprint: string | null
  readonly evaluatedAt: Date | null
  readonly attempts: number
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
}

// Clave compuesta serializada como lista: unir con un separador fijo haria
// colisionar a jugadores y logros que lo contengan.
const keyOf = (playerId: string, achievementId: string): string =>
  JSON.stringify([playerId, achievementId])

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Los nunca evaluados primero, como `nulls first`. */
const nullsFirst = (a: Date | null, b: Date | null): number =>
  a === null ? (b === null ? 0 : -1) : b === null ? 1 : a.getTime() - b.getTime()

const byNextAttempt = (unlock: AchievementUnlock): number =>
  unlock.grant?.nextAttemptAt?.getTime() ?? Number.MAX_SAFE_INTEGER

/**
 * Doble de desarrollo y pruebas de las tablas de HU-76. Reproduce la seleccion,
 * el orden y el limite de `PostgresAchievementRepository`, y sus escrituras
 * idempotentes y condicionales: cada una comprueba y escribe sin esperas
 * intermedias, que es el equivalente en memoria de una transaccion. No aplica
 * los CHECK del motor.
 */
export class InMemoryAchievementRepository implements AchievementRepositoryPort {
  private readonly unlocks = new Map<string, AchievementUnlock>()
  private readonly evaluations = new Map<string, StoredEvaluation>()

  constructor(
    private readonly enrollments: InMemoryEnrollmentRepository,
    private readonly masters: MasterEncounterRepositoryPort,
  ) {}

  /** El punto de control del jugador. Solo para pruebas y diagnostico. */
  evaluationOf(playerId: string): StoredEvaluation | null {
    return this.evaluations.get(playerId) ?? null
  }

  async playersToEvaluate(
    now: Date,
    fingerprint: string,
    limit: number,
  ): Promise<readonly PlayerToEvaluate[]> {
    const settled = new Map<string, number>()

    for (const fact of this.enrollments.recordedFacts()) {
      const playerId =
        fact.type === 'MissionSettled'
          ? this.enrollments.current(fact.enrollmentId)?.playerId
          : undefined

      if (playerId !== undefined) {
        settled.set(playerId, (settled.get(playerId) ?? 0) + 1)
      }
    }

    const players: PlayerToEvaluate[] = []

    for (const [playerId, count] of settled) {
      const epicsGranted = await this.grantedEpicsOf(playerId)
      const evaluation = this.evaluations.get(playerId)
      const changed =
        evaluation?.settledSeen !== count ||
        evaluation.epicsGrantedSeen !== epicsGranted ||
        evaluation.fingerprint !== fingerprint
      const due =
        evaluation?.nextAttemptAt == null || evaluation.nextAttemptAt.getTime() <= now.getTime()

      if (changed && due) {
        players.push({
          playerId,
          settled: count,
          epicsGranted,
          attempts: evaluation?.attempts ?? 0,
        })
      }
    }

    return players
      .sort(
        (a, b) =>
          nullsFirst(
            this.evaluations.get(a.playerId)?.evaluatedAt ?? null,
            this.evaluations.get(b.playerId)?.evaluatedAt ?? null,
          ) || compareText(a.playerId, b.playerId),
      )
      .slice(0, limit)
  }

  unlocksOf(playerId: string): Promise<readonly AchievementUnlock[]> {
    return Promise.resolve(
      [...this.unlocks.values()]
        .filter((unlock) => unlock.playerId === playerId)
        .sort(
          (a, b) =>
            a.unlockedAt.getTime() - b.unlockedAt.getTime() ||
            compareText(a.achievementId, b.achievementId),
        ),
    )
  }

  recordEvaluation(
    playerId: string,
    unlocks: readonly AchievementUnlock[],
    checkpoint: EvaluationCheckpoint,
  ): Promise<readonly AchievementUnlock[]> {
    const inserted: AchievementUnlock[] = []

    for (const unlock of unlocks) {
      const key = keyOf(unlock.playerId, unlock.achievementId)

      // Un logro se otorga una sola vez por jugador: el que ya existe se conserva.
      if (!this.unlocks.has(key)) {
        this.unlocks.set(key, unlock)
        inserted.push(unlock)
      }
    }

    this.evaluations.set(playerId, {
      settledSeen: checkpoint.settledSeen,
      epicsGrantedSeen: checkpoint.epicsGrantedSeen,
      fingerprint: checkpoint.fingerprint,
      evaluatedAt: checkpoint.evaluatedAt,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    })

    return Promise.resolve(inserted)
  }

  deferEvaluation(playerId: string, retry: EvaluationRetry): Promise<void> {
    const current = this.evaluations.get(playerId)

    this.evaluations.set(playerId, {
      settledSeen: current?.settledSeen ?? 0,
      epicsGrantedSeen: current?.epicsGrantedSeen ?? 0,
      fingerprint: current?.fingerprint ?? null,
      evaluatedAt: current?.evaluatedAt ?? null,
      attempts: retry.attempts,
      nextAttemptAt: retry.nextAttemptAt,
      lastError: retry.lastError,
    })

    return Promise.resolve()
  }

  pendingRecognitionGrants(now: Date, limit: number): Promise<readonly AchievementUnlock[]> {
    return Promise.resolve(
      [...this.unlocks.values()]
        .filter(
          (unlock) =>
            unlock.recognition.status === 'PENDING' && byNextAttempt(unlock) <= now.getTime(),
        )
        .sort((a, b) => byNextAttempt(a) - byNextAttempt(b))
        .slice(0, limit),
    )
  }

  saveRecognitionGrant(next: AchievementUnlock, expectedAttempts: number): Promise<boolean> {
    const key = keyOf(next.playerId, next.achievementId)
    const stored = this.unlocks.get(key)
    const current = stored?.grant ?? null

    if (
      stored?.recognition.status !== 'PENDING' ||
      current?.attempts !== expectedAttempts ||
      next.grant === null
    ) {
      return Promise.resolve(false)
    }

    // Solo cambia la entrega: lo desbloqueado queda congelado, y un producto
    // congelado no se borra ni se cambia, como en PostgreSQL.
    this.unlocks.set(key, {
      ...stored,
      recognition: { ...stored.recognition, status: next.recognition.status },
      grant: {
        ...next.grant,
        operationId: current.operationId,
        productId: current.productId ?? next.grant.productId,
      },
    })

    return Promise.resolve(true)
  }

  freezeRecognitionProduct(next: AchievementUnlock, expectedAttempts: number): Promise<boolean> {
    const key = keyOf(next.playerId, next.achievementId)
    const stored = this.unlocks.get(key)
    const current = stored?.grant ?? null
    const productId = next.grant?.productId ?? null

    if (
      stored?.recognition.status !== 'PENDING' ||
      current?.attempts !== expectedAttempts ||
      current.productId !== null ||
      productId === null
    ) {
      return Promise.resolve(false)
    }

    this.unlocks.set(key, { ...stored, grant: { ...current, productId } })

    return Promise.resolve(true)
  }

  /** Las epicas entregadas del jugador, como el conteo de `epicas` en PostgreSQL. */
  private async grantedEpicsOf(playerId: string): Promise<number> {
    const enrollments = await this.enrollments.listByPlayer(playerId)
    const records = await Promise.all(
      enrollments.map((enrollment) => this.masters.listByEnrollment(enrollment.enrollmentId)),
    )

    return records.flat().filter((record) => record.grant?.status === 'GRANTED').length
  }
}
