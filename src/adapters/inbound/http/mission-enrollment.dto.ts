import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, IsUUID, Min, ValidateIf } from 'class-validator'

import {
  ENROLLMENT_STATUSES,
  type EnrollmentStatus,
} from '../../../domain/entities/MissionEnrollment'
import {
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
} from '../../../domain/value-objects/difficulty-level'

/**
 * Cuerpo de la matricula (hu-70-mission-enrollment-v1, con las extensiones de
 * HU-75 y HU-71). `difficulty` es opcional AQUI a proposito: si falta, el caso de
 * uso responde `400 UNKNOWN_DIFFICULTY`, que es lo que fija el contrato de HU-75,
 * en lugar de un error de validacion generico.
 */
export class EnrollmentRequestDto {
  @ApiProperty({ format: 'uuid', example: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60' })
  @IsUUID('all', { message: 'heroId debe ser un UUID.' })
  heroId!: string

  @ApiProperty({ enum: [...DIFFICULTY_LEVELS], example: 'NORMAL' })
  @IsOptional()
  @IsString()
  difficulty?: string

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'Versión de la estrategia guardada (HU-71), o null si no hay ninguna.',
  })
  @IsOptional()
  @ValidateIf((dto: EnrollmentRequestDto) => dto.strategyVersion !== null)
  @IsInt({ message: 'strategyVersion debe ser un entero positivo o null.' })
  @Min(1, { message: 'strategyVersion debe ser un entero positivo o null.' })
  strategyVersion?: number | null
}

export class EnrollmentResponseDto {
  @ApiProperty({ example: 'enr_4d1c…' })
  enrollmentId!: string

  @ApiProperty({ example: 'msn_templo_olvidado' })
  missionId!: string

  @ApiProperty({ format: 'uuid' })
  heroId!: string

  @ApiProperty({ enum: [...DIFFICULTY_LEVELS] })
  difficulty!: DifficultyLevel

  @ApiProperty({ enum: [...ENROLLMENT_STATUSES], example: 'IN_PROGRESS' })
  status!: EnrollmentStatus

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  startedAt!: string | null

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  endsAt!: string | null
}
