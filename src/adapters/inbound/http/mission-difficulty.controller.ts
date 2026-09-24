import { Controller, Get, Inject, Param } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  LIST_MISSION_DIFFICULTIES,
  ListMissionDifficulties,
} from '../../../application/use-cases/ListMissionDifficulties'
import { CurrentIdentity, Roles } from './auth/decorators'
import { MissionDifficultiesResponseDto, MissionIdParamDto } from './mission-difficulty.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/**
 * Primera ruta de negocio de Missions (Task HU-75.2, contrato
 * hu-75-mission-difficulty-v1).
 *
 * El jugador sale SIEMPRE del testimonio verificado (`subject`), nunca de la
 * ruta ni de la consulta: nadie puede consultar el progreso de otro.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions')
export class MissionDifficultyController {
  constructor(
    @Inject(LIST_MISSION_DIFFICULTIES)
    private readonly listMissionDifficulties: ListMissionDifficulties,
  ) {}

  @Get(':missionId/difficulties')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Niveles de dificultad de una mision y si el jugador autenticado los tiene libres',
  })
  @ApiOkResponse({ type: MissionDifficultiesResponseDto })
  @ApiResponse({ status: 400, description: 'missionId con formato invalido' })
  @ApiResponse({ status: 503, description: 'No se pudo consultar el progreso' })
  async difficulties(
    @Param() params: MissionIdParamDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionDifficultiesResponseDto> {
    try {
      return await this.listMissionDifficulties.execute(identity.subject, params.missionId)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
