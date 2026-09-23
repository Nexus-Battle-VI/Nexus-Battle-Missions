import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  confirmEnrollment,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import type { CombatOutcome, SimulationResult } from '../../src/domain/entities/MissionExecution'
import type {
  MissionReport,
  ReportMaster,
  ReportOutcome,
  ReportRecord,
  ReportRewardLine,
} from '../../src/domain/entities/MissionReport'
import {
  bestTimesOf,
  categoryStatsOf,
  epicCollectionOf,
  narrativeChainsOf,
  narrativeProgressOf,
} from '../../src/domain/policies/HistoryPolicy'
import { missionReportOf } from '../../src/domain/policies/ReportPolicy'
import { settlementOf, simulationFactsOf } from '../../src/domain/policies/SettlementPolicy'
import type { DifficultyLevel } from '../../src/domain/value-objects/difficulty-level'
import { isoDurationSeconds } from '../../src/domain/value-objects/iso-duration'
import type { MissionCategory } from '../../src/domain/value-objects/mission-category'

const [TEMPLO] = EXAMPLE_MISSIONS as [MissionDefinition]
const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const NO_MASTER = { appeared: false, masterRef: null, defeated: false }

/** Resumen del fixture P-01 de HU-72, con los campos que presenta el reporte. */
const P01_SUMMARY = {
  encountersCompleted: 5,
  encountersTotal: 5,
  totalTurns: 142,
  damageDealt: 1830,
  damageTaken: 640,
  minHealthPercent: 41.5,
  criticalEffects: 9,
  bossDefeated: true,
  master: NO_MASTER,
  simulatedDuration: 'PT9H40M',
  skillsUsed: [
    { abilityId: 'golpe-de-tormenta', count: 22 },
    { abilityId: 'BASIC_ATTACK', count: 61 },
  ],
  enemiesDefeated: [
    { enemyRef: 'sombra-corrompida', count: 10 },
    { enemyRef: 'guardian-de-piedra', count: 5 },
    { enemyRef: 'espectro-ancestral', count: 3 },
    { enemyRef: 'guardian-eterno', count: 1 },
  ],
}

/** Resumen del fixture P-04 de HU-72: el heroe cae en el tercer encuentro. */
const P04_SUMMARY = {
  encountersCompleted: 3,
  encountersTotal: 5,
  totalTurns: 88,
  damageDealt: 910,
  damageTaken: 1200,
  minHealthPercent: 0,
  criticalEffects: 4,
  bossDefeated: false,
  master: NO_MASTER,
  simulatedDuration: 'PT6H10M',
}

const inProgress = (): MissionEnrollment =>
  confirmEnrollment(
    newPendingEnrollment({
      enrollmentId: 'enr_1',
      playerId: 'sub-1',
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'NORMAL',
      operationId: 'op-1',
      idempotencyKey: 'key-1',
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    }),
    'cmt-1',
    AT,
    720,
  )

const PROFILE = { heroId: HERO, name: 'Kaelen', subtype: 'PICARO_VENENO' }

const reportFrom = (
  combatOutcome: CombatOutcome,
  summary: Readonly<Record<string, unknown>>,
  heroProfile: Readonly<Record<string, unknown>> | null = PROFILE,
): MissionReport => {
  const facts = simulationFactsOf(summary)

  if (facts === null) {
    throw new Error('El resumen de la prueba no trae los hechos que deciden el resultado.')
  }

  const result: SimulationResult = {
    simulationId: 'sim_1',
    seedRef: null,
    combatOutcome,
    summary,
    combatLog: [],
  }

  return missionReportOf({
    enrollment: inProgress(),
    definition: TEMPLO,
    result,
    settlement: settlementOf(combatOutcome, TEMPLO.objectives, facts),
    heroProfile,
    generatedAt: CLOSED,
  })
}

describe('Duraciones ISO-8601 del resumen (HU-74)', () => {
  it.each([
    ['PT9H40M', 34_800],
    ['PT12H', 43_200],
    ['P1DT2H', 93_600],
    ['PT30.5S', 30.5],
    ['PT0S', 0],
  ])('%s son %s segundos', (value, seconds) => {
    expect(isoDurationSeconds(value)).toBe(seconds)
  })

  it.each(['', 'P', 'PT', 'P1DT', 'PT9H40', '9H40M', 'P1W', 'P1Y', 'PT-5M', 'pt9h'])(
    'rechaza %j',
    (value) => {
      expect(isoDurationSeconds(value)).toBeNull()
    },
  )
})

