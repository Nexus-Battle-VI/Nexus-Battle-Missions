import {
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  rejectEnrollment,
  type EnrollmentRejection,
  type EnrollmentStatus,
  type MissionEnrollment,
} from '../../domain/entities/MissionEnrollment'
import type { DomainError } from '../../domain/errors/DomainError'
import {
  EnrollmentExpiredError,
  EnrollmentPendingError,
  HeroBusyError,
  HeroNotOwnedError,
  HeroNotReadyError,
  IdempotencyKeyReusedError,
  LoadoutIncompleteError,
  MissionAlreadyInProgressError,
  MissionNotFoundError,
  type BusyWith,
  type MissingSlot,
  type ReadinessBlocker,
} from '../../domain/errors/mission-errors'
import { assertDifficultyUnlocked } from '../../domain/policies/DifficultyPolicy'
import {
  assertHeroFree,
  assertMissionNotInProgress,
  assertPrerequisitesMet,
} from '../../domain/policies/EnrollmentPolicy'
import { assertStrategyVersionMatches } from '../../domain/policies/StrategyPolicy'
import {
  parseDifficultyLevel,
  type DifficultyLevel,
} from '../../domain/value-objects/difficulty-level'
import type { ClockPort } from '../ports/ClockPort'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  CommitmentRejection,
  HeroCommitmentPort,
} from '../ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { StrategyRepositoryPort } from '../ports/StrategyRepositoryPort'
import { namesOf } from './ListMissionBoard'

export interface EnrollCommand {
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: string
  readonly strategyVersion: number | null
  readonly idempotencyKey: string
}

export interface EnrollmentView {
  readonly enrollmentId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: DifficultyLevel
  readonly status: EnrollmentStatus
  readonly startedAt: string | null
  readonly endsAt: string | null
}

/** Plazo de una matricula `PENDING` para confirmarse (propuesta P-M8). */
export const PENDING_DEADLINE_MS = 2 * 60_000
/** Margen del compromiso tras la duracion: cubre la simulacion y el cierre de HU-72. */
export const COMMITMENT_GRACE_MS = 30 * 60_000

/**
 * Solicitud de reserva. Se calcula SOLO con datos guardados, asi el reconciliador
 * reenvia exactamente el mismo cuerpo con el mismo `operationId`.
 */
export const commitmentRequestFor = (
  enrollment: MissionEnrollment,
  durationMinutes: number,
): CommitHeroRequest => ({
  operationId: enrollment.operationId,
  playerId: enrollment.playerId,
  heroId: enrollment.heroId,
  reference: enrollment.enrollmentId,
  expiresAt: new Date(
    enrollment.requestedAt.getTime() +
      PENDING_DEADLINE_MS +
      durationMinutes * 60_000 +
      COMMITMENT_GRACE_MS,
  ),
  requireCompleteLoadout: true,
})

const toStoredRejection = (rejection: CommitmentRejection): EnrollmentRejection => {
  const { code, ...detail } = rejection

  return { code, detail }
}

/** El error que ve el jugador para un rechazo guardado. Se reconstruye igual al repetirlo. */
export const rejectionToError = (heroId: string, rejection: EnrollmentRejection): DomainError => {
  switch (rejection.code) {
    case 'HERO_NOT_OWNED':
      return new HeroNotOwnedError(heroId)
    case 'HERO_NOT_READY':
      return new HeroNotReadyError((rejection.detail.blockers ?? []) as readonly ReadinessBlocker[])
    case 'LOADOUT_INCOMPLETE':
      return new LoadoutIncompleteError(
        (rejection.detail.missingSlots ?? []) as readonly MissingSlot[],
      )
    case 'HERO_COMMITTED':
      return new HeroBusyError(heroId, (rejection.detail.busyWith ?? null) as BusyWith | null)
  }
}

export type AppliedOutcome =
  | { readonly kind: 'CONFIRMED'; readonly enrollment: MissionEnrollment }
  | { readonly kind: 'REJECTED'; readonly enrollment: MissionEnrollment }
  | { readonly kind: 'UNKNOWN' }
  /** Otro proceso movio la matricula antes: se devuelve como esta ahora. */
  | { readonly kind: 'RACE'; readonly current: MissionEnrollment | null }

/**
 * Paso 3 del patron de reservas de ADR-019: confirmar o compensar segun lo que
 * respondio el dueno del recurso. Lo comparten la matricula y el reconciliador.
 */
