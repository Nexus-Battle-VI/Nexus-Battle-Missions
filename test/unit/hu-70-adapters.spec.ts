import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { toMissionsHttpException } from '../../src/adapters/inbound/http/missions-error.mapper'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { InMemoryHeroCommitments } from '../../src/adapters/outbound/inventory/InMemoryHeroCommitments'
import { PlayerInventoryCommitmentClient } from '../../src/adapters/outbound/inventory/PlayerInventoryCommitmentClient'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { RandomIdGenerator } from '../../src/adapters/outbound/system/RandomIdGenerator'
import type { CommitHeroRequest } from '../../src/application/ports/HeroCommitmentPort'
import type { ReconcilePendingEnrollments } from '../../src/application/use-cases/ReconcilePendingEnrollments'
import {
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import {
  EnrollmentExpiredError,
  EnrollmentPendingError,
  HeroBusyError,
  HeroNotOwnedError,
  HeroNotReadyError,
  IdempotencyKeyReusedError,
  LoadoutIncompleteError,
  MissionAlreadyInProgressError,
  MissionLockedError,
  MissionNotFoundError,
  StrategyVersionMismatchError,
} from '../../src/domain/errors/mission-errors'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { EnrollmentReconcilerScheduler } from '../../src/infrastructure/scheduling/EnrollmentReconcilerScheduler'

const AT = new Date('2026-10-01T15:00:00.000Z')
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

const enrollment = (overrides: Partial<MissionEnrollment> = {}): MissionEnrollment => ({
  ...newPendingEnrollment({
    enrollmentId: 'enr_1',
    playerId: 'sub-1',
    missionId: 'msn_templo_olvidado',
    heroId: HERO,
    difficulty: 'NORMAL',
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'fp',
    strategyVersion: null,
    requestedAt: AT,
  }),
  ...overrides,
})

describe('InMemoryEnrollmentRepository (HU-70)', () => {
  it('reproduce los indices unicos del motor', async () => {
    const repository = new InMemoryEnrollmentRepository()
    await repository.insertPending(enrollment())

    await expect(repository.insertPending(enrollment({ enrollmentId: 'enr_2' }))).resolves.toEqual({
      kind: 'CONFLICT',
      reason: 'IDEMPOTENCY_KEY',
    })
    await expect(
      repository.insertPending(enrollment({ enrollmentId: 'enr_2', idempotencyKey: 'key-2' })),
    ).resolves.toEqual({ kind: 'CONFLICT', reason: 'HERO_ACTIVE' })
    await expect(
      repository.insertPending(
        enrollment({ enrollmentId: 'enr_2', idempotencyKey: 'key-2', heroId: 'otro' }),
      ),
    ).resolves.toEqual({ kind: 'CONFLICT', reason: 'PLAYER_MISSION_ACTIVE' })
  })

  it('una matricula terminada libera al heroe', async () => {
    const repository = new InMemoryEnrollmentRepository()
    await repository.insertPending(enrollment({ status: 'EXPIRED' }))

    await expect(
      repository.insertPending(enrollment({ enrollmentId: 'enr_2', idempotencyKey: 'key-2' })),
    ).resolves.toEqual({ kind: 'INSERTED' })
    await expect(repository.findActiveByHero(HERO)).resolves.toMatchObject({
      enrollmentId: 'enr_2',
    })
  })

  it('guarda una transicion solo con la version esperada, con su hecho', async () => {
    const repository = new InMemoryEnrollmentRepository()
    const pending = enrollment()
    await repository.insertPending(pending)
    const confirmed = confirmEnrollment(pending, 'cmt-1', AT, 60)

    await expect(repository.saveTransition(confirmed, 5, null)).resolves.toBe(false)
    await expect(
      repository.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed)),
    ).resolves.toBe(true)
    expect(repository.recordedFacts()).toHaveLength(1)
    await expect(repository.saveTransition(confirmed, 0, null)).resolves.toBe(false)
  })

  it('lista las pendientes mas viejas primero, antes del corte y con limite', async () => {
    const repository = new InMemoryEnrollmentRepository()
    await repository.insertPending(enrollment({ requestedAt: new Date('2026-10-01T15:02:00Z') }))
    await repository.insertPending(
      enrollment({
        enrollmentId: 'enr_2',
        idempotencyKey: 'k2',
        heroId: 'h2',
        missionId: 'm2',
        requestedAt: new Date('2026-10-01T15:01:00Z'),
      }),
    )
    await repository.insertPending(
      enrollment({
        enrollmentId: 'enr_3',
        idempotencyKey: 'k3',
        heroId: 'h3',
        missionId: 'm3',
        requestedAt: new Date('2026-10-01T15:09:00Z'),
      }),
    )

    const listed = await repository.listPendingRequestedBefore(new Date('2026-10-01T15:05:00Z'), 1)

    expect(listed.map((item) => item.enrollmentId)).toEqual(['enr_2'])
  })
})