describe('La foto del reporte (HU-74, CU-74.1)', () => {
  it('R-1: la mision completada trae los cinco bloques con lo que dijo Combat', () => {
    const met = [true, true, false, null, null]

    expect(reportFrom('HERO_VICTORIOUS', P01_SUMMARY)).toEqual({
      schemaVersion: 1,
      enrollmentId: 'enr_1',
      playerId: 'sub-1',
      mission: {
        missionId: 'msn_templo_olvidado',
        name: 'El Templo Olvidado',
        category: 'STORY',
        difficulty: 'NORMAL',
      },
      summary: {
        outcome: 'COMPLETED',
        outcomeReason: null,
        hero: { heroId: HERO, name: 'Kaelen', subtype: 'PICARO_VENENO' },
        startedAt: AT,
        // La mision termina al vencer su duracion, no cuando el planificador la cierra.
        finishedAt: ENDS,
        simulatedDuration: 'PT9H40M',
      },
      combatStats: {
        encountersCompleted: 5,
        encountersTotal: 5,
        totalTurns: 142,
        damageDealt: 1830,
        damageTaken: 640,
        criticalEffects: 9,
        skillsUsed: P01_SUMMARY.skillsUsed,
      },
      enemies: {
        defeated: [
          { enemyRef: 'sombra-corrompida', name: 'Sombras Corrompidas', count: 10 },
          { enemyRef: 'guardian-de-piedra', name: 'Guardianes de Piedra', count: 5 },
          { enemyRef: 'espectro-ancestral', name: 'Espectros Ancestrales', count: 3 },
        ],
        boss: { enemyRef: 'guardian-eterno', name: 'El Guardián Eterno', defeated: true },
        masters: [],
      },
      objectives: TEMPLO.objectives.map((objective, index) => ({
        id: objective.id,
        text: objective.text,
        primary: objective.primary,
        met: met[index],
        bonus: null,
      })),
      generatedAt: CLOSED,
    })
  })

  it('R-2: si el heroe cae, la foto muestra el fallo y hasta donde llego', () => {
    expect(reportFrom('HERO_DEFEATED', P04_SUMMARY)).toMatchObject({
      summary: { outcome: 'FAILED', outcomeReason: 'HERO_DEFEATED', simulatedDuration: 'PT6H10M' },
      combatStats: { encountersCompleted: 3, encountersTotal: 5, totalTurns: 88 },
      enemies: { defeated: [], boss: { defeated: false } },
    })
  })

  it('lo que el resumen no trae queda en null o fuera de su lista, sin impedir el cierre', () => {
    const minimal = {
      encountersCompleted: 4,
      encountersTotal: 5,
      bossDefeated: false,
      minHealthPercent: 22,
    }

    expect(reportFrom('TIME_BUDGET_EXHAUSTED', minimal, null)).toMatchObject({
      summary: {
        outcome: 'FAILED',
        outcomeReason: 'TIME_LIMIT',
        hero: { heroId: HERO, name: null, subtype: null },
        simulatedDuration: null,
      },
      combatStats: {
        encountersCompleted: 4,
        encountersTotal: 5,
        totalTurns: null,
        damageDealt: null,
        damageTaken: null,
        criticalEffects: null,
        skillsUsed: [],
      },
      enemies: { defeated: [], masters: [] },
    })
  })

  it('descarta las entradas del resumen que no cumplen', () => {
    const summary = {
      ...P01_SUMMARY,
      damageDealt: 12.5,
      damageTaken: -3,
      totalTurns: 1.5,
      simulatedDuration: 'nueve horas',
      skillsUsed: [
        { abilityId: 'golpe-de-tormenta', count: 2 },
        { abilityId: '', count: 1 },
        { abilityId: 'embate-sangriento', count: -1 },
        'basura',
      ],
      enemiesDefeated: [
        { enemyRef: 'sombra-corrompida', count: 2 },
        { enemyRef: 'desconocido', count: 1 },
        { count: 3 },
        null,
      ],
    }

    expect(reportFrom('HERO_VICTORIOUS', summary)).toMatchObject({
      summary: { simulatedDuration: null },
      combatStats: {
        damageDealt: 12.5,
        damageTaken: null,
        totalTurns: null,
        skillsUsed: [{ abilityId: 'golpe-de-tormenta', count: 2 }],
      },
      enemies: {
        defeated: [
          { enemyRef: 'sombra-corrompida', name: 'Sombras Corrompidas', count: 2 },
          { enemyRef: 'desconocido', name: 'desconocido', count: 1 },
        ],
      },
    })
  })

  it('una mision anulada no tiene reporte (P-T3)', () => {
    expect(() =>
      missionReportOf({
        enrollment: inProgress(),
        definition: TEMPLO,
        result: {
          simulationId: 'sim_1',
          seedRef: null,
          combatOutcome: 'HERO_VICTORIOUS',
          summary: P01_SUMMARY,
          combatLog: [],
        },
        settlement: { outcome: 'VOIDED', reason: 'INVALID_STRATEGY', objectives: [] },
        heroProfile: null,
        generatedAt: CLOSED,
      }),
    ).toThrow(RangeError)
  })
})

