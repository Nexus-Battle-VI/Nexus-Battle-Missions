import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import type { EnrollmentRepositoryPort } from '../../src/application/ports/EnrollmentRepositoryPort'
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
import type { MasterEncounterRepositoryPort } from '../../src/application/ports/MasterEncounterRepositoryPort'
import type { MissionCatalogPort } from '../../src/application/ports/MissionCatalogPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { GetMissionDetail } from '../../src/application/use-cases/GetMissionDetail'
import { GetMissionHistorySummary } from '../../src/application/use-cases/GetMissionHistorySummary'
import { GetMissionReport } from '../../src/application/use-cases/GetMissionReport'
import { GrantMasterEpics } from '../../src/application/use-cases/GrantMasterEpics'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import type { MasterEncounterRecord } from '../../src/domain/entities/MasterEncounterRecord'
import type {
  MasterCandidate,
  MasterEncounter,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import type {
  SimulationRequest,
  SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import { epicGrantOperationId } from '../../src/domain/policies/MasterPolicy'

const AT = new Date('2026-10-01T15:00:00.000Z')
const TEMPLO = EXAMPLE_MISSIONS[0]!
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const MASTER = 'sombra-del-olvido'
const EPIC = 'velo-de-sombras'
const PRODUCT = '11111111-1111-4111-8111-111111111111'

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

const BASE = required(TEMPLO.masterEncounter, 'el Master del Templo')
const CANDIDATE = required(BASE.candidates[0], 'el candidato del Templo')

/**
 * El Templo con su Master cambiado. Por defecto aparece siempre (probabilidad 1:
 * el doble de Combat lo saca y el heroe lo derrota) y la epica ya es un producto.
 */
const templo = (
  candidate: Partial<MasterCandidate> = {},
  master: Partial<MasterEncounter> = {},
): MissionDefinition => ({
  ...TEMPLO,
  masterEncounter: {
    ...BASE,
    candidates: [
      {
        ...CANDIDATE,
        probabilityByHeroType: { '*': 1 },
        ...candidate,
        epic: { ...CANDIDATE.epic, productId: PRODUCT, ...candidate.epic },
      },
    ],
    ...master,
  },
})

/** Catalogo que la prueba puede cambiar y que no valida al cargar, como PostgreSQL. */
class Catalog implements MissionCatalogPort {
  constructor(public definitions: readonly MissionDefinition[]) {}

  listActive(): Promise<readonly MissionDefinition[]> {
    return Promise.resolve(this.definitions)
  }

  findActive(missionId: string): Promise<MissionDefinition | null> {
    return this.findById(missionId)
  }

  findById(missionId: string): Promise<MissionDefinition | null> {
    return Promise.resolve(this.definitions.find((item) => item.missionId === missionId) ?? null)
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
  readonly releases: string[] = []

  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    return Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` })
  }

  release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'> {
    this.releases.push(operationId)
    return Promise.resolve('RELEASED')
  }
}

/** El doble de Combat, salvo que la prueba fije otra respuesta; anota las solicitudes. */
class Combat implements CombatSimulationPort {
  readonly requests: SimulationRequest[] = []
  next: ((request: SimulationRequest) => SimulationCallOutcome) | null = null
  private readonly double = new ScriptedCombatSimulation()

  simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    this.requests.push(request)

    return this.next === null ? this.double.simulate(request) : Promise.resolve(this.next(request))
  }
}

class Profiles implements HeroProfilePort {
  subtype: string | null = 'GUERRERO_ARMAS'

  profileOf(_playerId: string, heroId: string): Promise<HeroProfileOutcome> {
    return Promise.resolve({
      kind: 'FOUND',
      profile: this.subtype === null ? { heroId } : { heroId, subtype: this.subtype },
    })
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

const simulated = (
  request: SimulationRequest,
  result: Omit<SimulationResult, 'simulationId' | 'seedRef' | 'combatLog'>,
): SimulationCallOutcome => ({
  kind: 'SIMULATED',
  result: { simulationId: `sim_${request.operationId}`, seedRef: null, combatLog: [], ...result },
})

/** M-4: el Master aparece tras el tercer encuentro y derrota al heroe. */
const heroFallsToMaster = (request: SimulationRequest): SimulationCallOutcome =>
  simulated(request, {
    combatOutcome: 'HERO_DEFEATED',
    summary: {
      encountersCompleted: 3,
      encountersTotal: 5,
      bossDefeated: false,
      minHealthPercent: 0,
      master: {
        appeared: true,
        masterRef: MASTER,
        defeated: false,
        evaluations: [{ afterEncounter: 3, masterRef: MASTER, appeared: true }],
        encounters: [
          {
            masterRef: MASTER,
            afterEncounter: 3,
            levelOffset: 2,
            outcome: 'HERO_DEFEATED',
            turns: 9,
          },
        ],
      },
    },
  })

/** Una entrega pendiente escrita a mano, para los datos que el cierre nunca deja. */
const pendingGrant = (enrollmentId: string): MasterEncounterRecord => ({
  enrollmentId,
  sequence: 1,
  afterEncounter: 3,
  masterRef: MASTER,
  status: 'APPEARED_DEFEATED',
  epicRef: EPIC,
  levelOffset: 2,
  turns: 14,
  grant: {
    operationId: epicGrantOperationId(enrollmentId, MASTER, 1),
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date(0),
    lastError: null,
    grantedAt: null,
    rewardLineNo: null,
    productId: null,
  },
})

const setup = (definitions: readonly MissionDefinition[] = [templo()]) => {
  const catalog = new Catalog(definitions)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const reports = new InMemoryReportRepository()
  const masters = new InMemoryMasterEncounterRepository(reports)
  const commitments = new Commitments()
  const combat = new Combat()
  const profiles = new Profiles()
  const grants = new Grants()
  const clock = new MovableClock()
  const ids = new SequenceIds()
  const errors: { enrollmentId: string; error: unknown }[] = []
  const onError = (enrollmentId: string, error: unknown) => errors.push({ enrollmentId, error })
  const executor = new RunMissionExecutions(
    new InMemoryExecutionRepository(enrollments, clears, reports, masters),
    enrollments,
    catalog,
    profiles,
    combat,
    commitments,
    ids,
    clock,
    { batchSize: 50, onError },
  )
  const epicsWith = (source: EnrollmentRepositoryPort = enrollments) =>
    new GrantMasterEpics(masters, source, catalog, grants, clock, { batchSize: 50, onError })
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

  /** Se matricula, simula, avanza hasta el fin y cierra. */
  const play = async (): Promise<string> => {
    keys += 1
    const enrolled = await enroll.execute({
      playerId: 'sub-1',
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: `key-${String(keys)}`,
    })
    await executor.run()
    clock.current = new Date(enrolled.endsAt ?? clock.current)
    await executor.run()

    return enrolled.enrollmentId
  }

  return {
    catalog,
    enrollments,
    masters,
    commitments,
    combat,
    profiles,
    grants,
    clock,
    errors,
    play,
    epics: epicsWith(),
    epicsWith,
    report: new GetMissionReport(reports, enrollments),
    summary: new GetMissionHistorySummary(reports, catalog),
  }
}

const cycle = (counts: Partial<Record<string, number>> = {}) => ({
  epicsGranted: 0,
  epicsRetried: 0,
  epicsWaiting: 0,
  epicsRejected: 0,
  epicsFailed: 0,
  ...counts,
})

const settledPayload = (enrollments: InMemoryEnrollmentRepository) =>
  enrollments.recordedFacts().find((fact) => fact.type === 'MissionSettled')?.payload

const onlyRecord = async (
  masters: InMemoryMasterEncounterRepository,
  enrollmentId: string,
): Promise<MasterEncounterRecord> => {
  const records = await masters.listByEnrollment(enrollmentId)

  expect(records).toHaveLength(1)

  return required(records[0], 'la fila del Master')
}

describe('El Master en la simulacion y el cierre (Task HU-73.2)', () => {
  it('P-01 · CA-01 (M-3): aparece, el heroe lo derrota y la epica se entrega una vez', async () => {
    const { play, masters, enrollments, report, summary, epics, grants, clock } = setup()
    const enrollmentId = await play()
    const operationId = epicGrantOperationId(enrollmentId, MASTER, 1)

    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      afterEncounter: 3,
      masterRef: MASTER,
      status: 'APPEARED_DEFEATED',
      epicRef: EPIC,
      levelOffset: 2,
      grant: { operationId, status: 'PENDING', rewardLineNo: 1 },
    })
    expect(settledPayload(enrollments)).toMatchObject({
      missionOutcome: 'COMPLETED',
      masterEncounters: [
        { sequence: 1, masterRef: MASTER, status: 'APPEARED_DEFEATED', epicRef: EPIC },
      ],
    })
    await expect(report.execute('sub-1', enrollmentId)).resolves.toMatchObject({
      enemies: {
        masters: [{ masterRef: MASTER, name: 'Sombra del Olvido', status: 'APPEARED_DEFEATED' }],
      },
      rewards: [
        {
          kind: 'EPIC',
          reference: EPIC,
          name: 'Velo de Sombras',
          status: 'PENDING',
          source: 'HU-73',
        },
      ],
    })

    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 1 }))
    expect(grants.calls).toEqual([{ operationId, playerId: 'sub-1', productId: PRODUCT }])
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'GRANTED', grantedAt: clock.current, attempts: 1 },
    })
    await expect(report.execute('sub-1', enrollmentId)).resolves.toMatchObject({
      rewards: [{ kind: 'EPIC', status: 'CREDITED' }],
    })
    await expect(summary.execute('sub-1')).resolves.toMatchObject({
      epicCollection: [{ epicRef: EPIC, masterRef: MASTER, status: 'CREDITED' }],
    })

    // Entregada, ya no queda nada que pedir.
    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toHaveLength(1)
  })

  it('M-7: si la respuesta se pierde, el reintento lleva la misma operacion y entrega una vez', async () => {
    const { play, masters, epics, grants, clock } = setup()
    const enrollmentId = await play()
    grants.answers.push({ kind: 'UNKNOWN', reason: 'NETWORK' })

    await expect(epics.run()).resolves.toEqual(cycle({ epicsRetried: 1 }))
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'PENDING', attempts: 1, lastError: 'NETWORK' },
    })
    // Aun no toca: el primer reintento espera 5 s.
    await expect(epics.run()).resolves.toEqual(cycle())

    clock.advance(5_000)
    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 1 }))
    expect(grants.calls).toHaveLength(2)
    expect(new Set(grants.calls.map((call) => call.operationId)).size).toBe(1)
    expect(grants.double.granted()).toHaveLength(1)
  })

  it('P-02 · CA-02 (M-2): no aparece; se registra la ausencia y no hay epica', async () => {
    const { play, masters, report, epics, grants } = setup([
      templo({ probabilityByHeroType: { '*': 0.15 } }),
    ])
    const enrollmentId = await play()

    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      sequence: 1,
      afterEncounter: 3,
      masterRef: null,
      status: 'NOT_APPEARED',
      grant: null,
    })
    await expect(report.execute('sub-1', enrollmentId)).resolves.toMatchObject({
      enemies: { masters: [] },
      rewards: [],
    })
    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toEqual([])
  })

  it('P-03 · CA-03 (M-4): el Master derrota al heroe; la mision falla y no hay epica', async () => {
    const { play, masters, enrollments, report, combat, epics, grants } = setup()
    combat.next = heroFallsToMaster
    const enrollmentId = await play()

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'FAILED' })
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      status: 'APPEARED_HERO_DEFEATED',
      masterRef: MASTER,
      epicRef: null,
      turns: 9,
      grant: null,
    })
    const view = await report.execute('sub-1', enrollmentId)
    expect(view.rewards).toEqual([])
    expect(view.objectives.find((objective) => objective.id === 'obj_master')?.met).toBe(false)
    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toEqual([])
  })

  it('M-6: sin probabilidad para el subtipo, Combat no recibe el bloque y queda NOT_APPLICABLE', async () => {
    const { play, masters, combat, profiles } = setup([
      templo({ probabilityByHeroType: { PICARO_VENENO: 0.15 } }),
    ])
    profiles.subtype = 'MAGO_FUEGO'
    const enrollmentId = await play()

    expect(combat.requests[0]?.master).toBeNull()
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      afterEncounter: null,
      status: 'NOT_APPLICABLE',
    })
  })

  it('la probabilidad que viaja a Combat es la del subtipo del heroe congelado (P-X2)', async () => {
    const { play, combat, profiles } = setup([
      templo({ probabilityByHeroType: { PICARO_VENENO: 0.3, '*': 0.1 } }),
    ])
    profiles.subtype = 'PICARO_VENENO'
    await play()

    expect(combat.requests[0]?.master?.candidates).toEqual([
      expect.objectContaining({
        masterRef: MASTER,
        probability: 0.3,
        levelOffset: 2,
        epicRef: EPIC,
      }),
    ])
  })

  it('P-X5: un Master mal configurado no llega a Combat; la mision se anula sin penalizacion', async () => {
    const { play, enrollments, combat, commitments, masters } = setup([
      templo({}, { maxAppearances: 0 }),
    ])
    const enrollmentId = await play()

    expect(combat.requests).toEqual([])
    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'VOIDED' })
    expect(settledPayload(enrollments)).toMatchObject({ reason: 'INVALID_MASTER_CONFIG' })
    expect(commitments.releases).toHaveLength(1)
    await expect(masters.listByEnrollment(enrollmentId)).resolves.toEqual([])
  })

  it('una evidencia del Master que no cuadra anula la mision y no deja epica', async () => {
    const { play, enrollments, combat, masters, epics, grants } = setup()
    combat.next = (request) =>
      simulated(request, {
        combatOutcome: 'HERO_VICTORIOUS',
        summary: {
          encountersCompleted: 5,
          encountersTotal: 5,
          bossDefeated: true,
          minHealthPercent: 60,
          // Dice que lo derroto, sin evaluacion ni encuentro que lo respalden.
          master: { appeared: true, masterRef: MASTER, defeated: true },
        },
      })
    const enrollmentId = await play()

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'VOIDED' })
    expect(settledPayload(enrollments)).toMatchObject({
      reason: 'INVALID_SIMULATION_RESULT',
      masterEncounters: [],
    })
    await expect(masters.listByEnrollment(enrollmentId)).resolves.toEqual([])
    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toEqual([])
  })
})

describe('Entrega de la epica en Player/Inventory (Task HU-73.2, CU-73.3)', () => {
  it('sin producto de Catalog, la entrega espera; cuando el producto existe, se entrega', async () => {
    const { play, masters, catalog, epics, grants, clock } = setup([
      templo({ epic: { ...CANDIDATE.epic, productId: null } }),
    ])
    const enrollmentId = await play()

    await expect(epics.run()).resolves.toEqual(cycle({ epicsWaiting: 1 }))
    expect(grants.calls).toEqual([])
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'PENDING', lastError: 'EPIC_PRODUCT_MISSING', attempts: 1 },
    })

    catalog.definitions = [templo()]
    clock.advance(5_000)

    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 1 }))
    expect(grants.calls).toEqual([expect.objectContaining({ productId: PRODUCT })])
  })

  it('un rechazo definitivo queda para revision y la linea del reporte pasa a FAILED', async () => {
    const { play, masters, report, epics, grants, clock } = setup()
    const enrollmentId = await play()
    grants.answers.push({ kind: 'REJECTED', reason: 'INVENTORY_REJECTED' })

    await expect(epics.run()).resolves.toEqual(cycle({ epicsRejected: 1 }))
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'REJECTED', lastError: 'INVENTORY_REJECTED', nextAttemptAt: null },
    })
    await expect(report.execute('sub-1', enrollmentId)).resolves.toMatchObject({
      rewards: [{ kind: 'EPIC', status: 'FAILED' }],
    })

    clock.advance(3_600_000)
    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toHaveLength(1)
  })

  it('nunca entrega en una mision anulada, aunque quede una entrega pendiente (P-X6)', async () => {
    const { play, masters, combat, enrollments, epics, grants } = setup()
    combat.next = () => ({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    const enrollmentId = await play()

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'VOIDED' })
    masters.recordNow([pendingGrant(enrollmentId)])

    await expect(epics.run()).resolves.toEqual(cycle({ epicsRejected: 1 }))
    expect(grants.calls).toEqual([])
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'REJECTED', lastError: 'MISSION_VOIDED' },
    })
  })

  it('un fallo en una entrega no detiene las demas y se informa', async () => {
    const { play, enrollments, epicsWith, errors } = setup()
    const first = await play()
    const second = await play()
    const broken = {
      findById: (enrollmentId: string) =>
        enrollmentId === first
          ? Promise.reject(new Error('base caida'))
          : enrollments.findById(enrollmentId),
    } as unknown as EnrollmentRepositoryPort

    await expect(epicsWith(broken).run()).resolves.toEqual(
      cycle({ epicsGranted: 1, epicsFailed: 1 }),
    )
    expect(second).not.toBe(first)
    expect(errors).toEqual([{ enrollmentId: first, error: new Error('base caida') }])
  })

  it('una matricula que desaparecio es un fallo que se informa, no una entrega', async () => {
    const { masters, epics, errors, grants } = setup()
    masters.recordNow([pendingGrant('enr_fantasma')])

    await expect(epics.run()).resolves.toEqual(cycle({ epicsFailed: 1 }))
    expect(grants.calls).toEqual([])
    expect(errors).toEqual([
      { enrollmentId: 'enr_fantasma', error: new Error('La matricula enr_fantasma no existe.') },
    ])
  })
})

describe('El detalle de HU-70 con la configuracion de HU-73', () => {
  it('muestra la mayor probabilidad, la de cada subtipo y el subtipo del Master como heroType', async () => {
    const { enrollments, catalog } = setup([
      templo({ probabilityByHeroType: { PICARO_VENENO: 0.3, '*': 0.1 } }),
    ])
    const detail = new GetMissionDetail(
      catalog,
      enrollments,
      new InMemoryDifficultyClearRepository(),
    )

    await expect(detail.execute('sub-1', TEMPLO.missionId)).resolves.toMatchObject({
      masterEncounter: {
        probability: 0.3,
        candidates: [
          {
            name: 'Sombra del Olvido',
            heroType: 'PICARO_VENENO',
            probabilityByHeroType: { PICARO_VENENO: 0.3, '*': 0.1 },
          },
        ],
      },
    })
  })

  it('un candidato sin probabilidades en el contenido no rompe el detalle', async () => {
    const roto = templo({
      probabilityByHeroType: undefined as unknown as Record<string, number>,
    })
    const { enrollments } = setup()
    const detail = new GetMissionDetail(
      new Catalog([roto]),
      enrollments,
      new InMemoryDifficultyClearRepository(),
    )

    await expect(detail.execute('sub-1', TEMPLO.missionId)).resolves.toMatchObject({
      masterEncounter: { probability: 0, candidates: [{ probabilityByHeroType: {} }] },
    })
  })
})

describe('Lo que la revision pidio cubrir en la entrega y el cierre (HU-73)', () => {
  const OTHER = 'otro-master'
  const OTHER_EPIC = 'otra-epica'
  const OTHER_PRODUCT = '22222222-2222-4222-8222-222222222222'

  /** M-3 contado por Combat: el Master aparece tras el tercer encuentro y cae. */
  const masterFalls = (request: SimulationRequest): SimulationCallOutcome =>
    simulated(request, {
      combatOutcome: 'HERO_VICTORIOUS',
      summary: {
        encountersCompleted: 5,
        encountersTotal: 5,
        bossDefeated: true,
        minHealthPercent: 30,
        master: {
          appeared: true,
          masterRef: MASTER,
          defeated: true,
          evaluations: [{ afterEncounter: 3, masterRef: MASTER, appeared: true }],
          encounters: [
            { masterRef: MASTER, afterEncounter: 3, levelOffset: 2, outcome: 'DEFEATED', turns: 8 },
          ],
        },
      },
    })

  it('el producto se congela ANTES de enviar: si el guardado posterior falla, el reintento lleva el mismo', async () => {
    const { play, masters, enrollments, catalog, grants, clock, errors } = setup()
    const enrollmentId = await play()
    let broken = true
    // El guardado del GRANTED falla una vez: Player/Inventory ya entrego la epica.
    const flaky: MasterEncounterRepositoryPort = {
      pendingGrants: (now, limit) => masters.pendingGrants(now, limit),
      listByEnrollment: (id) => masters.listByEnrollment(id),
      freezeProduct: (next, attempts) => masters.freezeProduct(next, attempts),
      saveGrant: (next, attempts, at) => {
        if (broken && next.grant?.status === 'GRANTED') {
          broken = false
          return Promise.reject(new Error('conexion cortada'))
        }
        return masters.saveGrant(next, attempts, at)
      },
    }
    const epics = new GrantMasterEpics(flaky, enrollments, catalog, grants, clock, {
      batchSize: 50,
      onError: (id, error) => errors.push({ enrollmentId: id, error }),
    })

    await expect(epics.run()).resolves.toEqual(cycle({ epicsFailed: 1 }))
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'PENDING', lastError: 'INTERNAL_ERROR', productId: PRODUCT },
    })

    // El contenido cambia el producto antes del reintento.
    catalog.definitions = [templo({ epic: { ...CANDIDATE.epic, productId: OTHER_PRODUCT } })]
    clock.advance(5_000)
    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 1 }))

    expect(grants.calls.map((call) => call.productId)).toEqual([PRODUCT, PRODUCT])
    expect(grants.double.granted()).toHaveLength(1)
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: { status: 'GRANTED', productId: PRODUCT },
    })
  })

  it('si otro proceso ya congelo el producto, este no envia', async () => {
    const { play, masters, enrollments, catalog, grants, clock } = setup()
    const enrollmentId = await play()
    const [pending] = await masters.listByEnrollment(enrollmentId)
    const grant = pending?.grant

    if (pending === undefined || grant === null || grant === undefined) {
      throw new Error('Falta la entrega pendiente')
    }

    // Otro proceso congelo el producto con los mismos intentos leidos.
    await masters.freezeProduct({ ...pending, grant: { ...grant, productId: PRODUCT } }, 0)
    // Este proceso trabaja con lo que leyo antes: sin producto.
    const stale: MasterEncounterRepositoryPort = {
      pendingGrants: () => Promise.resolve([pending]),
      listByEnrollment: (id) => masters.listByEnrollment(id),
      freezeProduct: (next, attempts) => masters.freezeProduct(next, attempts),
      saveGrant: (next, attempts, at) => masters.saveGrant(next, attempts, at),
    }
    const epics = new GrantMasterEpics(stale, enrollments, catalog, grants, clock)

    await expect(epics.run()).resolves.toEqual(cycle())
    expect(grants.calls).toEqual([])
  })

  it('el producto se congela en el primer envio: si el contenido cambia, el reintento lleva el mismo', async () => {
    const { play, catalog, epics, grants, clock } = setup()
    await play()
    grants.answers.push({ kind: 'UNKNOWN', reason: 'NETWORK' })
    await epics.run()

    // El contenido cambia el producto entre el primer envio y el reintento.
    catalog.definitions = [templo({ epic: { ...CANDIDATE.epic, productId: OTHER_PRODUCT } })]
    clock.advance(5_000)
    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 1 }))

    expect(grants.calls.map((call) => call.productId)).toEqual([PRODUCT, PRODUCT])
  })

  it('una entrega que lanza se aplaza con el escalonado en vez de reintentarse en cada ciclo', async () => {
    const { play, masters, epicsWith, enrollments, grants, clock } = setup()
    const enrollmentId = await play()
    const broken = {
      findById: () => Promise.reject(new Error('base caida')),
    } as unknown as EnrollmentRepositoryPort

    await expect(epicsWith(broken).run()).resolves.toEqual(cycle({ epicsFailed: 1 }))
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      grant: {
        status: 'PENDING',
        attempts: 1,
        lastError: 'INTERNAL_ERROR',
        nextAttemptAt: new Date(clock.current.getTime() + 5_000),
      },
    })
    // Aun no toca, ni siquiera con la base de vuelta.
    await expect(epicsWith(enrollments).run()).resolves.toEqual(cycle())
    expect(grants.calls).toEqual([])
  })

  it('un contenido roto al cerrar no deja la mision sin cerrar: la epica queda esperando', async () => {
    const { play, catalog, combat, enrollments, masters, epics } = setup()
    combat.next = (request) => {
      // El contenido se estropea entre la simulacion y el cierre.
      catalog.definitions = [
        { ...templo(), masterEncounter: { candidates: [{ masterRef: MASTER }] } as never },
      ]

      return masterFalls(request)
    }
    const enrollmentId = await play()

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({
      status: 'COMPLETED',
    })
    await expect(onlyRecord(masters, enrollmentId)).resolves.toMatchObject({
      status: 'APPEARED_DEFEATED',
      grant: { status: 'PENDING' },
    })
    await expect(epics.run()).resolves.toEqual(cycle({ epicsWaiting: 1 }))
  })

  it('P-05: dos Master distintos derrotados dan dos entregas, dos lineas y cada epica con su Master', async () => {
    const definition = templo(
      {},
      {
        evaluationPoints: [{ afterEncounter: 2 }, { afterEncounter: 4 }],
        maxAppearances: 2,
        candidates: [
          {
            ...CANDIDATE,
            probabilityByHeroType: { '*': 0.5 },
            epic: { ...CANDIDATE.epic, productId: PRODUCT },
          },
          {
            ...CANDIDATE,
            masterRef: OTHER,
            name: 'Otro Master',
            probabilityByHeroType: { '*': 0.5 },
            epic: {
              ...CANDIDATE.epic,
              epicRef: OTHER_EPIC,
              name: 'Otra Epica',
              productId: OTHER_PRODUCT,
            },
          },
        ],
      },
    )
    const { play, combat, masters, epics, grants, summary } = setup([definition])
    combat.next = (request) =>
      simulated(request, {
        combatOutcome: 'HERO_VICTORIOUS',
        summary: {
          encountersCompleted: 5,
          encountersTotal: 5,
          bossDefeated: true,
          minHealthPercent: 30,
          master: {
            appeared: true,
            masterRef: MASTER,
            defeated: true,
            evaluations: [
              { afterEncounter: 2, masterRef: MASTER, appeared: true },
              { afterEncounter: 4, masterRef: MASTER, appeared: false },
              { afterEncounter: 4, masterRef: OTHER, appeared: true },
            ],
            encounters: [
              {
                masterRef: MASTER,
                afterEncounter: 2,
                levelOffset: 2,
                outcome: 'DEFEATED',
                turns: 8,
              },
              {
                masterRef: OTHER,
                afterEncounter: 4,
                levelOffset: 2,
                outcome: 'DEFEATED',
                turns: 12,
              },
            ],
          },
        },
      })
    const enrollmentId = await play()

    const records = await masters.listByEnrollment(enrollmentId)
    expect(records.map((item) => [item.masterRef, item.epicRef, item.grant?.rewardLineNo])).toEqual(
      [
        [MASTER, EPIC, 1],
        [OTHER, OTHER_EPIC, 2],
      ],
    )
    await expect(epics.run()).resolves.toEqual(cycle({ epicsGranted: 2 }))
    expect(grants.calls).toEqual([
      expect.objectContaining({
        operationId: epicGrantOperationId(enrollmentId, MASTER, 1),
        productId: PRODUCT,
      }),
      expect.objectContaining({
        operationId: epicGrantOperationId(enrollmentId, OTHER, 2),
        productId: OTHER_PRODUCT,
      }),
    ])
    const { epicCollection } = await summary.execute('sub-1')
    expect(epicCollection.map((entry) => [entry.epicRef, entry.masterRef, entry.status])).toEqual(
      expect.arrayContaining([
        [EPIC, MASTER, 'CREDITED'],
        [OTHER_EPIC, OTHER, 'CREDITED'],
      ]),
    )
  })
})
