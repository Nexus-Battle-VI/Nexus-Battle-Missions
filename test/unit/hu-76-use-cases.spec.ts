import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/example-achievements'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryAchievementEvidence } from '../../src/adapters/outbound/persistence/InMemoryAchievementEvidence'
import { InMemoryAchievementRepository } from '../../src/adapters/outbound/persistence/InMemoryAchievementRepository'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { AchievementCatalogPort } from '../../src/application/ports/AchievementCatalogPort'
import type { AchievementEvidencePort } from '../../src/application/ports/AchievementEvidencePort'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import type {
  EpicGrantOutcome,
  EpicGrantPort,
  EpicGrantRequest,
} from '../../src/application/ports/EpicGrantPort'
import type {
  HeroProfileOutcome,
  HeroProfilePort,
} from '../../src/application/ports/HeroAbilitiesPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  HeroCommitmentPort,
} from '../../src/application/ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import type { MissionCatalogPort } from '../../src/application/ports/MissionCatalogPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { EvaluateMissionAchievements } from '../../src/application/use-cases/EvaluateMissionAchievements'
import { GetMissionAchievements } from '../../src/application/use-cases/GetMissionAchievements'
import { GrantAchievementRecognitions } from '../../src/application/use-cases/GrantAchievementRecognitions'
import { GrantMasterEpics } from '../../src/application/use-cases/GrantMasterEpics'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import type {
  AchievementDefinition,
  AchievementUnlock,
} from '../../src/domain/entities/Achievement'
import type {
  MasterEncounter,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import type { CombatOutcome, SimulationRequest } from '../../src/domain/entities/MissionExecution'
import { achievementGrantOperationId } from '../../src/domain/policies/AchievementPolicy'
import * as ReportPolicy from '../../src/domain/policies/ReportPolicy'

const AT = new Date('2026-10-01T15:00:00.000Z')
const PLAYER = 'sub-1'
const OTHER = 'sub-2'
const HEROES: Readonly<Record<string, string>> = {
  [PLAYER]: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
  [OTHER]: '8a4d3b0f-3e5c-4d2b-8f80-2c3d4e5f6071',
}
const TEMPLO_ID = 'msn_templo_olvidado'
const CAMARA_ID = 'msn_camara_sellada'
const SOMBRA = 'sombra-del-olvido'
const CENTINELA = 'centinela-carmesi'
const VELO = 'velo-de-sombras'
const FURIA = 'furia-carmesi'
const VELO_PRODUCT = '11111111-1111-4111-8111-111111111111'
const FURIA_PRODUCT = '22222222-2222-4222-8222-222222222222'
/** El producto de Catalog del estandarte; en el contrato todavia no existe. */
const BANNER = '33333333-3333-4333-8333-333333333333'
const OTHER_BANNER = '44444444-4444-4444-8444-444444444444'
const COLLECTOR_OPERATION = achievementGrantOperationId(PLAYER, 'ach_coleccionista')

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

const [TEMPLO_BASE, CAMARA_BASE] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const BASE_CANDIDATE = required(TEMPLO_BASE.masterEncounter?.candidates[0], 'el Master del Templo')

/** Un Master que siempre aparece en ese punto: el doble de Combat lo saca y el heroe lo derrota. */
const masterAt = (
  afterEncounter: number,
  masterRef: string,
  epicRef: string,
  productId: string,
): MasterEncounter => ({
  evaluationPoints: [{ afterEncounter }],
  maxAppearances: 1,
  candidates: [
    {
      ...BASE_CANDIDATE,
      masterRef,
      name: masterRef,
      probabilityByHeroType: { '*': 1 },
      epic: { ...BASE_CANDIDATE.epic, epicRef, name: epicRef, productId },
    },
  ],
})

/**
 * Los dos Master y las dos epicas de los fixtures del contrato. El ejemplo no se
 * toca: la Camara de la prueba no tiene requisito previo y lleva tres
 * encuentros, con su Master tras el primero.
 */
const TEMPLO: MissionDefinition = {
  ...TEMPLO_BASE,
  masterEncounter: masterAt(3, SOMBRA, VELO, VELO_PRODUCT),
}
const CAMARA: MissionDefinition = {
  ...CAMARA_BASE,
  prerequisites: [],
  encounters: [
    {
      index: 1,
      kind: 'REGULAR',
      powerStep: null,
      enemies: [{ enemyRef: 'guardia-del-sello', count: 2 }],
    },
    {
      index: 2,
      kind: 'REGULAR',
      powerStep: null,
      enemies: [{ enemyRef: 'guardia-del-sello', count: 2 }],
    },
    {
      index: 3,
      kind: 'BOSS',
      powerStep: null,
      enemies: [{ enemyRef: 'custodio-del-sello', count: 1 }],
    },
  ],
  masterEncounter: masterAt(1, CENTINELA, FURIA, FURIA_PRODUCT),
}

/** El catalogo del contrato con el umbral de L-4 y el estandarte como producto de Catalog. */
const catalogWith = (banner: string | null): readonly AchievementDefinition[] =>
  EXAMPLE_ACHIEVEMENTS.map((definition): AchievementDefinition => {
    switch (definition.achievementId) {
      case 'ach_templo_veloz':
        return {
          ...definition,
          rule: {
            criterion: 'RECORD_TIME',
            missionId: TEMPLO_ID,
            maxSimulatedDuration: 'PT9H',
            difficulty: null,
          },
        }
      case 'ach_coleccionista':
        return {
          ...definition,
          recognition: { kind: 'COSMETIC_PRODUCT', name: definition.name, productId: banner },
        }
      default:
        return definition
    }
  })

const CATALOG = catalogWith(BANNER)

/** Catalogo de misiones que la prueba puede cambiar; solo lista las activas, como PostgreSQL. */
class Catalog implements MissionCatalogPort {
  constructor(public definitions: readonly MissionDefinition[]) {}

  listActive(): Promise<readonly MissionDefinition[]> {
    return Promise.resolve(this.definitions.filter((definition) => definition.active))
  }

  findActive(missionId: string): Promise<MissionDefinition | null> {
    return Promise.resolve(
      this.definitions.find(
        (definition) => definition.missionId === missionId && definition.active,
      ) ?? null,
    )
  }

  findById(missionId: string): Promise<MissionDefinition | null> {
    return Promise.resolve(
      this.definitions.find((definition) => definition.missionId === missionId) ?? null,
    )
  }
}

/** Catalogo de logros que la prueba puede cambiar (cargarlo, vaciarlo o cambiar un logro). */
class Achievements implements AchievementCatalogPort {
  constructor(public definitions: readonly AchievementDefinition[]) {}

  list(): Promise<readonly AchievementDefinition[]> {
    return Promise.resolve(this.definitions)
  }
}

class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}

