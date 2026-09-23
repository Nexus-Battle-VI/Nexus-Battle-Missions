import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import {
  EnrollmentExpiredError,
  EnrollmentPendingError,
  HeroBusyError,
  HeroNotOwnedError,
  HeroNotReadyError,
  IdempotencyKeyReusedError,
  LoadoutIncompleteError,
  MissionAlreadyInProgressError,
  MissionLockedError,
  MissionNotFoundError,
  StrategyVersionMismatchError,
} from '../../../domain/errors/mission-errors'
import {
  HeroAbilitiesUnavailableError,
  InvalidRotationError,
  StrategyNotFoundError,
  StrategyVersionConflictError,
  TooManyRotationsError,
  UnknownAbilityError,
} from '../../../domain/errors/strategy-errors'
import { ProgressionLockedError } from '../../../domain/policies/DifficultyPolicy'
import { UnknownDifficultyError } from '../../../domain/value-objects/difficulty-level'

/**
 * Traduce los errores de Missions a HTTP con los codigos ESTABLES de los
 * contratos hu-75-mission-difficulty-v1 y hu-70-mission-enrollment-v1. Web
 * muestra `message` tal cual y no recalcula ninguna regla.
 */
export const toMissionsHttpException = (error: unknown): HttpException => {
  if (error instanceof ProgressionLockedError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'PROGRESSION_LOCKED',
      message: error.message,
      missionId: error.missionId,
      requested: error.requested,
      required: error.required,
    })
  }

  if (error instanceof UnknownDifficultyError) {
    return new BadRequestException({
      statusCode: 400,
      code: 'UNKNOWN_DIFFICULTY',
      message: error.message,
    })
  }

  if (error instanceof MissionNotFoundError) {
    return new NotFoundException({
      statusCode: 404,
      code: 'MISSION_NOT_FOUND',
      message: error.message,
      missionId: error.missionId,
    })
  }

  if (error instanceof MissionLockedError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'MISSION_LOCKED',
      message: error.message,
      missionId: error.missionId,
      missingPrerequisites: error.missingPrerequisites,
    })
  }

  if (error instanceof HeroBusyError) {
    return new ConflictException({
      statusCode: 409,
      code: 'HERO_BUSY',
      message: error.message,
      heroId: error.heroId,
      busyWith: error.busyWith,
    })
  }

  if (error instanceof MissionAlreadyInProgressError) {
    return new ConflictException({
      statusCode: 409,
      code: 'MISSION_ALREADY_IN_PROGRESS',
      message: error.message,
      missionId: error.missionId,
      enrollmentId: error.enrollmentId,
    })
  }

  if (error instanceof IdempotencyKeyReusedError) {
    return new ConflictException({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: error.message,
    })
  }

  if (error instanceof EnrollmentExpiredError) {
    return new ConflictException({
      statusCode: 409,
      code: 'ENROLLMENT_EXPIRED',
      message: error.message,
      enrollmentId: error.enrollmentId,
    })
  }

  if (error instanceof StrategyVersionMismatchError) {
    return new ConflictException({
      statusCode: 409,
      code: 'STRATEGY_VERSION_MISMATCH',
      message: error.message,
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    })
  }

  if (error instanceof HeroNotOwnedError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'HERO_NOT_OWNED',
      message: error.message,
      heroId: error.heroId,
    })
  }

  if (error instanceof HeroNotReadyError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'HERO_NOT_READY',
      message: error.message,
      blockers: error.blockers,
    })
  }

  if (error instanceof LoadoutIncompleteError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'LOADOUT_INCOMPLETE',
      message: error.message,
      missingSlots: error.missingSlots,
    })
  }

  if (error instanceof EnrollmentPendingError) {
    // ADR-019: la reserva quedo sin confirmar. La matricula sigue PENDING y el
    // cliente reintenta con la MISMA Idempotency-Key.
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: error.message,
      enrollmentId: error.enrollmentId,
      enrollmentStatus: 'PENDING',
    })
  }

  // --- HU-71: estrategia de rotaciones (contrato hu-71-mission-strategy-v1) ---

  if (error instanceof TooManyRotationsError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'TOO_MANY_ROTATIONS',
      message: error.message,
      max: error.max,
      received: error.received,
    })
  }

  if (error instanceof InvalidRotationError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'INVALID_ROTATION',
      message: error.message,
      violations: error.violations,
    })
  }

  if (error instanceof UnknownAbilityError) {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: 'UNKNOWN_ABILITY',
      message: error.message,
      abilityIds: error.abilityIds,
    })
  }

  if (error instanceof StrategyVersionConflictError) {
    return new ConflictException({
      statusCode: 409,
      code: 'VERSION_CONFLICT',
      message: error.message,
      expectedVersion: error.expectedVersion,
      currentVersion: error.currentVersion,
    })
  }

  if (error instanceof StrategyNotFoundError) {
    return new NotFoundException({
      statusCode: 404,
      code: 'STRATEGY_NOT_FOUND',
      message: error.message,
      missionId: error.missionId,
      heroId: error.heroId,
    })
  }

  if (error instanceof HeroAbilitiesUnavailableError) {
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: error.message,
    })
  }

  if (error instanceof HttpException) {
    return error
  }

  // Motor inalcanzable o cualquier fallo no previsto: 503, nunca una respuesta
  // que aparente un resultado. El detalle interno no se expone.
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'El servicio de misiones no pudo completar la operación. Intenta de nuevo.',
  })
}