interface ReportShape {
  readonly enrollmentId: string
  readonly finishedAt: string
  readonly missionId?: string
  readonly category?: MissionCategory
  readonly difficulty?: DifficultyLevel
  readonly outcome?: ReportOutcome
  readonly simulatedDuration?: string | null
  readonly damageDealt?: number | null
  readonly damageTaken?: number | null
  readonly masters?: readonly ReportMaster[]
}

/** Un reporte del jugador con lo que cambia entre escenarios; el resto, como en P-01. */
const report = (shape: ReportShape): MissionReport => {
  const base = reportFrom('HERO_VICTORIOUS', P01_SUMMARY)

  return {
    ...base,
    enrollmentId: shape.enrollmentId,
    mission: {
      ...base.mission,
      missionId: shape.missionId ?? base.mission.missionId,
      category: shape.category ?? 'STORY',
      difficulty: shape.difficulty ?? 'NORMAL',
    },
    summary: {
      ...base.summary,
      outcome: shape.outcome ?? 'COMPLETED',
      simulatedDuration:
        shape.simulatedDuration === undefined ? 'PT9H40M' : shape.simulatedDuration,
      finishedAt: new Date(shape.finishedAt),
    },
    combatStats: {
      ...base.combatStats,
      damageDealt: shape.damageDealt === undefined ? 100 : shape.damageDealt,
      damageTaken: shape.damageTaken === undefined ? 40 : shape.damageTaken,
    },
    enemies: { ...base.enemies, masters: shape.masters ?? [] },
    generatedAt: new Date(shape.finishedAt),
  }
}

/** Escenario H-1 del contrato de HU-74. */
const H1: readonly MissionReport[] = [
  report({
    enrollmentId: 'enr_a',
    simulatedDuration: 'PT9H40M',
    finishedAt: '2026-10-02T03:00:00Z',
    damageDealt: 1830,
    damageTaken: 640,
  }),
  report({
    enrollmentId: 'enr_b',
    simulatedDuration: 'PT8H55M',
    finishedAt: '2026-10-04T03:00:00Z',
    damageDealt: 2100,
    damageTaken: 500,
  }),
  report({
    enrollmentId: 'enr_c',
    missionId: 'msn_camara_sellada',
    outcome: 'FAILED',
    simulatedDuration: 'PT3H10M',
    finishedAt: '2026-10-05T09:00:00Z',
    damageDealt: 1280,
    damageTaken: 1100,
  }),
]

const empty = (category: MissionCategory) => ({
  category,
  completed: 0,
  failed: 0,
  abandoned: 0,
  damageDealt: 0,
  damageTaken: 0,
})