describe('InMemoryMissionCatalog (HU-70)', () => {
  it('ordena por nombre y separa activas de retiradas', async () => {
    const retired = { ...EXAMPLE_MISSIONS[0]!, active: false }
    const catalog = new InMemoryMissionCatalog([EXAMPLE_MISSIONS[1]!, retired])

    expect((await catalog.listActive()).map((mission) => mission.name)).toEqual([
      'La Cámara Sellada',
    ])
    await expect(catalog.findActive(retired.missionId)).resolves.toBeNull()
    await expect(catalog.findById(retired.missionId)).resolves.toMatchObject({ active: false })
    await expect(new InMemoryMissionCatalog().listActive()).resolves.toEqual([])
  })
})

describe('InMemoryHeroCommitments (HU-70)', () => {
  const request = (overrides: Partial<CommitHeroRequest> = {}): CommitHeroRequest => ({
    operationId: 'op-1',
    playerId: 'sub-1',
    heroId: HERO,
    reference: 'enr_1',
    expiresAt: AT,
    requireCompleteLoadout: true,
    ...overrides,
  })

  it('concede, repite lo mismo con el mismo operationId y libera', async () => {
    const commitments = new InMemoryHeroCommitments()

    await expect(commitments.commit(request())).resolves.toEqual({
      kind: 'GRANTED',
      commitmentId: 'cmt_op-1',
    })
    await expect(commitments.commit(request())).resolves.toMatchObject({ kind: 'GRANTED' })
    await expect(commitments.commit(request({ reference: 'otra' }))).resolves.toMatchObject({
      kind: 'UNKNOWN',
    })
    await expect(commitments.commit(request({ operationId: 'op-2' }))).resolves.toMatchObject({
      kind: 'REJECTED',
      rejection: { code: 'HERO_COMMITTED', busyWith: 'MISSION' },
    })
    await expect(commitments.release('op-1')).resolves.toBe('RELEASED')
    await expect(commitments.commit(request({ operationId: 'op-2' }))).resolves.toMatchObject({
      kind: 'GRANTED',
    })
  })
})

