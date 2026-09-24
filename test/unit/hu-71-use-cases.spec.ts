import { InMemoryHeroCommitments } from '../../src/adapters/outbound/inventory/InMemoryHeroCommitments'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import { RandomIdGenerator } from '../../src/adapters/outbound/system/RandomIdGenerator'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  HeroAbilitiesOutcome,
  HeroAbilitiesPort,
} from '../../src/application/ports/HeroAbilitiesPort'
import {
  EnrollInMission,
  type EnrollCommand,
} from '../../src/application/use-cases/EnrollInMission'
import { GetMissionStrategy } from '../../src/application/use-cases/GetMissionStrategy'
import {
  SaveMissionStrategy,
  type SaveStrategyCommand,
} from '../../src/application/use-cases/SaveMissionStrategy'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  HeroNotOwnedError,
  MissionNotFoundError,
  StrategyVersionMismatchError,
} from '../../src/domain/errors/mission-errors'
import {
  HeroAbilitiesUnavailableError,
  InvalidRotationError,
  StrategyNotFoundError,
  StrategyVersionConflictError,
  TooManyRotationsError,
  UnknownAbilityError,
} from '../../src/domain/errors/strategy-errors'
import type { Rotation } from '../../src/domain/value-objects/rotation'
import { COURSE_ABILITIES, COURSE_STRATEGY } from '../support/fixtures'

const AT = new Date('2026-10-01T14:55:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_2 = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const ONLY_BASIC: readonly Rotation[] = [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }]

class FixedClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

/** Player/Inventory guionizado: por defecto el heroe es del jugador y tiene las habilidades del curso. */
class ScriptedAbilities implements HeroAbilitiesPort {
  outcome: HeroAbilitiesOutcome = { kind: 'FOUND', abilityIds: new Set(COURSE_ABILITIES) }
  readonly calls: (readonly [string, string])[] = []

  abilitiesOf(playerId: string, heroId: string): Promise<HeroAbilitiesOutcome> {
    this.calls.push([playerId, heroId])
    return Promise.resolve(this.outcome)
  }
}

const setup = (definitions: readonly MissionDefinition[] = EXAMPLE_MISSIONS) => {
  const catalog = new InMemoryMissionCatalog(definitions)
  const strategies = new InMemoryStrategyRepository()
  const enrollments = new InMemoryEnrollmentRepository()
  const abilities = new ScriptedAbilities()
  const clock = new FixedClock(AT)

  return {
    abilities,
    enrollments,
    save: new SaveMissionStrategy(catalog, strategies, abilities, clock),
    get: new GetMissionStrategy(catalog, strategies),
    enroll: new EnrollInMission(
      catalog,
      enrollments,
      new InMemoryDifficultyClearRepository(),
      strategies,
      new InMemoryHeroCommitments(),
      new RandomIdGenerator(),
      clock,
    ),
  }
}

const saveCommand = (overrides: Partial<SaveStrategyCommand> = {}): SaveStrategyCommand => ({
  playerId: 'sub-1',
  missionId: TEMPLO,
  heroId: HERO,
  expectedVersion: null,
  rotations: COURSE_STRATEGY,
  ...overrides,
})

const enrollCommand = (overrides: Partial<EnrollCommand> = {}): EnrollCommand => ({
  playerId: 'sub-1',
  missionId: TEMPLO,
  heroId: HERO,
  difficulty: 'NORMAL',
  strategyVersion: null,
  idempotencyKey: '3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f',
  ...overrides,
})

describe('SaveMissionStrategy (Task HU-71.2)', () => {
  it('P-01: guarda la estrategia del curso como version 1 (CA-01)', async () => {
    const { save, abilities } = setup()

    await expect(save.execute(saveCommand())).resolves.toEqual({
      created: true,
      strategy: {
        missionId: TEMPLO,
        heroId: HERO,
        version: 1,
        rotations: COURSE_STRATEGY,
        updatedAt: AT.toISOString(),
      },
    })
    expect(abilities.calls).toEqual([['sub-1', HERO]])
  })

  it('reemplazar con la version leida crea la siguiente', async () => {
    const { save, get } = setup()
    await save.execute(saveCommand())

    await expect(
      save.execute(saveCommand({ expectedVersion: 1, rotations: ONLY_BASIC })),
    ).resolves.toMatchObject({ created: false, strategy: { version: 2, rotations: ONLY_BASIC } })
    await expect(get.execute('sub-1', TEMPLO, HERO)).resolves.toMatchObject({ version: 2 })
  })

  it('T-01: la segunda edicion con la misma version leida es VERSION_CONFLICT', async () => {
    const { save, get } = setup()
    await save.execute(saveCommand())
    await save.execute(saveCommand({ expectedVersion: 1 }))

    const stale = save.execute(saveCommand({ expectedVersion: 1, rotations: ONLY_BASIC }))

    await expect(stale).rejects.toBeInstanceOf(StrategyVersionConflictError)
    await expect(stale).rejects.toMatchObject({ expectedVersion: 1, currentVersion: 2 })
    await expect(get.execute('sub-1', TEMPLO, HERO)).resolves.toMatchObject({
      rotations: COURSE_STRATEGY,
    })
  })

  it('crear cuando ya hay una es VERSION_CONFLICT con la version que hay', async () => {
    const { save } = setup()
    await save.execute(saveCommand())

    await expect(save.execute(saveCommand())).rejects.toMatchObject({
      expectedVersion: null,
      currentVersion: 1,
    })
  })

  it('reemplazar una que no existe es VERSION_CONFLICT sin version actual', async () => {
    await expect(setup().save.execute(saveCommand({ expectedVersion: 3 }))).rejects.toMatchObject({
      expectedVersion: 3,
      currentVersion: null,
    })
  })

  it('P-04: una cuarta rotacion no guarda nada ni consulta a Player/Inventory (CA-04)', async () => {
    const { save, get, abilities } = setup()
    await save.execute(saveCommand())

    await expect(
      save.execute(
        saveCommand({ expectedVersion: 1, rotations: [...COURSE_STRATEGY, ...ONLY_BASIC] }),
      ),
    ).rejects.toBeInstanceOf(TooManyRotationsError)
    expect(abilities.calls).toHaveLength(1)
    await expect(get.execute('sub-1', TEMPLO, HERO)).resolves.toMatchObject({ version: 1 })
  })

  it('T-03: prioridades con hueco son INVALID_ROTATION', async () => {
    const rotations: Rotation[] = [
      { priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] },
      { priority: 'LOW', steps: [{ kind: 'BASIC_ATTACK' }] },
    ]
    const failure = setup().save.execute(saveCommand({ rotations }))

    await expect(failure).rejects.toBeInstanceOf(InvalidRotationError)
    await expect(failure).rejects.toMatchObject({
      violations: [{ field: 'rotations[1].priority', reason: 'PRIORITY_GAP' }],
    })
  })

  it('T-02: una habilidad que el heroe no tiene es UNKNOWN_ABILITY', async () => {
    const rotations: Rotation[] = [
      { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'furia-del-dragon' }] },
    ]
    const failure = setup().save.execute(saveCommand({ rotations }))

    await expect(failure).rejects.toBeInstanceOf(UnknownAbilityError)
    await expect(failure).rejects.toMatchObject({ abilityIds: ['furia-del-dragon'] })
  })

  it('el heroe de otro jugador es HERO_NOT_OWNED', async () => {
    const { save, abilities } = setup()
    abilities.outcome = { kind: 'NOT_OWNED' }

    await expect(save.execute(saveCommand())).rejects.toEqual(new HeroNotOwnedError(HERO))
  })

  it('sin respuesta de Player/Inventory no guarda nada', async () => {
    const { save, get, abilities } = setup()
    abilities.outcome = { kind: 'UNKNOWN', reason: 'HTTP_503' }

    await expect(save.execute(saveCommand())).rejects.toBeInstanceOf(HeroAbilitiesUnavailableError)
    await expect(get.execute('sub-1', TEMPLO, HERO)).rejects.toBeInstanceOf(StrategyNotFoundError)
  })

  it('una mision inexistente o retirada es MISSION_NOT_FOUND', async () => {
    const retired = { ...EXAMPLE_MISSIONS[0]!, active: false }

    await expect(setup().save.execute(saveCommand({ missionId: 'msn_x' }))).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
    await expect(setup([retired]).save.execute(saveCommand())).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
  })
})

