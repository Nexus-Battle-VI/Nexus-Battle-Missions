import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
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
import {
  EnrollInMission,
  type EnrollCommand,
} from '../../src/application/use-cases/EnrollInMission'
import {
  RunMissionExecutions,
  simulationRequestFor,
  type ExecutionCycleSummary,
  type ExecutionOptions,
} from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionCatalogPort } from '../../src/application/ports/MissionCatalogPort'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import { newPendingEnrollment } from '../../src/domain/entities/MissionEnrollment'
import {
  queueExecution,
  type ObjectiveResult,
  type SimulationRequest,
  type SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import { COURSE_STRATEGY } from '../support/fixtures'

const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')
const DEADLINE = new Date(ENDS.getTime() + 30 * 60_000)
const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_2 = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const KEY = '3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f'
const KEY_2 = '4c0a7d2f-9e3b-4a8c-8d5f-6b7c8d9e0f1a'
const PROFILE = { heroId: HERO, subtype: 'GUERRERO_ARMAS', level: 12 }

/** Resultado del fixture P-01 del contrato de HU-72. */
const P01_RESULT: SimulationResult = {
  simulationId: 'sim_p01',
  seedRef: 'seed_p01',
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    damageDealt: 1830,
    damageTaken: 640,
    minHealthPercent: 41.5,
    criticalEffects: 9,
    bossDefeated: true,
    // HU-73: el Templo pide sortear el Master tras el tercer encuentro; no aparece.
    master: {
      appeared: false,
      masterRef: null,
      defeated: false,
      evaluations: [{ afterEncounter: 3, masterRef: 'sombra-del-olvido', appeared: false }],
      encounters: [],
    },
    simulatedDuration: 'PT9H40M',
  },
  combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' }],
}

