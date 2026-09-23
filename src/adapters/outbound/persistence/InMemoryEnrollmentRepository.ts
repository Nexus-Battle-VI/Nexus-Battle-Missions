import type {
  EnrollmentRepositoryPort,
  InsertPendingResult,
} from '../../../application/ports/EnrollmentRepositoryPort'
import type { StartedMission } from '../../../application/ports/ExecutionRepositoryPort'
import {
  isActiveEnrollment,
  type MissionEnrollment,
  type MissionFact,
} from '../../../domain/entities/MissionEnrollment'

interface StoredFact {
  readonly factId: string
  readonly fact: MissionFact
  processedAt: Date | null
}

/**
 * Doble de desarrollo y pruebas (`PERSISTENCE_DRIVER=memory`). Reproduce las
 * invariantes que `PostgresEnrollmentRepository` delega en el motor: un heroe en
 * una sola matricula activa, una matricula activa por jugador y mision, una clave
 * de idempotencia por jugador y el bloqueo optimista por version.
 */
export class InMemoryEnrollmentRepository implements EnrollmentRepositoryPort {
  private readonly enrollments = new Map<string, MissionEnrollment>()
  private readonly facts: StoredFact[] = []

  /** Hechos registrados, en orden. Solo para pruebas y diagnostico. */
  recordedFacts(): readonly MissionFact[] {
    return this.facts.map((stored) => stored.fact)
  }

  // Operaciones sincronas para el doble de ejecuciones de HU-72: su cierre
  // escribe matricula, ejecucion, clear y hecho sin que otra operacion se cuele.

  current(enrollmentId: string): MissionEnrollment | null {
    return this.enrollments.get(enrollmentId) ?? null
  }

  /** Como `saveTransition`, sincrona. Un hecho repetido no se duplica (como en el motor). */
  applyTransition(next: MissionEnrollment, expectedVersion: number, fact: MissionFact | null) {
    if (this.enrollments.get(next.enrollmentId)?.version !== expectedVersion) {
      return false
    }

    this.enrollments.set(next.enrollmentId, { ...next })

    if (
      fact !== null &&
      !this.facts.some(
        (stored) =>
          stored.fact.type === fact.type && stored.fact.enrollmentId === fact.enrollmentId,
      )
    ) {
      this.facts.push({ factId: String(this.facts.length + 1), fact, processedAt: null })
    }

    return true
  }

  /** Hechos `MissionEnrollmentStarted` sin procesar, en orden. */
  pendingStartFacts(limit: number): readonly StartedMission[] {
    return this.facts
      .filter(
        (stored) => stored.fact.type === 'MissionEnrollmentStarted' && stored.processedAt === null,
      )
      .slice(0, limit)
      .map((stored) => ({ factId: stored.factId, enrollmentId: stored.fact.enrollmentId }))
  }

  markFactProcessed(factId: string, at: Date): void {
    const stored = this.facts.find((candidate) => candidate.factId === factId)

    if (stored !== undefined) {
      stored.processedAt = at
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(enrollmentId: string): Promise<MissionEnrollment | null> {
    return this.enrollments.get(enrollmentId) ?? null
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findByIdempotencyKey(
    playerId: string,
    idempotencyKey: string,
  ): Promise<MissionEnrollment | null> {
    return (
      this.all().find(
        (enrollment) =>
          enrollment.playerId === playerId && enrollment.idempotencyKey === idempotencyKey,
      ) ?? null
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findActiveByHero(heroId: string): Promise<MissionEnrollment | null> {
    return (
      this.all().find(
        (enrollment) => enrollment.heroId === heroId && isActiveEnrollment(enrollment.status),
      ) ?? null
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findActiveByPlayerAndMission(
    playerId: string,
    missionId: string,
  ): Promise<MissionEnrollment | null> {
    return (
      this.all().find(
        (enrollment) =>
          enrollment.playerId === playerId &&
          enrollment.missionId === missionId &&
          isActiveEnrollment(enrollment.status),
      ) ?? null
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByPlayer(playerId: string): Promise<readonly MissionEnrollment[]> {
    return this.all().filter((enrollment) => enrollment.playerId === playerId)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async insertPending(enrollment: MissionEnrollment): Promise<InsertPendingResult> {
    const all = this.all()

    if (
      all.some(
        (other) =>
          other.playerId === enrollment.playerId &&
          other.idempotencyKey === enrollment.idempotencyKey,
      )
    ) {
      return { kind: 'CONFLICT', reason: 'IDEMPOTENCY_KEY' }
    }

    const active = all.filter((other) => isActiveEnrollment(other.status))

    if (active.some((other) => other.heroId === enrollment.heroId)) {
      return { kind: 'CONFLICT', reason: 'HERO_ACTIVE' }
    }

    if (
      active.some(
        (other) =>
          other.playerId === enrollment.playerId && other.missionId === enrollment.missionId,
      )
    ) {
      return { kind: 'CONFLICT', reason: 'PLAYER_MISSION_ACTIVE' }
    }

    this.enrollments.set(enrollment.enrollmentId, { ...enrollment })

    return { kind: 'INSERTED' }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async saveTransition(
    next: MissionEnrollment,
    expectedVersion: number,
    fact: MissionFact | null,
  ): Promise<boolean> {
    return this.applyTransition(next, expectedVersion, fact)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listPendingRequestedBefore(
    cutoff: Date,
    limit: number,
  ): Promise<readonly MissionEnrollment[]> {
    return this.all()
      .filter(
        (enrollment) =>
          enrollment.status === 'PENDING' && enrollment.requestedAt.getTime() < cutoff.getTime(),
      )
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, limit)
  }

  private all(): MissionEnrollment[] {
    return [...this.enrollments.values()]
  }
}