describe('GetMissionStrategy (Task HU-71.2)', () => {
  it('sin estrategia es STRATEGY_NOT_FOUND', async () => {
    await expect(setup().get.execute('sub-1', TEMPLO, HERO)).rejects.toMatchObject({
      missionId: TEMPLO,
      heroId: HERO,
    })
  })

  it('la estrategia es de cada jugador y de cada heroe', async () => {
    const { save, get } = setup()
    await save.execute(saveCommand())

    await expect(get.execute('sub-2', TEMPLO, HERO)).rejects.toBeInstanceOf(StrategyNotFoundError)
    await expect(get.execute('sub-1', TEMPLO, HERO_2)).rejects.toBeInstanceOf(StrategyNotFoundError)
  })

  it('una mision inexistente es MISSION_NOT_FOUND', async () => {
    await expect(setup().get.execute('sub-1', 'msn_x', HERO)).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
  })
})

describe('La matricula congela la estrategia (CU-71.3)', () => {
  it('con la version guardada lleva su copia, y editarla despues no la cambia', async () => {
    const { save, enroll, enrollments } = setup()
    await save.execute(saveCommand())

    const view = await enroll.execute(enrollCommand({ strategyVersion: 1 }))
    await save.execute(saveCommand({ expectedVersion: 1, rotations: ONLY_BASIC }))

    await expect(enrollments.findById(view.enrollmentId)).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      strategyVersion: 1,
      rotations: COURSE_STRATEGY,
    })
  })

  it('T-04: con una version vieja es STRATEGY_VERSION_MISMATCH y no crea matricula', async () => {
    const { save, enroll, enrollments } = setup()
    await save.execute(saveCommand())
    await save.execute(saveCommand({ expectedVersion: 1, rotations: ONLY_BASIC }))

    const failure = enroll.execute(enrollCommand({ strategyVersion: 1 }))

    await expect(failure).rejects.toBeInstanceOf(StrategyVersionMismatchError)
    await expect(failure).rejects.toMatchObject({ expectedVersion: 1, currentVersion: 2 })
    expect(await enrollments.listByPlayer('sub-1')).toEqual([])
  })

  it('con estrategia guardada, matricularse sin version es STRATEGY_VERSION_MISMATCH', async () => {
    const { save, enroll } = setup()
    await save.execute(saveCommand())

    await expect(enroll.execute(enrollCommand())).rejects.toMatchObject({
      expectedVersion: null,
      currentVersion: 1,
    })
  })

  it('P-R9: sin estrategia la matricula sigue adelante sin rotaciones', async () => {
    const { enroll, enrollments } = setup()

    const view = await enroll.execute(enrollCommand())

    await expect(enrollments.findById(view.enrollmentId)).resolves.toMatchObject({
      strategyVersion: null,
      rotations: [],
    })
  })

  it('la estrategia de otro heroe no cuenta para este', async () => {
    const { save, enroll } = setup()
    await save.execute(saveCommand({ heroId: HERO_2 }))

    await expect(enroll.execute(enrollCommand())).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    })
  })
})
