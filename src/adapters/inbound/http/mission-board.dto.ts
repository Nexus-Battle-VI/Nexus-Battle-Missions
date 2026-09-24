import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsIn, IsOptional } from 'class-validator'

import {
  MISSION_CATEGORIES,
  PLAYER_MISSION_STATUSES,
  type MissionCategory,
  type PlayerMissionStatus,
} from '../../../domain/value-objects/mission-category'

/** Filtros opcionales del tablon (hu-70-mission-enrollment-v1). */
export class MissionBoardQueryDto {
  @ApiPropertyOptional({ enum: [...MISSION_CATEGORIES] })
  @IsOptional()
  @IsIn([...MISSION_CATEGORIES], {
    message: `category debe ser uno de: ${MISSION_CATEGORIES.join(', ')}.`,
  })
  category?: MissionCategory

  @ApiPropertyOptional({ enum: [...PLAYER_MISSION_STATUSES] })
  @IsOptional()
  @IsIn([...PLAYER_MISSION_STATUSES], {
    message: `status debe ser uno de: ${PLAYER_MISSION_STATUSES.join(', ')}.`,
  })
  status?: PlayerMissionStatus
}

export class RewardLabelDto {
  @ApiProperty({ example: '50 créditos' })
  label!: string
}

export class MissionCardDto {
  @ApiProperty({ example: 'msn_templo_olvidado' })
  missionId!: string

  @ApiProperty({ example: 'El Templo Olvidado' })
  name!: string

  @ApiProperty({ enum: [...MISSION_CATEGORIES] })
  category!: MissionCategory

  @ApiProperty()
  summary!: string

  @ApiProperty({ type: String, nullable: true })
  imageRef!: string | null

  @ApiProperty({ example: 'PT12H', description: 'Duración ISO-8601.' })
  estimatedDuration!: string

  @ApiProperty({ type: Number, nullable: true, description: 'Informativo: no bloquea.' })
  recommendedPower!: number | null

  @ApiProperty({ type: [RewardLabelDto] })
  highlightedRewards!: readonly RewardLabelDto[]

  @ApiProperty({ enum: [...PLAYER_MISSION_STATUSES] })
  playerStatus!: PlayerMissionStatus

  @ApiProperty()
  canEnroll!: boolean

  @ApiProperty({ type: String, nullable: true, example: 'Completa primero «El Templo Olvidado».' })
  lockReason!: string | null

  @ApiProperty({ type: String, nullable: true })
  activeEnrollmentId!: string | null
}

export class MissionBoardResponseDto {
  @ApiProperty({ type: [MissionCardDto] })
  items!: readonly MissionCardDto[]
}

/**
 * Detalle antes de confirmar (CA-06). Los bloques anidados siguen el contrato;
 * aqui se documentan como objetos para no duplicar su forma.
 */
export class MissionDetailResponseDto {
  @ApiProperty() missionId!: string
  @ApiProperty() name!: string
  @ApiProperty({ enum: [...MISSION_CATEGORIES] }) category!: MissionCategory
  @ApiProperty() narrative!: string
  @ApiProperty({ type: [Object] }) objectives!: readonly object[]
  @ApiProperty({ example: 'PT12H' }) estimatedDuration!: string
  @ApiProperty({ type: Number, nullable: true }) recommendedPower!: number | null
  @ApiProperty({ type: [String] }) prerequisites!: readonly string[]
  @ApiProperty({ type: [Object] }) enemies!: readonly object[]
  @ApiProperty({ type: Object }) finalBoss!: object
  @ApiProperty({ type: Object }) masterEncounter!: object
  @ApiProperty({ type: Object }) rewards!: object
  @ApiProperty({ enum: [...PLAYER_MISSION_STATUSES] }) playerStatus!: PlayerMissionStatus
  @ApiProperty() canEnroll!: boolean
  @ApiProperty({ type: String, nullable: true }) lockReason!: string | null
}
