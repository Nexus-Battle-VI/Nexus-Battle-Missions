import { Controller, Get, Inject } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  GET_MISSION_ACHIEVEMENTS,
  GetMissionAchievements,
  type MissionAchievementsView,
} from '../../../application/use-cases/GetMissionAchievements'
import { CurrentIdentity, Roles } from './auth/decorators'
import { MissionAchievementsResponseDto } from './mission-achievement.dto'
import { toMissionsHttpException } from './missions-error.mapper'

/**
 * Logros de misiones del jugador (Task HU-76.2, contrato
 * hu-76-mission-achievements-v1). Cuelga de `/me`: el jugador sale SIEMPRE del
 * testimonio verificado, nunca de la consulta; un `?playerId=` se ignora.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions/me')
export class MissionAchievementController {
  constructor(
    @Inject(GET_MISSION_ACHIEVEMENTS) private readonly getAchievements: GetMissionAchievements,
  ) {}

  @Get('achievements')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Logros de misiones del jugador con su progreso y su reconocimiento (CA-01 a CA-03)',
  })
  @ApiOkResponse({ type: MissionAchievementsResponseDto })
  @ApiResponse({ status: 503, description: 'DEPENDENCY_UNAVAILABLE' })
  async achievements(
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionAchievementsView> {
    try {
      return await this.getAchievements.execute(identity.subject)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
