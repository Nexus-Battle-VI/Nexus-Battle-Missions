import { BadRequestException, Body, Controller, Get, Inject, Param, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'

import {
  MISSION_CONTENT,
  type MissionContentPort,
} from '../../../application/ports/MissionContentPort'
import { Role } from '../../../application/ports/TokenVerifierPort'
import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import { InvalidMasterConfigError } from '../../../domain/policies/MasterPolicy'
import {
  InvalidMissionContentError,
  missionDefinitionOf,
} from '../../../domain/policies/MissionContentPolicy'
import { Roles } from './auth/decorators'

@ApiTags('mission-content')
@ApiBearerAuth()
@Controller('v1/admin/missions')
export class MissionContentController {
  constructor(@Inject(MISSION_CONTENT) private readonly content: MissionContentPort) {}

  @Get()
  @Roles(Role.Administrator)
  @ApiOperation({ summary: 'Lista el contenido completo, incluso misiones inactivas' })
  list(): Promise<readonly MissionDefinition[]> {
    return this.content.listAll()
  }

  @Put(':missionId')
  @Roles(Role.Administrator)
  @ApiOperation({ summary: 'Crea o actualiza una mision jugable' })
  async save(
    @Param('missionId') missionId: string,
    @Body() body: unknown,
  ): Promise<MissionDefinition> {
    try {
      return await this.content.save(missionDefinitionOf(body, missionId))
    } catch (error: unknown) {
      if (
        error instanceof InvalidMissionContentError ||
        error instanceof InvalidMasterConfigError
      ) {
        throw new BadRequestException({ code: 'MISSION_CONTENT_INVALID', message: error.message })
      }
      throw error
    }
  }
}
