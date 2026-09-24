import { CombatSimulationClient } from '../../src/adapters/outbound/combat/CombatSimulationClient'
import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import {
  canonicalBody,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { InMemoryHeroAbilities } from '../../src/adapters/outbound/inventory/InMemoryHeroAbilities'
import { PlayerInventoryAbilitiesClient } from '../../src/adapters/outbound/inventory/PlayerInventoryAbilitiesClient'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import type { SimulationCallOutcome } from '../../src/application/ports/CombatSimulationPort'
import {
  simulationRequestFor,
  type RunMissionExecutions,
} from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  closeEnrollment,
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import {
  markHeroReleased,
  queueExecution,
  recordSimulation,
  requestSimulation,
  settleExecution,
  type SimulationRequest,
  type SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import {
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../src/domain/policies/SettlementPolicy'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'

const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_2 = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const PROFILE = { heroId: HERO, subtype: 'GUERRERO_ARMAS', level: 12 }
const [TEMPLO_DEFINITION] = EXAMPLE_MISSIONS as [MissionDefinition]

const inProgress = (enrollmentId = 'enr_1', playerId = 'sub-1', heroId = HERO): MissionEnrollment =>
  confirmEnrollment(
    newPendingEnrollment({
      enrollmentId,
      playerId,
      missionId: TEMPLO,
      heroId,
      difficulty: 'NORMAL',
      operationId: `op-${enrollmentId}`,
      idempotencyKey: `key-${enrollmentId}`,
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    }),
    'cmt-1',
    AT,
    720,
  )

const REQUEST: SimulationRequest = simulationRequestFor(
  queueExecution({ enrollmentId: 'enr_1', operationId: 'op-sim', endsAt: ENDS, now: AT }),
  inProgress(),
  TEMPLO_DEFINITION,
  PROFILE,
)
const COMBAT_PAYLOAD = { ...REQUEST }
Reflect.deleteProperty(COMBAT_PAYLOAD, 'contentSnapshot')

/** Cuerpo del fixture P-01 del contrato de HU-72. */
const P01_BODY = {
  simulationId: 'sim_p01',
  operationId: 'op-sim',
  seedRef: 'seed_p01',
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    minHealthPercent: 41.5,
    bossDefeated: true,
    master: { appeared: false, masterRef: null, defeated: false },
  },
  combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' }],
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}.`)
  }

  return value
}

const resultOf = (outcome: SimulationCallOutcome): SimulationResult => {
  if (outcome.kind !== 'SIMULATED') {
    throw new Error(`Se esperaba una simulacion y llego ${outcome.kind}.`)
  }

  return outcome.result
}

describe('CombatSimulationClient (HU-72)', () => {
  const clock = { now: (): Date => AT }
  const PATH = '/api/internal/v1/combat/simulations'

  /** `respond` crea una respuesta nueva por llamada: un cuerpo solo se lee una vez. */
  const clientReturning = (respond: () => Response | Error) => {
    const calls: { url: string; init: RequestInit }[] = []
    const failures: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
    const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      const response = respond()
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new CombatSimulationClient({
      baseUrl: 'http://combat:3004',
      secret: 'secreto',
      clock,
      timeoutMs: 1_000,
      fetchImpl,
      onFailure: (event, detail) => failures.push({ event, detail }),
    })

    return { client, calls, failures }
  }

  const headersOf = (call: { init: RequestInit } | undefined) =>
    call?.init.headers as Record<string, string>

  it('firma un POST con la ruta completa y el cuerpo canonico, y lee el resultado', async () => {
    const { client, calls, failures } = clientReturning(() => json(200, P01_BODY))

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'SIMULATED',
      result: {
        simulationId: 'sim_p01',
        seedRef: 'seed_p01',
        combatOutcome: 'HERO_VICTORIOUS',
        summary: P01_BODY.summary,
        combatLog: P01_BODY.combatLog,
      },
    })

    const [call] = calls
    expect(call?.url).toBe(`http://combat:3004${PATH}`)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.body).toBe(canonicalBody(COMBAT_PAYLOAD))
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)
    expect(headersOf(call)).toMatchObject({
      'content-type': 'application/json',
      'x-internal-service': 'missions',
      'x-internal-timestamp': String(AT.getTime()),
      'x-internal-signature': signInternalRequest('secreto', {
        service: 'missions',
        method: 'POST',
        path: PATH,
        timestamp: String(AT.getTime()),
        body: COMBAT_PAYLOAD,
      }),
    })
    expect(failures).toEqual([])
  })

  it('P-S3: la solicitud releida con otro orden de claves se envia y se firma igual', async () => {
    const { client, calls } = clientReturning(() => json(503, {}))
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(REQUEST).reverse())),
    ) as SimulationRequest

    await client.simulate(REQUEST)
    await client.simulate(reordered)

    expect(calls[1]?.init.body).toBe(calls[0]?.init.body)
    expect(headersOf(calls[1])['x-internal-signature']).toBe(
      headersOf(calls[0])['x-internal-signature'],
    )
  })

  it('conserva la definicion local sin enviarla a Combat', async () => {
    const { client, calls } = clientReturning(() => json(200, P01_BODY))
    await client.simulate({ ...REQUEST, contentSnapshot: EXAMPLE_MISSIONS[0]! })
    expect(calls[0]?.init.body).toBe(canonicalBody(COMBAT_PAYLOAD))
    expect(headersOf(calls[0])['x-internal-signature']).toBe(
      signInternalRequest('secreto', {
        service: 'missions',
        method: 'POST',
        path: PATH,
        timestamp: String(AT.getTime()),
        body: COMBAT_PAYLOAD,
      }),
    )
  })

  it('sin seedRef, la referencia queda en null', async () => {
    // JSON.stringify omite la clave: el cuerpo llega sin seedRef.
    const { client } = clientReturning(() => json(200, { ...P01_BODY, seedRef: undefined }))

    expect(resultOf(await client.simulate(REQUEST)).seedRef).toBeNull()
  })

  it.each([
    ['de otra operacion', { ...P01_BODY, operationId: 'op-otra' }],
    ['sin simulationId', { ...P01_BODY, simulationId: '' }],
    ['con un combatOutcome desconocido', { ...P01_BODY, combatOutcome: 'DRAW' }],
    ['sin los hechos del resumen', { ...P01_BODY, summary: { totalTurns: 3 } }],
    ['sin combatLog', { ...P01_BODY, combatLog: undefined }],
  ])('un 200 %s no se da por bueno', async (_caso, body) => {
    const { client, failures } = clientReturning(() => json(200, body))

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
    expect(failures).toEqual([
      { event: 'combat_respuesta_invalida', detail: { path: PATH, status: 200 } },
    ])
  })

  it('un 200 sin JSON no se da por bueno', async () => {
    const { client } = clientReturning(() => new Response('ok', { status: 200 }))

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
  })

  it('un 422 con codigo es un rechazo definitivo: la mision se anula (P-S7)', async () => {
    const { client, failures } = clientReturning(() =>
      json(422, { code: 'INVALID_STRATEGY', message: 'x' }),
    )

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'REJECTED',
      code: 'INVALID_STRATEGY',
    })
    expect(failures).toEqual([])
  })

  it('un 401 del guard HMAC se avisa y no se reintenta aunque no traiga code', async () => {
    const { client, failures } = clientReturning(() =>
      json(401, { message: 'Peticion interna no autorizada.' }),
    )

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'REJECTED',
      code: 'INTERNAL_SIGNATURE_INVALID',
    })
    expect(failures).toEqual([
      { event: 'combat_autorizacion_rechazada', detail: { path: PATH, status: 401 } },
    ])
  })

  it.each([400, 409])(
    'un %i con codigo es un error de programacion: se anula y se avisa',
    async (status) => {
      const { client, failures } = clientReturning(() =>
        json(status, { code: 'SCHEMA_VERSION_UNSUPPORTED' }),
      )

      await expect(client.simulate(REQUEST)).resolves.toEqual({
        kind: 'REJECTED',
        code: 'SCHEMA_VERSION_UNSUPPORTED',
      })
      expect(failures).toEqual([
        {
          event: 'combat_rechazo_de_programacion',
          detail: { path: PATH, status, code: 'SCHEMA_VERSION_UNSUPPORTED' },
        },
      ])
    },
  )

  it.each([
    [422, {}],
    [404, { message: `Cannot POST ${PATH}`, statusCode: 404 }],
    [500, {}],
    [503, { code: 'COMBAT_BUSY' }],
  ])('un %i sin rechazo definitivo es desconocido y se reintenta', async (status, body) => {
    const { client, failures } = clientReturning(() => json(status, body))

    await expect(client.simulate(REQUEST)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: `HTTP_${String(status)}`,
    })
    expect(failures).toEqual([{ event: 'combat_sin_resultado', detail: { path: PATH, status } }])
  })

  it('un error de red es desconocido y el registro no lleva el cuerpo', async () => {
    const { client, failures } = clientReturning(() => new TypeError('fetch failed'))

    await expect(client.simulate(REQUEST)).resolves.toEqual({ kind: 'UNKNOWN', reason: 'NETWORK' })
    expect(failures).toEqual([
      { event: 'combat_inalcanzable', detail: { path: PATH, reason: 'NETWORK' } },
    ])
  })

  it('un tiempo agotado es TIMEOUT', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    const { client } = clientReturning(() => timeout)

    await expect(client.simulate(REQUEST)).resolves.toEqual({ kind: 'UNKNOWN', reason: 'TIMEOUT' })
  })

  it('el doble de desarrollo cumple el contrato que valida el cliente', async () => {
    const scripted = await new ScriptedCombatSimulation().simulate(REQUEST)
    const { client } = clientReturning(() =>
      json(200, { operationId: REQUEST.operationId, ...resultOf(scripted) }),
    )

    await expect(client.simulate(REQUEST)).resolves.toEqual(scripted)
  })
})