export const applyCommitOutcome = async (
  repository: EnrollmentRepositoryPort,
  now: Date,
  pending: MissionEnrollment,
  outcome: CommitHeroOutcome,
  durationMinutes: number,
): Promise<AppliedOutcome> => {
  if (outcome.kind === 'UNKNOWN') {
    return { kind: 'UNKNOWN' }
  }

  const next =
    outcome.kind === 'GRANTED'
      ? confirmEnrollment(pending, outcome.commitmentId, now, durationMinutes)
      : rejectEnrollment(pending, toStoredRejection(outcome.rejection), now)
  const fact = next.status === 'IN_PROGRESS' ? enrollmentStartedFact(next) : null

  if (!(await repository.saveTransition(next, pending.version, fact))) {
    return { kind: 'RACE', current: await repository.findById(pending.enrollmentId) }
  }

  return next.status === 'IN_PROGRESS'
    ? { kind: 'CONFIRMED', enrollment: next }
    : { kind: 'REJECTED', enrollment: next }
}

export const toEnrollmentView = (enrollment: MissionEnrollment): EnrollmentView => ({
  enrollmentId: enrollment.enrollmentId,
  missionId: enrollment.missionId,
  heroId: enrollment.heroId,
  difficulty: enrollment.difficulty,
  status: enrollment.status,
  startedAt: enrollment.startedAt?.toISOString() ?? null,
  endsAt: enrollment.endsAt?.toISOString() ?? null,
})

const fingerprintOf = (
  missionId: string,
  heroId: string,
  difficulty: DifficultyLevel,
  strategyVersion: number | null,
): string => JSON.stringify([missionId, heroId, difficulty, strategyVersion])

/** La matricula salio de esta misma pulsacion: mismo jugador y misma clave. */
const isSameRequest = (enrollment: MissionEnrollment, command: EnrollCommand): boolean =>
  enrollment.playerId === command.playerId && enrollment.idempotencyKey === command.idempotencyKey

/**
 * `POST /api/v1/missions/{missionId}/enrollments` (Task HU-70.2, CA-01 a CA-05 y
 * CA-07). Sigue el orden de validacion del contrato: responde con el PRIMER
 * fallo, y lo de la mision va antes que lo del heroe (propuesta P-M4).
 *
 * Nada se escribe antes del paso 10. La matricula `PENDING` se inserta ANTES de
 * pedir la reserva (patron de ADR-019), y los indices unicos del motor resuelven
 * dos confirmaciones simultaneas.
 */
