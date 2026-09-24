import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { toMissionsHttpException } from '../../src/adapters/inbound/http/missions-error.mapper'
import { ProgressionLockedError } from '../../src/domain/policies/DifficultyPolicy'
import { UnknownDifficultyError } from '../../src/domain/value-objects/difficulty-level'

describe('toMissionsHttpException: codigos estables del contrato de HU-75', () => {
  it('PROGRESSION_LOCKED es 422 con el cuerpo que Web muestra sin recalcular la regla', () => {
    const exception = toMissionsHttpException(
      new ProgressionLockedError('msn-1', 'LEGENDARY', 'HEROIC'),
    )

    expect(exception).toBeInstanceOf(UnprocessableEntityException)
    expect(exception.getResponse()).toEqual({
      statusCode: 422,
      code: 'PROGRESSION_LOCKED',
      message: 'No puedes iniciar esta misión en Legendario: primero complétala en Heroico.',
      missionId: 'msn-1',
      requested: 'LEGENDARY',
      required: 'HEROIC',
    })
  })

  it('UNKNOWN_DIFFICULTY es 400', () => {
    const exception = toMissionsHttpException(new UnknownDifficultyError('EASY'))

    expect(exception).toBeInstanceOf(BadRequestException)
    expect(exception.getResponse()).toMatchObject({ statusCode: 400, code: 'UNKNOWN_DIFFICULTY' })
  })

  it('una excepcion HTTP ya construida pasa tal cual', () => {
    const original = new NotFoundException('no existe')

    expect(toMissionsHttpException(original)).toBe(original)
  })

  // Control: un motor caido no puede aparentar "sin progreso". Si se tradujera
  // a un 200 vacio, un jugador con Heroico libre lo veria bloqueado.
  it('cualquier otro fallo es 503 y no filtra el detalle interno', () => {
    const exception = toMissionsHttpException(new Error('connect ECONNREFUSED 10.0.0.5:5432'))

    expect(exception).toBeInstanceOf(ServiceUnavailableException)
    expect(exception.getResponse()).toMatchObject({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
    })
    expect(JSON.stringify(exception.getResponse())).not.toContain('ECONNREFUSED')
  })
})
