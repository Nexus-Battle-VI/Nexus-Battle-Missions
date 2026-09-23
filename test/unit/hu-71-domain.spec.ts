import { nextStrategyVersion } from '../../src/domain/entities/MissionStrategy'
import { newPendingEnrollment } from '../../src/domain/entities/MissionEnrollment'
import { StrategyVersionMismatchError } from '../../src/domain/errors/mission-errors'
import {
  InvalidRotationError,
  TooManyRotationsError,
  UnknownAbilityError,
} from '../../src/domain/errors/strategy-errors'
import {
  assertAbilitiesKnown,
  assertRotationShape,
  assertStrategyVersionMatches,
  rotationViolations,
} from '../../src/domain/policies/StrategyPolicy'
import {
  abilitiesUsedBy,
  type Rotation,
  type RotationPriority,
} from '../../src/domain/value-objects/rotation'
import { COURSE_ABILITIES, COURSE_STRATEGY } from '../support/fixtures'

const basic = (priority: RotationPriority, steps = 1): Rotation => ({
  priority,
  steps: Array.from({ length: steps }, () => ({ kind: 'BASIC_ATTACK' as const })),
})

/** El error que lanza `action`; falla la prueba si no lanza ninguno. */
const thrownBy = (action: () => void): unknown => {
  try {
    action()
  } catch (error: unknown) {
    return error
  }

  throw new Error('Se esperaba un error.')
}

describe('Forma de la estrategia (HU-71, reglas 1 a 3)', () => {
  it('la estrategia del curso es valida', () => {
    expect(rotationViolations(COURSE_STRATEGY)).toEqual([])
    expect(() => {
      assertRotationShape(COURSE_STRATEGY)
    }).not.toThrow()
  })

  it('P-04: una cuarta rotacion es TOO_MANY_ROTATIONS antes que cualquier otra regla (CA-04)', () => {
    const error = thrownBy(() => {
      assertRotationShape([...COURSE_STRATEGY, basic('LOW')])
    })

    expect(error).toBeInstanceOf(TooManyRotationsError)
    expect(error).toMatchObject({
      max: 3,
      received: 4,
      message: 'Puedes configurar hasta tres rotaciones.',
    })
  })

  it.each([
    [
      'T-03: con hueco (Alta y Baja)',
      [basic('HIGH'), basic('LOW')],
      [{ field: 'rotations[1].priority', reason: 'PRIORITY_GAP' }],
    ],
    [
      'repetida',
      [basic('HIGH'), basic('HIGH')],
      [{ field: 'rotations[1].priority', reason: 'PRIORITY_REPEATED' }],
    ],
    [
      'sin la alta',
      [basic('MEDIUM')],
      [{ field: 'rotations[0].priority', reason: 'PRIORITY_GAP' }],
    ],
    [
      'desordenada',
      [basic('MEDIUM'), basic('HIGH')],
      [
        { field: 'rotations[0].priority', reason: 'PRIORITY_GAP' },
        { field: 'rotations[1].priority', reason: 'PRIORITY_ORDER' },
      ],
    ],
  ])('rechaza una prioridad %s', (_caso, rotations, violations) => {
    expect(rotationViolations(rotations)).toEqual(violations)
    expect(() => {
      assertRotationShape(rotations)
    }).toThrow('Las prioridades deben ser Alta, Media y Baja, en ese orden y sin saltos.')
  })

  it('una rotacion vacia o con mas de tres acciones es INVALID_ROTATION', () => {
    const rotations = [{ priority: 'HIGH' as const, steps: [] }, basic('MEDIUM', 4)]

    expect(rotationViolations(rotations)).toEqual([
      { field: 'rotations[0].steps', reason: 'EMPTY_ROTATION' },
      { field: 'rotations[1].steps', reason: 'TOO_MANY_STEPS' },
    ])
    expect(() => {
      assertRotationShape(rotations)
    }).toThrow('Cada rotación debe tener entre una y tres acciones.')
  })

  it('sin rotaciones tambien es INVALID_ROTATION, con su propio motivo', () => {
    expect(() => {
      assertRotationShape([])
    }).toThrow(new InvalidRotationError([], 'Configura al menos una rotación.'))
    expect(rotationViolations([])).toEqual([{ field: 'rotations', reason: 'NO_ROTATIONS' }])
  })

  it('junta las violaciones de prioridad y de acciones en un solo error', () => {
    const error = thrownBy(() => {
      assertRotationShape([basic('HIGH'), basic('LOW', 4)])
    })

    expect(error).toBeInstanceOf(InvalidRotationError)
    expect(error).toMatchObject({
      violations: [
        { field: 'rotations[1].priority', reason: 'PRIORITY_GAP' },
        { field: 'rotations[1].steps', reason: 'TOO_MANY_STEPS' },
      ],
    })
  })

  it('una o dos rotaciones en orden tambien son validas', () => {
    expect(rotationViolations([basic('HIGH')])).toEqual([])
    expect(rotationViolations([basic('HIGH', 3), basic('MEDIUM', 2)])).toEqual([])
  })
})