describe('ScriptedCombatSimulation (HU-72)', () => {
  it('vence todos los encuentros sin dano y sin aleatoriedad', async () => {
    const outcome = await new ScriptedCombatSimulation().simulate(REQUEST)
    const result = resultOf(outcome)

    expect(result).toMatchObject({
      simulationId: 'sim_op-sim',
      seedRef: null,
      combatOutcome: 'HERO_VICTORIOUS',
    })
    expect(simulationFactsOf(result.summary)).toEqual({
      encountersCompleted: 5,
      encountersTotal: 5,
      bossDefeated: true,
      minHealthPercent: 100,
      master: { appeared: false, defeated: false },
    })
    expect(result.summary).toMatchObject({
      simulatedDuration: 'PT12H',
      enemiesDefeated: [
        { enemyRef: 'sombra-corrompida', count: 10 },
        { enemyRef: 'guardian-de-piedra', count: 5 },
        { enemyRef: 'espectro-ancestral', count: 3 },
        { enemyRef: 'guardian-eterno', count: 1 },
      ],
    })
    expect(result.combatLog).toHaveLength(11)
    expect(result.combatLog.at(-1)).toEqual({
      seq: 11,
      type: 'simulationFinished',
      combatOutcome: 'HERO_VICTORIOUS',
    })
    // La misma solicitud da el mismo resultado.
    await expect(new ScriptedCombatSimulation().simulate(REQUEST)).resolves.toEqual(outcome)
  })

  it('sin encuentro de jefe, el jefe no cuenta como derrotado', async () => {
    const outcome = await new ScriptedCombatSimulation().simulate({
      ...REQUEST,
      encounters: REQUEST.encounters.slice(0, 1),
    })

    expect(simulationFactsOf(resultOf(outcome).summary)).toMatchObject({
      encountersTotal: 1,
      bossDefeated: false,
    })
  })
})

