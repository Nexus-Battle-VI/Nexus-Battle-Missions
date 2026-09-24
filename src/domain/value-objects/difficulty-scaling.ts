import type { DifficultyLevel } from './difficulty-level'

/**
 * Nivel de recompensa de una matricula (propuesta P-D7 del diseno de HU-75,
 * pendiente de acuerdo con HU-10). Missions NO decide montos, objetos ni rareza:
 * eso es HU-10. Este valor es la referencia con la que HU-10 elegira su tabla.
 */
export const REWARD_TIERS = ['STANDARD', 'IMPROVED', 'PREMIUM', 'EXCLUSIVE'] as const

export type RewardTier = (typeof REWARD_TIERS)[number]

/**
 * Descriptor de escalado de un nivel: lo que Missions aportara a HU-72 para que
 * Combat lo aplique. Missions no escala ninguna estadistica por si misma.
 */
export interface DifficultyScaling {
  readonly difficulty: DifficultyLevel
  /**
   * Factor sobre las estadisticas ENEMIGAS. El equipo definio Mitico en 2.5
   * para poder jugarlo; Combat redondea hacia arriba Vida, Ataque y Defensa.
   */
  readonly enemyStatMultiplier: number | null
  readonly rewardTier: RewardTier
  /**
   * Diseno «misiones jugables», P-J8: cada nivel cambia tambien QUE se enfrenta y
   * QUE se gana, no solo las estadisticas. Enemigos de mas en cada encuentro
   * regular (mas experiencia), ataque de mas del jefe enfurecido, y mas
   * probabilidad de botin y de Master (con tope en el 100 %). Propuesta del equipo,
   * pendiente del PO: el curso solo fija el porcentaje de estadisticas (7.8.11).
   */
  readonly extraEnemiesPerEncounter: number
  readonly bossEnrageBonus: number
  readonly lootProbabilityMultiplier: number
  readonly masterProbabilityMultiplier: number
}

const SCALING: Readonly<Record<DifficultyLevel, DifficultyScaling>> = {
  NORMAL: {
    difficulty: 'NORMAL',
    enemyStatMultiplier: 1,
    rewardTier: 'STANDARD',
    extraEnemiesPerEncounter: 0,
    bossEnrageBonus: 0,
    lootProbabilityMultiplier: 1,
    masterProbabilityMultiplier: 1,
  },
  HEROIC: {
    difficulty: 'HEROIC',
    enemyStatMultiplier: 1.5,
    rewardTier: 'IMPROVED',
    extraEnemiesPerEncounter: 1,
    bossEnrageBonus: 0,
    lootProbabilityMultiplier: 1.25,
    masterProbabilityMultiplier: 1.25,
  },
  LEGENDARY: {
    difficulty: 'LEGENDARY',
    enemyStatMultiplier: 2,
    rewardTier: 'PREMIUM',
    extraEnemiesPerEncounter: 1,
    bossEnrageBonus: 2,
    lootProbabilityMultiplier: 1.5,
    masterProbabilityMultiplier: 1.5,
  },
  MYTHIC: {
    difficulty: 'MYTHIC',
    enemyStatMultiplier: 2.5,
    rewardTier: 'EXCLUSIVE',
    extraEnemiesPerEncounter: 2,
    bossEnrageBonus: 4,
    lootProbabilityMultiplier: 2,
    masterProbabilityMultiplier: 2,
  },
}

export const scalingOf = (level: DifficultyLevel): DifficultyScaling => SCALING[level]
