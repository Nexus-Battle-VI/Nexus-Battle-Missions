import { Body, Controller, Get, Inject, Param, Put, Res } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Response } from 'express'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  GET_MISSION_STRATEGY,
  GetMissionStrategy,
  type StrategyView,
} from '../../../application/use-cases/GetMissionStrategy'
import {
  SAVE_MISSION_STRATEGY,
  SaveMissionStrategy,
} from '../../../application/use-cases/SaveMissionStrategy'
import type { Rotation, RotationStep } from '../../../domain/value-objects/rotation'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  RotationDto,
  RotationStepDto,
  SaveStrategyRequestDto,
  StrategyPathDto,
  StrategyResponseDto,
} from './mission-strategy.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/** Del DTO ya validado al dominio: un ataque basico no lleva `abilityId`. */
const toStep = (step: RotationStepDto): RotationStep =>
  step.kind === 'ABILITY'
    ? { kind: 'ABILITY', abilityId: step.abilityId ?? '' }
    : { kind: 'BASIC_ATTACK' }

const toRotation = (rotation: RotationDto): Rotation => ({
  priority: rotation.priority,
  steps: rotation.steps.map(toStep),
})

/**
 * Estrategia de rotaciones por mision y heroe (Task HU-71.2, contrato
 * hu-71-mission-strategy-v1). El jugador sale SIEMPRE del testimonio: nadie lee
 * ni guarda la estrategia de otro.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions')
export class MissionStrategyController {
  constructor(
    @Inject(GET_MISSION_STRATEGY) private readonly getStrategy: GetMissionStrategy,
    @Inject(SAVE_MISSION_STRATEGY) private readonly saveStrategy: SaveMissionStrategy,
  ) {}

  @Get(':missionId/strategies/:heroId')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Consultar la estrategia guardada de un héroe en una misión' })
  @ApiOkResponse({ type: StrategyResponseDto })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND o STRATEGY_NOT_FOUND' })
  async strategy(
    @Param() params: StrategyPathDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<StrategyView> {
    try {
      return await this.getStrategy.execute(
        identity.subject,
        params.missionId,
        params.heroId.toLowerCase(),
      )
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }

  @Put(':missionId/strategies/:heroId')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Guardar la estrategia: hasta tres rotaciones (CA-01 y CA-04)' })
  @ApiCreatedResponse({ type: StrategyResponseDto, description: 'Primera versión' })
  @ApiOkResponse({ type: StrategyResponseDto, description: 'Versión reemplazada' })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'VERSION_CONFLICT' })
  @ApiResponse({
    status: 422,
    description: 'TOO_MANY_ROTATIONS, INVALID_ROTATION, UNKNOWN_ABILITY o HERO_NOT_OWNED',
  })
  @ApiResponse({ status: 503, description: 'DEPENDENCY_UNAVAILABLE: habilidades sin consultar' })
  async save(
    @Param() params: StrategyPathDto,
    @Body() body: SaveStrategyRequestDto,
    @CurrentIdentity() identity: VerifiedIdentity,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StrategyView> {
    try {
      const saved = await this.saveStrategy.execute({
        playerId: identity.subject,
        missionId: params.missionId,
        heroId: params.heroId.toLowerCase(),
        expectedVersion: body.expectedVersion ?? null,
        rotations: body.rotations.map(toRotation),
      })

      response.status(saved.created ? 201 : 200)

      return saved.strategy
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
