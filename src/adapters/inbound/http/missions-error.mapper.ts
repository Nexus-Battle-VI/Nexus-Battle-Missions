import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { ProgressionLockedError } from '../../../domain/policies/DifficultyPolicy'
import { UnknownDifficultyError } from '../../../domain/value-objects/difficulty-level'

/**
 * Traduce los errores de Missions a HTTP con los codigos ESTABLES del contrato
 * hu-75-mission-difficulty-v1. Web muestra `message` tal cual y no recalcula la
 * regla de progresion.
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

  if (error instanceof HttpException) {
    return error
  }

  // Motor inalcanzable o cualquier fallo no previsto: 503, nunca una respuesta
  // que aparente "sin progreso". Un jugador con Heroico libre no debe verlo
  // bloqueado porque la base no respondio. El detalle interno no se expone.
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'No se pudo consultar el progreso de dificultad. Intenta de nuevo.',
  })
}
