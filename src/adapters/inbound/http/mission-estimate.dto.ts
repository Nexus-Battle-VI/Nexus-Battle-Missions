import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, IsUUID } from 'class-validator'

import { ESTIMATE_RISKS, type EstimateRisk } from '../../../domain/policies/EstimatePolicy'
import {
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
} from '../../../domain/value-objects/difficulty-level'

/**
 * Consulta de la estimacion (P-J7). `difficulty` es opcional AQUI por lo mismo que
 * en la matricula: si falta o no existe, el caso de uso responde
 * `400 UNKNOWN_DIFFICULTY`, que es el codigo del contrato de HU-75.
 */
export class MissionEstimateQueryDto {
  @ApiProperty({ format: 'uuid', example: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60' })
  @IsUUID('all', { message: 'heroId debe ser un UUID.' })
  heroId!: string

  @ApiPropertyOptional({ enum: [...DIFFICULTY_LEVELS], example: 'NORMAL' })
  @IsOptional()
  @IsString()
  difficulty?: string
}

export class EstimatedAbilityDto {
  @ApiProperty({ example: 'golpe-de-tormenta' })
  abilityId!: string

  @ApiProperty({ example: 'Golpe de tormenta' })
  name!: string

  @ApiProperty({ example: true })
  usable!: boolean

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'un efecto condicionado no se evalua: Combat no recibe la condicion.',
  })
  reason!: string | null
}

/** Missions -> Web: la probabilidad de exito antes de enviar al heroe. */
export class MissionEstimateResponseDto {
  @ApiProperty({ example: 'msn_templo_olvidado' })
  missionId!: string

  @ApiProperty({ format: 'uuid' })
  heroId!: string

  @ApiProperty({ enum: [...DIFFICULTY_LEVELS], example: 'NORMAL' })
  difficulty!: DifficultyLevel

  @ApiProperty({ type: Number, nullable: true, example: 2 })
  strategyVersion!: number | null

  @ApiProperty({ example: 30, description: 'Simulaciones que corrio Combat.' })
  runs!: number

  @ApiProperty({ example: 73, description: 'Victorias, en porcentaje entero.' })
  successPercent!: number

  @ApiProperty({ example: 20 })
  defeatPercent!: number

  @ApiProperty({ example: 7, description: 'Corridas que agotaron el tiempo de la mision.' })
  timeoutPercent!: number

  @ApiProperty({ enum: [...ESTIMATE_RISKS], example: 'MEDIUM' })
  risk!: EstimateRisk

  @ApiProperty({ example: 'Pareja' })
  riskLabel!: string

  @ApiProperty({ example: 41 })
  averageTurns!: number

  @ApiProperty({ example: 35, description: 'Vida mas baja del heroe, de media, en porcentaje.' })
  averageMinHealthPercent!: number

  @ApiProperty({ example: 17 })
  masterAppearancePercent!: number

  @ApiProperty({ type: [EstimatedAbilityDto] })
  abilities!: readonly EstimatedAbilityDto[]
}
