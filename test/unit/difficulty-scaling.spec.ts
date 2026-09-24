import { DIFFICULTY_LEVELS } from '../../src/domain/value-objects/difficulty-level'
import { REWARD_TIERS, scalingOf } from '../../src/domain/value-objects/difficulty-scaling'

describe('Descriptor de escalado (HU-75, CA-02 y CA-04)', () => {
  it.each([
    ['NORMAL', 1, 'STANDARD'],
    ['HEROIC', 1.5, 'IMPROVED'],
    ['LEGENDARY', 2, 'PREMIUM'],
  ] as const)('%s multiplica las estadisticas enemigas por %s y usa %s', (level, factor, tier) => {
    expect(scalingOf(level)).toEqual({
      difficulty: level,
      enemyStatMultiplier: factor,
      rewardTier: tier,
    })
  })

  it('Mitico usa el multiplicador definido por el equipo', () => {
    expect(scalingOf('MYTHIC')).toEqual({
      difficulty: 'MYTHIC',
      enemyStatMultiplier: 2.5,
      rewardTier: 'EXCLUSIVE',
    })
  })

  it('cada nivel apunta a su propia tabla de recompensa, en el mismo orden', () => {
    expect(DIFFICULTY_LEVELS.map((level) => scalingOf(level).rewardTier)).toEqual([...REWARD_TIERS])
  })
})
