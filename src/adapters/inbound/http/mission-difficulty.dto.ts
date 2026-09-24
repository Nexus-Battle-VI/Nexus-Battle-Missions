import { ApiProperty } from '@nestjs/swagger'
import { Matches } from 'class-validator'

import {
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
} from '../../../domain/value-objects/difficulty-level'
import { REWARD_TIERS, type RewardTier } from '../../../domain/value-objects/difficulty-scaling'

/**
 * Forma admitida para el identificador de mision en la ruta. El tablon (HU-70)
 * todavia no fija el formato: este patron solo acota longitud y caracteres para
 * que la ruta no acepte cualquier cadena, sin adelantar una decision de HU-70.
 */
export const MISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export class MissionIdParamDto {
  @ApiProperty({ example: 'msn_templo-olvidado', pattern: MISSION_ID_PATTERN.source })
  @Matches(MISSION_ID_PATTERN, {
    message: 'missionId solo admite letras, digitos, guion y guion bajo, hasta 64 caracteres.',
  })
  missionId!: string
}

export class MissionDifficultyItemDto {
  @ApiProperty({ enum: [...DIFFICULTY_LEVELS], example: 'HEROIC' })
  difficulty!: DifficultyLevel

  @ApiProperty({ example: false })
  unlocked!: boolean

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Debes completar esta misión en Normal al menos una vez.',
  })
  lockReason!: string | null

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1.5,
    description: 'Factor sobre las estadisticas enemigas. null en MYTHIC hasta que el PO lo fije.',
  })
  enemyStatMultiplier!: number | null

  @ApiProperty({ enum: [...REWARD_TIERS], example: 'IMPROVED' })
  rewardTier!: RewardTier

  @ApiProperty({
    example: 1,
    description: 'P-J8: enemigos de mas en el primer grupo de cada encuentro regular.',
  })
  extraEnemiesPerEncounter!: number

  @ApiProperty({ example: 0, description: 'P-J8: ataque de mas del jefe cuando se enfurece.' })
  bossEnrageBonus!: number

  @ApiProperty({
    example: 25,
    description: 'P-J8: cuanto sube la probabilidad del botin del jefe, en porcentaje.',
  })
  lootBonusPercent!: number
}

/** Web -> Missions, `GET /api/v1/missions/{missionId}/difficulties` (hu-75-mission-difficulty-v1). */
export class MissionDifficultiesResponseDto {
  @ApiProperty({ example: 'msn_templo-olvidado' })
  missionId!: string

  @ApiProperty({ type: [MissionDifficultyItemDto] })
  items!: readonly MissionDifficultyItemDto[]
}
