import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  GET_MISSION_HISTORY_SUMMARY,
  GetMissionHistorySummary,
  type HistorySummaryView,
} from '../../../application/use-cases/GetMissionHistorySummary'
import {
  GET_MISSION_REPORT,
  GetMissionReport,
  type MissionReportView,
} from '../../../application/use-cases/GetMissionReport'
import {
  HISTORY_DEFAULT_LIMIT,
  LIST_MISSION_HISTORY,
  ListMissionHistory,
  type HistoryPage,
} from '../../../application/use-cases/ListMissionHistory'
import { CurrentIdentity, Roles } from './auth/decorators'
import {
  EnrollmentIdParamDto,
  MissionHistoryQueryDto,
  MissionHistoryResponseDto,
  MissionHistorySummaryResponseDto,
  MissionReportResponseDto,
} from './mission-report.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/**
 * Reporte e historial de misiones (Task HU-74.2, contrato hu-74-mission-report-v1).
 *
 * Todo cuelga de `/me`: el jugador sale SIEMPRE del testimonio verificado, nunca
 * de la ruta ni de la consulta, y nadie lee los reportes de otro (P-T8).
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions/me')
export class MissionReportController {
  constructor(
    @Inject(GET_MISSION_REPORT) private readonly getReport: GetMissionReport,
    @Inject(LIST_MISSION_HISTORY) private readonly listHistory: ListMissionHistory,
    @Inject(GET_MISSION_HISTORY_SUMMARY) private readonly getSummary: GetMissionHistorySummary,
  ) {}

  @Get('reports/:enrollmentId')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Reporte de una misión terminada del jugador (CA-01 a CA-04)' })
  @ApiOkResponse({ type: MissionReportResponseDto })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_AVAILABLE (en curso) o REPORT_NOT_FOUND' })
  async report(
    @Param() params: EnrollmentIdParamDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionReportView> {
    try {
      return await this.getReport.execute(identity.subject, params.enrollmentId)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }

  @Get('history')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Misiones terminadas del jugador, de la más reciente a la más antigua' })
  @ApiOkResponse({ type: MissionHistoryResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR: limit o cursor no válidos' })
  async history(
    @Query() query: MissionHistoryQueryDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<HistoryPage> {
    try {
      return await this.listHistory.execute(identity.subject, {
        limit: query.limit ?? HISTORY_DEFAULT_LIMIT,
        cursor: query.cursor ?? null,
      })
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }

  @Get('history/summary')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Estadísticas por tipo, mejores tiempos, épicas y progreso narrativo (CA-05)',
  })
  @ApiOkResponse({ type: MissionHistorySummaryResponseDto })
  async summary(@CurrentIdentity() identity: VerifiedIdentity): Promise<HistorySummaryView> {
    try {
      return await this.getSummary.execute(identity.subject)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
