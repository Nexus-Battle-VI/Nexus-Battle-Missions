import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  ESTIMATE_MISSION_SUCCESS,
  EstimateMissionSuccess,
} from '../../../application/use-cases/EstimateMissionSuccess'
import { CurrentIdentity, Roles } from './auth/decorators'
import { MissionIdParamDto } from './mission-difficulty.dto'
import { MissionEstimateQueryDto, MissionEstimateResponseDto } from './mission-estimate.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/**
 * Probabilidad de exito antes de enviar al heroe (diseno «misiones jugables»,
 * P-J7). El jugador sale del testimonio verificado, nunca de la consulta: solo se
 * estima con heroes y estrategias propios.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions')
export class MissionEstimateController {
  constructor(
    @Inject(ESTIMATE_MISSION_SUCCESS)
    private readonly estimateMissionSuccess: EstimateMissionSuccess,
  ) {}

  @Get(':missionId/estimate')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Probabilidad de exito de un heroe en una mision y nivel, sin matricular',
    description:
      'Combat corre la misma simulacion varias veces con semillas propias. No guarda nada ni adelanta el resultado de la mision real.',
  })
  @ApiOkResponse({ type: MissionEstimateResponseDto })
  @ApiResponse({ status: 400, description: 'UNKNOWN_DIFFICULTY o datos invalidos' })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  @ApiResponse({ status: 422, description: 'HERO_NOT_OWNED' })
  @ApiResponse({ status: 503, description: 'ESTIMATE_UNAVAILABLE' })
  async estimate(
    @Param() params: MissionIdParamDto,
    @Query() query: MissionEstimateQueryDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionEstimateResponseDto> {
    try {
      return await this.estimateMissionSuccess.execute({
        playerId: identity.subject,
        missionId: params.missionId,
        heroId: query.heroId,
        difficulty: query.difficulty ?? '',
      })
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
