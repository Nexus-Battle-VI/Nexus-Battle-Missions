import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import {
  grantConfirmed,
  grantDeferred,
  grantRejected,
  InvalidGrantTransitionError,
  type MasterEncounterRecord,
} from '../../src/domain/entities/MasterEncounterRecord'
import type {
  MasterCandidate,
  MasterEncounter,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import {
  closeEnrollment,
  confirmEnrollment,
  newPendingEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import type {
  SimulationFacts,
  SimulationMaster,
  SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import {
  assertMasterConfig,
  epicGrantOperationId,
  epicOf,
  epicRewardsOf,
  heroSubtypeOf,
  InvalidMasterConfigError,
  masterConfigProblem,
  masterEncounterRecordsOf,
  maxAppearancesOf,
  probabilityFor,
  simulationMasterOf,
} from '../../src/domain/policies/MasterPolicy'
import { missionReportOf } from '../../src/domain/policies/ReportPolicy'
import { missionSettledFact, settlementOf } from '../../src/domain/policies/SettlementPolicy'
import { uuidV5 } from '../../src/domain/value-objects/deterministic-uuid'

const TEMPLO = EXAMPLE_MISSIONS[0]!
const MASTER = 'sombra-del-olvido'
// La epica oficial del Picaro Veneno (P-J5), la que entrega la Sombra del Olvido.
const EPIC = 'toma-y-lleva'
const ENROLLMENT = 'enr_01JB8Y3K7Q'
const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

/** El candidato del ejemplo del curso (§7.8.14), con lo que se quiera cambiar. */
const candidate = (overrides: Partial<MasterCandidate> = {}): MasterCandidate => ({
  ...required(TEMPLO.masterEncounter?.candidates[0], 'el Master del Templo'),
  ...overrides,
})

const config = (overrides: Partial<MasterEncounter> = {}): MasterEncounter => ({
  evaluationPoints: [{ afterEncounter: 3 }],
  maxAppearances: 1,
  candidates: [candidate()],
  ...overrides,
})

/** El bloque `master` que Missions envia a Combat, con una sola probabilidad. */
const sent = (
  probability: number,
  points: readonly number[] = [3],
  maxAppearances = 1,
): SimulationMaster => ({
  evaluationPoints: points.map((afterEncounter) => ({ afterEncounter })),
  maxAppearances,
  candidates: [
    {
      masterRef: MASTER,
      subtype: 'PICARO_VENENO',
      probability,
      levelOffset: 2,
      profile: TEMPLO.masterEncounter?.candidates[0]?.profile ?? null,
      epicRef: EPIC,
    },
  ],
})

const facts = (
  encountersCompleted: number,
  master: SimulationFacts['master'] = { appeared: false, defeated: false },
): SimulationFacts => ({
  encountersCompleted,
  encountersTotal: 5,
  bossDefeated: encountersCompleted === 5,
  minHealthPercent: 40,
  master,
})

const evaluation = (afterEncounter: number, appeared: boolean, masterRef = MASTER) => ({
  afterEncounter,
  masterRef,
  appeared,
})

const fight = (afterEncounter: number, outcome: string, turns: unknown = 14) => ({
  masterRef: MASTER,
  afterEncounter,
  levelOffset: 2,
  outcome,
  turns,
})

const recordsOf = (input: {
  sent: SimulationMaster | null
  master: unknown
  facts: SimulationFacts
  config?: MasterEncounter | null
}): readonly MasterEncounterRecord[] | null =>
  masterEncounterRecordsOf({
    enrollmentId: ENROLLMENT,
    config: input.config === undefined ? config() : input.config,
    sent: input.sent,
    summary: { master: input.master },
    facts: input.facts,
  })

/** El resumen de M-3: aparece tras el tercer encuentro y el heroe lo derrota. */
const M3 = {
  appeared: true,
  defeated: true,
  evaluations: [evaluation(3, true)],
  encounters: [fight(3, 'DEFEATED')],
}

describe('UUID determinista de la entrega (HU-73, P-X6)', () => {
  it('cumple el ejemplo de la RFC 9562 para la version 5', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    )
  })

  it('M-7: la misma matricula, Master y aparicion dan siempre la misma operacion', () => {
    const operationId = epicGrantOperationId(ENROLLMENT, MASTER, 1)

    expect(epicGrantOperationId(ENROLLMENT, MASTER, 1)).toBe(operationId)
    expect(operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(epicGrantOperationId(ENROLLMENT, MASTER, 2)).not.toBe(operationId)
    expect(epicGrantOperationId('enr_otra', MASTER, 1)).not.toBe(operationId)
  })
})

describe('Configuracion del Master al cargar la mision (HU-73, P-X5)', () => {
  it('la del ejemplo del curso es valida', () => {
    expect(masterConfigProblem(config(), 5)).toBeNull()
    expect(() => {
      assertMasterConfig(TEMPLO)
    }).not.toThrow()
  })

  it('C-1: una probabilidad fuera de [0, 1] es PROBABILITY_OUT_OF_RANGE', () => {
    for (const probability of [1.5, -0.1, Number.NaN]) {
      expect(
        masterConfigProblem(
          config({ candidates: [candidate({ probabilityByHeroType: { '*': probability } })] }),
          5,
        ),
      ).toBe('PROBABILITY_OUT_OF_RANGE')
    }
  })

  it('C-2: una epica sin referencia es MISSING_REFERENCE, igual que un Master sin nombre', () => {
    const sinEpica = { ...candidate(), epic: {} } as unknown as MasterCandidate

    expect(masterConfigProblem(config({ candidates: [sinEpica] }), 5)).toBe('MISSING_REFERENCE')
    expect(masterConfigProblem(config({ candidates: [] }), 5)).toBe('MISSING_REFERENCE')
    expect(masterConfigProblem(config({ candidates: [candidate({ masterRef: ' ' })] }), 5)).toBe(
      'MISSING_REFERENCE',
    )
    expect(masterConfigProblem(config({ candidates: [candidate({ subtype: '' })] }), 5)).toBe(
      'MISSING_REFERENCE',
    )
  })

  it.each([
    ['antes del primer encuentro', [0]],
    ['despues del ultimo', [6]],
    ['no entero', [2.5]],
    ['repetido', [3, 3]],
    ['sin ningun punto', []],
  ])('un punto %s es EVALUATION_POINT_OUT_OF_RANGE', (_caso, points) => {
    expect(
      masterConfigProblem(
        config({ evaluationPoints: points.map((afterEncounter) => ({ afterEncounter })) }),
        5,
      ),
    ).toBe('EVALUATION_POINT_OUT_OF_RANGE')
  })

  it('un tope menor que 1 o no entero es INVALID_MAX_APPEARANCES', () => {
    expect(masterConfigProblem(config({ maxAppearances: 0 }), 5)).toBe('INVALID_MAX_APPEARANCES')
    expect(masterConfigProblem(config({ maxAppearances: 1.5 }), 5)).toBe('INVALID_MAX_APPEARANCES')
  })

  it('cargar el catalogo con un Master invalido falla con INVALID_MASTER_CONFIG', () => {
    const invalida: MissionDefinition = {
      ...TEMPLO,
      masterEncounter: config({ maxAppearances: 0 }),
    }

    expect(() => new InMemoryMissionCatalog([invalida])).toThrow(InvalidMasterConfigError)
    expect(() => {
      assertMasterConfig(invalida)
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_MASTER_CONFIG',
        reason: 'INVALID_MAX_APPEARANCES',
        missionId: TEMPLO.missionId,
      }) as Error,
    )
  })

  it('una mision sin Master no se valida', () => {
    expect(() => {
      assertMasterConfig({ ...TEMPLO, masterEncounter: null })
    }).not.toThrow()
  })
})

describe('Probabilidad para el heroe matriculado (HU-73, P-X2)', () => {
  const porTipo = candidate({ probabilityByHeroType: { PICARO_VENENO: 0.3, '*': 0.1 } })

  it('la del subtipo del heroe gana a la de "*"; sin la suya, vale "*"', () => {
    expect(probabilityFor(porTipo, 'PICARO_VENENO')).toBe(0.3)
    expect(probabilityFor(porTipo, 'MAGO_FUEGO')).toBe(0.1)
    expect(probabilityFor(porTipo, null)).toBe(0.1)
  })

  it('sin la suya ni "*", el candidato no aplica; una clave heredada no cuenta', () => {
    const soloPicaro = candidate({ probabilityByHeroType: { PICARO_VENENO: 0.15 } })

    expect(probabilityFor(soloPicaro, 'MAGO_FUEGO')).toBeNull()
    expect(probabilityFor(soloPicaro, 'toString')).toBeNull()
    expect(probabilityFor(candidate({ probabilityByHeroType: { '*': 0 } }), 'MAGO_FUEGO')).toBe(0)
  })

  it('el subtipo sale del perfil congelado del heroe, si es un texto', () => {
    expect(heroSubtypeOf({ subtype: 'PICARO_VENENO' })).toBe('PICARO_VENENO')
    expect(heroSubtypeOf({ subtype: '' })).toBeNull()
    expect(heroSubtypeOf({ subtype: 7 })).toBeNull()
    expect(heroSubtypeOf(null)).toBeNull()
  })

  it('el bloque para Combat es el del contrato, con la probabilidad ya resuelta', () => {
    expect(simulationMasterOf(config(), 'GUERRERO_ARMAS')).toEqual(sent(0.15))
  })

  it('M-6: si ningun candidato aplica al subtipo, no se envia el bloque', () => {
    const soloPicaro = config({
      candidates: [candidate({ probabilityByHeroType: { PICARO_VENENO: 0.15 } })],
    })

    expect(simulationMasterOf(soloPicaro, 'MAGO_FUEGO')).toBeNull()
  })

  it('solo van los candidatos que aplican, y los puntos en orden de encuentro', () => {
    const dos = config({
      evaluationPoints: [{ afterEncounter: 4 }, { afterEncounter: 2 }],
      candidates: [
        candidate({ masterRef: 'otro', probabilityByHeroType: { MAGO_FUEGO: 0.5 } }),
        candidate(),
      ],
    })
    const master = required(simulationMasterOf(dos, 'GUERRERO_ARMAS'), 'el bloque')

    expect(master.evaluationPoints).toEqual([{ afterEncounter: 2 }, { afterEncounter: 4 }])
    expect(master.candidates.map((item) => item.masterRef)).toEqual([MASTER])
  })
})

describe('Evidencia del Master al cerrar (HU-73, CU-73.3 y P-X7)', () => {
  it('M-1 y M-2: no aparece; queda registrada la no aparicion (CA-02)', () => {
    for (const probability of [0, 0.15]) {
      expect(
        recordsOf({
          sent: sent(probability),
          master: { appeared: false, evaluations: [evaluation(3, false)], encounters: [] },
          facts: facts(5),
        }),
      ).toEqual([
        {
          enrollmentId: ENROLLMENT,
          sequence: 1,
          afterEncounter: 3,
          masterRef: null,
          status: 'NOT_APPEARED',
          epicRef: null,
          levelOffset: null,
          turns: null,
          grant: null,
        },
      ])
    }
  })

  it('M-3: aparece y el heroe lo derrota; la fila nombra la epica (CA-01 y CA-04)', () => {
    expect(
      recordsOf({
        sent: sent(0.15),
        master: M3,
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toEqual([
      {
        enrollmentId: ENROLLMENT,
        sequence: 1,
        afterEncounter: 3,
        masterRef: MASTER,
        status: 'APPEARED_DEFEATED',
        epicRef: EPIC,
        levelOffset: 2,
        turns: 14,
        grant: null,
      },
    ])
  })

  it('M-4: el Master derrota al heroe; sin epica (CA-03)', () => {
    expect(
      recordsOf({
        sent: sent(0.15),
        master: {
          appeared: true,
          defeated: false,
          evaluations: [evaluation(3, true)],
          encounters: [fight(3, 'HERO_DEFEATED', 9)],
        },
        facts: facts(3, { appeared: true, defeated: false }),
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'APPEARED_HERO_DEFEATED',
        masterRef: MASTER,
        epicRef: null,
        turns: 9,
      }),
    ])
  })

  it('un Master que se retira sin caer no da epica (decision 8)', () => {
    expect(
      recordsOf({
        sent: sent(0.15),
        master: {
          appeared: true,
          defeated: false,
          evaluations: [evaluation(3, true)],
          encounters: [fight(3, 'ESCAPED', null)],
        },
        facts: facts(5, { appeared: true, defeated: false }),
      }),
    ).toEqual([expect.objectContaining({ status: 'APPEARED_ESCAPED', epicRef: null, turns: null })])
  })

  it('M-5: con el tope alcanzado, el punto siguiente queda SKIPPED_MAX_REACHED', () => {
    expect(
      recordsOf({
        sent: sent(1, [2, 4]),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(2, true)],
          encounters: [fight(2, 'DEFEATED', 11)],
        },
        facts: facts(5, { appeared: true, defeated: true }),
      })?.map(({ sequence, afterEncounter, status }) => [sequence, afterEncounter, status]),
    ).toEqual([
      [1, 2, 'APPEARED_DEFEATED'],
      [2, 4, 'SKIPPED_MAX_REACHED'],
    ])
  })

  it('varios Master en una mision larga: cada aparicion conserva su punto (regla de la HU)', () => {
    expect(
      recordsOf({
        sent: sent(0.5, [1, 3, 5], 2),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(1, true), evaluation(3, false), evaluation(5, true)],
          encounters: [fight(1, 'ESCAPED'), fight(5, 'DEFEATED')],
        },
        facts: facts(5, { appeared: true, defeated: true }),
      })?.map(({ sequence, status }) => [sequence, status]),
    ).toEqual([
      [1, 'APPEARED_ESCAPED'],
      [2, 'NOT_APPEARED'],
      [3, 'APPEARED_DEFEATED'],
    ])
  })

  it('M-6: con configuracion pero sin bloque enviado, NOT_APPLICABLE', () => {
    expect(recordsOf({ sent: null, master: undefined, facts: facts(5) })).toEqual([
      expect.objectContaining({ sequence: 1, afterEncounter: null, status: 'NOT_APPLICABLE' }),
    ])
  })

  it('una mision sin Master no deja evidencia', () => {
    expect(recordsOf({ sent: null, master: undefined, facts: facts(5), config: null })).toEqual([])
  })

  it('un punto que la mision no alcanzo no deja fila', () => {
    expect(
      recordsOf({
        sent: sent(0.15),
        master: { appeared: false, evaluations: [], encounters: [] },
        facts: facts(2),
      }),
    ).toEqual([])
  })

  it.each([
    ['falta el bloque master', undefined, facts(5)],
    ['faltan las evaluaciones', { appeared: false, encounters: [] }, facts(5)],
    ['un punto alcanzado quedo sin evaluar', { evaluations: [], encounters: [] }, facts(5)],
    [
      'se evaluo un punto que no se alcanzo',
      { evaluations: [evaluation(3, false)], encounters: [] },
      facts(2),
    ],
    [
      'aparece un Master que no se envio',
      { evaluations: [evaluation(3, false, 'otro')], encounters: [] },
      facts(5),
    ],
    [
      'se evaluo un punto que no se envio',
      { evaluations: [evaluation(3, false), evaluation(4, false)], encounters: [] },
      facts(5),
    ],
    [
      'el mismo candidato se evaluo dos veces en un punto',
      { evaluations: [evaluation(3, false), evaluation(3, false)], encounters: [] },
      facts(5),
    ],
    [
      'una aparicion no tiene encuentro',
      { ...M3, encounters: [] },
      facts(5, { appeared: true, defeated: true }),
    ],
    [
      'un encuentro no tiene aparicion',
      { ...M3, evaluations: [evaluation(3, false)] },
      facts(5, { appeared: true, defeated: true }),
    ],
    [
      'el desenlace no es del vocabulario',
      { ...M3, encounters: [fight(3, 'EMPATE')] },
      facts(5, { appeared: true, defeated: true }),
    ],
    ['el resumen corto dice que no aparecio', M3, facts(5)],
    ['el resumen corto dice que no cayo', M3, facts(5, { appeared: true, defeated: false })],
  ])('la evidencia no cuadra si %s: el cierre anula la mision', (_caso, master, hechos) => {
    expect(recordsOf({ sent: sent(0.15), master, facts: hechos })).toBeNull()
  })

  it('no admite una aparicion por encima del tope', () => {
    expect(
      recordsOf({
        sent: sent(1, [2, 4]),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(2, true), evaluation(4, true)],
          encounters: [fight(2, 'DEFEATED'), fight(4, 'DEFEATED')],
        },
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toBeNull()
  })

  it('sin bloque enviado, un Master que aparece es evidencia falsa', () => {
    expect(
      recordsOf({
        sent: null,
        master: undefined,
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toBeNull()
  })
})

describe('Epica ganada y su linea en el reporte (HU-73, CA-01 y CA-03)', () => {
  const derrotado = required(
    recordsOf({
      sent: sent(0.15),
      master: M3,
      facts: facts(5, { appeared: true, defeated: true }),
    }),
    'la evidencia M-3',
  )

  it('M-3: el Master derrotado deja su entrega pendiente y la linea EPIC', () => {
    const { records, rewards } = epicRewardsOf(derrotado, TEMPLO.masterEncounter, ENDS)

    expect(records[0]?.grant).toEqual({
      operationId: epicGrantOperationId(ENROLLMENT, MASTER, 1),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: ENDS,
      lastError: null,
      grantedAt: null,
      rewardLineNo: 1,
      productId: null,
    })
    expect(rewards).toEqual([
      {
        lineNo: 1,
        kind: 'EPIC',
        reference: EPIC,
        name: 'Toma y lleva',
        rarity: null,
        quantity: 1,
        status: 'PENDING',
        source: 'HU-73',
        progression: null,
        updatedAt: ENDS,
      },
    ])
  })

  it('M-7: repetir el cierre da la misma operacion', () => {
    const first = epicRewardsOf(derrotado, null, ENDS).records[0]?.grant?.operationId
    const later = new Date(ENDS.getTime() + 1_000)

    expect(first).toBeDefined()
    expect(epicRewardsOf(derrotado, null, later).records[0]?.grant?.operationId).toBe(first)
  })

  it('sin derrota del Master, ni entrega ni linea; el numero de aparicion si avanza', () => {
    const fila = required(derrotado[0], 'la fila')
    const escapado: MasterEncounterRecord = { ...fila, status: 'APPEARED_ESCAPED', epicRef: null }
    const { records, rewards } = epicRewardsOf([escapado, { ...fila, sequence: 2 }], null, ENDS)

    expect(records[0]?.grant).toBeNull()
    expect(records[1]?.grant?.operationId).toBe(epicGrantOperationId(ENROLLMENT, MASTER, 2))
    // Sin nombre en el contenido, la linea usa la referencia.
    expect(rewards).toEqual([expect.objectContaining({ lineNo: 1, name: EPIC })])
  })
})

describe('Avance de la entrega de la epica (HU-73, P-X6)', () => {
  const pendiente = required(
    epicRewardsOf(
      required(
        recordsOf({
          sent: sent(0.15),
          master: M3,
          facts: facts(5, { appeared: true, defeated: true }),
        }),
        'la evidencia',
      ),
      [],
      ENDS,
    ).records[0],
    'la fila pendiente',
  )

  it('confirmada: GRANTED con su fecha, sin mas intentos', () => {
    expect(grantConfirmed(pendiente, AT).grant).toMatchObject({
      status: 'GRANTED',
      attempts: 1,
      nextAttemptAt: null,
      grantedAt: AT,
      lastError: null,
    })
  })

  it('rechazada: REJECTED con el motivo, para revision', () => {
    expect(grantRejected(pendiente, 'INVENTORY_REJECTED').grant).toMatchObject({
      status: 'REJECTED',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'INVENTORY_REJECTED',
      grantedAt: null,
    })
  })

  it('aplazada: sigue PENDING, con el escalonado de HU-72 y la misma operacion', () => {
    const once = grantDeferred(pendiente, 'HTTP_503', AT)
    const twice = grantDeferred(once, 'HTTP_503', AT)

    expect(once.grant).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'HTTP_503' })
    expect(once.grant?.nextAttemptAt).toEqual(new Date(AT.getTime() + 5_000))
    expect(twice.grant?.nextAttemptAt).toEqual(new Date(AT.getTime() + 30_000))
    expect(twice.grant?.operationId).toBe(pendiente.grant?.operationId)
  })

  it('una entrega que ya no esta pendiente no cambia', () => {
    const entregada = grantConfirmed(pendiente, AT)

    expect(() => grantConfirmed(entregada, AT)).toThrow(InvalidGrantTransitionError)
    expect(() => grantDeferred(entregada, 'x', AT)).toThrow(InvalidGrantTransitionError)
    expect(() => grantRejected({ ...pendiente, grant: null }, 'x')).toThrow(
      InvalidGrantTransitionError,
    )
  })
})

describe('La evidencia en el hecho y en el reporte (HU-73 con HU-72 y HU-74)', () => {
  const enrollment = confirmEnrollment(
    newPendingEnrollment({
      enrollmentId: ENROLLMENT,
      playerId: 'sub-1',
      missionId: TEMPLO.missionId,
      heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
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
  const hechos = facts(5, { appeared: true, defeated: true })
  const { records } = epicRewardsOf(
    required(recordsOf({ sent: sent(0.15), master: M3, facts: hechos }), 'la evidencia'),
    null,
    ENDS,
  )
  const settlement = settlementOf('HERO_VICTORIOUS', TEMPLO.objectives, hechos)

  it('el hecho MissionSettled lleva la evidencia, sin la entrega', () => {
    expect(
      missionSettledFact(enrollment, settlement, 'sim_1', ENDS, records).payload,
    ).toMatchObject({
      masterEncounters: [
        {
          sequence: 1,
          afterEncounter: 3,
          masterRef: MASTER,
          status: 'APPEARED_DEFEATED',
          epicRef: EPIC,
        },
      ],
    })
  })

  it('el reporte muestra solo los Master que aparecieron, con su nombre (CA-03 de HU-74)', () => {
    const result: SimulationResult = {
      simulationId: 'sim_1',
      seedRef: null,
      combatOutcome: 'HERO_VICTORIOUS',
      summary: { encountersCompleted: 5, encountersTotal: 5, bossDefeated: true },
      combatLog: [],
    }
    const noAparecio: MasterEncounterRecord = {
      ...required(records[0], 'la fila'),
      sequence: 2,
      masterRef: null,
      status: 'NOT_APPEARED',
      epicRef: null,
      grant: null,
    }
    const report = missionReportOf({
      enrollment: closeEnrollment(enrollment, 'COMPLETED', ENDS),
      definition: TEMPLO,
      result,
      settlement,
      heroProfile: null,
      masters: [...records, noAparecio],
      generatedAt: ENDS,
    })

    expect(report.enemies.masters).toEqual([
      { masterRef: MASTER, name: 'Sombra del Olvido', status: 'APPEARED_DEFEATED' },
    ])
    expect(report.objectives.find((objective) => objective.id === 'obj_master')?.met).toBe(true)
  })
})

describe('Casos limite que la revision pidio cubrir (HU-73)', () => {
  const OTHER = 'otro-master'
  const OTHER_EPIC = 'otra-epica'

  /** Dos candidatos por punto: el del curso y otro, cada uno con su epica. */
  const sentTwo = (points: readonly number[], maxAppearances: number): SimulationMaster => {
    const first = required(sent(0.5).candidates[0], 'el candidato')

    return {
      evaluationPoints: points.map((afterEncounter) => ({ afterEncounter })),
      maxAppearances,
      candidates: [first, { ...first, masterRef: OTHER, epicRef: OTHER_EPIC }],
    }
  }

  it('P-X3: con dos candidatos, cada punto registra al que aparecio y su epica', () => {
    expect(
      recordsOf({
        sent: sentTwo([3], 1),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(3, false), evaluation(3, true, OTHER)],
          encounters: [{ ...fight(3, 'DEFEATED'), masterRef: OTHER }],
        },
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toEqual([
      expect.objectContaining({
        masterRef: OTHER,
        status: 'APPEARED_DEFEATED',
        epicRef: OTHER_EPIC,
      }),
    ])
  })

  it.each([
    [
      'aparecen dos Master en el mismo punto',
      {
        evaluations: [evaluation(3, true), evaluation(3, true, OTHER)],
        encounters: [fight(3, 'DEFEATED')],
      },
    ],
    [
      'pelea un Master distinto del que aparecio',
      {
        evaluations: [evaluation(3, true), evaluation(3, false, OTHER)],
        encounters: [{ ...fight(3, 'DEFEATED'), masterRef: OTHER }],
      },
    ],
  ])('con dos candidatos, la evidencia no cuadra si %s', (_caso, master) => {
    expect(
      recordsOf({
        sent: sentTwo([3], 1),
        master: { appeared: true, defeated: true, ...master },
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toBeNull()
  })

  it('P-05: dos Master derrotados en una mision larga dan dos entregas y dos lineas', () => {
    const evidence = required(
      recordsOf({
        sent: sentTwo([2, 4], 2),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(2, true), evaluation(4, false), evaluation(4, true, OTHER)],
          encounters: [fight(2, 'DEFEATED'), { ...fight(4, 'DEFEATED'), masterRef: OTHER }],
        },
        facts: facts(5, { appeared: true, defeated: true }),
      }),
      'la evidencia',
    )
    const { records, rewards } = epicRewardsOf(evidence, null, ENDS)

    expect(records.map((item) => [item.masterRef, item.grant?.operationId])).toEqual([
      [MASTER, epicGrantOperationId(ENROLLMENT, MASTER, 1)],
      [OTHER, epicGrantOperationId(ENROLLMENT, OTHER, 2)],
    ])
    expect(records.map((item) => item.grant?.rewardLineNo)).toEqual([1, 2])
    expect(rewards.map((line) => [line.lineNo, line.reference])).toEqual([
      [1, EPIC],
      [2, OTHER_EPIC],
    ])
  })

  it('CA-04: el desfase que devuelve Combat debe ser el que se le envio', () => {
    for (const levelOffset of [3, 2.5, '2', 1e21]) {
      expect(
        recordsOf({
          sent: sent(0.15),
          master: { ...M3, encounters: [{ ...fight(3, 'DEFEATED'), levelOffset }] },
          facts: facts(5, { appeared: true, defeated: true }),
        }),
      ).toBeNull()
    }
  })

  it('unos turnos que no caben en la columna se pierden, pero la evidencia vale', () => {
    expect(
      recordsOf({
        sent: sent(0.15),
        master: { ...M3, encounters: [fight(3, 'DEFEATED', 2_147_483_648)] },
        facts: facts(5, { appeared: true, defeated: true }),
      }),
    ).toEqual([expect.objectContaining({ status: 'APPEARED_DEFEATED', turns: null })])
  })

  it('un punto no alcanzado no deja fila aunque el tope ya estuviera cubierto', () => {
    expect(
      recordsOf({
        sent: sent(1, [2, 4]),
        master: {
          appeared: true,
          defeated: true,
          evaluations: [evaluation(2, true)],
          encounters: [fight(2, 'DEFEATED')],
        },
        // El heroe no llego al cuarto encuentro.
        facts: facts(3, { appeared: true, defeated: true }),
      })?.map(({ sequence, status }) => [sequence, status]),
    ).toEqual([[1, 'APPEARED_DEFEATED']])
  })

  it.each([
    ['no entero', 2.5],
    ['negativo', -1],
    ['en texto', '2'],
    ['que no cabe en la columna', 2_147_483_648],
    ['ausente', undefined],
  ])('P-X5: un desfase %s es INVALID_LEVEL_OFFSET', (_caso, levelOffset) => {
    expect(
      masterConfigProblem(
        config({ candidates: [candidate({ levelOffset: levelOffset as number })] }),
        5,
      ),
    ).toBe('INVALID_LEVEL_OFFSET')
  })

  it('P-X5: dos candidatos con el mismo Master son DUPLICATE_REFERENCE', () => {
    expect(masterConfigProblem(config({ candidates: [candidate(), candidate()] }), 5)).toBe(
      'DUPLICATE_REFERENCE',
    )
  })

  it('P-X3: sin tope en el contenido, vale 1', () => {
    const sinTope: MasterEncounter = {
      evaluationPoints: [{ afterEncounter: 2 }, { afterEncounter: 4 }],
      candidates: [candidate()],
    }

    expect(masterConfigProblem(sinTope, 5)).toBeNull()
    expect(maxAppearancesOf(sinTope)).toBe(1)
    expect(simulationMasterOf(sinTope, null)?.maxAppearances).toBe(1)
  })

  it('la epica del contenido vigente se busca por Master y epica, sin fiarse de su forma', () => {
    const conDos = config({
      candidates: [
        candidate(),
        candidate({
          masterRef: OTHER,
          epic: { ...candidate().epic, name: 'Otra', productId: 'prod-otro' },
        }),
      ],
    })

    expect(epicOf(conDos, OTHER, EPIC)).toEqual({ name: 'Otra', productId: 'prod-otro' })
    expect(epicOf(conDos, MASTER, EPIC)).toEqual({ name: 'Toma y lleva', productId: null })
    expect(epicOf(conDos, 'nadie', EPIC)).toBeNull()
    for (const roto of [null, undefined, 'x', { candidates: 'x' }, { candidates: [{}, 7] }]) {
      expect(epicOf(roto, MASTER, EPIC)).toBeNull()
    }
  })

  it('un contenido roto al cerrar no impide la epica: el nombre cae en la referencia', () => {
    const evidence = required(
      recordsOf({
        sent: sent(0.15),
        master: M3,
        facts: facts(5, { appeared: true, defeated: true }),
      }),
      'la evidencia',
    )

    for (const roto of [{ candidates: [{ masterRef: MASTER }] }, { candidates: null }, 42]) {
      expect(epicRewardsOf(evidence, roto, ENDS).rewards).toEqual([
        expect.objectContaining({ reference: EPIC, name: EPIC }),
      ])
    }
  })
})
