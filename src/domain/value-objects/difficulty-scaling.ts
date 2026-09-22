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
   * Factor sobre las estadisticas ENEMIGAS. `1.5` y `2` son literales de la HU
   * (50 % y 100 % mas). `null` en Mitico: la HU y el documento del curso solo
   * dicen "maxima dificultad" y no dan un numero; inventarlo seria decidir por
   * el PO. Que estadisticas escalan y como se redondean tambien esta pendiente.
   */
  readonly enemyStatMultiplier: number | null
  readonly rewardTier: RewardTier
}

const SCALING: Readonly<Record<DifficultyLevel, DifficultyScaling>> = {
  NORMAL: { difficulty: 'NORMAL', enemyStatMultiplier: 1, rewardTier: 'STANDARD' },
  HEROIC: { difficulty: 'HEROIC', enemyStatMultiplier: 1.5, rewardTier: 'IMPROVED' },
  LEGENDARY: { difficulty: 'LEGENDARY', enemyStatMultiplier: 2, rewardTier: 'PREMIUM' },
  MYTHIC: { difficulty: 'MYTHIC', enemyStatMultiplier: null, rewardTier: 'EXCLUSIVE' },
}

export const scalingOf = (level: DifficultyLevel): DifficultyScaling => SCALING[level]
