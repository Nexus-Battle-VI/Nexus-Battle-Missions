import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator'

import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from '../../../application/use-cases/ListMissionHistory'

/**
 * Forma admitida para el identificador de matricula en la ruta. HU-70 los crea
 * como `enr_<uuid>`; el patron acota longitud y caracteres sin atarse a eso.
 */
export const ENROLLMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

export class EnrollmentIdParamDto {
  @ApiProperty({
    example: 'enr_3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f',
    pattern: ENROLLMENT_ID_PATTERN.source,
  })
  @Matches(ENROLLMENT_ID_PATTERN, {
    message: 'enrollmentId solo admite letras, digitos, guion y guion bajo, hasta 100 caracteres.',
  })
  enrollmentId!: string
}

/** El cursor es el `nextCursor` de la pagina anterior: base64url, opaco para el cliente. */
export const HISTORY_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/

export class MissionHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: HISTORY_MAX_LIMIT, default: HISTORY_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un número entero.' })
  @Min(1, { message: 'limit debe ser al menos 1.' })
  @Max(HISTORY_MAX_LIMIT, { message: `limit no puede pasar de ${String(HISTORY_MAX_LIMIT)}.` })
  limit?: number

  @ApiPropertyOptional({ description: 'El `nextCursor` de la página anterior.' })
  @IsOptional()
  @Matches(HISTORY_CURSOR_PATTERN, { message: 'cursor no tiene la forma que da el servicio.' })
  cursor?: string
}

/**
 * Reporte de una mision terminada (contrato hu-74-mission-report-v1). Los
 * bloques anidados siguen el contrato; aqui se documentan como objetos para no
 * duplicar su forma.
 */
export class MissionReportResponseDto {
  @ApiProperty({ example: 1 }) schemaVersion!: number
  @ApiProperty() enrollmentId!: string
  @ApiProperty({ type: Object }) mission!: object
  @ApiProperty({ type: Object }) summary!: object
  @ApiProperty({ type: Object }) combatStats!: object
  @ApiProperty({ type: Object }) enemies!: object
  @ApiPropertyOptional({ type: [Object], description: 'Botin obtenido del jefe.' })
  loot?: readonly object[]
  @ApiProperty({ type: [Object] }) objectives!: readonly object[]
  @ApiProperty({ type: [Object], description: 'Lo único que cambia con el tiempo.' })
  rewards!: readonly object[]

  @ApiProperty({
    type: Object,
    description:
      'Experiencia por derrota agregada (HU-09): derrotas, experiencia acreditada y nivel del héroe.',
  })
  experience!: object

  @ApiProperty({ example: '2026-10-02T03:00:05.000Z' }) generatedAt!: string
}

export class MissionHistoryResponseDto {
  @ApiProperty({ type: [Object] }) items!: readonly object[]
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null
}

export class MissionHistorySummaryResponseDto {
  @ApiProperty({ type: [Object] }) byCategory!: readonly object[]
  @ApiProperty({ type: [Object] }) bestTimes!: readonly object[]
  @ApiProperty({ type: [Object] }) epicCollection!: readonly object[]
  @ApiProperty({
    type: [Object],
    description:
      'Cada epica que se puede ganar, con su Master y su mision, y si ya se tiene (P-J3).',
  })
  epicAlbum!: readonly object[]
  @ApiProperty({ type: [Object] }) lootCollection!: readonly object[]
  @ApiProperty({ type: [Object] }) narrativeProgress!: readonly object[]
}
