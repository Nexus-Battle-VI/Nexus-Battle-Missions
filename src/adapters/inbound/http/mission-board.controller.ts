import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  GET_MISSION_DETAIL,
  GetMissionDetail,
  type MissionDetailView,
} from '../../../application/use-cases/GetMissionDetail'
import {
  LIST_MISSION_BOARD,
  ListMissionBoard,
  type MissionCardView,
} from '../../../application/use-cases/ListMissionBoard'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  MissionBoardQueryDto,
  MissionBoardResponseDto,
  MissionDetailResponseDto,
} from './mission-board.dto'
import { MissionIdParamDto } from './mission-difficulty.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/**
 * Tablon y detalle de misiones (Task HU-70.2, contrato hu-70-mission-enrollment-v1).
 *
 * El jugador sale SIEMPRE del testimonio verificado: el estado de cada mision se
 * deriva para ese jugador y nadie puede ver el de otro.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions')
export class MissionBoardController {
  constructor(
    @Inject(LIST_MISSION_BOARD) private readonly listBoard: ListMissionBoard,
    @Inject(GET_MISSION_DETAIL) private readonly getDetail: GetMissionDetail,
  ) {}

  @Get()
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Tablón de misiones con el estado para el jugador autenticado' })
  @ApiOkResponse({ type: MissionBoardResponseDto })
  @ApiResponse({ status: 400, description: 'Filtro fuera del vocabulario' })
  @ApiResponse({ status: 503, description: 'No se pudo consultar el tablón' })
  async board(
    @Query() query: MissionBoardQueryDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<{ readonly items: readonly MissionCardView[] }> {
    try {
      return await this.listBoard.execute(identity.subject, {
        category: query.category ?? null,
        status: query.status ?? null,
      })
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }

  @Get(':missionId')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Detalle de una misión antes de matricularse (CA-06)' })
  @ApiOkResponse({ type: MissionDetailResponseDto })
  @ApiResponse({ status: 404, description: 'MISSION_NOT_FOUND' })
  async detail(
    @Param() params: MissionIdParamDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionDetailView> {
    try {
      return await this.getDetail.execute(identity.subject, params.missionId)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