export class EnrollInMission {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly clears: DifficultyClearRepositoryPort,
    private readonly strategies: StrategyRepositoryPort,
    private readonly commitments: HeroCommitmentPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: EnrollCommand): Promise<EnrollmentView> {
    const difficulty = parseDifficultyLevel(command.difficulty)
    const definition = await this.catalog.findActive(command.missionId)

    if (definition === null) {
      throw new MissionNotFoundError(command.missionId)
    }

    const fingerprint = fingerprintOf(
      command.missionId,
      command.heroId,
      difficulty,
      command.strategyVersion,
    )
    const previous = await this.enrollments.findByIdempotencyKey(
      command.playerId,
      command.idempotencyKey,
    )

    if (previous !== null) {
      return this.replay(previous, fingerprint)
    }

    const [definitions, completed, cleared, strategy] = await Promise.all([
      this.catalog.listActive(),
      this.clears.completedMissions(command.playerId),
      this.clears.clearedLevels(command.playerId, command.missionId),
      this.strategies.find(command.playerId, command.heroId, command.missionId),
    ])

    assertPrerequisitesMet(definition, completed, namesOf(definitions))
    assertDifficultyUnlocked(command.missionId, difficulty, cleared)
    assertStrategyVersionMatches(command.strategyVersion, strategy?.version ?? null)

    // Otra peticion con esta misma clave pudo matricular despues de la busqueda
    // por clave. Esa matricula activa es la de esta pulsacion: se repite, en
    // lugar de responder que la mision o el heroe estan ocupados.
    const activeInMission = await this.enrollments.findActiveByPlayerAndMission(
      command.playerId,
      command.missionId,
    )

    if (activeInMission !== null && isSameRequest(activeInMission, command)) {
      return this.replay(activeInMission, fingerprint)
    }

    assertMissionNotInProgress(command.missionId, activeInMission)

    const activeHero = await this.enrollments.findActiveByHero(command.heroId)

    if (activeHero !== null && isSameRequest(activeHero, command)) {
      return this.replay(activeHero, fingerprint)
    }

    assertHeroFree(command.heroId, activeHero)

    const pending = newPendingEnrollment({
      enrollmentId: this.ids.newEnrollmentId(),
      playerId: command.playerId,
      missionId: command.missionId,
      heroId: command.heroId,
      difficulty,
      operationId: this.ids.newOperationId(),
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: fingerprint,
      strategyVersion: command.strategyVersion,
      // Copia congelada (HU-71, P-R1): editar la estrategia despues no cambia
      // esta mision. Sin estrategia, la IA solo usara el ataque basico (P-R9).
      rotations: strategy?.rotations ?? [],
      requestedAt: this.clock.now(),
    })
    const inserted = await this.enrollments.insertPending(pending)

    if (inserted.kind === 'CONFLICT') {
      return this.resolveInsertConflict(inserted.reason, command, fingerprint)
    }

    const outcome = await this.commitments.commit(
      commitmentRequestFor(pending, definition.estimatedDurationMinutes),
    )
    const applied = await applyCommitOutcome(
      this.enrollments,
      this.clock.now(),
      pending,
      outcome,
      definition.estimatedDurationMinutes,
    )

    switch (applied.kind) {
      case 'CONFIRMED':
        return toEnrollmentView(applied.enrollment)
      case 'REJECTED':
        throw this.rejectionOf(applied.enrollment)
      case 'UNKNOWN':
        throw new EnrollmentPendingError(pending.enrollmentId)
      case 'RACE':
        if (applied.current === null) {
          throw new EnrollmentPendingError(pending.enrollmentId)
        }

        return this.replay(applied.current, fingerprint)
    }
  }

  /**
   * Una fila que viola varias restricciones a la vez solo informa la primera que
   * el motor comprueba, y ese orden no esta garantizado: el reintento simultaneo
   * de una pulsacion viola la clave, el heroe y la mision. Por eso la clave se
   * mira SIEMPRE primero: ese reintento debe repetir la matricula ganadora.
   */
  private async resolveInsertConflict(
    reason: 'HERO_ACTIVE' | 'PLAYER_MISSION_ACTIVE' | 'IDEMPOTENCY_KEY',
    command: EnrollCommand,
    fingerprint: string,
  ): Promise<EnrollmentView> {
    const winner = await this.enrollments.findByIdempotencyKey(
      command.playerId,
      command.idempotencyKey,
    )

    if (winner !== null) {
      return this.replay(winner, fingerprint)
    }

    switch (reason) {
      case 'HERO_ACTIVE':
        throw new HeroBusyError(command.heroId, 'MISSION')
      case 'PLAYER_MISSION_ACTIVE': {
        const active = await this.enrollments.findActiveByPlayerAndMission(
          command.playerId,
          command.missionId,
        )

        throw new MissionAlreadyInProgressError(command.missionId, active?.enrollmentId ?? null)
      }
      case 'IDEMPOTENCY_KEY':
        // El motor vio la clave y esta lectura no: no se inventa un resultado,
        // el jugador recibe 503 y su reintento encontrara la matricula.
        throw new Error('La clave de idempotencia choco con una matricula que no se pudo leer.')
    }
  }

  /** Respuesta a una clave ya usada (contrato, «Reintentos con la misma clave»). */
  private replay(existing: MissionEnrollment, fingerprint: string): EnrollmentView {
    if (existing.requestFingerprint !== fingerprint) {
      throw new IdempotencyKeyReusedError()
    }

    switch (existing.status) {
      case 'PENDING':
        throw new EnrollmentPendingError(existing.enrollmentId)
      case 'REJECTED':
        throw this.rejectionOf(existing)
      case 'EXPIRED':
        throw new EnrollmentExpiredError(existing.enrollmentId)
      default:
        return toEnrollmentView(existing)
    }
  }

  private rejectionOf(enrollment: MissionEnrollment): DomainError {
    // Una matricula REJECTED siempre guarda su motivo (lo impone la transicion).
    return rejectionToError(
      enrollment.heroId,
      enrollment.rejection ?? { code: 'HERO_COMMITTED', detail: {} },
    )
  }
}

export const ENROLL_IN_MISSION = Symbol('EnrollInMission')
