import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  ENROLL_IN_MISSION,
  EnrollInMission,
  type EnrollmentView,
} from '../../../application/use-cases/EnrollInMission'
import { CurrentIdentity, Roles } from './auth/decorators'
import { MissionIdParamDto } from './mission-difficulty.dto'
import { EnrollmentRequestDto, EnrollmentResponseDto } from './mission-enrollment.dto'
import { toMissionsHttpException } from './missions-error.mapper'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Matricula de un heroe en una mision (Task HU-70.2, contrato
 * hu-70-mission-enrollment-v1). `Idempotency-Key` es obligatoria (propuesta
 * P-M3): Web la genera al pulsar «Iniciar misión» y la reutiliza en los
 * reintentos de esa pulsacion. Repetirla devuelve el resultado guardado.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions')
export class MissionEnrollmentController {
  constructor(@Inject(ENROLL_IN_MISSION) private readonly enrollInMission: EnrollInMission) {}

  @Post(':missionId/enrollments')
  @HttpCode(201)
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Matricular un héroe en una misión (CA-01 a CA-05 y CA-07)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID de la pulsación' })
  @ApiCreatedResponse({ type: EnrollmentResponseDto })
  @ApiResponse({
    status: 400,
    description: 'IDEMPOTENCY_KEY_REQUIRED, UNKNOWN_DIFFICULTY o validación',
  })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'HERO_BUSY, MISSION_ALREADY_IN_PROGRESS, …' })
  @ApiResponse({
    status: 422,
    description: 'MISSION_LOCKED, PROGRESSION_LOCKED, LOADOUT_INCOMPLETE, …',
  })
  @ApiResponse({ status: 503, description: 'DEPENDENCY_UNAVAILABLE: la matrícula sigue PENDING' })
  async enroll(
    @Param() params: MissionIdParamDto,
    @Body() body: EnrollmentRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<EnrollmentView> {
    if (idempotencyKey === undefined || !UUID_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'La cabecera Idempotency-Key es obligatoria y debe ser un UUID.',
      })
    }

    try {
      return await this.enrollInMission.execute({
        playerId: identity.subject,
        missionId: params.missionId,
        heroId: body.heroId.toLowerCase(),
        difficulty: body.difficulty ?? '',
        strategyVersion: body.strategyVersion ?? null,
        idempotencyKey: idempotencyKey.toLowerCase(),
      })
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
