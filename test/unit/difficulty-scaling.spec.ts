import { DIFFICULTY_LEVELS } from '../../src/domain/value-objects/difficulty-level'
import { REWARD_TIERS, scalingOf } from '../../src/domain/value-objects/difficulty-scaling'

describe('Descriptor de escalado (HU-75, CA-02 y CA-04)', () => {
  it.each([
    ['NORMAL', 1, 'STANDARD'],
    ['HEROIC', 1.5, 'IMPROVED'],
    ['LEGENDARY', 2, 'PREMIUM'],
  ] as const)('%s multiplica las estadisticas enemigas por %s y usa %s', (level, factor, tier) => {
    expect(scalingOf(level)).toMatchObject({
      difficulty: level,
      enemyStatMultiplier: factor,
      rewardTier: tier,
    })
  })

  it('Mitico usa el multiplicador definido por el equipo', () => {
    expect(scalingOf('MYTHIC')).toMatchObject({
      difficulty: 'MYTHIC',
      enemyStatMultiplier: 2.5,
      rewardTier: 'EXCLUSIVE',
    })
  })

  it('P-J8: cada nivel cambia tambien la composicion y las recompensas, de menos a mas', () => {
    expect(
      DIFFICULTY_LEVELS.map((level) => {
        const scaling = scalingOf(level)
        return [
          scaling.extraEnemiesPerEncounter,
          scaling.bossEnrageBonus,
          scaling.lootProbabilityMultiplier,
          scaling.masterProbabilityMultiplier,
        ]
      }),
    ).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1.25, 1.25],
      [1, 2, 1.5, 1.5],
      [2, 4, 2, 2],
    ])
  })

  it('cada nivel apunta a su propia tabla de recompensa, en el mismo orden', () => {
    expect(DIFFICULTY_LEVELS.map((level) => scalingOf(level).rewardTier)).toEqual([...REWARD_TIERS])
  })
})