class SequenceIds implements IdGeneratorPort {
  private enrollments = 0
  private operations = 0
  newEnrollmentId(): string {
    this.enrollments += 1
    return `enr_${String(this.enrollments)}`
  }
  newOperationId(): string {
    this.operations += 1
    return `op-${String(this.operations)}`
  }
}

class Commitments implements HeroCommitmentPort {
  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    return Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` })
  }

  release(): Promise<'RELEASED' | 'UNKNOWN'> {
    return Promise.resolve('RELEASED')
  }
}

class Profiles implements HeroProfilePort {
  profileOf(_playerId: string, heroId: string): Promise<HeroProfileOutcome> {
    return Promise.resolve({ kind: 'FOUND', profile: { heroId, subtype: 'GUERRERO_ARMAS' } })
  }
}

/** Cambios al resumen del doble de Combat para la proxima simulacion. */
type SummaryChange = Readonly<Record<string, unknown>> & {
  readonly combatOutcome?: CombatOutcome
}

/**
 * El doble de Combat con el resumen que la prueba cambia (dano, duracion,
 * encuentros o desenlace). Conserva el bloque del Master del doble: si no
 * cuadrara con los encuentros, la mision se anularia (HU-73).
 */
class Combat implements CombatSimulationPort {
  readonly changes: SummaryChange[] = []
  private readonly double = new ScriptedCombatSimulation()

  async simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    const outcome = await this.double.simulate(request)
    const change = this.changes.shift()

    if (outcome.kind !== 'SIMULATED' || change === undefined) {
      return outcome
    }

    const { combatOutcome, ...summary } = change

    return {
      kind: 'SIMULATED',
      result: {
        ...outcome.result,
        combatOutcome: combatOutcome ?? outcome.result.combatOutcome,
        summary: { ...outcome.result.summary, ...summary },
      },
    }
  }
}

/** Player/Inventory: el doble idempotente, salvo las respuestas que la prueba encole. */
class Grants implements EpicGrantPort {
  readonly calls: EpicGrantRequest[] = []
  readonly answers: EpicGrantOutcome[] = []
  readonly double = new InMemoryEpicGrants()

  grant(request: EpicGrantRequest): Promise<EpicGrantOutcome> {
    this.calls.push(request)
    const answer = this.answers.shift()

    return answer === undefined ? this.double.grant(request) : Promise.resolve(answer)
  }
}

const evaluation = (counts: Partial<Record<string, number>> = {}) => ({
  achievementPlayersEvaluated: 0,
  achievementsUnlocked: 0,
  achievementEvaluationsFailed: 0,
  ...counts,
})

const recognition = (counts: Partial<Record<string, number>> = {}) => ({
  recognitionsCredited: 0,
  recognitionsRetried: 0,
  recognitionsWaiting: 0,
  recognitionsRejected: 0,
  recognitionsFailed: 0,
  ...counts,
})

/** El resto del ciclo del planificador, sin cambios: epicas, logros y cosmeticos. */
const NOTHING = {
  epicsGranted: 0,
  epicsRetried: 0,
  epicsWaiting: 0,
  epicsRejected: 0,
  epicsFailed: 0,
  ...evaluation(),
  ...recognition(),
}

const setup = (definitions: readonly AchievementDefinition[] = CATALOG) => {
  const catalog = new Catalog([TEMPLO, CAMARA])
  const achievementCatalog = new Achievements(definitions)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const reports = new InMemoryReportRepository()
  const masters = new InMemoryMasterEncounterRepository(reports)
  const achievements = new InMemoryAchievementRepository(enrollments, masters)
  const evidence = new InMemoryAchievementEvidence(enrollments, reports, masters)
  const combat = new Combat()
  const commitments = new Commitments()
  const epicGrants = new Grants()
  const recognitionGrants = new Grants()
  const clock = new MovableClock()
  const ids = new SequenceIds()
  const errors: unknown[] = []
  const onError = (error: unknown) => {
    errors.push(error)
  }
  const executor = new RunMissionExecutions(
    new InMemoryExecutionRepository(enrollments, clears, reports, masters),
    enrollments,
    catalog,
    new Profiles(),
    combat,
    commitments,
    ids,
    clock,
    { batchSize: 50 },
  )
  const epics = new GrantMasterEpics(masters, enrollments, catalog, epicGrants, clock, {
    batchSize: 50,
  })
  const evaluatorWith = (source: AchievementEvidencePort = evidence) =>
    new EvaluateMissionAchievements(
      achievementCatalog,
      achievements,
      source,
      clears,
      catalog,
      clock,
      {
        batchSize: 50,
        onError,
      },
    )
  const evaluator = evaluatorWith()
  const recognitions = new GrantAchievementRecognitions(
    achievements,
    achievementCatalog,
    recognitionGrants,
    clock,
    { batchSize: 50, onError },
  )
  const query = new GetMissionAchievements(
    achievementCatalog,
    achievements,
    evidence,
    clears,
    catalog,
  )
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    new InMemoryStrategyRepository(),
    commitments,
    ids,
    clock,
  )
  let keys = 0

  /** Se matricula, simula (con el cambio al resumen, si lo hay), avanza hasta el fin y cierra. */
  const play = async (
    missionId: string,
    change: SummaryChange | null = null,
    playerId = PLAYER,
  ): Promise<string> => {
    keys += 1

    if (change !== null) {
      combat.changes.push(change)
    }

    const enrolled = await enroll.execute({
      playerId,
      missionId,
      heroId: required(HEROES[playerId], 'el heroe'),
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: `key-${String(keys)}`,
    })
    await executor.run()
    clock.current = new Date(enrolled.endsAt ?? clock.current)
    await executor.run()

    return enrolled.enrollmentId
  }

  /** Lo que sigue al cierre en el ciclo del planificador, en su orden. */
  const cycle = async () => ({
    ...(await epics.run()),
    ...(await evaluator.run()),
    ...(await recognitions.run()),
  })

  const view = async (achievementId: string, playerId = PLAYER) =>
    required(
      (await query.execute(playerId)).items.find((item) => item.achievementId === achievementId),
      achievementId,
    )

  const unlockOf = async (achievementId: string, playerId = PLAYER): Promise<AchievementUnlock> =>
    required(
      (await achievements.unlocksOf(playerId)).find(
        (unlock) => unlock.achievementId === achievementId,
      ),
      achievementId,
    )

  return {
    catalog,
    achievementCatalog,
    enrollments,
    achievements,
    evidence,
    epicGrants,
    recognitionGrants,
    clock,
    errors,
    epics,
    evaluator,
    evaluatorWith,
    recognitions,
    query,
    play,
    cycle,
    view,
    unlockOf,
  }
}

describe('Evaluacion y entrega de logros (Task HU-76.2)', () => {
  it('P-01 · CA-01 y CA-02 (L-1): sin dano, la insignia queda registrada y visible, sin entregas', async () => {
    const { play, cycle, view, unlockOf, recognitionGrants, clock } = setup()
    const enrollmentId = await play(TEMPLO_ID)

    // La consulta nunca desbloquea: el criterio cumplido se ve en curso hasta evaluar.
    await expect(view('ach_sin_rasgunos')).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      progress: { current: 1, target: 1 },
      unlockedAt: null,
    })

    await expect(cycle()).resolves.toEqual({
      ...NOTHING,
      epicsGranted: 1,
      achievementPlayersEvaluated: 1,
      achievementsUnlocked: 1,
    })
    await expect(view('ach_sin_rasgunos')).resolves.toEqual({
      achievementId: 'ach_sin_rasgunos',
      name: 'Sin un rasguño',
      criterion: 'FLAWLESS_MISSION',
      status: 'UNLOCKED',
      progress: { current: 1, target: 1 },
      unlockedAt: clock.current.toISOString(),
      recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
    })
    await expect(unlockOf('ach_sin_rasgunos')).resolves.toMatchObject({
      proof: { refs: [TEMPLO_ID], enrollmentIds: [enrollmentId] },
      grant: null,
    })
    // Un titulo o una insignia no pasan por Player/Inventory.
    expect(recognitionGrants.calls).toEqual([])
  })

  it.each([
    ['con un punto de dano', { damageTaken: 1 }, 'COMPLETED'],
    ['sin el dano en el resumen de Combat', { damageTaken: undefined }, 'COMPLETED'],
    [
      'fallida por tiempo, aunque sin dano',
      { combatOutcome: 'TIME_BUDGET_EXHAUSTED', encountersCompleted: 4, bossDefeated: false },
      'FAILED',
    ],
  ] as const)('P-02 · CA-02: no se otorga %s', async (_caso, change, status) => {
    const { play, cycle, view, enrollments } = setup()
    const enrollmentId = await play(TEMPLO_ID, change)

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status })
    await cycle()
    await expect(view('ach_sin_rasgunos')).resolves.toMatchObject({
      status: 'LOCKED',
      progress: { current: 0, target: 1 },
    })
  })

  it('una mision sin reporte cuenta para la historia, pero no prueba que no hubo dano', async () => {
    const { play, cycle, view } = setup()
    const broken = jest.spyOn(ReportPolicy, 'missionReportOf').mockImplementation(() => {
      throw new Error('foto rota')
    })

    try {
      await play(TEMPLO_ID)
      await play(CAMARA_ID)
    } finally {
      broken.mockRestore()
    }

    await cycle()
    await expect(view('ach_historia_completa')).resolves.toMatchObject({
      status: 'UNLOCKED',
      progress: { current: 2, target: 2 },
    })
    await expect(view('ach_sin_rasgunos')).resolves.toMatchObject({ status: 'LOCKED' })
  })

  it('L-4: una mision dentro del umbral de tiempo record lo otorga', async () => {
    const { play, cycle, view } = setup()

    await play(TEMPLO_ID, { simulatedDuration: 'PT9H0M1S' })
    await cycle()
    await expect(view('ach_templo_veloz')).resolves.toMatchObject({ status: 'LOCKED' })

    await play(TEMPLO_ID, { simulatedDuration: 'PT8H55M', damageTaken: 120 })
    await cycle()
    await expect(view('ach_templo_veloz')).resolves.toMatchObject({
      status: 'UNLOCKED',
      progress: { current: 1, target: 1 },
    })
  })

  it('P-03 · CA-03 (L-5): con uno de dos Master no hay desbloqueo ni fila', async () => {
    const { play, cycle, view, achievements } = setup()

    await play(TEMPLO_ID)
    await cycle()

    await expect(view('ach_cazador_de_master')).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      progress: { current: 1, target: 2 },
      unlockedAt: null,
      recognition: { status: null },
    })
    expect((await achievements.unlocksOf(PLAYER)).map((unlock) => unlock.achievementId)).toEqual([
      'ach_sin_rasgunos',
    ])
  })

  it('L-6 · CA-02: el Master derrotado en una mision fallida completa el cazador', async () => {
    const { play, cycle, view, enrollments } = setup()

    await play(TEMPLO_ID)
    await cycle()
    const failed = await play(CAMARA_ID, {
      combatOutcome: 'HERO_DEFEATED',
      damageTaken: 900,
      encountersCompleted: 2,
      bossDefeated: false,
      minHealthPercent: 0,
    })

    await expect(enrollments.findById(failed)).resolves.toMatchObject({ status: 'FAILED' })
    await cycle()
    await expect(view('ach_cazador_de_master')).resolves.toMatchObject({
      status: 'UNLOCKED',
      progress: { current: 2, target: 2 },
    })
  })

  it('L-7: la epica acreditada tarde completa la coleccion sin otra mision y el cosmetico se entrega una vez', async () => {
    const { play, cycle, view, unlockOf, epicGrants, recognitionGrants, clock } = setup()

    await play(TEMPLO_ID)
    await cycle()
    epicGrants.answers.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await play(CAMARA_ID)

    // La epica de la Camara no llega en el ciclo del cierre: la coleccion sigue a medias.
    await expect(cycle()).resolves.toEqual({
      ...NOTHING,
      epicsRetried: 1,
      achievementPlayersEvaluated: 1,
      achievementsUnlocked: 2,
    })
    await expect(view('ach_coleccionista')).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      progress: { current: 1, target: 2 },
    })

    // Cinco segundos despues llega; eso solo, sin un MissionSettled nuevo, dispara la evaluacion.
    clock.advance(5_000)
    await expect(cycle()).resolves.toEqual({
      ...NOTHING,
      epicsGranted: 1,
      achievementPlayersEvaluated: 1,
      achievementsUnlocked: 1,
      recognitionsCredited: 1,
    })
    expect(recognitionGrants.calls).toEqual([
      { operationId: COLLECTOR_OPERATION, playerId: PLAYER, productId: BANNER },
    ])
    await expect(view('ach_coleccionista')).resolves.toMatchObject({
      status: 'UNLOCKED',
      progress: { current: 2, target: 2 },
      recognition: {
        kind: 'COSMETIC_PRODUCT',
        name: 'Estandarte del Coleccionista',
        status: 'CREDITED',
      },
    })
    await expect(unlockOf('ach_coleccionista')).resolves.toMatchObject({
      proof: { refs: [FURIA, VELO], enrollmentIds: ['enr_1', 'enr_2'] },
      grant: { operationId: COLLECTOR_OPERATION, productId: BANNER, creditedAt: clock.current },
    })

    // Otro ciclo no cambia nada.
    await expect(cycle()).resolves.toEqual(NOTHING)
    expect(recognitionGrants.calls).toHaveLength(1)
  })

  it('una epica rechazada no cuenta nunca para la coleccion', async () => {
    const { play, cycle, view, epicGrants, clock } = setup()

    await play(TEMPLO_ID)
    await cycle()
    epicGrants.answers.push({ kind: 'REJECTED', reason: 'INVENTORY_REJECTED' })
    await play(CAMARA_ID)
    await expect(cycle()).resolves.toMatchObject({ epicsRejected: 1 })

    clock.advance(3_600_000)
    await cycle()
    await expect(view('ach_coleccionista')).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      progress: { current: 1, target: 2 },
    })
  })

  describe('P-04: la categoria y el catalogo vigentes', () => {
    it('L-8: la historia a medias; retirar la Camara la completa sin jugar otra mision', async () => {
      const { play, cycle, view, catalog } = setup()

      await play(TEMPLO_ID)
      await cycle()
      await expect(view('ach_historia_completa')).resolves.toMatchObject({
        status: 'IN_PROGRESS',
        progress: { current: 1, target: 2 },
      })

      // Cambia la huella: se reevalua y lo que ya se cumplia se otorga.
      catalog.definitions = [TEMPLO, { ...CAMARA, active: false }]
      await expect(cycle()).resolves.toEqual({
        ...NOTHING,
        achievementPlayersEvaluated: 1,
        achievementsUnlocked: 3,
        recognitionsCredited: 1,
      })
      await expect(view('ach_historia_completa')).resolves.toMatchObject({
        status: 'UNLOCKED',
        progress: { current: 1, target: 1 },
      })
    })

    it('sin catalogo no se evalua ni se consulta nada; al cargarlo, se otorga lo que ya se cumplia', async () => {
      const { play, evaluator, achievementCatalog, achievements, catalog, query, view } = setup([])

      await play(TEMPLO_ID)
      const players = jest.spyOn(achievements, 'playersToEvaluate')
      const missions = jest.spyOn(catalog, 'listActive')

      await expect(evaluator.run()).resolves.toEqual(evaluation())
      expect(players).not.toHaveBeenCalled()
      expect(missions).not.toHaveBeenCalled()
      await expect(query.execute(PLAYER)).resolves.toEqual({ items: [] })

      achievementCatalog.definitions = CATALOG
      await expect(evaluator.run()).resolves.toEqual(
        evaluation({ achievementPlayersEvaluated: 1, achievementsUnlocked: 1 }),
      )
      await expect(view('ach_sin_rasgunos')).resolves.toMatchObject({ status: 'UNLOCKED' })
    })
  })

  it('P-05 (L-9): el mismo hecho otra vez, otro ciclo o la huella forzada no duplican nada', async () => {
    const {
      play,
      cycle,
      enrollments,
      evaluator,
      recognitions,
      achievementCatalog,
      recognitionGrants,
      achievements,
    } = setup()

    await play(TEMPLO_ID)
    await cycle()
    const enrollmentId = await play(CAMARA_ID)
    await expect(cycle()).resolves.toMatchObject({
      achievementsUnlocked: 3,
      recognitionsCredited: 1,
    })
    const unlocked = await achievements.unlocksOf(PLAYER)

    // Dos ciclos seguidos: el segundo no evalua a nadie.
    await expect(cycle()).resolves.toEqual(NOTHING)

    // El mismo hecho otra vez: el doble, como el motor, no lo duplica.
    const current = required(enrollments.current(enrollmentId), 'la matricula')
    const settled = required(
      enrollments
        .recordedFacts()
        .find((fact) => fact.type === 'MissionSettled' && fact.enrollmentId === enrollmentId),
      'el hecho',
    )
    expect(enrollments.applyTransition(current, current.version, settled)).toBe(true)
    await expect(evaluator.run()).resolves.toEqual(evaluation())

    // Forzar la huella reevalua al jugador sin desbloqueos ni entregas nuevas.
    achievementCatalog.definitions = CATALOG.map((definition) =>
      definition.achievementId === 'ach_sin_rasgunos' ? { ...definition, version: 2 } : definition,
    )
    await expect(evaluator.run()).resolves.toEqual(evaluation({ achievementPlayersEvaluated: 1 }))
    await expect(recognitions.run()).resolves.toEqual(recognition())
    await expect(achievements.unlocksOf(PLAYER)).resolves.toEqual(unlocked)
    expect(recognitionGrants.calls).toHaveLength(1)
    expect(recognitionGrants.double.granted()).toHaveLength(1)
  })

  it('una mision anulada cuenta como hecho, pero no aporta evidencia', async () => {
    const { play, enrollments, evaluator, achievements, query } = setup()
    const enrollmentId = await play(TEMPLO_ID, { encountersCompleted: 9 })

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'VOIDED' })
    await expect(evaluator.run()).resolves.toEqual(evaluation({ achievementPlayersEvaluated: 1 }))
    expect(achievements.evaluationOf(PLAYER)).toMatchObject({
      settledSeen: 1,
      epicsGrantedSeen: 0,
      attempts: 0,
    })
    // Queda al dia: no se vuelve a leer.
    await expect(evaluator.run()).resolves.toEqual(evaluation())
    expect((await query.execute(PLAYER)).items.map((item) => item.status)).toEqual(
      Array.from({ length: CATALOG.length }, () => 'LOCKED'),
    )
  })

  describe('fallos de la evaluacion', () => {
    it('si la evidencia de un jugador falla, los demas siguen y el se aplaza con el escalonado', async () => {
      const { play, achievements, evidence, evaluatorWith, clock, errors } = setup()

      await play(TEMPLO_ID, null, PLAYER)
      await play(TEMPLO_ID, null, OTHER)
      let failures = 1
      const flaky: AchievementEvidencePort = {
        completedReportsOf: (playerId) => {
          if (playerId === PLAYER && failures > 0) {
            failures -= 1
            return Promise.reject(new Error('base caida'))
          }

          return evidence.completedReportsOf(playerId)
        },
        defeatedMastersOf: (playerId) => evidence.defeatedMastersOf(playerId),
      }
      const evaluator = evaluatorWith(flaky)

      await expect(evaluator.run()).resolves.toEqual(
        evaluation({
          achievementPlayersEvaluated: 1,
          achievementsUnlocked: 1,
          achievementEvaluationsFailed: 1,
        }),
      )
      expect(errors).toEqual([new Error('base caida')])
      expect(achievements.evaluationOf(PLAYER)).toEqual({
        settledSeen: 0,
        epicsGrantedSeen: 0,
        fingerprint: null,
        evaluatedAt: null,
        attempts: 1,
        nextAttemptAt: new Date(clock.current.getTime() + 5_000),
        lastError: 'INTERNAL_ERROR',
      })

      // Aun no toca: el primer reintento espera 5 s.
      await expect(evaluator.run()).resolves.toEqual(evaluation())

      clock.advance(5_000)
      await expect(evaluator.run()).resolves.toEqual(
        evaluation({ achievementPlayersEvaluated: 1, achievementsUnlocked: 1 }),
      )
      expect(achievements.evaluationOf(PLAYER)).toMatchObject({
        settledSeen: 1,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      })
    })

    it('si ni siquiera se puede aplazar, el ciclo sigue y lo reintenta el siguiente', async () => {
      const { play, achievements, evaluator, errors } = setup()

      await play(TEMPLO_ID)
      jest.spyOn(achievements, 'unlocksOf').mockRejectedValueOnce(new Error('base caida'))
      jest.spyOn(achievements, 'deferEvaluation').mockRejectedValueOnce(new Error('sigue caida'))

      await expect(evaluator.run()).resolves.toEqual(
        evaluation({ achievementEvaluationsFailed: 1 }),
      )
      expect(errors).toEqual([new Error('base caida')])
      expect(achievements.evaluationOf(PLAYER)).toBeNull()
      await expect(evaluator.run()).resolves.toEqual(
        evaluation({ achievementPlayersEvaluated: 1, achievementsUnlocked: 1 }),
      )
    })
  })

  describe('el cosmetico (CU-76.2)', () => {
    /** La coleccion completa: las dos misiones jugadas y sus epicas entregadas. */
    const collected = async (definitions: readonly AchievementDefinition[] = CATALOG) => {
      const context = setup(definitions)

      await context.play(TEMPLO_ID)
      await context.epics.run()
      await context.play(CAMARA_ID)
      await context.epics.run()
      await context.evaluator.run()

      return context
    }

    it('sin producto de Catalog espera, sin llamar a Player/Inventory', async () => {
      const { recognitions, recognitionGrants, unlockOf, view, clock } = await collected(
        catalogWith(null),
      )

      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsWaiting: 1 }))
      expect(recognitionGrants.calls).toEqual([])
      await expect(unlockOf('ach_coleccionista')).resolves.toMatchObject({
        recognition: { status: 'PENDING' },
        grant: {
          attempts: 1,
          nextAttemptAt: new Date(clock.current.getTime() + 5_000),
          lastError: 'RECOGNITION_PRODUCT_MISSING',
          productId: null,
        },
      })
      await expect(view('ach_coleccionista')).resolves.toMatchObject({
        status: 'UNLOCKED',
        recognition: { status: 'PENDING' },
      })
    })

    it('con producto, lo congela y lo entrega una sola vez (CA-01)', async () => {
      const { recognitions, recognitionGrants, unlockOf, clock } = await collected()

      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsCredited: 1 }))
      expect(recognitionGrants.calls).toEqual([
        { operationId: COLLECTOR_OPERATION, playerId: PLAYER, productId: BANNER },
      ])
      await expect(unlockOf('ach_coleccionista')).resolves.toMatchObject({
        recognition: { status: 'CREDITED' },
        grant: {
          operationId: COLLECTOR_OPERATION,
          attempts: 1,
          nextAttemptAt: null,
          lastError: null,
          productId: BANNER,
          creditedAt: clock.current,
        },
      })
      await expect(recognitions.run()).resolves.toEqual(recognition())
      expect(recognitionGrants.double.granted()).toHaveLength(1)
    })

    it('un rechazo definitivo queda FAILED, visible y sin reintento', async () => {
      const { recognitions, recognitionGrants, view, clock } = await collected()

      recognitionGrants.answers.push({ kind: 'REJECTED', reason: 'INVENTORY_REJECTED' })
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsRejected: 1 }))
      await expect(view('ach_coleccionista')).resolves.toMatchObject({
        status: 'UNLOCKED',
        recognition: { status: 'FAILED' },
      })

      clock.advance(3_600_000)
      await expect(recognitions.run()).resolves.toEqual(recognition())
      expect(recognitionGrants.calls).toHaveLength(1)
    })

    it('sin respuesta, reintenta con el mismo operationId y el producto congelado', async () => {
      const { recognitions, recognitionGrants, achievementCatalog, unlockOf, clock } =
        await collected()

      recognitionGrants.answers.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsRetried: 1 }))
      await expect(unlockOf('ach_coleccionista')).resolves.toMatchObject({
        recognition: { status: 'PENDING' },
        grant: { attempts: 1, lastError: 'HTTP_503', productId: BANNER },
      })

      // Catalog cambia el producto: la entrega ya salio con el primero y no cambia.
      achievementCatalog.definitions = catalogWith(OTHER_BANNER)
      await expect(recognitions.run()).resolves.toEqual(recognition())
      clock.advance(5_000)
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsCredited: 1 }))
      expect(recognitionGrants.calls).toEqual([
        { operationId: COLLECTOR_OPERATION, playerId: PLAYER, productId: BANNER },
        { operationId: COLLECTOR_OPERATION, playerId: PLAYER, productId: BANNER },
      ])
    })

    it('si el logro sale del catalogo o deja de ser un cosmetico, espera sin producto', async () => {
      const { recognitions, recognitionGrants, achievementCatalog, clock } = await collected()

      achievementCatalog.definitions = CATALOG.filter(
        (definition) => definition.achievementId !== 'ach_coleccionista',
      )
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsWaiting: 1 }))

      achievementCatalog.definitions = CATALOG.map((definition) =>
        definition.achievementId === 'ach_coleccionista'
          ? { ...definition, recognition: { kind: 'TITLE', name: 'Coleccionista' } as const }
          : definition,
      )
      clock.advance(5_000)
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsWaiting: 1 }))
      expect(recognitionGrants.calls).toEqual([])
    })

    it('si otro proceso congelo el producto antes, no se envia', async () => {
      const { recognitions, recognitionGrants, achievements } = await collected()

      jest.spyOn(achievements, 'freezeRecognitionProduct').mockResolvedValueOnce(false)
      await expect(recognitions.run()).resolves.toEqual(recognition())
      expect(recognitionGrants.calls).toEqual([])
    })

    it.each([
      ['entregado', { kind: 'GRANTED' }, BANNER],
      ['rechazado', { kind: 'REJECTED', reason: 'INVENTORY_REJECTED' }, BANNER],
      ['sin respuesta', { kind: 'UNKNOWN', reason: 'HTTP_503' }, BANNER],
      ['sin producto', null, null],
    ] as const)('si otro proceso guardo antes (%s), no cuenta', async (_caso, answer, banner) => {
      const { recognitions, recognitionGrants, achievements } = await collected(catalogWith(banner))

      if (answer !== null) {
        recognitionGrants.answers.push(answer)
      }
      jest.spyOn(achievements, 'saveRecognitionGrant').mockResolvedValue(false)

      await expect(recognitions.run()).resolves.toEqual(recognition())
    })

    it('un fallo interno se cuenta, se informa y aplaza la entrega', async () => {
      const { recognitions, recognitionGrants, unlockOf, errors, clock } = await collected()

      jest.spyOn(recognitionGrants, 'grant').mockRejectedValueOnce(new Error('socket colgado'))
      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsFailed: 1 }))
      expect(errors).toEqual([new Error('socket colgado')])
      await expect(unlockOf('ach_coleccionista')).resolves.toMatchObject({
        recognition: { status: 'PENDING' },
        grant: {
          attempts: 1,
          lastError: 'INTERNAL_ERROR',
          nextAttemptAt: new Date(clock.current.getTime() + 5_000),
          productId: BANNER,
        },
      })
    })

    it('si ni siquiera se puede aplazar, el ciclo sigue', async () => {
      const { recognitions, recognitionGrants, achievements } = await collected()

      jest.spyOn(recognitionGrants, 'grant').mockRejectedValueOnce(new Error('socket colgado'))
      jest
        .spyOn(achievements, 'saveRecognitionGrant')
        .mockRejectedValueOnce(new Error('base caida'))

      await expect(recognitions.run()).resolves.toEqual(recognition({ recognitionsFailed: 1 }))
    })

    it('una fila que no es un cosmetico pendiente no se toca', async () => {
      const { recognitions, recognitionGrants, achievements, unlockOf } = await collected()

      await recognitions.run()
      const badge = await unlockOf('ach_sin_rasgunos')
      const credited = await unlockOf('ach_coleccionista')
      jest.spyOn(achievements, 'pendingRecognitionGrants').mockResolvedValueOnce([badge, credited])

      await expect(recognitions.run()).resolves.toEqual(recognition())
      expect(recognitionGrants.calls).toHaveLength(1)
    })
  })
})