describe('Habilidades del heroe (HU-71, regla 4)', () => {
  const heroAbilities = new Set(COURSE_ABILITIES)

  it('acepta las habilidades que el heroe tiene y el ataque basico', () => {
    expect(() => {
      assertAbilitiesKnown(COURSE_STRATEGY, heroAbilities)
    }).not.toThrow()
    expect(() => {
      assertAbilitiesKnown([basic('HIGH')], new Set())
    }).not.toThrow()
  })

  it('T-02: una habilidad que el heroe no tiene es UNKNOWN_ABILITY con su referencia', () => {
    const rotations: Rotation[] = [
      { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'furia-del-dragon' }] },
    ]

    expect(() => {
      assertAbilitiesKnown(rotations, heroAbilities)
    }).toThrow(
      new UnknownAbilityError(
        ['furia-del-dragon'],
        'Tu héroe no tiene la habilidad «furia-del-dragon».',
      ),
    )
  })

  it('nombra cada habilidad desconocida una sola vez', () => {
    const rotations: Rotation[] = [
      {
        priority: 'HIGH',
        steps: [
          { kind: 'ABILITY', abilityId: 'a' },
          { kind: 'ABILITY', abilityId: 'golpe-de-tormenta' },
          { kind: 'ABILITY', abilityId: 'b' },
        ],
      },
      { priority: 'MEDIUM', steps: [{ kind: 'ABILITY', abilityId: 'a' }] },
    ]

    expect(
      thrownBy(() => {
        assertAbilitiesKnown(rotations, heroAbilities)
      }),
    ).toMatchObject({
      abilityIds: ['a', 'b'],
      message: 'Tu héroe no tiene las habilidades «a» y «b».',
    })
  })

  it('abilitiesUsedBy devuelve las habilidades distintas en orden de aparicion', () => {
    expect(abilitiesUsedBy(COURSE_STRATEGY)).toEqual([
      'golpe-de-tormenta',
      'embate-sangriento',
      'lanza-de-los-dioses',
    ])
  })
})

describe('Version de la estrategia en la matricula (P-R8 y P-R9)', () => {
  it.each([
    ['la guardada es la 1 y llega 1', 1, 1, true],
    ['la guardada es la 2 y llega 1', 1, 2, false],
    ['la guardada es la 1 y llega null', null, 1, false],
    ['no hay estrategia y llega null', null, null, true],
    ['no hay estrategia y llega 1', 1, null, false],
  ] as const)('%s', (_caso, requested, current, accepted) => {
    const check = (): void => {
      assertStrategyVersionMatches(requested, current)
    }

    if (accepted) {
      expect(check).not.toThrow()
    } else {
      expect(check).toThrow(new StrategyVersionMismatchError(requested, current))
    }
  })

  it('la siguiente version es la esperada mas uno; la primera, la 1', () => {
    expect(nextStrategyVersion(null)).toBe(1)
    expect(nextStrategyVersion(4)).toBe(5)
  })
})

describe('Copia congelada en la matricula (P-R1)', () => {
  const base = {
    enrollmentId: 'enr_1',
    playerId: 'sub-1',
    missionId: 'msn_templo_olvidado',
    heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
    difficulty: 'NORMAL' as const,
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'fp',
    requestedAt: new Date('2026-10-01T15:00:00.000Z'),
  }

  it('guarda la copia con su version, y sin estrategia no guarda ninguna', () => {
    expect(
      newPendingEnrollment({ ...base, strategyVersion: 2, rotations: COURSE_STRATEGY }).rotations,
    ).toEqual(COURSE_STRATEGY)
    expect(newPendingEnrollment({ ...base, strategyVersion: null }).rotations).toEqual([])
  })

  it.each([
    ['una version sin rotaciones', 2, []],
    ['rotaciones sin version', null, COURSE_STRATEGY],
  ] as const)('rechaza %s', (_caso, strategyVersion, rotations) => {
    expect(() => newPendingEnrollment({ ...base, strategyVersion, rotations })).toThrow(RangeError)
  })
})