describe('Proyecciones del historial (HU-74, CA-05)', () => {
  it('H-1: estadisticas por tipo, con todas las categorias del vocabulario', () => {
    expect(categoryStatsOf(H1)).toEqual([
      {
        category: 'STORY',
        completed: 2,
        failed: 1,
        abandoned: 0,
        damageDealt: 5210,
        damageTaken: 2240,
      },
      empty('CHALLENGE'),
      empty('EXPLORATION'),
    ])
  })

  it('un dano desconocido cuenta como cero', () => {
    const [stats] = categoryStatsOf([
      report({ enrollmentId: 'enr_x', finishedAt: '2026-10-02T03:00:00Z', damageDealt: null }),
    ])

    expect(stats).toMatchObject({ completed: 1, damageDealt: 0, damageTaken: 40 })
  })

  it('H-1: el mejor tiempo es la menor duracion simulada de las completadas (P-T5)', () => {
    expect(bestTimesOf(H1)).toEqual([
      {
        missionId: 'msn_templo_olvidado',
        difficulty: 'NORMAL',
        simulatedDuration: 'PT8H55M',
        enrollmentId: 'enr_b',
      },
    ])
  })

  it('por mision y dificultad; a igual tiempo gana el primero; sin duracion no cuenta', () => {
    const reports = [
      report({
        enrollmentId: 'enr_tarde',
        finishedAt: '2026-10-06T03:00:00Z',
        simulatedDuration: 'PT8H',
      }),
      report({
        enrollmentId: 'enr_pronto',
        finishedAt: '2026-10-03T03:00:00Z',
        simulatedDuration: 'PT8H',
      }),
      report({
        enrollmentId: 'enr_heroico',
        finishedAt: '2026-10-07T03:00:00Z',
        difficulty: 'HEROIC',
        simulatedDuration: 'PT11H',
      }),
      report({
        enrollmentId: 'enr_sin',
        finishedAt: '2026-10-08T03:00:00Z',
        simulatedDuration: null,
      }),
      report({
        enrollmentId: 'enr_rara',
        finishedAt: '2026-10-09T03:00:00Z',
        simulatedDuration: 'ocho horas',
      }),
    ]

    expect(bestTimesOf(reports)).toEqual([
      {
        missionId: 'msn_templo_olvidado',
        difficulty: 'NORMAL',
        simulatedDuration: 'PT8H',
        enrollmentId: 'enr_pronto',
      },
      {
        missionId: 'msn_templo_olvidado',
        difficulty: 'HEROIC',
        simulatedDuration: 'PT11H',
        enrollmentId: 'enr_heroico',
      },
    ])
  })

  it('la coleccion de epicas sale de las lineas EPIC, de la primera a la ultima', () => {
    const line = (overrides: Partial<ReportRewardLine>): ReportRewardLine => ({
      lineNo: 1,
      kind: 'EPIC',
      reference: 'velo-de-sombras',
      name: 'Velo de Sombras',
      rarity: null,
      quantity: 1,
      status: 'CREDITED',
      source: 'HU-73',
      updatedAt: CLOSED,
      ...overrides,
    })
    const records: ReportRecord[] = [
      {
        report: report({
          enrollmentId: 'enr_b',
          finishedAt: '2026-10-04T03:00:00Z',
          masters: [
            {
              masterRef: 'sombra-del-olvido',
              name: 'Sombra del Olvido',
              status: 'APPEARED_DEFEATED',
            },
          ],
        }),
        rewards: [
          line({}),
          line({
            lineNo: 2,
            kind: 'CREDITS',
            reference: null,
            name: 'Créditos',
            quantity: 50,
            status: 'PENDING',
            source: 'HU-10',
          }),
        ],
      },
      {
        report: report({ enrollmentId: 'enr_a', finishedAt: '2026-10-02T03:00:00Z' }),
        rewards: [line({ reference: 'otra-epica', name: 'Otra épica', status: 'PENDING' })],
      },
    ]

    expect(epicCollectionOf(records)).toEqual([
      {
        epicRef: 'otra-epica',
        name: 'Otra épica',
        masterRef: null,
        obtainedAt: new Date('2026-10-02T03:00:00Z'),
        status: 'PENDING',
      },
      {
        epicRef: 'velo-de-sombras',
        name: 'Velo de Sombras',
        masterRef: 'sombra-del-olvido',
        obtainedAt: new Date('2026-10-04T03:00:00Z'),
        status: 'CREDITED',
      },
    ])
  })
})

describe('Cadenas narrativas (HU-74, P-T6)', () => {
  const mission = (
    missionId: string,
    category: MissionCategory,
    prerequisites: readonly string[],
  ): MissionDefinition => ({ ...TEMPLO, missionId, category, prerequisites })

  it('la cadena del ejemplo del curso: el Templo y despues la Camara', () => {
    expect(narrativeChainsOf(EXAMPLE_MISSIONS)).toEqual([
      { chainId: 'msn_templo_olvidado', missions: ['msn_templo_olvidado', 'msn_camara_sellada'] },
    ])
  })

  it('una mision suelta, las que no son STORY y los requisitos de fuera no forman cadena', () => {
    const catalog = [
      mission('a', 'STORY', []),
      mission('b', 'STORY', ['a']),
      mission('c', 'STORY', ['b', 'no-esta']),
      mission('suelta', 'STORY', []),
      mission('reto', 'CHALLENGE', ['a']),
      mission('tras-reto', 'STORY', ['reto']),
    ]

    expect(narrativeChainsOf(catalog)).toEqual([{ chainId: 'a', missions: ['a', 'b', 'c'] }])
  })

  it('ordena por requisitos aunque el catalogo venga al reves; dos raices comparten cadena', () => {
    const catalog = [
      mission('final', 'STORY', ['izquierda', 'derecha']),
      mission('derecha', 'STORY', []),
      mission('izquierda', 'STORY', []),
    ]

    expect(narrativeChainsOf(catalog)).toEqual([
      { chainId: 'derecha', missions: ['derecha', 'izquierda', 'final'] },
    ])
  })

  it('un ciclo en el contenido no cuelga el calculo', () => {
    const catalog = [mission('p', 'STORY', ['q']), mission('q', 'STORY', ['p'])]

    expect(narrativeChainsOf(catalog)).toEqual([{ chainId: 'p', missions: ['p', 'q'] }])
  })

  it('H-1: el progreso cuenta las misiones de la cadena completadas alguna vez', () => {
    expect(
      narrativeProgressOf(narrativeChainsOf(EXAMPLE_MISSIONS), new Set(['msn_templo_olvidado'])),
    ).toEqual([
      {
        chainId: 'msn_templo_olvidado',
        missions: ['msn_templo_olvidado', 'msn_camara_sellada'],
        completed: 1,
        total: 2,
      },
    ])
  })
})