describe('RandomIdGenerator (HU-70)', () => {
  it('genera UUID y el prefijo enr_ para las matriculas', () => {
    const ids = new RandomIdGenerator()

    expect(ids.newEnrollmentId()).toMatch(/^enr_[0-9a-f-]{36}$/)
    expect(ids.newOperationId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('PlayerInventoryCommitmentClient (HU-70)', () => {
  const clock = { now: (): Date => AT }
  const COMMIT_PATH = `/api/internal/v1/inventory/heroes/${HERO}/commitments`
  const request: CommitHeroRequest = {
    operationId: 'op-1',
    playerId: 'sub-1',
    heroId: HERO,
    reference: 'enr_1',
    expiresAt: new Date('2026-10-02T03:32:00.000Z'),
    requireCompleteLoadout: true,
  }

  const clientReturning = (response: Response | Error) => {
    const calls: { url: string; init: RequestInit }[] = []
    const failures: string[] = []
    const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new PlayerInventoryCommitmentClient({
      baseUrl: 'http://player-inventory:3002',
      secret: 'secreto',
      clock,
      timeoutMs: 1_000,
      fetchImpl,
      onFailure: (event) => failures.push(event),
    })

    return { client, calls, failures }
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('firma la ruta COMPLETA y concede con 201', async () => {
    const { client, calls } = clientReturning(json(201, { commitmentId: 'cmt-9' }))

    await expect(client.commit(request)).resolves.toEqual({
      kind: 'GRANTED',
      commitmentId: 'cmt-9',
    })

    const call = calls[0]!
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>
    const headers = call.init.headers as Record<string, string>
    expect(call.url).toBe(`http://player-inventory:3002${COMMIT_PATH}`)
    expect(body).toEqual({
      operationId: 'op-1',
      playerId: 'sub-1',
      purpose: 'MISSION',
      reference: 'enr_1',
      expiresAt: '2026-10-02T03:32:00.000Z',
      requirements: { completeLoadout: true },
    })
    expect(headers['x-internal-service']).toBe('missions')
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('secreto', {
        service: 'missions',
        method: 'POST',
        path: COMMIT_PATH,
        timestamp: String(AT.getTime()),
        body,
      }),
    )
  })

  it('una respuesta 201 sin commitmentId no se da por buena', async () => {
    const { client, failures } = clientReturning(json(201, {}))

    await expect(client.commit(request)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
    expect(failures).toEqual(['player_inventory_respuesta_invalida'])
  })

  it.each([
    [{ code: 'HERO_NOT_OWNED' }, { code: 'HERO_NOT_OWNED' }],
    [
      { code: 'HERO_NOT_READY', blockers: [{ code: 'HERO_NOT_ACTIVE', slot: null }] },
      { code: 'HERO_NOT_READY', blockers: [{ code: 'HERO_NOT_ACTIVE', slot: null }] },
    ],
    [{ code: 'HERO_NOT_READY' }, { code: 'HERO_NOT_READY', blockers: [] }],
    [
      { code: 'LOADOUT_INCOMPLETE', missingSlots: [{ family: 'ITEM', missing: 2 }] },
      { code: 'LOADOUT_INCOMPLETE', missingSlots: [{ family: 'ITEM', missing: 2 }] },
    ],
    [{ code: 'LOADOUT_INCOMPLETE' }, { code: 'LOADOUT_INCOMPLETE', missingSlots: [] }],
    [
      { code: 'HERO_COMMITTED', purpose: 'TOURNAMENT' },
      { code: 'HERO_COMMITTED', busyWith: 'TOURNAMENT' },
    ],
    [
      { code: 'HERO_COMMITTED', purpose: 'RAID' },
      { code: 'HERO_COMMITTED', busyWith: null },
    ],
  ])('un 422 %j es un rechazo terminal', async (body, rejection) => {
    const { client } = clientReturning(json(422, body))

    await expect(client.commit(request)).resolves.toEqual({ kind: 'REJECTED', rejection })
  })

  it.each([
    ['un 422 con codigo desconocido', json(422, { code: 'OTRO' }), 'HTTP_422'],
    ['un 422 sin JSON', new Response('no es json', { status: 422 }), 'HTTP_422'],
    ['la ruta aun inexistente (404)', json(404, {}), 'HTTP_404'],
    ['un 409 de operationId', json(409, { code: 'OPERATION_ID_REUSED' }), 'HTTP_409'],
    ['un 503', json(503, {}), 'HTTP_503'],
  ])('%s es un resultado desconocido', async (_caso, response, reason) => {
    const { client } = clientReturning(response)

    await expect(client.commit(request)).resolves.toEqual({ kind: 'UNKNOWN', reason })
  })

  it('un error de red es desconocido y se registra', async () => {
    const { client, failures } = clientReturning(new TypeError('fetch failed'))

    await expect(client.commit(request)).resolves.toEqual({ kind: 'UNKNOWN', reason: 'NETWORK' })
    expect(failures).toEqual(['player_inventory_inalcanzable'])
  })

  it('libera por operationId: 204 confirma y cualquier otra cosa no', async () => {
    const released = clientReturning(new Response(null, { status: 204 }))
    await expect(released.client.release('op-1')).resolves.toBe('RELEASED')
    expect(released.calls[0]?.url).toBe(
      'http://player-inventory:3002/api/internal/v1/inventory/commitments/op-1/release',
    )

    await expect(clientReturning(json(500, {})).client.release('op-1')).resolves.toBe('UNKNOWN')
    await expect(clientReturning(new Error('x')).client.release('op-1')).resolves.toBe('UNKNOWN')
  })
})

describe('EnrollmentReconcilerScheduler (HU-70)', () => {
  const logger = (): Logger & { events: string[] } => {
    const events: string[] = []
    const record = (message: string): void => {
      events.push(message)
    }

    return { events, debug: record, info: record, warn: record, error: record }
  }

  const reconcileReturning = (execute: () => Promise<unknown>) =>
    ({ execute }) as unknown as ReconcilePendingEnrollments

  const zero = { confirmed: 0, rejected: 0, expired: 0, stillPending: 0, failed: 0 }

  it('registra solo los ciclos que cambiaron algo', async () => {
    const log = logger()
    const quiet = new EnrollmentReconcilerScheduler(
      reconcileReturning(() => Promise.resolve(zero)),
      log,
      1_000,
      false,
    )
    await quiet.tick()
    expect(log.events).toEqual([])

    const busy = new EnrollmentReconcilerScheduler(
      reconcileReturning(() => Promise.resolve({ ...zero, confirmed: 1 })),
      log,
      1_000,
      false,
    )
    await busy.tick()
    expect(log.events).toEqual(['enrollment_reconciler_cycle'])
  })

  it('un ciclo que falla se registra y no rompe los siguientes', async () => {
    const log = logger()
    const scheduler = new EnrollmentReconcilerScheduler(
      reconcileReturning(() => Promise.reject(new Error('db caida'))),
      log,
      1_000,
      false,
    )

    await scheduler.tick()
    await scheduler.tick()

    expect(log.events).toEqual(['enrollment_reconciler_failed', 'enrollment_reconciler_failed'])
  })

  it('no solapa dos ciclos', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const scheduler = new EnrollmentReconcilerScheduler(
      reconcileReturning(() => {
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
      const execute = () => {
        calls += 1
        return Promise.resolve(zero)
      }
      const disabled = new EnrollmentReconcilerScheduler(
        reconcileReturning(execute),
        logger(),
        1_000,
        false,
      )
      disabled.onModuleInit()
      await jest.advanceTimersByTimeAsync(3_000)
      expect(calls).toBe(0)

      const enabled = new EnrollmentReconcilerScheduler(
        reconcileReturning(execute),
        logger(),
        1_000,
        true,
      )
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

describe('Errores de HU-70 en HTTP', () => {
  it.each([
    [new MissionNotFoundError('m'), NotFoundException, 'MISSION_NOT_FOUND'],
    [new MissionLockedError('m', ['a'], 'x'), UnprocessableEntityException, 'MISSION_LOCKED'],
    [new HeroBusyError('h', 'BATTLE'), ConflictException, 'HERO_BUSY'],
    [new HeroBusyError('h', null), ConflictException, 'HERO_BUSY'],
    [new MissionAlreadyInProgressError('m', 'e'), ConflictException, 'MISSION_ALREADY_IN_PROGRESS'],
    [new IdempotencyKeyReusedError(), ConflictException, 'IDEMPOTENCY_KEY_REUSED'],
    [new EnrollmentExpiredError('e'), ConflictException, 'ENROLLMENT_EXPIRED'],
    [new StrategyVersionMismatchError(1, null), ConflictException, 'STRATEGY_VERSION_MISMATCH'],
    [new HeroNotOwnedError('h'), UnprocessableEntityException, 'HERO_NOT_OWNED'],
    [new HeroNotReadyError([]), UnprocessableEntityException, 'HERO_NOT_READY'],
    [new LoadoutIncompleteError([]), UnprocessableEntityException, 'LOADOUT_INCOMPLETE'],
    [new EnrollmentPendingError('e'), ServiceUnavailableException, 'DEPENDENCY_UNAVAILABLE'],
  ])('%p responde su codigo estable', (error, type, code) => {
    const exception = toMissionsHttpException(error)

    expect(exception).toBeInstanceOf(type)
    expect(exception.getResponse()).toMatchObject({ code, message: error.message })
  })

  it('la matricula pendiente indica su estado para que el cliente reintente', () => {
    expect(
      toMissionsHttpException(new EnrollmentPendingError('enr_1')).getResponse(),
    ).toMatchObject({ enrollmentId: 'enr_1', enrollmentStatus: 'PENDING' })
  })
})

describe('Configuracion de HU-70', () => {
  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'pool',
    COGNITO_CLIENT_ID: 'cliente',
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/missions',
  }

  it('en desarrollo usa el doble de compromisos y apaga el reconciliador', () => {
    expect(loadConfig({})).toMatchObject({
      heroCommitmentsDriver: 'memory',
      playerInventoryBaseUrl: null,
      internalHttpTimeoutMs: 3_000,
      enrollmentReconcilerEnabled: false,
      enrollmentReconcilerIntervalMs: 15_000,
      exampleCatalog: false,
    })
  })

  it('en produccion reserva por HTTP y arranca aunque falte la URL', () => {
    expect(loadConfig(production)).toMatchObject({
      heroCommitmentsDriver: 'http',
      playerInventoryBaseUrl: null,
    })
  })

  it('prohibe el doble de compromisos en produccion', () => {
    expect(() => loadConfig({ ...production, HERO_COMMITMENTS_DRIVER: 'memory' })).toThrow(
      ConfigurationError,
    )
  })

  it('el catalogo de ejemplo solo se admite en memoria', () => {
    expect(loadConfig({ MISSIONS_EXAMPLE_CATALOG: 'true' }).exampleCatalog).toBe(true)
    expect(() =>
      loadConfig({
        MISSIONS_EXAMPLE_CATALOG: 'true',
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/missions',
      }),
    ).toThrow(ConfigurationError)
  })

  it('lee la URL sin barra final y los ajustes del reconciliador', () => {
    expect(
      loadConfig({
        HERO_COMMITMENTS_DRIVER: 'http',
        PLAYER_INVENTORY_BASE_URL: 'http://player-inventory:3002/',
        INTERNAL_HTTP_TIMEOUT_MS: '500',
        ENROLLMENT_RECONCILER_ENABLED: 'true',
        ENROLLMENT_RECONCILER_INTERVAL_MS: '5000',
      }),
    ).toMatchObject({
      heroCommitmentsDriver: 'http',
      playerInventoryBaseUrl: 'http://player-inventory:3002',
      internalHttpTimeoutMs: 500,
      enrollmentReconcilerEnabled: true,
      enrollmentReconcilerIntervalMs: 5_000,
    })
  })

  it('rechaza valores fuera de rango', () => {
    expect(() => loadConfig({ HERO_COMMITMENTS_DRIVER: 'grpc' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ ENROLLMENT_RECONCILER_INTERVAL_MS: '10' })).toThrow(
      ConfigurationError,
    )
  })
})