describe('InMemoryExecutionRepository (HU-72)', () => {
  /** Dos matriculas iniciadas, de jugadores distintos, con su hecho sin procesar. */
  const repositories = async () => {
    const enrollments = new InMemoryEnrollmentRepository()
    const clears = new InMemoryDifficultyClearRepository()

    for (const [enrollmentId, playerId, heroId] of [
      ['enr_1', 'sub-1', HERO],
      ['enr_2', 'sub-2', HERO_2],
    ] as const) {
      const confirmed = inProgress(enrollmentId, playerId, heroId)
      await enrollments.insertPending({ ...confirmed, status: 'PENDING', version: 0 })
      await enrollments.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed))
    }

    return {
      enrollments,
      clears,
      executions: new InMemoryExecutionRepository(
        enrollments,
        clears,
        new InMemoryReportRepository(),
      ),
    }
  }

  const queued = (enrollmentId: string, now = AT) =>
    queueExecution({ enrollmentId, operationId: `sim-${enrollmentId}`, endsAt: ENDS, now })

  it('programa una sola ejecucion por matricula y marca el hecho como procesado', async () => {
    const { executions } = await repositories()
    const starts = await executions.pendingStarts(10)

    expect(starts).toEqual([
      { factId: '1', enrollmentId: 'enr_1' },
      { factId: '2', enrollmentId: 'enr_2' },
    ])
    await executions.queue(queued('enr_1'), '1')
    await executions.queue({ ...queued('enr_1'), operationId: 'otra' }, '1')

    await expect(executions.pendingStarts(10)).resolves.toEqual([
      { factId: '2', enrollmentId: 'enr_2' },
    ])
    await expect(executions.findById('enr_1')).resolves.toMatchObject({ operationId: 'sim-enr_1' })
    await expect(executions.findById('enr_x')).resolves.toBeNull()
  })

  it('due: solo las pendientes vencidas, las mas atrasadas primero y con limite', async () => {
    const { executions } = await repositories()
    await executions.queue(queued('enr_1', new Date(AT.getTime() + 10_000)), '1')
    await executions.queue(queued('enr_2'), '2')

    const ids = async (now: Date, limit = 10) =>
      (await executions.due(now, limit)).map((execution) => execution.enrollmentId)

    await expect(ids(new Date(AT.getTime() + 10_000))).resolves.toEqual(['enr_2', 'enr_1'])
    await expect(ids(new Date(AT.getTime() + 9_999))).resolves.toEqual(['enr_2'])
    await expect(ids(new Date(AT.getTime() + 10_000), 1)).resolves.toEqual(['enr_2'])

    const requested = requestSimulation(queued('enr_2'), REQUEST, AT)
    await executions.saveTransition(requested, 0)
    await executions.saveTransition(
      recordSimulation(
        requested,
        resultOf(await new ScriptedCombatSimulation().simulate(REQUEST)),
        AT,
      ),
      1,
    )
    await expect(ids(ENDS)).resolves.toEqual(['enr_1'])
  })

  it('una transicion exige la version leida', async () => {
    const { executions } = await repositories()
    await executions.queue(queued('enr_1'), '1')
    const requested = requestSimulation(queued('enr_1'), REQUEST, AT)

    await expect(executions.saveTransition(requested, 5)).resolves.toBe(false)
    await expect(executions.saveTransition(requested, 0)).resolves.toBe(true)
    await expect(executions.saveTransition(requested, 0)).resolves.toBe(false)
    await expect(
      executions.saveTransition({ ...requested, enrollmentId: 'enr_x' }, 0),
    ).resolves.toBe(false)
  })

  it('cierra todo junto, o nada si otro proceso cambio antes la matricula', async () => {
    const { enrollments, clears, executions } = await repositories()
    await executions.queue(queued('enr_1'), '1')
    const requested = requestSimulation(queued('enr_1'), REQUEST, AT)
    const simulated = recordSimulation(
      requested,
      resultOf(await new ScriptedCombatSimulation().simulate(REQUEST)),
      AT,
    )
    await executions.saveTransition(requested, 0)
    await executions.saveTransition(simulated, 1)

    await expect(executions.closable(new Date(ENDS.getTime() - 1), 10)).resolves.toEqual([])
    await expect(executions.closable(ENDS, 10)).resolves.toEqual([simulated])

    const enrollment = inProgress()
    const settlement = settlementOf(
      'HERO_VICTORIOUS',
      TEMPLO_DEFINITION.objectives,
      required(simulationFactsOf(simulated.result?.summary), 'los hechos del resumen'),
    )
    const closure = {
      enrollment: closeEnrollment(enrollment, 'COMPLETED', ENDS),
      enrollmentVersion: enrollment.version,
      execution: settleExecution(simulated, settlement, ENDS),
      executionVersion: simulated.version,
      clear: {
        playerId: 'sub-1',
        missionId: TEMPLO,
        difficulty: 'NORMAL' as const,
        completedAt: ENDS,
      },
      fact: missionSettledFact(enrollment, settlement, 'sim_op-sim', ENDS),
      masters: [],
      report: null,
    }

    await expect(executions.close({ ...closure, enrollmentVersion: 0 })).resolves.toBe(false)
    await expect(executions.close({ ...closure, executionVersion: 1 })).resolves.toBe(false)
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'IN_PROGRESS' })
    await expect(executions.findById('enr_1')).resolves.toMatchObject({ status: 'SIMULATED' })
    expect(enrollments.recordedFacts().map((fact) => fact.type)).not.toContain('MissionSettled')
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual([])

    await expect(executions.close(closure)).resolves.toBe(true)
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'COMPLETED' })
    await expect(executions.findById('enr_1')).resolves.toMatchObject({ status: 'SETTLED' })
    expect(enrollments.recordedFacts().map((fact) => fact.type)).toContain('MissionSettled')
    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual(['NORMAL'])
    await expect(executions.close(closure)).resolves.toBe(false)

    const [awaiting] = await executions.awaitingRelease(10)
    expect(awaiting?.enrollmentId).toBe('enr_1')
    await executions.saveTransition(
      markHeroReleased(required(awaiting, 'la ejecucion cerrada'), ENDS),
      awaiting?.version ?? -1,
    )
    await expect(executions.awaitingRelease(10)).resolves.toEqual([])
  })
})

