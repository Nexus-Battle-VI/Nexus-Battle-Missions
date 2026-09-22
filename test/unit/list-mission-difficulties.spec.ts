import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { ListMissionDifficulties } from '../../src/application/use-cases/ListMissionDifficulties'
import type { DifficultyLevel } from '../../src/domain/value-objects/difficulty-level'

type Fact = readonly [playerId: string, missionId: string, difficulty: DifficultyLevel]

const AT = new Date('2026-09-22T15:00:00.000Z')
const PLAYER = 'jugador-p'
const OTHER_PLAYER = 'jugador-q'
const MISSION = 'mision-m'
const OTHER_MISSION = 'mision-n'

const withFacts = async (facts: readonly Fact[]): Promise<ListMissionDifficulties> => {
  const repository = new InMemoryDifficultyClearRepository()

  for (const [playerId, missionId, difficulty] of facts) {
    await repository.record({ playerId, missionId, difficulty, completedAt: AT })
  }

  return new ListMissionDifficulties(repository)
}

const unlockedFor = async (facts: readonly Fact[]): Promise<DifficultyLevel[]> => {
  const view = await (await withFacts(facts)).execute(PLAYER, MISSION)

  return view.items.filter((item) => item.unlocked).map((item) => item.difficulty)
}

describe('ListMissionDifficulties (Task HU-75.2)', () => {
  it('sin progreso responde el fixture completo del contrato', async () => {
    const view = await (await withFacts([])).execute(PLAYER, MISSION)

    expect(view).toEqual({
      missionId: MISSION,
      items: [
        {
          difficulty: 'NORMAL',
          unlocked: true,
          lockReason: null,
          enemyStatMultiplier: 1,
          rewardTier: 'STANDARD',
        },
        {
          difficulty: 'HEROIC',
          unlocked: false,
          lockReason: 'Debes completar esta misión en Normal al menos una vez.',
          enemyStatMultiplier: 1.5,
          rewardTier: 'IMPROVED',
        },
        {
          difficulty: 'LEGENDARY',
          unlocked: false,
          lockReason: 'Debes completar esta misión en Heroico al menos una vez.',
          enemyStatMultiplier: 2,
          rewardTier: 'PREMIUM',
        },
        {
          difficulty: 'MYTHIC',
          unlocked: false,
          lockReason: 'Debes completar esta misión en Legendario al menos una vez.',
          enemyStatMultiplier: null,
          rewardTier: 'EXCLUSIVE',
        },
      ],
    })
  })

  it('completar Normal desbloquea Heroico (CA-02, segundo fixture del contrato)', async () => {
    await expect(unlockedFor([[PLAYER, MISSION, 'NORMAL']])).resolves.toEqual(['NORMAL', 'HEROIC'])
  })

  it('con los tres primeros niveles completados los cuatro quedan libres', async () => {
    await expect(
      unlockedFor([
        [PLAYER, MISSION, 'NORMAL'],
        [PLAYER, MISSION, 'HEROIC'],
        [PLAYER, MISSION, 'LEGENDARY'],
      ]),
    ).resolves.toEqual(['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'])
  })

  describe('aislamiento: nada de esto desbloquea Heroico ni nada superior', () => {
    it.each<[string, readonly Fact[]]>([
      ['Normal completado en otra mision', [[PLAYER, OTHER_MISSION, 'NORMAL']]],
      [
        'Heroico completado en otra mision',
        [
          [PLAYER, OTHER_MISSION, 'NORMAL'],
          [PLAYER, OTHER_MISSION, 'HEROIC'],
        ],
      ],
      ['Normal completado por otro jugador en esta mision', [[OTHER_PLAYER, MISSION, 'NORMAL']]],
    ])('%s', async (_caso, facts) => {
      await expect(unlockedFor(facts)).resolves.toEqual(['NORMAL'])
    })

    it('saltar un nivel: con Normal completado, Legendario sigue bloqueado y pide Heroico', async () => {
      const view = await (await withFacts([[PLAYER, MISSION, 'NORMAL']])).execute(PLAYER, MISSION)

      expect(view.items.find((item) => item.difficulty === 'LEGENDARY')).toMatchObject({
        unlocked: false,
        lockReason: 'Debes completar esta misión en Heroico al menos una vez.',
      })
    })
  })
})