class FixedClock implements ClockPort {
  constructor(public current: Date) {}
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

/** Player/Inventory: concede la reserva y anota las liberaciones. */
class ScriptedCommitments implements HeroCommitmentPort {
  readonly releases: string[] = []
  releaseResult: 'RELEASED' | 'UNKNOWN' = 'RELEASED'

  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    return Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` })
  }

  release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'> {
    this.releases.push(operationId)
    return Promise.resolve(this.releaseResult)
  }
}

/** Combat con respuestas guionizadas; por defecto, el resultado de P-01. */
class ScriptedCombat implements CombatSimulationPort {
  readonly outcomes: (SimulationCallOutcome | Error)[] = []
  readonly requests: SimulationRequest[] = []
  /** Llamadas que no responden hasta que la prueba las suelta, en orden. */
  readonly holds: Promise<void>[] = []

  async simulate(request: SimulationRequest): Promise<SimulationCallOutcome> {
    this.requests.push(request)
    const next = this.outcomes.shift()
    await this.holds.shift()

    if (next instanceof Error) {
      throw next
    }

    return next ?? { kind: 'SIMULATED', result: P01_RESULT }
  }
}

/** Deja correr todo lo pendiente: los dobles en memoria responden sin esperas reales. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

/** Perfiles de Player/Inventory; por defecto, el heroe es del jugador. */
class ScriptedProfiles implements HeroProfilePort {
  readonly outcomes: HeroProfileOutcome[] = []
  calls = 0

  profileOf(): Promise<HeroProfileOutcome> {
    this.calls += 1
    return Promise.resolve(this.outcomes.shift() ?? { kind: 'FOUND', profile: PROFILE })
  }
}

const setup = (options: Partial<ExecutionOptions> = {}) => {
  const catalog = new InMemoryMissionCatalog(EXAMPLE_MISSIONS)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const strategies = new InMemoryStrategyRepository()
  const reports = new InMemoryReportRepository()
  const executions = new InMemoryExecutionRepository(enrollments, clears, reports)
  const commitments = new ScriptedCommitments()
  const combat = new ScriptedCombat()
  const profiles = new ScriptedProfiles()
  const ids = new SequenceIds()
  const clock = new FixedClock(AT)
  const errors: { enrollmentId: string; error: unknown }[] = []
  // Cada llamada es otro proceso sobre el mismo estado.
  const runner = (runnerCatalog: MissionCatalogPort = catalog) =>
    new RunMissionExecutions(
      executions,
      enrollments,
      runnerCatalog,
      profiles,
      combat,
      commitments,
      ids,
      clock,
      {
        batchSize: 50,
        onError: (enrollmentId, error) => errors.push({ enrollmentId, error }),
        ...options,
      },
    )

  return {
    catalog,
    enrollments,
    clears,
    strategies,
    executions,
    reports,
    commitments,
    combat,
    profiles,
    clock,
    errors,
    runner,
    executor: runner(),
    enroll: new EnrollInMission(catalog, enrollments, clears, strategies, commitments, ids, clock),
  }
}

const command = (overrides: Partial<EnrollCommand> = {}): EnrollCommand => ({
  playerId: 'sub-1',
  missionId: TEMPLO,
  heroId: HERO,
  difficulty: 'NORMAL',
  strategyVersion: null,
  idempotencyKey: KEY,
  ...overrides,
})

const cycle = (counts: Partial<ExecutionCycleSummary> = {}): ExecutionCycleSummary => ({
  queued: 0,
  simulated: 0,
  retried: 0,
  settled: 0,
  voided: 0,
  released: 0,
  failed: 0,
  ...counts,
})

const settledPayloads = (enrollments: InMemoryEnrollmentRepository) =>
  enrollments
    .recordedFacts()
    .filter((fact) => fact.type === 'MissionSettled')
    .map((fact) => fact.payload)

const metByObjective = (payload: Readonly<Record<string, unknown>> | undefined) =>
  Object.fromEntries(
    (payload?.objectives as readonly ObjectiveResult[]).map(({ id, met }) => [id, met]),
  )

describe('RunMissionExecutions: simulacion (Task HU-72.2, CU-72.1)', () => {
  it('P-01: programa la mision iniciada, la simula y sella el resultado hasta endsAt (P-S9)', async () => {
    const { enroll, executor, executions, enrollments, combat } = setup()
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, simulated: 1 }))
    // op-1 es la reserva de HU-70; la simulacion tiene su propio operationId.
    expect(combat.requests.map((request) => request.operationId)).toEqual(['op-2'])
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'SIMULATED',
      attempts: 1,
      result: P01_RESULT,
      simulatedAt: AT,
    })
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({
      status: 'IN_PROGRESS',
      finishedAt: null,
    })
    expect(settledPayloads(enrollments)).toEqual([])
    // El hecho ya se consumio: no se programa ni se simula dos veces.
    await expect(executor.run()).resolves.toEqual(cycle())
  })

  it('la solicitud lleva todo lo congelado: duracion, dificultad, estrategia y encuentros (P-S4)', async () => {
    const { enroll, executor, strategies, combat } = setup()
    await strategies.save(
      {
        playerId: 'sub-1',
        heroId: HERO,
        missionId: TEMPLO,
        version: 1,
        rotations: COURSE_STRATEGY,
        updatedAt: AT,
      },
      null,
    )
    await enroll.execute(command({ strategyVersion: 1 }))
    await executor.run()

    const [request] = combat.requests
    expect(request).toMatchObject({
      schemaVersion: 1,
      operationId: 'op-2',
      enrollmentId: 'enr_1',
      missionId: TEMPLO,
      difficulty: 'NORMAL',
      enemyStatMultiplier: 1,
      timeBudget: 'PT12H',
      hero: { heroId: HERO, profile: PROFILE },
      strategy: { version: 1, rotations: COURSE_STRATEGY, fallback: 'BASIC_ATTACK' },
      // HU-73 (P-X2): la probabilidad ya resuelta para el subtipo del heroe. El
      // heroe es Guerrero Armas: al Coloso le toca la de "*", no la del Tanque.
      master: {
        evaluationPoints: [{ afterEncounter: 3 }],
        maxAppearances: 1,
        candidates: [
          {
            masterRef: 'sombra-del-olvido',
            subtype: 'PICARO_VENENO',
            probability: 0.15,
            levelOffset: 2,
            profile: EXAMPLE_MISSIONS[0]!.masterEncounter?.candidates[0]?.profile,
            epicRef: 'toma-y-lleva',
          },
          {
            masterRef: 'coloso-de-obsidiana',
            subtype: 'GUERRERO_TANQUE',
            probability: 0.05,
            levelOffset: 2,
            profile: EXAMPLE_MISSIONS[0]!.masterEncounter?.candidates[1]?.profile,
            epicRef: 'golpe-de-defensa',
          },
        ],
      },
    })
    expect(
      request?.encounters.map(({ index, kind, enemies }) => [
        index,
        kind,
        enemies.map(({ count, name }) => `${String(count)} ${name}`),
      ]),
    ).toEqual([
      [1, 'REGULAR', ['4 Sombras Corrompidas']],
      [2, 'REGULAR', ['6 Sombras Corrompidas']],
      [3, 'REGULAR', ['5 Guardianes de Piedra']],
      [4, 'REGULAR', ['3 Espectros Ancestrales']],
      [5, 'BOSS', ['1 El Guardián Eterno']],
    ])
    expect(request?.encounters[4]?.enemies[0]?.profile).toEqual(
      EXAMPLE_MISSIONS[0]!.finalBoss.profile,
    )
    expect(request?.encounters[0]?.enemies[0]?.profile).toEqual(
      EXAMPLE_MISSIONS[0]!.enemies[0]!.profile,
    )
  })

  it('envia a Combat perfiles de enemigos y jefe cuando el contenido los define', async () => {
    const { enroll, runner, combat } = setup()
    const example = EXAMPLE_MISSIONS[0]!
    const regularProfile = { subtype: 'GUERRERO_ARMAS', maxHealth: 24, attack: 8, defense: 3 }
    const bossProfile = { subtype: 'GUERRERO_TANQUE', maxHealth: 100, attack: 13, defense: 9 }
    const content: MissionDefinition = {
      ...example,
      enemies: example.enemies.map((enemy) =>
        enemy.enemyRef === 'sombra-corrompida' ? { ...enemy, profile: regularProfile } : enemy,
      ),
      finalBoss: { ...example.finalBoss, profile: bossProfile },
    }
    await enroll.execute(command())
    await runner(new InMemoryMissionCatalog([content])).run()

    expect(combat.requests[0]?.encounters[0]?.enemies[0]?.profile).toEqual(regularProfile)
    expect(combat.requests[0]?.encounters[4]?.enemies[0]?.profile).toEqual(bossProfile)
    expect(combat.requests[0]?.encounters[2]?.enemies[0]?.profile).toEqual(
      example.enemies[1]?.profile,
    )
  })

  it('T-01: sin respuesta de Combat reintenta con el mismo operationId a los 5 s y a los 30 s (P-S3)', async () => {
    const { enroll, executor, executions, combat, profiles, clock } = setup()
    combat.outcomes.push(
      { kind: 'UNKNOWN', reason: 'HTTP_503' },
      { kind: 'UNKNOWN', reason: 'TIMEOUT' },
    )
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, retried: 1 }))
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'REQUESTED',
      attempts: 1,
      lastError: 'HTTP_503',
      nextAttemptAt: new Date(AT.getTime() + 5_000),
    })

    clock.advance(4_999)
    await expect(executor.run()).resolves.toEqual(cycle())
    clock.advance(1)
    await expect(executor.run()).resolves.toEqual(cycle({ retried: 1 }))
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      attempts: 2,
      lastError: 'TIMEOUT',
      nextAttemptAt: new Date(AT.getTime() + 35_000),
    })

    clock.advance(30_000)
    await expect(executor.run()).resolves.toEqual(cycle({ simulated: 1 }))
    const [first, second, third] = combat.requests
    expect(combat.requests).toHaveLength(3)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    // La solicitud se armo una vez: el perfil del heroe no se volvio a pedir.
    expect(profiles.calls).toBe(1)
  })

  it('T-02: dos procesos a la vez piden la simulacion una sola vez', async () => {
    const { enroll, executor, runner, combat } = setup()
    await enroll.execute(command())
    await executor.queueStarted()

    const [first, second] = await Promise.all([executor.simulateDue(), runner().simulateDue()])

    expect(first.simulated + second.simulated).toBe(1)
    expect(combat.requests).toHaveLength(1)
  })

  it('T-02: si Combat tarda mas que el plazo del intento, otro proceso reintenta y el resultado se guarda una vez', async () => {
    const { enroll, executor, runner, executions, combat, clock } = setup()
    let answer: () => void = () => undefined
    combat.holds.push(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    await enroll.execute(command())
    await executor.queueStarted()

    const slow = executor.simulateDue()
    await settle()
    clock.advance(5_000)
    await expect(runner().simulateDue()).resolves.toMatchObject({ simulated: 1 })
    answer()

    // La respuesta tardia es la misma simulacion (mismo operationId): se descarta.
    await expect(slow).resolves.toMatchObject({ simulated: 0, failed: 0 })
    expect(combat.requests.map((request) => request.operationId)).toEqual(['op-2', 'op-2'])
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'SIMULATED',
      attempts: 2,
    })
  })

  it('sin el perfil del heroe espera sin llamar a Combat, y despues simula', async () => {
    const { enroll, executor, executions, combat, profiles, clock } = setup()
    profiles.outcomes.push({ kind: 'UNKNOWN', reason: 'TIMEOUT' })
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, retried: 1 }))
    expect(combat.requests).toHaveLength(0)
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      request: null,
      lastError: 'HERO_PROFILE_TIMEOUT',
      nextAttemptAt: new Date(AT.getTime() + 5_000),
    })

    clock.advance(5_000)
    await expect(executor.run()).resolves.toEqual(cycle({ simulated: 1 }))
  })

  it('si Combat vuelve despues de endsAt pero dentro del plazo, simula y cierra en el mismo ciclo', async () => {
    const { enroll, executor, enrollments, combat, clock } = setup()
    combat.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await enroll.execute(command())
    await executor.run()

    clock.current = DEADLINE
    await expect(executor.run()).resolves.toEqual(cycle({ simulated: 1, settled: 1, released: 1 }))
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'COMPLETED' })
  })

  it('batchSize limita cuantas misiones avanza cada paso', async () => {
    const { enroll, executor } = setup({ batchSize: 1 })
    await enroll.execute(command())
    await enroll.execute(command({ playerId: 'sub-2', heroId: HERO_2, idempotencyKey: KEY_2 }))

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, simulated: 1 }))
    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, simulated: 1 }))
  })

  it('no arma la solicitud de una matricula que no empezo', () => {
    const [templo] = EXAMPLE_MISSIONS as [MissionDefinition]
    const pending = newPendingEnrollment({
      enrollmentId: 'enr_1',
      playerId: 'sub-1',
      missionId: TEMPLO,
      heroId: HERO,
      difficulty: 'NORMAL',
      operationId: 'op-1',
      idempotencyKey: KEY,
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    })
    const execution = queueExecution({
      enrollmentId: 'enr_1',
      operationId: 'op-2',
      endsAt: ENDS,
      now: AT,
    })

    expect(() => simulationRequestFor(execution, pending, templo, PROFILE)).toThrow(
      'La matricula enr_1 no tiene inicio y fin.',
    )
  })
})

describe('RunMissionExecutions: cierre (Task HU-72.2, CU-72.2)', () => {
  it('cierra con el contenido congelado aunque un administrador lo edite durante la mision', async () => {
    const { enroll, executor, catalog, reports, clock } = setup()
    await enroll.execute(command())
    await executor.run()
    await catalog.save({
      ...EXAMPLE_MISSIONS[0]!,
      name: 'Templo cambiado',
      objectives: [
        { id: 'obj_nuevo', text: 'Nuevo objetivo', primary: true, rule: { type: 'DEFEAT_MASTER' } },
      ],
    })
    clock.current = ENDS
    await executor.run()
    const record = await reports.findByEnrollment('enr_1')
    expect(record?.report.mission.name).toBe('El Templo Olvidado')
    expect(record?.report.objectives.map((objective) => objective.id)).toContain('obj_guardian')
    expect(record?.report.objectives.map((objective) => objective.id)).not.toContain('obj_nuevo')
  })

  it('P-01: al llegar endsAt se completa, registra el clear y el hecho, y libera al heroe', async () => {
    const { enroll, executor, executions, enrollments, clears, commitments, clock } = setup()
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS

    await expect(executor.run()).resolves.toEqual(cycle({ settled: 1, released: 1 }))
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({
      status: 'COMPLETED',
      finishedAt: ENDS,
    })
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual(['NORMAL'])

    const [payload] = settledPayloads(enrollments)
    expect(payload).toMatchObject({
      missionOutcome: 'COMPLETED',
      reason: null,
      simulationId: 'sim_p01',
      settledAt: ENDS.toISOString(),
    })
    expect(metByObjective(payload)).toEqual({
      obj_guardian: true,
      obj_camaras: true,
      obj_vida: false,
      obj_master: null,
      obj_fragmentos: null,
    })
    // Se libera el compromiso de HU-70 (op-1), no la simulacion (op-2).
    expect(commitments.releases).toEqual(['op-1'])
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'SETTLED',
      settledAt: ENDS,
      heroReleasedAt: ENDS,
    })
  })

  it('el exito desbloquea Heroico y el heroe queda libre para otra matricula (HU-75)', async () => {
    const { enroll, executor, clock } = setup()
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS
    await executor.run()

    await expect(
      enroll.execute(command({ difficulty: 'HEROIC', idempotencyKey: KEY_2 })),
    ).resolves.toMatchObject({ status: 'IN_PROGRESS', difficulty: 'HEROIC' })
  })

  it('antes de endsAt no se cierra nada', async () => {
    const { enroll, executor, enrollments, clock } = setup()
    await enroll.execute(command())
    await executor.run()

    clock.current = new Date(ENDS.getTime() - 1)
    await expect(executor.run()).resolves.toEqual(cycle())
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'IN_PROGRESS' })
  })

  it('P-04: si el heroe cae la mision falla, sin clear, y el heroe se libera (CA-04)', async () => {
    const { enroll, executor, enrollments, clears, combat, clock } = setup()
    combat.outcomes.push({
      kind: 'SIMULATED',
      result: { ...P01_RESULT, combatOutcome: 'HERO_DEFEATED' },
    })
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS

    await expect(executor.run()).resolves.toEqual(cycle({ settled: 1, released: 1 }))
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'FAILED' })
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual([])
    expect(settledPayloads(enrollments)).toEqual([
      expect.objectContaining({ missionOutcome: 'FAILED', reason: 'HERO_DEFEATED' }),
    ])
  })

  it('T-03: dos cierres a la vez dejan un solo hecho MissionSettled', async () => {
    const { enroll, executor, runner, enrollments, clock } = setup()
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS

    const [first, second] = await Promise.all([executor.closeDue(), runner().closeDue()])

    expect(first.settled + second.settled).toBe(1)
    expect(settledPayloads(enrollments)).toHaveLength(1)
    await expect(executor.run()).resolves.toEqual(cycle({ released: 1 }))
    await expect(executor.run()).resolves.toEqual(cycle())
  })

  it('un resultado guardado sin los hechos necesarios se anula y libera al heroe', async () => {
    const { enroll, executor, executions, enrollments, clears, combat, clock } = setup()
    combat.outcomes.push({
      kind: 'SIMULATED',
      result: { ...P01_RESULT, summary: { encountersCompleted: 5 } },
    })
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS

    await expect(executor.run()).resolves.toEqual(cycle({ voided: 1, released: 1 }))
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'VOIDED' })
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      settlement: { reason: 'INVALID_SIMULATION_RESULT' },
    })
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual([])
    // Nada queda pendiente: el siguiente ciclo no vuelve a intentarlo.
    await expect(executor.run()).resolves.toEqual(cycle())
  })

  it('una mision que desaparece del catalogo despues de simularse cierra con su copia', async () => {
    const { enroll, executor, runner, enrollments, commitments, clock } = setup()
    await enroll.execute(command())
    await executor.run()
    clock.current = ENDS

    await expect(runner(new InMemoryMissionCatalog([])).run()).resolves.toEqual(
      cycle({ settled: 1, released: 1 }),
    )
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'COMPLETED' })
    // La simulacion llego a hacerse: su referencia queda en el hecho.
    expect(settledPayloads(enrollments)).toEqual([
      expect.objectContaining({
        missionOutcome: 'COMPLETED',
        reason: null,
        simulationId: 'sim_p01',
      }),
    ])
    expect(commitments.releases).toEqual(['op-1'])
  })
})

describe('RunMissionExecutions: anulacion y liberacion (Task HU-72.2, CU-72.3)', () => {
  it('T-04: si Combat rechaza, la mision se anula sin penalizacion y el heroe se libera', async () => {
    const { enroll, executor, executions, enrollments, clears, combat, commitments } = setup()
    combat.outcomes.push({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, voided: 1, released: 1 }))
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({
      status: 'VOIDED',
      finishedAt: AT,
    })
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'VOIDED',
      settlement: { outcome: 'VOIDED', reason: 'INVALID_STRATEGY', objectives: [] },
    })
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual([])
    expect(settledPayloads(enrollments)).toEqual([
      expect.objectContaining({
        missionOutcome: 'VOIDED',
        reason: 'INVALID_STRATEGY',
        objectives: [],
        simulationId: null,
      }),
    ])
    expect(commitments.releases).toEqual(['op-1'])
    // Sin penalizacion: el mismo heroe puede volver a la misma mision.
    await expect(enroll.execute(command({ idempotencyKey: KEY_2 }))).resolves.toMatchObject({
      status: 'IN_PROGRESS',
    })
  })

  it('sin resultado pasado el plazo (endsAt + 30 min) se anula con SIMULATION_TIMEOUT (P-S8)', async () => {
    const { enroll, executor, executions, enrollments, combat, clock } = setup()
    combat.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await enroll.execute(command())
    await executor.run()

    clock.current = new Date(DEADLINE.getTime() + 1)
    await expect(executor.run()).resolves.toEqual(cycle({ voided: 1, released: 1 }))
    expect(combat.requests).toHaveLength(1)
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'VOIDED' })
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      settlement: { reason: 'SIMULATION_TIMEOUT' },
    })
  })

  it('un heroe que ya no es del jugador anula la mision sin llamar a Combat', async () => {
    const { enroll, executor, executions, combat, profiles } = setup()
    profiles.outcomes.push({ kind: 'NOT_OWNED' })
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, voided: 1, released: 1 }))
    expect(combat.requests).toHaveLength(0)
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      settlement: { reason: 'HERO_NOT_OWNED' },
    })
  })

  it('una mision retirada del catalogo se anula con MISSION_NOT_FOUND', async () => {
    const { enroll, runner, executions, combat } = setup()
    await enroll.execute(command())

    await expect(runner(new InMemoryMissionCatalog([])).run()).resolves.toEqual(
      cycle({ queued: 1, voided: 1, released: 1 }),
    )
    expect(combat.requests).toHaveLength(0)
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      settlement: { reason: 'MISSION_NOT_FOUND' },
    })
  })

  it('si liberar al heroe no tiene respuesta se reintenta, y se anota una sola vez (P-S10)', async () => {
    const { enroll, executor, executions, combat, commitments } = setup()
    commitments.releaseResult = 'UNKNOWN'
    combat.outcomes.push({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    await enroll.execute(command())

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, voided: 1 }))
    await expect(executions.findById('enr_1')).resolves.toMatchObject({ heroReleasedAt: null })

    commitments.releaseResult = 'RELEASED'
    await expect(executor.run()).resolves.toEqual(cycle({ released: 1 }))
    await expect(executor.run()).resolves.toEqual(cycle())
    expect(commitments.releases).toEqual(['op-1', 'op-1'])
  })

  it('dos procesos que anulan a la vez dejan una sola anulacion', async () => {
    const { enroll, executor, runner, enrollments, combat, clock } = setup()
    combat.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await enroll.execute(command())
    await executor.run()
    clock.current = new Date(DEADLINE.getTime() + 1)

    const [first, second] = await Promise.all([executor.simulateDue(), runner().simulateDue()])

    expect(first.voided + second.voided).toBe(1)
    expect(settledPayloads(enrollments)).toHaveLength(1)
  })

  it('dos procesos que liberan a la vez anotan una sola liberacion', async () => {
    const { enroll, executor, runner, combat, commitments } = setup()
    combat.outcomes.push({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    await enroll.execute(command())
    await executor.queueStarted()
    await executor.simulateDue()

    const [first, second] = await Promise.all([executor.releaseHeroes(), runner().releaseHeroes()])

    // Liberar en Player/Inventory es idempotente; anotarlo, no.
    expect(first.released + second.released).toBe(1)
    expect(commitments.releases).toEqual(['op-1', 'op-1'])
  })

  it('un fallo en una mision se informa, no detiene a las demas y vuelve a tocar tras el plazo', async () => {
    const { enroll, executor, executions, combat, clock, errors } = setup()
    combat.outcomes.push(new Error('socket hang up'))
    await enroll.execute(command())
    await enroll.execute(command({ playerId: 'sub-2', heroId: HERO_2, idempotencyKey: KEY_2 }))

    await expect(executor.run()).resolves.toEqual(cycle({ queued: 2, simulated: 1, failed: 1 }))
    expect(errors).toEqual([{ enrollmentId: 'enr_1', error: new Error('socket hang up') }])
    // La llamada quedo a medias: sigue pedida y el plazo del intento la devuelve a la cola.
    await expect(executions.findById('enr_1')).resolves.toMatchObject({
      status: 'REQUESTED',
      attempts: 1,
    })

    clock.advance(5_000)
    await expect(executor.run()).resolves.toEqual(cycle({ simulated: 1 }))
  })
})