describe('MissionExecutionScheduler (HU-72)', () => {
  const logger = (): Logger & { events: string[] } => {
    const events: string[] = []
    const record = (message: string): void => {
      events.push(message)
    }

    return { events, debug: record, info: record, warn: record, error: record }
  }

  const executionsReturning = (run: () => Promise<unknown>) =>
    ({ run }) as unknown as RunMissionExecutions

  const zero = {
    queued: 0,
    simulated: 0,
    retried: 0,
    settled: 0,
    voided: 0,
    released: 0,
    failed: 0,
  }

  it('registra solo los ciclos que cambiaron algo', async () => {
    const log = logger()
    await new MissionExecutionScheduler(
      executionsReturning(() => Promise.resolve(zero)),
      log,
      1_000,
      false,
    ).tick()
    expect(log.events).toEqual([])

    await new MissionExecutionScheduler(
      executionsReturning(() => Promise.resolve({ ...zero, settled: 1 })),
      log,
      1_000,
      false,
    ).tick()
    expect(log.events).toEqual(['mission_execution_cycle'])
  })

  it('un ciclo que falla se registra y no rompe los siguientes', async () => {
    const log = logger()
    const scheduler = new MissionExecutionScheduler(
      executionsReturning(() => Promise.reject(new Error('db caida'))),
      log,
      1_000,
      false,
    )

    await scheduler.tick()
    await scheduler.tick()

    expect(log.events).toEqual(['mission_execution_failed', 'mission_execution_failed'])
  })

  it('no solapa dos ciclos', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const scheduler = new MissionExecutionScheduler(
      executionsReturning(() => {
        calls += 1
        return new Promise((resolve) => {
          release = () => {
            resolve(zero)
          }
        })
      }),
      logger(),
      1_000,
      false,
    )

    const first = scheduler.tick()
    await scheduler.tick()
    release()
    await first

    expect(calls).toBe(1)
  })

  it('arranca solo si esta habilitado y ejecuta en cada intervalo', async () => {
    jest.useFakeTimers()
    try {
      let calls = 0
      const run = () => {
        calls += 1
        return Promise.resolve(zero)
      }
      const disabled = new MissionExecutionScheduler(
        executionsReturning(run),
        logger(),
        1_000,
        false,
      )
      disabled.onModuleInit()
      await jest.advanceTimersByTimeAsync(3_000)
      expect(calls).toBe(0)

      const enabled = new MissionExecutionScheduler(executionsReturning(run), logger(), 1_000, true)
      enabled.onModuleInit()
      enabled.start()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(calls).toBe(2)

      enabled.onModuleDestroy()
      enabled.stop()
      await jest.advanceTimersByTimeAsync(3_000)
      expect(calls).toBe(2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('Perfil del heroe para la simulacion (HU-72)', () => {
  const clientReturning = (response: Response | Error) =>
    new PlayerInventoryAbilitiesClient({
      baseUrl: 'http://player-inventory:3002',
      secret: 'secreto',
      clock: { now: (): Date => AT },
      timeoutMs: 1_000,
      fetchImpl: () =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    })

  it('Player/Inventory: el perfil es el cuerpo de la ruta del heroe, sin interpretarlo', async () => {
    const body = { heroId: HERO, abilities: [{ abilityId: 'a' }], stats: { attack: 30 } }

    await expect(clientReturning(json(200, body)).profileOf('sub-1', HERO)).resolves.toEqual({
      kind: 'FOUND',
      profile: body,
    })
  })

  it.each([
    ['el heroe es de otro jugador', json(404, { code: 'HERO_NOT_OWNED' }), { kind: 'NOT_OWNED' }],
    ['no hay respuesta', json(503, {}), { kind: 'UNKNOWN', reason: 'HTTP_503' }],
    [
      'el cuerpo no cumple el contrato',
      json(200, { heroId: 'otro', abilities: [] }),
      { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE' },
    ],
    ['falla la red', new TypeError('fetch failed'), { kind: 'UNKNOWN', reason: 'NETWORK' }],
  ])('sin perfil cuando %s', async (_caso, response, expected) => {
    await expect(clientReturning(response).profileOf('sub-1', HERO)).resolves.toEqual(expected)
  })

  it('el doble de desarrollo da el heroe con sus habilidades', async () => {
    await expect(new InMemoryHeroAbilities(['x']).profileOf('sub-1', HERO)).resolves.toMatchObject({
      kind: 'FOUND',
      profile: {
        heroId: HERO,
        effectiveStats: { health: 40, attack: 10 },
        abilities: [{ abilityId: 'x', powerCost: { mode: 'FIXED', amount: 2 } }],
      },
    })
  })
})

describe('Configuracion de HU-72', () => {
  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'pool',
    COGNITO_CLIENT_ID: 'cliente',
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/missions',
  }

  it('en desarrollo la simulacion usa el doble; en produccion, Combat', () => {
    expect(loadConfig({}).combatSimulationDriver).toBe('memory')
    expect(loadConfig(production).combatSimulationDriver).toBe('http')
    expect(loadConfig({ COMBAT_SIMULATION_DRIVER: 'http' }).combatSimulationDriver).toBe('http')
  })

  it('prohibe el doble de Combat en produccion', () => {
    expect(() => loadConfig({ ...production, COMBAT_SIMULATION_DRIVER: 'memory' })).toThrow(
      new ConfigurationError(
        'COMBAT_SIMULATION_DRIVER no puede ser "memory" con NODE_ENV=production.',
      ),
    )
  })

  it('la URL de Combat pierde la barra final, y sin valor queda en null', () => {
    expect(loadConfig({ COMBAT_BASE_URL: 'http://combat:3004//' }).combatBaseUrl).toBe(
      'http://combat:3004',
    )
    expect(loadConfig({}).combatBaseUrl).toBeNull()
  })

  it('el planificador esta apagado por defecto y los tiempos tienen limites', () => {
    expect(loadConfig({})).toMatchObject({
      combatSimulationTimeoutMs: 15_000,
      missionExecutionEnabled: false,
      missionExecutionIntervalMs: 15_000,
    })
    expect(
      loadConfig({
        COMBAT_SIMULATION_TIMEOUT_MS: '120000',
        MISSION_EXECUTION_ENABLED: 'true',
        MISSION_EXECUTION_INTERVAL_MS: '1000',
      }),
    ).toMatchObject({
      combatSimulationTimeoutMs: 120_000,
      missionExecutionEnabled: true,
      missionExecutionIntervalMs: 1_000,
    })
    expect(() => loadConfig({ COMBAT_SIMULATION_TIMEOUT_MS: '999' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ COMBAT_SIMULATION_TIMEOUT_MS: '120001' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ MISSION_EXECUTION_INTERVAL_MS: '999' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ MISSION_EXECUTION_ENABLED: 'si' })).toThrow(ConfigurationError)
  })
})
