import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { buildSimulationRequest } from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import type { DifficultyLevel } from '../../src/domain/value-objects/difficulty-level'

const TEMPLO = EXAMPLE_MISSIONS[0]!

/** El Templo con un botin casi seguro, para ver el tope del 100 %. */
const templo: MissionDefinition = {
  ...TEMPLO,
  finalBoss: {
    ...TEMPLO.finalBoss,
    drops: [
      ...(TEMPLO.finalBoss.drops ?? []),
      { label: 'Casi seguro', probability: 0.9, rolls: 1, productId: null },
    ],
  },
}

const requestAt = (difficulty: DifficultyLevel) =>
  buildSimulationRequest({
    operationId: 'op-1',
    enrollmentId: 'enr_1',
    missionId: templo.missionId,
    difficulty,
    durationMinutes: 720,
    heroId: 'heroe',
    heroProfile: { subtype: 'GUERRERO_ARMAS' },
    strategyVersion: null,
    rotations: [],
    definition: templo,
  })

const counts = (difficulty: DifficultyLevel) =>
  requestAt(difficulty).encounters.map((encounter) => encounter.enemies.map((enemy) => enemy.count))

describe('La dificultad cambia la composicion y las recompensas (P-J8)', () => {
  it('Normal es el contenido tal cual', () => {
    const request = requestAt('NORMAL')

    expect(counts('NORMAL')).toEqual(
      templo.encounters.map((encounter) => encounter.enemies.map((enemy) => enemy.count)),
    )
    expect(request.bossDrops?.map((drop) => drop.probability)).toEqual([0.6, 0.2, 0.15, 0.9])
    expect(request.master?.candidates[0]?.probability).toBe(0.15)
    expect(request.timeBudget).toBe('PT12H')
  })

  it('suma enemigos al primer grupo de cada encuentro regular, nunca al jefe', () => {
    const normal = counts('NORMAL')
    const heroic = counts('HEROIC')
    const mythic = counts('MYTHIC')

    templo.encounters.forEach((encounter, index) => {
      const base = normal[index] ?? []
      if (encounter.kind === 'BOSS') {
        expect(heroic[index]).toEqual(base)
        expect(mythic[index]).toEqual(base)
      } else {
        expect(heroic[index]?.[0]).toBe((base[0] ?? 0) + 1)
        expect(mythic[index]?.[0]).toBe((base[0] ?? 0) + 2)
        expect(heroic[index]?.slice(1)).toEqual(base.slice(1))
      }
    })
  })

  it('el jefe enfurecido pega mas en Legendario y Mitico', () => {
    const bossOf = (difficulty: DifficultyLevel) =>
      requestAt(difficulty)
        .encounters.flatMap((encounter) => encounter.enemies)
        .find((enemy) => enemy.enemyRef === templo.finalBoss.enemyRef)?.profile as {
        readonly enrageAttackBonus?: number
      }
    const base = bossOf('NORMAL').enrageAttackBonus ?? 0

    expect(bossOf('HEROIC').enrageAttackBonus ?? 0).toBe(base)
    expect(bossOf('LEGENDARY').enrageAttackBonus).toBe(base + 2)
    expect(bossOf('MYTHIC').enrageAttackBonus).toBe(base + 4)
  })

  it('el botin y el Master son mas probables, con tope en el 100 %', () => {
    expect(requestAt('HEROIC').bossDrops?.map((drop) => drop.probability)).toEqual([
      0.75, 0.25, 0.1875, 1,
    ])
    expect(requestAt('MYTHIC').bossDrops?.map((drop) => drop.probability)).toEqual([1, 0.4, 0.3, 1])
    expect(requestAt('LEGENDARY').master?.candidates[0]?.probability).toBeCloseTo(0.225)
    expect(requestAt('MYTHIC').master?.candidates[0]?.probability).toBeCloseTo(0.3)
  })
})
