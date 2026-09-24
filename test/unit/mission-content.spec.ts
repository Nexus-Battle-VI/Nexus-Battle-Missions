import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { ListMissionDifficulties } from '../../src/application/use-cases/ListMissionDifficulties'
import { missionDefinitionOf } from '../../src/domain/policies/MissionContentPolicy'
import { evaluateObjectives, simulationFactsOf } from '../../src/domain/policies/SettlementPolicy'

describe('editable playable mission content', () => {
  it('accepts both seeded missions with boss, enemy profiles and configurable rules', () => {
    for (const mission of EXAMPLE_MISSIONS) {
      expect(missionDefinitionOf(mission, mission.missionId)).toBe(mission)
      expect(mission.finalBoss.profile).toMatchObject({ ai: 'BOSS' })
      expect(mission.combatRules?.maxTurnsPerEncounter).toBeGreaterThan(0)
    }
  })

  it('rejects incomplete enemy profiles and boss loot probabilities', () => {
    const [mission] = EXAMPLE_MISSIONS
    if (mission === undefined) throw new Error('No seed mission')
    expect(() =>
      missionDefinitionOf(
        { ...mission, enemies: [{ ...mission.enemies[0], profile: null }] },
        mission.missionId,
      ),
    ).toThrow(/enemies\[0\]\.profile/u)
    expect(() =>
      missionDefinitionOf(
        {
          ...mission,
          finalBoss: { ...mission.finalBoss, drops: [{ label: 'x', probability: 1.5, rolls: 1 }] },
        },
        mission.missionId,
      ),
    ).toThrow(/finalBoss\.drops/u)
  })

  it('accepts editable dice damage for an enemy', () => {
    const mission = EXAMPLE_MISSIONS[0]!
    const edited = {
      ...mission,
      enemies: mission.enemies.map((enemy, index) =>
        index === 0
          ? {
              ...enemy,
              profile: { ...enemy.profile, damage: { mode: 'DICE', count: 1, sides: 6 } },
            }
          : enemy,
      ),
    }
    expect(missionDefinitionOf(edited, mission.missionId).enemies[0]?.profile).toMatchObject({
      damage: { mode: 'DICE', count: 1, sides: 6 },
    })
  })

  it('publishes an edited definition through the same catalog players read', async () => {
    const [mission] = EXAMPLE_MISSIONS
    if (mission === undefined) throw new Error('No seed mission')
    const catalog = new InMemoryMissionCatalog(EXAMPLE_MISSIONS)
    const edited = missionDefinitionOf(
      {
        ...mission,
        name: 'Templo revisado',
        finalBoss: {
          ...mission.finalBoss,
          profile: { ...mission.finalBoss.profile, maxHealth: 120 },
        },
      },
      mission.missionId,
    )
    await catalog.save(edited)
    expect((await catalog.findActive(mission.missionId))?.finalBoss.profile).toMatchObject({
      maxHealth: 120,
    })
    expect(
      (await catalog.listAll()).filter((item) => item.missionId === mission.missionId),
    ).toHaveLength(1)
  })

  it('evaluates the temple fragment objective from the boss drop roll', () => {
    const mission = EXAMPLE_MISSIONS[0]!
    const facts = simulationFactsOf({
      encountersCompleted: 5,
      encountersTotal: 5,
      bossDefeated: true,
      minHealthPercent: 65,
      loot: [{ label: 'Fragmento del Sello Antiguo', quantity: 3, productId: null }],
    })
    expect(facts).not.toBeNull()
    expect(
      evaluateObjectives(mission.objectives, facts!).find((item) => item.id === 'obj_fragmentos')
        ?.met,
    ).toBe(true)
  })

  it('publishes edited difficulty factors in the player difficulty view', async () => {
    const mission = EXAMPLE_MISSIONS[0]!
    const catalog = new InMemoryMissionCatalog([mission])
    await catalog.save(
      missionDefinitionOf(
        {
          ...mission,
          combatRules: {
            ...mission.combatRules,
            difficultyMultipliers: { NORMAL: 1.2, HEROIC: 1.7, LEGENDARY: 2.2, MYTHIC: 3 },
          },
        },
        mission.missionId,
      ),
    )
    const view = await new ListMissionDifficulties(
      new InMemoryDifficultyClearRepository(),
      catalog,
    ).execute('player-1', mission.missionId)
    expect(view.items.map((item) => item.enemyStatMultiplier)).toEqual([1.2, 1.7, 2.2, 3])
  })
})
