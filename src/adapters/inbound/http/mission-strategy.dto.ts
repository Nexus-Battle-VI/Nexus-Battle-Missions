import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator'

import {
  ROTATION_PRIORITIES,
  STEP_KINDS,
  type RotationPriority,
  type StepKind,
} from '../../../domain/value-objects/rotation'
import { MISSION_ID_PATTERN } from './mission-difficulty.dto'

/**
 * Forma de un `abilityId`. El real es el `productId` de Catalog (un UUID); el
 * ejemplo del curso usa nombres legibles. Aqui solo se acota la forma: si el
 * heroe tiene esa habilidad lo decide Player/Inventory (`422 UNKNOWN_ABILITY`).
 */
const ABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const kindOf = (args?: ValidationArguments): unknown => (args?.object as { kind?: unknown }).kind

/** `ABILITY` exige `abilityId`; `BASIC_ATTACK` no lo admite. */
@ValidatorConstraint({ name: 'abilityIdMatchesKind' })
class AbilityIdMatchesKind implements ValidatorConstraintInterface {
  validate(value: unknown, args?: ValidationArguments): boolean {
    return kindOf(args) === 'ABILITY'
      ? typeof value === 'string' && ABILITY_ID_PATTERN.test(value)
      : value === undefined
  }

  defaultMessage(args?: ValidationArguments): string {
    return kindOf(args) === 'ABILITY'
      ? 'abilityId es obligatorio en una acción ABILITY: letras, dígitos, guion o guion bajo, hasta 64 caracteres.'
      : 'abilityId solo se admite en una acción ABILITY.'
  }
}

export class StrategyPathDto {
  @ApiProperty({ example: 'msn_templo_olvidado', pattern: MISSION_ID_PATTERN.source })
  @Matches(MISSION_ID_PATTERN, {
    message: 'missionId solo admite letras, digitos, guion y guion bajo, hasta 64 caracteres.',
  })
  missionId!: string

  @ApiProperty({ format: 'uuid', example: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60' })
  @IsUUID('all', { message: 'heroId debe ser un UUID.' })
  heroId!: string
}

export class RotationStepDto {
  @ApiProperty({ enum: [...STEP_KINDS] })
  @IsIn([...STEP_KINDS], { message: `kind debe ser uno de: ${STEP_KINDS.join(', ')}.` })
  kind!: StepKind

  @ApiPropertyOptional({ description: 'Obligatorio en ABILITY: el productId de la habilidad.' })
  @Validate(AbilityIdMatchesKind)
  abilityId?: string
}

export class RotationDto {
  @ApiProperty({ enum: [...ROTATION_PRIORITIES] })
  @IsIn([...ROTATION_PRIORITIES], {
    message: `priority debe ser uno de: ${ROTATION_PRIORITIES.join(', ')}.`,
  })
  priority!: RotationPriority

  @ApiProperty({ type: [RotationStepDto], description: 'Entre 1 y 3 acciones.' })
  @IsArray({ message: 'steps debe ser una lista.' })
  @ValidateNested({ each: true })
  @Type(() => RotationStepDto)
  steps!: RotationStepDto[]
}

/**
 * Cuerpo del guardado. Cuantas rotaciones y cuantas acciones NO se valida aqui:
 * una cuarta rotacion es `422 TOO_MANY_ROTATIONS` (CA-04), no un `400`.
 */
export class SaveStrategyRequestDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    description: 'La versión que leíste; null (o ausente) para crear la primera.',
  })
  @IsOptional()
  @ValidateIf((dto: SaveStrategyRequestDto) => dto.expectedVersion !== null)
  @IsInt({ message: 'expectedVersion debe ser un entero positivo o null.' })
  @Min(1, { message: 'expectedVersion debe ser un entero positivo o null.' })
  expectedVersion?: number | null

  @ApiProperty({
    type: [RotationDto],
    description: 'Hasta tres rotaciones: HIGH, MEDIUM y LOW, en ese orden.',
  })
  @IsArray({ message: 'rotations debe ser una lista.' })
  @ValidateNested({ each: true })
  @Type(() => RotationDto)
  rotations!: RotationDto[]
}

export class StrategyResponseDto {
  @ApiProperty({ example: 'msn_templo_olvidado' })
  missionId!: string

  @ApiProperty({ format: 'uuid' })
  heroId!: string

  @ApiProperty({ example: 1 })
  version!: number

  @ApiProperty({ type: [RotationDto] })
  rotations!: RotationDto[]

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string
}
