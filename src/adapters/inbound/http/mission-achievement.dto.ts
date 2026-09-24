import { ApiProperty } from '@nestjs/swagger'

/**
 * Logros del jugador (contrato hu-76-mission-achievements-v1). Cada elemento
 * sigue el contrato: `achievementId`, `name`, `criterion`, `status` (`LOCKED`,
 * `IN_PROGRESS` o `UNLOCKED`), `progress` (`current` y `target`), `unlockedAt` y
 * `recognition` (`kind`, `name` y `status`). Aqui se documentan como objetos para
 * no duplicar su forma.
 */
export class MissionAchievementsResponseDto {
  @ApiProperty({
    type: [Object],
    description:
      'Un logro por definición del catálogo, y los desbloqueados que ya no están en él. ' +
      'Primero los desbloqueados, del más reciente al más antiguo.',
  })
  items!: readonly object[]
}
