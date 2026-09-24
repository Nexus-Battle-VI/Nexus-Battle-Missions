import { APPROVED_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/approved-achievements'
import { EXAMPLE_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/example-achievements'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import {
  InvalidRecognitionTransitionError,
  recognitionCredited,
  recognitionDeferred,
  recognitionFailed,
  type AchievementDefinition,
  type AchievementUnlock,
} from '../../src/domain/entities/Achievement'
import type { EpicGrantStatus } from '../../src/domain/entities/MasterEncounterRecord'
import type {
  MasterCandidate,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import { InvalidAchievementCatalogError } from '../../src/domain/errors/achievement-errors'
import {
  achievementCatalogProblem,
  achievementContentOf,
  achievementGrantOperationId,
  achievementViewsOf,
  assertAchievementCatalog,
  catalogFingerprintOf,
  completedReportEvidenceOf,
  evidenceNeedsOf,
  progressOf,
  unlocksDue,
  type AchievementContent,
  type CompletedReportEvidence,
  type CompletedReportRow,
  type DefeatedMasterEvidence,
  type PlayerAchievementEvidence,
} from '../../src/domain/policies/AchievementPolicy'
import { epicGrantOperationId } from '../../src/domain/policies/MasterPolicy'

const PLAYER = 'cognito-sub-jugador-demo'
const AT = new Date('2026-10-02T03:00:00.000Z')
const NOW = new Date('2026-10-02T03:00:07.000Z')
const TEMPLO_ID = 'msn_templo_olvidado'
const CAMARA_ID = 'msn_camara_sellada'
const SOMBRA = 'sombra-del-olvido'
const CENTINELA = 'centinela-carmesi'
const VELO = 'velo-de-sombras'
const FURIA = 'furia-carmesi'
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** El caracter U+0000: una columna `text` de PostgreSQL no lo admite. */
const NUL = String.fromCharCode(0)

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

const [TEMPLO, CAMARA] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const BASE_CANDIDATE = required(TEMPLO.masterEncounter?.candidates[0], 'el Master del Templo')

const candidate = (
  masterRef: string,
  epicRef: string,
  probabilityByHeroType: Readonly<Record<string, number>> = { '*': 0.15 },
): MasterCandidate => ({
  ...BASE_CANDIDATE,
  masterRef,
  name: masterRef,
  probabilityByHeroType,
  epic: { ...BASE_CANDIDATE.epic, epicRef, name: epicRef },
})

const withMaster = (
  definition: MissionDefinition,
  candidates: readonly MasterCandidate[],
  afterEncounter = 1,
): MissionDefinition => ({
  ...definition,
  masterEncounter: { evaluationPoints: [{ afterEncounter }], maxAppearances: 1, candidates },
})

/**
 * El contenido activo de los fixtures del contrato: dos misiones de historia,
 * cada una con su Master y su epica (los del contrato, no los del ejemplo).
 */
const MISSIONS: readonly MissionDefinition[] = [
  withMaster(TEMPLO, [candidate(SOMBRA, VELO)], 3),
  withMaster(CAMARA, [candidate(CENTINELA, FURIA)]),
]
const CONTENT = achievementContentOf(MISSIONS)

const definitionOf = (achievementId: string): AchievementDefinition =>
  required(
    EXAMPLE_ACHIEVEMENTS.find((definition) => definition.achievementId === achievementId),
    achievementId,
  )

const recordTime = (
  maxSimulatedDuration: string | null,
  difficulty: 'NORMAL' | 'HEROIC' | null = null,
): AchievementDefinition => ({
  ...definitionOf('ach_templo_veloz'),
  rule: { criterion: 'RECORD_TIME', missionId: TEMPLO_ID, maxSimulatedDuration, difficulty },
})

/** El catalogo de los fixtures: el del contrato, con el umbral de L-4 (PT9H). */
const CATALOG: readonly AchievementDefinition[] = EXAMPLE_ACHIEVEMENTS.map((definition) =>
  definition.achievementId === 'ach_templo_veloz' ? recordTime('PT9H') : definition,
)

/** Un hecho de los fixtures del contrato (hu-76-mission-achievements-fixtures-v1). */
interface Fact {
  readonly enrollmentId: string
  readonly missionId: string
  readonly outcome: 'COMPLETED' | 'FAILED'
  readonly damageTaken: number
  readonly simulatedDuration: string
  readonly mastersDefeated: readonly string[]
  readonly epicsCredited: readonly string[]
}

const EPIC_OF: Readonly<Record<string, string>> = { [SOMBRA]: VELO, [CENTINELA]: FURIA }
const ENCOUNTERS: Readonly<Record<string, number>> = { [TEMPLO_ID]: 5, [CAMARA_ID]: 1 }

/**
 * La evidencia que dejan los hechos. Los fixtures no traen los encuentros ni el
 * estado de la entrega: la prueba da el recorrido completo de cada mision y deja
 * `GRANTED` las epicas de `epicsCredited` y `PENDING` las demas.
 */
const evidenceOf = (facts: readonly Fact[]): PlayerAchievementEvidence => {
  const completed = facts.filter((fact) => fact.outcome === 'COMPLETED')

  return {
    completedMissionIds: new Set(completed.map((fact) => fact.missionId)),
    completedReports: completed.map((fact, index) => ({
      enrollmentId: fact.enrollmentId,
      missionId: fact.missionId,
      difficulty: 'NORMAL',
      finishedAt: new Date(AT.getTime() + index * 60_000),
      damageTaken: fact.damageTaken,
      simulatedDuration: fact.simulatedDuration,
      encountersCompleted: ENCOUNTERS[fact.missionId] ?? 1,
      encountersTotal: ENCOUNTERS[fact.missionId] ?? 1,
    })),
    defeatedMasters: facts.flatMap((fact) =>
      fact.mastersDefeated.map((masterRef, index): DefeatedMasterEvidence => {
        const epicRef = EPIC_OF[masterRef] ?? null

        return {
          enrollmentId: fact.enrollmentId,
          sequence: index + 1,
          masterRef,
          epicRef,
          grantStatus:
            epicRef !== null && fact.epicsCredited.includes(epicRef) ? 'GRANTED' : 'PENDING',
        }
      }),
    ),
  }
}

const fact = (values: Partial<Fact> & Pick<Fact, 'enrollmentId'>): Fact => ({
  missionId: TEMPLO_ID,
  outcome: 'COMPLETED',
  damageTaken: 300,
  simulatedDuration: 'PT10H',
  mastersDefeated: [],
  epicsCredited: [],
  ...values,
})

const NO_EVIDENCE: PlayerAchievementEvidence = {
  completedMissionIds: null,
  completedReports: null,
  defeatedMasters: null,
}

/** Evaluar (desbloquear lo que toca) y leer, como hacen el evaluador y la consulta. */
const evaluate = (
  evidence: PlayerAchievementEvidence,
  definitions: readonly AchievementDefinition[] = CATALOG,
  content: AchievementContent = CONTENT,
) => {
  const unlocks = unlocksDue({
    playerId: PLAYER,
    pending: definitions,
    content,
    evidence,
    now: NOW,
  })

  return {
    unlocks,
    views: achievementViewsOf({ definitions, content, evidence, unlocks }),
  }
}

const viewOf = (views: ReturnType<typeof evaluate>['views'], achievementId: string) =>
  required(
    views.find((view) => view.achievementId === achievementId),
    achievementId,
  )

describe('Logros de misiones (Task HU-76.2)', () => {
  describe('fixtures del contrato (L-1 a L-9)', () => {
    const CASES: readonly {
      readonly id: string
      readonly achievementId: string
      readonly given: readonly Fact[]
      readonly fact: Fact
      readonly expected: Record<string, unknown>
    }[] = [
      {
        id: 'L-1 · CA-01 y CA-02: completada sin recibir dano',
        achievementId: 'ach_sin_rasgunos',
        given: [],
        fact: fact({ enrollmentId: 'enr_l1', damageTaken: 0, simulatedDuration: 'PT9H40M' }),
        expected: {
          status: 'UNLOCKED',
          progress: { current: 1, target: 1 },
          unlockedAt: NOW,
          recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
        },
      },
      {
        id: 'L-2 · CA-03: completada con un punto de dano',
        achievementId: 'ach_sin_rasgunos',
        given: [],
        fact: fact({ enrollmentId: 'enr_l2', damageTaken: 1, simulatedDuration: 'PT9H40M' }),
        expected: { status: 'LOCKED', progress: { current: 0, target: 1 } },
      },
      {
        id: 'L-3 · CA-03: fallida sin dano',
        achievementId: 'ach_sin_rasgunos',
        given: [],
        fact: fact({
          enrollmentId: 'enr_l3',
          outcome: 'FAILED',
          damageTaken: 0,
          simulatedDuration: 'PT2H',
        }),
        expected: { status: 'LOCKED', progress: { current: 0, target: 1 } },
      },
      {
        id: 'L-4 · CA-02: tiempo dentro del umbral (PT9H)',
        achievementId: 'ach_templo_veloz',
        given: [],
        fact: fact({ enrollmentId: 'enr_l4', damageTaken: 120, simulatedDuration: 'PT8H55M' }),
        expected: { status: 'UNLOCKED', progress: { current: 1, target: 1 } },
      },
      {
        id: 'L-5 · CA-03: un Master derrotado de dos disponibles',
        achievementId: 'ach_cazador_de_master',
        given: [],
        fact: fact({ enrollmentId: 'enr_l5', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
        expected: { status: 'IN_PROGRESS', progress: { current: 1, target: 2 } },
      },
      {
        id: 'L-6 · CA-02: el segundo Master, en una mision fallida',
        achievementId: 'ach_cazador_de_master',
        given: [fact({ enrollmentId: 'enr_l6_previa', mastersDefeated: [SOMBRA] })],
        fact: fact({
          enrollmentId: 'enr_l6',
          missionId: CAMARA_ID,
          outcome: 'FAILED',
          damageTaken: 900,
          simulatedDuration: 'PT3H',
          mastersDefeated: [CENTINELA],
        }),
        expected: { status: 'UNLOCKED', progress: { current: 2, target: 2 } },
      },
      {
        id: 'L-7 · CA-02: la coleccion de epicas completa',
        achievementId: 'ach_coleccionista',
        given: [
          fact({ enrollmentId: 'enr_l7_previa', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
        ],
        fact: fact({
          enrollmentId: 'enr_l7',
          missionId: CAMARA_ID,
          damageTaken: 400,
          simulatedDuration: 'PT5H',
          mastersDefeated: [CENTINELA],
          epicsCredited: [FURIA],
        }),
        expected: {
          status: 'UNLOCKED',
          progress: { current: 2, target: 2 },
          recognition: { kind: 'COSMETIC_PRODUCT', status: 'PENDING' },
        },
      },
      {
        id: 'L-8 · CA-03: la historia a medias',
        achievementId: 'ach_historia_completa',
        given: [],
        fact: fact({ enrollmentId: 'enr_l8', damageTaken: 50, simulatedDuration: 'PT9H40M' }),
        expected: { status: 'IN_PROGRESS', progress: { current: 1, target: 2 } },
      },
    ]

    it.each(CASES)('$id', ({ achievementId, given, fact: current, expected }) => {
      const { views } = evaluate(evidenceOf([...given, current]))

      expect(viewOf(views, achievementId)).toMatchObject(expected)
    })

    it('L-7: el cosmetico nace pendiente, sin producto y con su operationId v5', () => {
      const { unlocks } = evaluate(
        evidenceOf([
          fact({ enrollmentId: 'enr_l7_previa', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
          fact({
            enrollmentId: 'enr_l7',
            missionId: CAMARA_ID,
            mastersDefeated: [CENTINELA],
            epicsCredited: [FURIA],
          }),
        ]),
      )

      expect(unlocks.find((unlock) => unlock.achievementId === 'ach_coleccionista')).toEqual({
        playerId: PLAYER,
        achievementId: 'ach_coleccionista',
        achievementVersion: 1,
        criterion: 'ALL_MASTER_EPICS',
        name: 'Estandarte del Coleccionista',
        progress: { current: 2, target: 2 },
        proof: { refs: [FURIA, VELO], enrollmentIds: ['enr_l7', 'enr_l7_previa'] },
        unlockedAt: NOW,
        recognition: {
          kind: 'COSMETIC_PRODUCT',
          name: 'Estandarte del Coleccionista',
          status: 'PENDING',
        },
        grant: {
          operationId: achievementGrantOperationId(PLAYER, 'ach_coleccionista'),
          attempts: 0,
          nextAttemptAt: NOW,
          lastError: null,
          productId: null,
          creditedAt: null,
        },
      })
    })

    it('L-9: el mismo hecho reprocesado no cambia el progreso ni desbloquea otra vez', () => {
      const given = fact({
        enrollmentId: 'enr_l7_previa',
        mastersDefeated: [SOMBRA],
        epicsCredited: [VELO],
      })
      const l7 = fact({
        enrollmentId: 'enr_l7',
        missionId: CAMARA_ID,
        mastersDefeated: [CENTINELA],
        epicsCredited: [FURIA],
      })
      const first = evaluate(evidenceOf([given, l7]))
      const stored = new Set(first.unlocks.map((unlock) => unlock.achievementId))
      const pending = CATALOG.filter((definition) => !stored.has(definition.achievementId))
      const again = evidenceOf([given, l7, l7])

      expect(stored.has('ach_coleccionista')).toBe(true)
      expect(
        unlocksDue({ playerId: PLAYER, pending, content: CONTENT, evidence: again, now: NOW }),
      ).toEqual([])
      expect(
        achievementViewsOf({
          definitions: CATALOG,
          content: CONTENT,
          evidence: again,
          unlocks: first.unlocks,
        }),
      ).toEqual(first.views)
    })
  })

  describe('CA-02 (P-02): solo con evidencia de que no hubo dano', () => {
    const flawless = definitionOf('ach_sin_rasgunos')
    const report = (values: Partial<CompletedReportEvidence> = {}): CompletedReportEvidence => ({
      enrollmentId: 'enr_p02',
      missionId: TEMPLO_ID,
      difficulty: 'NORMAL',
      finishedAt: AT,
      damageTaken: 0,
      simulatedDuration: 'PT9H40M',
      encountersCompleted: 5,
      encountersTotal: 5,
      ...values,
    })
    const progressFor = (...reports: CompletedReportEvidence[]) =>
      progressOf(flawless, CONTENT, { ...NO_EVIDENCE, completedReports: reports })

    it('P-02: una mision completa, recorrida entera y sin dano lo otorga', () => {
      expect(progressFor(report())).toEqual({
        current: 1,
        target: 1,
        evaluable: true,
        met: true,
        proof: { refs: [TEMPLO_ID], enrollmentIds: ['enr_p02'] },
      })
    })

    it.each([
      ['sin el dano informado: null no es 0', { damageTaken: null }],
      ['con un punto de dano', { damageTaken: 1 }],
      ['con dano decimal', { damageTaken: 0.5 }],
      ['con el recorrido incompleto (4 de 5)', { encountersCompleted: 4 }],
      ['sin encuentros: una ejecucion vacia', { encountersCompleted: 0, encountersTotal: 0 }],
      ['sin el recorrido informado', { encountersCompleted: null, encountersTotal: null }],
    ])('no lo otorga %s', (_caso, values: Partial<CompletedReportEvidence>) => {
      expect(progressFor(report(values))).toMatchObject({ current: 0, met: false })
    })

    const row = (values: Partial<CompletedReportRow> = {}): CompletedReportRow => ({
      enrollmentId: 'enr_row',
      missionId: TEMPLO_ID,
      difficulty: 'HEROIC',
      finishedAt: AT,
      schemaVersion: 1,
      damageTaken: 0,
      simulatedDuration: 'PT9H40M',
      encountersCompleted: 5,
      encountersTotal: 5,
      ...values,
    })

    it('lee la foto de la version 1', () => {
      expect(completedReportEvidenceOf(row({ damageTaken: 12.5 }))).toEqual({
        enrollmentId: 'enr_row',
        missionId: TEMPLO_ID,
        difficulty: 'HEROIC',
        finishedAt: AT,
        damageTaken: 12.5,
        simulatedDuration: 'PT9H40M',
        encountersCompleted: 5,
        encountersTotal: 5,
      })
    })

    it('un reporte de otra version no aporta evidencia y no lanza', () => {
      expect(completedReportEvidenceOf(row({ schemaVersion: 2 }))).toMatchObject({
        enrollmentId: 'enr_row',
        damageTaken: null,
        simulatedDuration: null,
        encountersCompleted: null,
        encountersTotal: null,
      })
    })

    it.each([
      ['dano como texto', { damageTaken: '0' }, 'damageTaken'],
      ['dano negativo', { damageTaken: -1 }, 'damageTaken'],
      ['dano infinito', { damageTaken: Number.POSITIVE_INFINITY }, 'damageTaken'],
      ['dano NaN', { damageTaken: Number.NaN }, 'damageTaken'],
      ['dano como objeto', { damageTaken: { valor: 0 } }, 'damageTaken'],
      ['dano ausente', { damageTaken: undefined }, 'damageTaken'],
      ['dano nulo de jsonb', { damageTaken: null }, 'damageTaken'],
      ['una duracion que no es ISO', { simulatedDuration: 'nueve horas' }, 'simulatedDuration'],
      ['una duracion numerica', { simulatedDuration: 34_800 }, 'simulatedDuration'],
      ['la duracion P a secas', { simulatedDuration: 'P' }, 'simulatedDuration'],
      ['encuentros decimales', { encountersCompleted: 2.5 }, 'encountersCompleted'],
      ['encuentros como texto', { encountersTotal: '5' }, 'encountersTotal'],
      ['encuentros negativos', { encountersTotal: -1 }, 'encountersTotal'],
    ])('no lanza con %s: lo deja en null', (_caso, values: Partial<CompletedReportRow>, field) => {
      expect(completedReportEvidenceOf(row(values))).toMatchObject({ [field]: null })
    })
  })

  describe('CA-03 (P-03): nunca con progreso parcial ni con un objetivo vacio', () => {
    it('P-03: con parte de los Master no se otorgan ni el cazador ni la coleccion', () => {
      const { unlocks, views } = evaluate(
        evidenceOf([
          fact({ enrollmentId: 'enr_p03', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
        ]),
      )

      expect(unlocks.map((unlock) => unlock.achievementId)).not.toContain('ach_cazador_de_master')
      expect(unlocks.map((unlock) => unlock.achievementId)).not.toContain('ach_coleccionista')
      expect(viewOf(views, 'ach_cazador_de_master')).toMatchObject({
        status: 'IN_PROGRESS',
        progress: { current: 1, target: 2 },
      })
      expect(viewOf(views, 'ach_coleccionista')).toMatchObject({
        status: 'IN_PROGRESS',
        progress: { current: 1, target: 2 },
      })
    })

    it('un «todas» sin contenido no se otorga nunca: 0 de 0', () => {
      const everything = evidenceOf([
        fact({ enrollmentId: 'enr_a', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
        fact({ enrollmentId: 'enr_b', missionId: CAMARA_ID, mastersDefeated: [CENTINELA] }),
      ])
      // Sin Master en el contenido: la evidencia de uno retirado no cuenta.
      const withoutMasters = achievementContentOf(
        [TEMPLO, CAMARA].map((d) => ({ ...d, masterEncounter: null })),
      )

      expect(progressOf(definitionOf('ach_desafio_completo'), CONTENT, everything)).toEqual({
        current: 0,
        target: 0,
        evaluable: false,
        met: false,
        proof: { refs: [], enrollmentIds: [] },
      })
      for (const achievementId of ['ach_cazador_de_master', 'ach_coleccionista']) {
        expect(progressOf(definitionOf(achievementId), withoutMasters, everything)).toMatchObject({
          current: 0,
          target: 0,
          met: false,
        })
      }

      const { unlocks, views } = evaluate(everything, CATALOG, withoutMasters)

      expect(unlocks.map((unlock) => unlock.achievementId)).toEqual(['ach_historia_completa'])
      expect(viewOf(views, 'ach_desafio_completo')).toMatchObject({
        status: 'LOCKED',
        progress: { current: 0, target: 0 },
      })
    })

    it('sin dano con count 2: una mision da 1 de 2, aunque se repita', () => {
      const twice: AchievementDefinition = {
        ...definitionOf('ach_sin_rasgunos'),
        rule: { criterion: 'FLAWLESS_MISSION', count: 2 },
      }
      const flawless = (enrollmentId: string, missionId = TEMPLO_ID) =>
        fact({ enrollmentId, missionId, damageTaken: 0 })

      expect(progressOf(twice, CONTENT, evidenceOf([flawless('enr_1')]))).toMatchObject({
        current: 1,
        target: 2,
        met: false,
      })
      expect(
        progressOf(twice, CONTENT, evidenceOf([flawless('enr_1'), flawless('enr_2')])),
      ).toMatchObject({ current: 1, target: 2, met: false })
      expect(
        progressOf(
          twice,
          CONTENT,
          evidenceOf([flawless('enr_1'), flawless('enr_2'), flawless('enr_3', CAMARA_ID)]),
        ),
      ).toEqual({
        current: 2,
        target: 2,
        evaluable: true,
        met: true,
        proof: { refs: [TEMPLO_ID, CAMARA_ID], enrollmentIds: ['enr_1', 'enr_3'] },
      })
    })

    it('todo desbloqueo tiene el progreso completo y un objetivo real (propiedad)', () => {
      const pool: readonly Fact[] = [
        fact({ enrollmentId: 'enr_1', damageTaken: 0, simulatedDuration: 'PT8H' }),
        fact({ enrollmentId: 'enr_2', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
        fact({
          enrollmentId: 'enr_3',
          missionId: CAMARA_ID,
          outcome: 'FAILED',
          mastersDefeated: [CENTINELA],
        }),
        fact({ enrollmentId: 'enr_4', missionId: CAMARA_ID, damageTaken: 0 }),
        fact({
          enrollmentId: 'enr_5',
          missionId: CAMARA_ID,
          mastersDefeated: [CENTINELA],
          epicsCredited: [FURIA],
        }),
        fact({ enrollmentId: 'enr_6', damageTaken: 1, simulatedDuration: 'PT9H0M1S' }),
      ]

      for (let mask = 0; mask < 2 ** pool.length; mask += 1) {
        const subset = pool.filter((_fact, index) => (mask & (1 << index)) !== 0)

        for (const unlock of evaluate(evidenceOf(subset)).unlocks) {
          expect(unlock.progress.target).toBeGreaterThanOrEqual(1)
          expect(unlock.progress.current).toBe(unlock.progress.target)
        }
      }
    })
  })

  describe('tiempo record (P-L7, decision 3)', () => {
    const completedIn = (
      simulatedDuration: string,
      values: Partial<CompletedReportEvidence> = {},
    ): CompletedReportEvidence => ({
      enrollmentId: 'enr_record',
      missionId: TEMPLO_ID,
      difficulty: 'NORMAL',
      finishedAt: AT,
      damageTaken: 120,
      simulatedDuration,
      encountersCompleted: 5,
      encountersTotal: 5,
      ...values,
    })
    const progressFor = (
      definition: AchievementDefinition,
      ...reports: CompletedReportEvidence[]
    ) => progressOf(definition, CONTENT, { ...NO_EVIDENCE, completedReports: reports })

    it.each([
      ['justo en el umbral', 'PT9H', true],
      ['por debajo', 'PT8H55M', true],
      ['un segundo por encima', 'PT9H0M1S', false],
    ])('%s (%s): otorgado = %s', (_caso, duration, met) => {
      expect(progressFor(recordTime('PT9H'), completedIn(duration)).met).toBe(met)
    })

    it('sin umbral no se evalua: LOCKED 0/1 y no pide reportes', () => {
      const pending = definitionOf('ach_templo_veloz')

      expect(progressFor(pending, completedIn('PT1H'))).toEqual({
        current: 0,
        target: 1,
        evaluable: false,
        met: false,
        proof: { refs: [], enrollmentIds: [] },
      })
      expect(evidenceNeedsOf([pending]).reports).toBe(false)
      expect(
        viewOf(evaluate(NO_EVIDENCE, EXAMPLE_ACHIEVEMENTS).views, 'ach_templo_veloz'),
      ).toMatchObject({
        status: 'LOCKED',
        progress: { current: 0, target: 1 },
      })
    })

    it('la dificultad de la regla filtra; sin dificultad vale cualquiera', () => {
      const heroic = completedIn('PT8H', { difficulty: 'HEROIC' })

      expect(progressFor(recordTime('PT9H', 'NORMAL'), heroic).met).toBe(false)
      expect(progressFor(recordTime('PT9H', 'HEROIC'), heroic).met).toBe(true)
      expect(progressFor(recordTime('PT9H'), heroic).met).toBe(true)
    })

    it('solo cuenta la mision de la regla, y sin duracion no hay marca', () => {
      expect(
        progressFor(recordTime('PT9H'), completedIn('PT1H', { missionId: CAMARA_ID }), {
          ...completedIn('PT1H'),
          simulatedDuration: null,
        }).met,
      ).toBe(false)
    })

    it('la prueba es la mejor marca; a igual tiempo, la mas antigua', () => {
      const later = new Date(AT.getTime() + 60_000)

      expect(
        progressFor(
          recordTime('PT9H'),
          completedIn('PT8H30M', { enrollmentId: 'enr_lenta' }),
          completedIn('PT8H', { enrollmentId: 'enr_nueva', finishedAt: later }),
          completedIn('PT8H', { enrollmentId: 'enr_vieja' }),
        ).proof,
      ).toEqual({ refs: [TEMPLO_ID], enrollmentIds: ['enr_vieja'] })
    })
  })

  describe('objetivos: el contenido activo (P-L6) y la categoria (P-04)', () => {
    it('reune las misiones activas por categoria, los Master disponibles y sus epicas', () => {
      expect(CONTENT).toEqual({
        missionsByCategory: {
          STORY: [CAMARA_ID, TEMPLO_ID],
          CHALLENGE: [],
          EXPLORATION: [],
        },
        availableMasters: [CENTINELA, SOMBRA],
        masterEpics: [FURIA, VELO],
      })
    })

    it('descarta lo que no puede aparecer y quita los repetidos', () => {
      const content = achievementContentOf([
        // Valido: el mismo Master en dos misiones y dos Master con la misma epica.
        withMaster({ ...TEMPLO, missionId: 'msn_a' }, [candidate(SOMBRA, VELO)], 3),
        withMaster(
          { ...TEMPLO, missionId: 'msn_b' },
          [candidate(SOMBRA, VELO), candidate('gemelo', VELO)],
          3,
        ),
        // Configuracion invalida: la mision se anula con INVALID_MASTER_CONFIG.
        withMaster(
          { ...TEMPLO, missionId: 'msn_c' },
          [candidate('roto', 'epica-rota', { '*': 2 })],
          3,
        ),
        // Probabilidad 0 para todos los subtipos: nunca aparece.
        withMaster(
          { ...TEMPLO, missionId: 'msn_d' },
          [candidate('nunca', 'epica-nunca', { '*': 0, GUERRERO_ARMAS: 0 })],
          3,
        ),
        // Contenido de jsonb sin la forma esperada.
        { ...TEMPLO, missionId: 'msn_e', masterEncounter: 'roto' as never },
        { ...TEMPLO, missionId: 'msn_f', masterEncounter: undefined as never },
        withMaster(
          { ...TEMPLO, missionId: 'msn_g', encounters: 'roto' as never },
          [candidate('encuentros-rotos', 'epica-encuentros-rotos')],
          3,
        ),
        // Inactiva: ni su mision ni su Master cuentan.
        {
          ...withMaster(
            { ...TEMPLO, missionId: 'msn_h' },
            [candidate('retirado', 'epica-retirada')],
            3,
          ),
          active: false,
        },
        // Valida, con los Master del contenido: la Hechicera del Sello y el Coloso de
        // Obsidiana, cada uno con su epica.
        { ...CAMARA, category: 'CHALLENGE' },
      ])

      expect(content).toEqual({
        missionsByCategory: {
          STORY: ['msn_a', 'msn_b', 'msn_c', 'msn_d', 'msn_e', 'msn_f', 'msn_g'],
          CHALLENGE: [CAMARA_ID],
          EXPLORATION: [],
        },
        availableMasters: ['coloso-de-obsidiana', 'gemelo', 'hechicera-del-sello', SOMBRA],
        masterEpics: ['frio-concentrado', 'golpe-de-defensa', VELO],
      })
    })

    it('P-04: una mision cuenta en su categoria de hoy y en cualquier dificultad', () => {
      const historia = definitionOf('ach_historia_completa')
      const desafio = definitionOf('ach_desafio_completo')
      const evidence: PlayerAchievementEvidence = {
        ...NO_EVIDENCE,
        completedMissionIds: new Set([CAMARA_ID]),
      }
      const reclassified = achievementContentOf([
        MISSIONS[0]!,
        { ...CAMARA, category: 'CHALLENGE' },
      ])

      expect(progressOf(historia, CONTENT, evidence)).toMatchObject({ current: 1, target: 2 })
      // La Camara pasa a Desafio: ya no suma a la historia y completa el desafio.
      expect(progressOf(historia, reclassified, evidence)).toMatchObject({ current: 0, target: 1 })
      expect(progressOf(desafio, reclassified, evidence)).toMatchObject({
        current: 1,
        target: 1,
        met: true,
        proof: { refs: [CAMARA_ID], enrollmentIds: [] },
      })
    })

    it('con CREDITED solo cuenta la epica entregada; con WON, tambien la pendiente, nunca la rechazada', () => {
      const credited = definitionOf('ach_coleccionista')
      const won: AchievementDefinition = {
        ...credited,
        rule: { criterion: 'ALL_MASTER_EPICS', epicState: 'WON' },
      }
      const masters = (
        sombra: EpicGrantStatus,
        centinela: EpicGrantStatus,
      ): PlayerAchievementEvidence => ({
        ...NO_EVIDENCE,
        defeatedMasters: [
          {
            enrollmentId: 'enr_1',
            sequence: 1,
            masterRef: SOMBRA,
            epicRef: VELO,
            grantStatus: sombra,
          },
          {
            enrollmentId: 'enr_2',
            sequence: 1,
            masterRef: CENTINELA,
            epicRef: FURIA,
            grantStatus: centinela,
          },
        ],
      })

      expect(progressOf(credited, CONTENT, masters('GRANTED', 'PENDING')).current).toBe(1)
      expect(progressOf(credited, CONTENT, masters('GRANTED', 'REJECTED')).current).toBe(1)
      expect(progressOf(credited, CONTENT, masters('GRANTED', 'GRANTED')).met).toBe(true)
      expect(progressOf(won, CONTENT, masters('PENDING', 'PENDING')).met).toBe(true)
      expect(progressOf(won, CONTENT, masters('GRANTED', 'REJECTED')).current).toBe(1)
    })

    it('la misma epica de dos Master cuenta una vez, con la primera matricula', () => {
      const content = achievementContentOf([
        withMaster(TEMPLO, [candidate(SOMBRA, VELO), candidate('gemelo', VELO)], 3),
      ])
      const evidence: PlayerAchievementEvidence = {
        ...NO_EVIDENCE,
        defeatedMasters: [
          {
            enrollmentId: 'enr_2',
            sequence: 1,
            masterRef: 'gemelo',
            epicRef: VELO,
            grantStatus: 'GRANTED',
          },
          {
            enrollmentId: 'enr_1',
            sequence: 1,
            masterRef: SOMBRA,
            epicRef: VELO,
            grantStatus: 'GRANTED',
          },
        ],
      }

      expect(progressOf(definitionOf('ach_coleccionista'), content, evidence)).toEqual({
        current: 1,
        target: 1,
        evaluable: true,
        met: true,
        proof: { refs: [VELO], enrollmentIds: ['enr_1'] },
      })
      expect(progressOf(definitionOf('ach_cazador_de_master'), content, evidence)).toMatchObject({
        current: 2,
        target: 2,
        proof: { refs: ['gemelo', SOMBRA], enrollmentIds: ['enr_1', 'enr_2'] },
      })
    })

    it('solo pide la evidencia que necesitan los logros pendientes', () => {
      expect(evidenceNeedsOf([])).toEqual({ clears: false, reports: false, masters: false })
      expect(evidenceNeedsOf([definitionOf('ach_historia_completa')])).toEqual({
        clears: true,
        reports: false,
        masters: false,
      })
      expect(evidenceNeedsOf([definitionOf('ach_sin_rasgunos')])).toEqual({
        clears: false,
        reports: true,
        masters: false,
      })
      expect(evidenceNeedsOf([recordTime('PT9H')]).reports).toBe(true)
      expect(evidenceNeedsOf([definitionOf('ach_cazador_de_master')]).masters).toBe(true)
      expect(evidenceNeedsOf([definitionOf('ach_coleccionista')]).masters).toBe(true)
      expect(evidenceNeedsOf(CATALOG)).toEqual({ clears: true, reports: true, masters: true })
    })

    it('sin la evidencia leida, nada cuenta', () => {
      for (const definition of CATALOG) {
        expect(progressOf(definition, CONTENT, NO_EVIDENCE)).toMatchObject({
          current: 0,
          met: false,
        })
      }
    })
  })

  describe('conmutatividad', () => {
    const permutations = <T>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [[...items]]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          )

    it('el orden en que llega la evidencia no cambia el progreso ni los desbloqueos', () => {
      const base = evidenceOf([
        fact({ enrollmentId: 'enr_1', damageTaken: 0, simulatedDuration: 'PT8H' }),
        fact({
          enrollmentId: 'enr_2',
          simulatedDuration: 'PT8H',
          mastersDefeated: [SOMBRA],
          epicsCredited: [VELO],
        }),
        fact({ enrollmentId: 'enr_3', missionId: CAMARA_ID, damageTaken: 0 }),
        fact({ enrollmentId: 'enr_4', missionId: CAMARA_ID, mastersDefeated: [CENTINELA, SOMBRA] }),
      ])
      const expected = evaluate(base)
      const reports = required(base.completedReports, 'los reportes')
      const masters = required(base.defeatedMasters, 'los Master')

      for (const completedReports of permutations(reports)) {
        for (const defeatedMasters of permutations(masters)) {
          expect(evaluate({ ...base, completedReports, defeatedMasters })).toEqual(expected)
        }
      }
    })
  })

  describe('la vista de la consulta', () => {
    const contractEvidence = evidenceOf([
      fact({
        enrollmentId: 'enr_01JB8Y3K7Q',
        damageTaken: 0,
        simulatedDuration: 'PT9H40M',
        mastersDefeated: [SOMBRA],
        epicsCredited: [VELO],
      }),
    ])

    it('reproduce el ejemplo del contrato: primero lo desbloqueado, despues el catalogo', () => {
      const { unlocks, views } = evaluate(contractEvidence, EXAMPLE_ACHIEVEMENTS)
      const shown = new Set(['ach_sin_rasgunos', 'ach_historia_completa', 'ach_coleccionista'])

      expect(unlocks.map((unlock) => unlock.achievementId)).toEqual(['ach_sin_rasgunos'])
      expect(views.filter((view) => shown.has(view.achievementId))).toEqual([
        {
          achievementId: 'ach_sin_rasgunos',
          name: 'Sin un rasguño',
          criterion: 'FLAWLESS_MISSION',
          status: 'UNLOCKED',
          progress: { current: 1, target: 1 },
          unlockedAt: new Date('2026-10-02T03:00:07Z'),
          recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
        },
        {
          achievementId: 'ach_historia_completa',
          name: 'Cronista del Nexus',
          criterion: 'ALL_CATEGORY_MISSIONS',
          status: 'IN_PROGRESS',
          progress: { current: 1, target: 2 },
          unlockedAt: null,
          recognition: { kind: 'TITLE', name: 'Cronista del Nexus', status: null },
        },
        {
          achievementId: 'ach_coleccionista',
          name: 'Estandarte del Coleccionista',
          criterion: 'ALL_MASTER_EPICS',
          status: 'IN_PROGRESS',
          progress: { current: 1, target: 2 },
          unlockedAt: null,
          recognition: {
            kind: 'COSMETIC_PRODUCT',
            name: 'Estandarte del Coleccionista',
            status: null,
          },
        },
      ])
      expect(views.map((view) => [view.achievementId, view.status])).toEqual([
        ['ach_sin_rasgunos', 'UNLOCKED'],
        ['ach_historia_completa', 'IN_PROGRESS'],
        ['ach_desafio_completo', 'LOCKED'],
        ['ach_exploracion_completa', 'LOCKED'],
        ['ach_cazador_de_master', 'IN_PROGRESS'],
        ['ach_templo_veloz', 'LOCKED'],
        ['ach_coleccionista', 'IN_PROGRESS'],
      ])
    })

    it('lo desbloqueado queda congelado aunque crezca el objetivo o cambie la regla (P-L5)', () => {
      const { unlocks } = evaluate(
        evidenceOf([
          fact({ enrollmentId: 'enr_1', damageTaken: 0 }),
          fact({ enrollmentId: 'enr_2', missionId: CAMARA_ID }),
        ]),
      )
      // Los dos logros siguen en el catalogo: la historia gana una tercera mision
      // y «sin rasguños» pasa a pedir dos misiones.
      const grown = achievementContentOf([...MISSIONS, { ...CAMARA, missionId: 'msn_tercera' }])
      const stricter = CATALOG.map((definition): AchievementDefinition =>
        definition.achievementId === 'ach_sin_rasgunos'
          ? { ...definition, version: 2, rule: { criterion: 'FLAWLESS_MISSION', count: 2 } }
          : definition,
      )
      const views = achievementViewsOf({
        definitions: stricter,
        content: grown,
        evidence: NO_EVIDENCE,
        unlocks,
      })

      expect(unlocks.map((unlock) => unlock.achievementId)).toEqual([
        'ach_historia_completa',
        'ach_sin_rasgunos',
      ])
      expect(viewOf(views, 'ach_historia_completa')).toMatchObject({
        status: 'UNLOCKED',
        progress: { current: 2, target: 2 },
      })
      expect(viewOf(views, 'ach_sin_rasgunos')).toMatchObject({
        status: 'UNLOCKED',
        progress: { current: 1, target: 1 },
      })
      expect(views).toHaveLength(CATALOG.length)
    })

    it('lo desbloqueado que sale del catalogo se sigue mostrando, congelado', () => {
      const { unlocks } = evaluate(
        evidenceOf([
          fact({ enrollmentId: 'enr_1' }),
          fact({ enrollmentId: 'enr_2', missionId: CAMARA_ID }),
        ]),
      )
      const withoutIt = CATALOG.filter(
        (definition) => definition.achievementId !== 'ach_historia_completa',
      )
      const views = achievementViewsOf({
        definitions: withoutIt,
        content: CONTENT,
        evidence: NO_EVIDENCE,
        unlocks,
      })

      expect(views[0]).toEqual({
        achievementId: 'ach_historia_completa',
        name: 'Cronista del Nexus',
        criterion: 'ALL_CATEGORY_MISSIONS',
        status: 'UNLOCKED',
        progress: { current: 2, target: 2 },
        unlockedAt: NOW,
        recognition: { kind: 'TITLE', name: 'Cronista del Nexus', status: 'RECORDED' },
      })
      expect(views).toHaveLength(CATALOG.length)
    })

    it('ordena lo desbloqueado del mas reciente al mas antiguo; a igual momento, por el catalogo', () => {
      const unlock = (achievementId: string, unlockedAt: Date): AchievementUnlock => ({
        ...required(
          evaluate(contractEvidence).unlocks.find(
            (item) => item.achievementId === 'ach_sin_rasgunos',
          ),
          'el desbloqueo',
        ),
        achievementId,
        unlockedAt,
      })
      const later = new Date(NOW.getTime() + 1_000)
      const views = achievementViewsOf({
        definitions: CATALOG,
        content: CONTENT,
        evidence: NO_EVIDENCE,
        unlocks: [
          unlock('ach_zz_huerfano', NOW),
          unlock('ach_aa_huerfano', NOW),
          unlock('ach_coleccionista', NOW),
          unlock('ach_historia_completa', NOW),
          unlock('ach_sin_rasgunos', later),
        ],
      })

      expect(views.slice(0, 5).map((view) => view.achievementId)).toEqual([
        'ach_sin_rasgunos',
        'ach_historia_completa',
        'ach_coleccionista',
        'ach_aa_huerfano',
        'ach_zz_huerfano',
      ])
    })

    it('un criterio cumplido que aun no se guardo se ve IN_PROGRESS con el progreso completo', () => {
      const views = achievementViewsOf({
        definitions: CATALOG,
        content: CONTENT,
        evidence: contractEvidence,
        unlocks: [],
      })

      expect(viewOf(views, 'ach_sin_rasgunos')).toMatchObject({
        status: 'IN_PROGRESS',
        progress: { current: 1, target: 1 },
        unlockedAt: null,
        recognition: { status: null },
      })
    })
  })

  describe('el catalogo', () => {
    const base = definitionOf('ach_sin_rasgunos')
    const invalid = (values: Record<string, unknown>): AchievementDefinition => ({
      ...base,
      ...values,
    })

    it('los logros de ejemplo son validos y el catalogo aprobado sigue vacio (decision 1)', () => {
      expect(achievementCatalogProblem(EXAMPLE_ACHIEVEMENTS)).toBeNull()
      expect(achievementCatalogProblem(APPROVED_ACHIEVEMENTS)).toBeNull()
      expect(APPROVED_ACHIEVEMENTS).toEqual([])
      expect(EXAMPLE_ACHIEVEMENTS.map((definition) => definition.achievementId)).toEqual([
        'ach_historia_completa',
        'ach_desafio_completo',
        'ach_exploracion_completa',
        'ach_cazador_de_master',
        'ach_sin_rasgunos',
        'ach_templo_veloz',
        'ach_coleccionista',
      ])
      expect(() => {
        assertAchievementCatalog(EXAMPLE_ACHIEVEMENTS)
      }).not.toThrow()
    })

    it.each([
      ['un id con mayusculas', { achievementId: 'Ach_Mayus' }, 'INVALID_ID'],
      ['un id de mas de 64 caracteres', { achievementId: 'a'.repeat(65) }, 'INVALID_ID'],
      ['un id con dos puntos', { achievementId: 'ach:x' }, 'INVALID_ID'],
      ['una version 0', { version: 0 }, 'INVALID_VERSION'],
      ['una version decimal', { version: 1.5 }, 'INVALID_VERSION'],
      ['una version que no cabe en integer', { version: 2 ** 31 }, 'INVALID_VERSION'],
      ['un nombre en blanco', { name: '  ' }, 'INVALID_NAME'],
      [
        'un nombre que PostgreSQL no puede guardar',
        { name: 'Sin' + NUL + 'rasguño' },
        'INVALID_NAME',
      ],
      ['un criterio desconocido', { rule: { criterion: 'ALL_PVP_WINS' } }, 'UNKNOWN_CRITERION'],
      ['una regla que no es objeto', { rule: null }, 'UNKNOWN_CRITERION'],
      [
        'una categoria desconocida',
        { rule: { criterion: 'ALL_CATEGORY_MISSIONS', category: 'PVP' } },
        'INVALID_CATEGORY',
      ],
      ['un count 0', { rule: { criterion: 'FLAWLESS_MISSION', count: 0 } }, 'INVALID_COUNT'],
      [
        'un count decimal',
        { rule: { criterion: 'FLAWLESS_MISSION', count: 1.5 } },
        'INVALID_COUNT',
      ],
      [
        'un tiempo record sin mision',
        {
          rule: {
            criterion: 'RECORD_TIME',
            missionId: ' ',
            maxSimulatedDuration: null,
            difficulty: null,
          },
        },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'un umbral de 0 segundos',
        {
          rule: {
            criterion: 'RECORD_TIME',
            missionId: TEMPLO_ID,
            maxSimulatedDuration: 'PT0S',
            difficulty: null,
          },
        },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'un umbral que no es ISO-8601',
        {
          rule: {
            criterion: 'RECORD_TIME',
            missionId: TEMPLO_ID,
            maxSimulatedDuration: '9h',
            difficulty: null,
          },
        },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'una dificultad desconocida',
        {
          rule: {
            criterion: 'RECORD_TIME',
            missionId: TEMPLO_ID,
            maxSimulatedDuration: 'PT9H',
            difficulty: 'EASY',
          },
        },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'una dificultad omitida',
        { rule: { criterion: 'RECORD_TIME', missionId: TEMPLO_ID, maxSimulatedDuration: 'PT9H' } },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'un estado de epica desconocido',
        { rule: { criterion: 'ALL_MASTER_EPICS', epicState: 'LOST' } },
        'INVALID_EPIC_STATE',
      ],
      [
        'un reconocimiento desconocido',
        { recognition: { kind: 'EMOTE', name: 'Baile' } },
        'INVALID_RECOGNITION',
      ],
      [
        'un reconocimiento sin nombre',
        { recognition: { kind: 'TITLE', name: '' } },
        'INVALID_RECOGNITION',
      ],
      ['un reconocimiento que no es objeto', { recognition: 'TITLE' }, 'INVALID_RECOGNITION'],
      [
        'un producto que no es UUID',
        { recognition: { kind: 'COSMETIC_PRODUCT', name: 'Estandarte', productId: 'estandarte' } },
        'INVALID_RECOGNITION',
      ],
      [
        'un producto en mayusculas',
        {
          recognition: {
            kind: 'COSMETIC_PRODUCT',
            name: 'Estandarte',
            productId: '1111AAAA-1111-4111-8111-111111111111',
          },
        },
        'INVALID_RECOGNITION',
      ],
      [
        'un reconocimiento que PostgreSQL no puede guardar',
        { recognition: { kind: 'BADGE', name: 'Insignia' + NUL } },
        'INVALID_RECOGNITION',
      ],
      [
        'un tiempo record con una mision que PostgreSQL no puede guardar',
        {
          rule: {
            criterion: 'RECORD_TIME',
            missionId: 'msn' + NUL,
            maxSimulatedDuration: null,
            difficulty: null,
          },
        },
        'INVALID_RECORD_PARAMS',
      ],
      [
        'un cosmetico sin producto declarado',
        { recognition: { kind: 'COSMETIC_PRODUCT', name: 'Estandarte' } },
        'INVALID_RECOGNITION',
      ],
      [
        'una insignia con producto',
        { recognition: { kind: 'BADGE', name: 'Insignia', productId: null } },
        'INVALID_RECOGNITION',
      ],
    ])('rechaza %s', (_caso, values: Record<string, unknown>, reason) => {
      const definition = invalid(values)
      const achievementId =
        typeof values.achievementId === 'string' ? values.achievementId : base.achievementId

      let thrown: unknown = null

      try {
        assertAchievementCatalog([definition])
      } catch (error: unknown) {
        thrown = error
      }

      expect(achievementCatalogProblem([definition])).toEqual({ achievementId, reason })
      expect(thrown).toBeInstanceOf(InvalidAchievementCatalogError)
      expect(thrown).toMatchObject({ achievementId, reason })
    })

    it('rechaza un id repetido y una definicion que no es un objeto', () => {
      expect(achievementCatalogProblem([base, base])).toEqual({
        achievementId: 'ach_sin_rasgunos',
        reason: 'DUPLICATE_ID',
      })
      expect(achievementCatalogProblem([null as unknown as AchievementDefinition])).toEqual({
        achievementId: null,
        reason: 'INVALID_ID',
      })
      expect(achievementCatalogProblem([invalid({ achievementId: 7 })])).toEqual({
        achievementId: null,
        reason: 'INVALID_ID',
      })
    })

    it('admite un cosmetico con producto de Catalog y un tiempo record con dificultad', () => {
      expect(
        achievementCatalogProblem([
          invalid({
            recognition: {
              kind: 'COSMETIC_PRODUCT',
              name: 'Estandarte',
              productId: '11111111-1111-4111-8111-111111111111',
            },
          }),
          recordTime('PT9H', 'HEROIC'),
        ]),
      ).toBeNull()
    })

    it('el error dice que logro y por que', () => {
      const error = new InvalidAchievementCatalogError(null, 'INVALID_ID')

      expect(error).toMatchObject({ name: 'InvalidAchievementCatalogError', achievementId: null })
      expect(error.message).toContain('(sin id)')
    })
  })

  describe('la huella del catalogo y el contenido (retroactividad)', () => {
    const base = catalogFingerprintOf(CATALOG, CONTENT)

    it('es un UUID v5 que no cambia al reordenar el catalogo ni el contenido', () => {
      expect(base).toMatch(UUID_V5)
      expect(
        catalogFingerprintOf([...CATALOG].reverse(), {
          missionsByCategory: {
            STORY: [...CONTENT.missionsByCategory.STORY].reverse(),
            CHALLENGE: [],
            EXPLORATION: [],
          },
          availableMasters: [...CONTENT.availableMasters].reverse(),
          masterEpics: [...CONTENT.masterEpics].reverse(),
        }),
      ).toBe(base)
    })

    it('no cambia con nombres ni reconocimientos: no cambian quien cumple', () => {
      expect(
        catalogFingerprintOf(
          CATALOG.map((definition) => ({
            ...definition,
            name: `${definition.name} (renombrado)`,
            recognition: { kind: 'TITLE', name: 'Otro' } as const,
          })),
          CONTENT,
        ),
      ).toBe(base)
    })

    it.each([
      [
        'una regla',
        () =>
          catalogFingerprintOf(
            CATALOG.map((d) => (d.achievementId === 'ach_templo_veloz' ? recordTime('PT10H') : d)),
            CONTENT,
          ),
      ],
      [
        'la categoria de una regla',
        () =>
          catalogFingerprintOf(
            CATALOG.map((d): AchievementDefinition =>
              d.achievementId === 'ach_historia_completa'
                ? { ...d, rule: { criterion: 'ALL_CATEGORY_MISSIONS', category: 'EXPLORATION' } }
                : d,
            ),
            CONTENT,
          ),
      ],
      [
        'el count de una regla',
        () =>
          catalogFingerprintOf(
            CATALOG.map((d): AchievementDefinition =>
              d.achievementId === 'ach_sin_rasgunos'
                ? { ...d, rule: { criterion: 'FLAWLESS_MISSION', count: 2 } }
                : d,
            ),
            CONTENT,
          ),
      ],
      [
        'el estado de epica de una regla',
        () =>
          catalogFingerprintOf(
            CATALOG.map((d): AchievementDefinition =>
              d.achievementId === 'ach_coleccionista'
                ? { ...d, rule: { criterion: 'ALL_MASTER_EPICS', epicState: 'WON' } }
                : d,
            ),
            CONTENT,
          ),
      ],
      [
        'una version',
        () =>
          catalogFingerprintOf(
            CATALOG.map((d) => ({ ...d, version: 2 })),
            CONTENT,
          ),
      ],
      ['un logro menos', () => catalogFingerprintOf(CATALOG.slice(1), CONTENT)],
      // La Camara del ejemplo trae su propio Master: se quita para que cada caso
      // cambie solo lo que dice.
      [
        'una mision activa mas',
        () =>
          catalogFingerprintOf(
            CATALOG,
            achievementContentOf([
              ...MISSIONS,
              { ...CAMARA, missionId: 'msn_nueva', masterEncounter: null },
            ]),
          ),
      ],
      [
        'un Master menos',
        () =>
          catalogFingerprintOf(
            CATALOG,
            achievementContentOf([MISSIONS[0]!, { ...CAMARA, masterEncounter: null }]),
          ),
      ],
    ])('cambia con %s', (_caso, fingerprint) => {
      expect(fingerprint()).not.toBe(base)
    })
  })

  describe('la entrega del cosmetico', () => {
    const pendingUnlock = (): AchievementUnlock =>
      required(
        evaluate(
          evidenceOf([
            fact({ enrollmentId: 'enr_1', mastersDefeated: [SOMBRA], epicsCredited: [VELO] }),
            fact({
              enrollmentId: 'enr_2',
              missionId: CAMARA_ID,
              mastersDefeated: [CENTINELA],
              epicsCredited: [FURIA],
            }),
          ]),
        ).unlocks.find((unlock) => unlock.achievementId === 'ach_coleccionista'),
        'el cosmetico',
      )

    it('el operationId es un UUID v5 por jugador y logro, distinto del de la epica', () => {
      const operationId = achievementGrantOperationId(PLAYER, 'ach_coleccionista')

      expect(operationId).toMatch(UUID_V5)
      expect(achievementGrantOperationId(PLAYER, 'ach_coleccionista')).toBe(operationId)
      expect(achievementGrantOperationId('otro-jugador', 'ach_coleccionista')).not.toBe(operationId)
      expect(achievementGrantOperationId(PLAYER, 'ach_otro')).not.toBe(operationId)
      expect(epicGrantOperationId(PLAYER, 'ach_coleccionista', 1)).not.toBe(operationId)
    })

    it('se reintenta con el escalonado de HU-72 y el mismo operationId', () => {
      let unlock = pendingUnlock()
      const delays: number[] = []

      for (let attempt = 0; attempt < 5; attempt += 1) {
        unlock = recognitionDeferred(unlock, 'NETWORK', NOW)
        delays.push((unlock.grant?.nextAttemptAt?.getTime() ?? 0) - NOW.getTime())
      }

      expect(delays).toEqual([5_000, 30_000, 120_000, 600_000, 600_000])
      expect(unlock).toMatchObject({
        recognition: { status: 'PENDING' },
        grant: {
          operationId: achievementGrantOperationId(PLAYER, 'ach_coleccionista'),
          attempts: 5,
          lastError: 'NETWORK',
        },
      })
    })

    it('entregado o rechazado ya no esta pendiente', () => {
      const pending = { ...pendingUnlock(), grant: { ...pendingUnlock().grant!, productId: 'p-1' } }
      const credited = recognitionCredited(pending, NOW)
      const failed = recognitionFailed(pending, 'INVENTORY_REJECTED')

      expect(credited).toMatchObject({
        recognition: { status: 'CREDITED' },
        grant: {
          attempts: 1,
          nextAttemptAt: null,
          lastError: null,
          creditedAt: NOW,
          productId: 'p-1',
        },
      })
      expect(failed).toMatchObject({
        recognition: { status: 'FAILED' },
        grant: {
          attempts: 1,
          nextAttemptAt: null,
          lastError: 'INVENTORY_REJECTED',
          creditedAt: null,
        },
      })
      for (const done of [credited, failed]) {
        expect(() => recognitionDeferred(done, 'X', NOW)).toThrow(InvalidRecognitionTransitionError)
        expect(() => recognitionCredited(done, NOW)).toThrow(InvalidRecognitionTransitionError)
        expect(() => recognitionFailed(done, 'X')).toThrow(InvalidRecognitionTransitionError)
      }
    })

    it('un titulo o una insignia no tienen entrega', () => {
      const badge = required(
        evaluate(evidenceOf([fact({ enrollmentId: 'enr_badge', damageTaken: 0 })])).unlocks.find(
          (unlock) => unlock.achievementId === 'ach_sin_rasgunos',
        ),
        'la insignia',
      )

      expect(badge).toMatchObject({ recognition: { status: 'RECORDED' }, grant: null })
      expect(() => recognitionCredited(badge, NOW)).toThrow(
        /El reconocimiento de ach_sin_rasgunos para cognito-sub-jugador-demo ya no esta pendiente/,
      )
    })
  })
})
