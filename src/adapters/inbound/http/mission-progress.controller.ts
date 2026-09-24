import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Min } from 'class-validator'

import { Role } from '../../../application/ports/TokenVerifierPort'
import type { VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  GET_MISSION_PROGRESS,
  GetMissionProgress,
  type MissionProgressView,
} from '../../../application/use-cases/GetMissionProgress'
import {
  LIST_ACTIVE_MISSIONS,
  ListActiveMissions,
  type ActiveMissionsView,
} from '../../../application/use-cases/ListActiveMissions'
import { CurrentIdentity, Roles } from './auth/decorators'
import { EnrollmentIdParamDto } from './mission-report.dto'
import { toMissionsHttpException } from './missions-error.mapper'

export class MissionProgressQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: 'El `lastSeq` de la consulta anterior: solo llega lo nuevo.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'after debe ser un número entero.' })
  @Min(0, { message: 'after no puede ser negativo.' })
  after?: number
}

/** Las formas se documentan como objetos: siguen el diseno «misiones jugables», P-J6. */
export class ActiveMissionsResponseDto {
  @ApiProperty() serverTime!: string
  @ApiProperty({ type: [Object] }) items!: object[]
}

export class MissionProgressResponseDto {
  @ApiProperty() enrollmentId!: string
  @ApiProperty() status!: string
  @ApiProperty() progressPercent!: number
  @ApiProperty({ type: [Object] }) entries!: object[]
  @ApiProperty() lastSeq!: number
}

/**
 * Misiones en curso y su progreso (diseno «misiones jugables», P-J6; curso 7.8.9,
 * «Panel de misiones activas»). Como el reporte, todo cuelga de `/me`: el jugador
 * sale del testimonio verificado y nadie ve las misiones de otro.
 */
@ApiTags('missions')
@ApiBearerAuth()
@Controller('v1/missions/me')
export class MissionProgressController {
  constructor(
    @Inject(LIST_ACTIVE_MISSIONS) private readonly listActive: ListActiveMissions,
    @Inject(GET_MISSION_PROGRESS) private readonly getProgress: GetMissionProgress,
  ) {}

  @Get('active')
  @Roles(Role.Player)
  @ApiOperation({ summary: 'Misiones en curso del jugador, con su progreso y el tiempo que falta' })
  @ApiOkResponse({ type: ActiveMissionsResponseDto })
  async active(@CurrentIdentity() identity: VerifiedIdentity): Promise<ActiveMissionsView> {
    try {
      return await this.listActive.execute(identity.subject)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }

  @Get('progress/:enrollmentId')
  @Roles(Role.Player)
  @ApiOperation({
    summary: 'Bitácora revelada de una misión: lo que ya pasó, sin adelantar el desenlace',
  })
  @ApiOkResponse({ type: MissionProgressResponseDto })
  @ApiResponse({ status: 404, description: 'ENROLLMENT_NOT_FOUND: no existe o no es del jugador' })
  async progress(
    @Param() params: EnrollmentIdParamDto,
    @Query() query: MissionProgressQueryDto,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<MissionProgressView> {
    try {
      return await this.getProgress.execute(identity.subject, params.enrollmentId, query.after ?? 0)
    } catch (error: unknown) {
      throw toMissionsHttpException(error)
    }
  }
}
