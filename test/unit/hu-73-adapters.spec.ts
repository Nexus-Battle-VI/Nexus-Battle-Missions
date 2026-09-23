import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { PlayerInventoryEpicGrantClient } from '../../src/adapters/outbound/inventory/PlayerInventoryEpicGrantClient'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import type { EpicGrantRequest } from '../../src/application/ports/EpicGrantPort'
import type { GrantMasterEpics } from '../../src/application/use-cases/GrantMasterEpics'
import type { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import {
  grantConfirmed,
  grantDeferred,
  grantRejected,
  type MasterEncounterRecord,
} from '../../src/domain/entities/MasterEncounterRecord'
import type { SimulationRequest } from '../../src/domain/entities/MissionExecution'
import type { MissionReport, ReportRecord } from '../../src/domain/entities/MissionReport'
import { epicGrantOperationId } from '../../src/domain/policies/MasterPolicy'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'

const AT = new Date('2026-10-02T03:00:00.000Z')
const MASTER = 'sombra-del-olvido'
const EPIC = 'velo-de-sombras'
const PRODUCT = '11111111-1111-4111-8111-111111111111'
const GRANTS_PATH = '/api/internal/v1/inventory/grants'

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

describe('PlayerInventoryEpicGrantClient (HU-73, contrato de entregas de HU-59)', () => {
  const clock = { now: (): Date => AT }
  const request: EpicGrantRequest = {
    operationId: epicGrantOperationId('enr_1', MASTER, 1),
    playerId: 'sub-1',
    productId: PRODUCT,
  }

  const clientReturning = (response: Response | Error) => {
    const calls: { url: string; init: RequestInit }[] = []
    const failures: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
    const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new PlayerInventoryEpicGrantClient({
      baseUrl: 'http://player-inventory:3002',
      secret: 'secreto',
      clock,
      timeoutMs: 1_000,
      fetchImpl,
      onFailure: (event, detail) => failures.push({ event, detail }),
    })

    return { client, calls, failures }
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('pide un lote con un solo producto, firmado como missions sobre la ruta completa', async () => {
    const { client, calls } = clientReturning(
      json(200, { ...request, items: [{ productId: PRODUCT, quantity: 1 }], applied: true }),
    )

    await expect(client.grant(request)).resolves.toEqual({ kind: 'GRANTED' })

    const call = required(calls[0], 'la llamada')
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>
    const headers = call.init.headers as Record<string, string>
    expect(call.url).toBe(`http://player-inventory:3002${GRANTS_PATH}`)
    expect(body).toEqual({
      operationId: request.operationId,
      playerId: 'sub-1',
      items: [{ productId: PRODUCT, quantity: 1 }],
    })
    expect(headers['x-internal-service']).toBe('missions')
    expect(headers['x-internal-timestamp']).toBe(String(AT.getTime()))
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('secreto', {
        service: 'missions',
        method: 'POST',
        path: GRANTS_PATH,
        timestamp: String(AT.getTime()),
        body,
      }),
    )
  })

  it('un 200 de otra operacion o sin applied no se da por entregado', async () => {
    for (const body of [
      { operationId: 'otra', applied: true },
      { operationId: request.operationId },
      'no es un objeto',
    ]) {
      const { client, failures } = clientReturning(json(200, body))

      await expect(client.grant(request)).resolves.toEqual({
        kind: 'UNKNOWN',
        reason: 'INVALID_RESPONSE',
      })
      expect(failures.map(({ event }) => event)).toEqual(['player_inventory_respuesta_invalida'])
    }
  })

  it('un 422 es un rechazo definitivo con su codigo; un 400 tambien', async () => {
    const rejected = clientReturning(
      json(422, { code: 'INVENTORY_REJECTED', message: 'Sin espacio' }),
    )
    await expect(rejected.client.grant(request)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'INVENTORY_REJECTED',
    })
    // Se registra el estado y el codigo, nunca el cuerpo ni el mensaje.
    expect(rejected.failures).toEqual([
      {
        event: 'player_inventory_entrega_rechazada',
        detail: { path: GRANTS_PATH, status: 422, code: 'INVENTORY_REJECTED' },
      },
    ])

    const invalid = clientReturning(new Response('mal', { status: 400 }))
    await expect(invalid.client.grant(request)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'HTTP_400',
    })
  })

  it.each([
    ['401: Player/Inventory todavia no autoriza a missions', 401],
    ['409: otra escritura a la vez', 409],
    ['404: ruta inexistente', 404],
    ['503: dependencia caida', 503],
  ])('un %s queda sin confirmar y se reintenta', async (_caso, status) => {
    const { client, failures } = clientReturning(json(status, { message: 'x' }))

    await expect(client.grant(request)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: `HTTP_${String(status)}`,
    })
    expect(failures).toEqual([
      { event: 'player_inventory_entrega_sin_confirmar', detail: { path: GRANTS_PATH, status } },
    ])
  })

  it('sin respuesta, desconocido', async () => {
    const { client, failures } = clientReturning(new Error('ECONNREFUSED'))

    await expect(client.grant(request)).resolves.toEqual({ kind: 'UNKNOWN', reason: 'NETWORK' })
    expect(failures.map(({ event }) => event)).toEqual(['player_inventory_inalcanzable'])
  })
})

describe('InMemoryEpicGrants (doble de desarrollo)', () => {
  const request: EpicGrantRequest = { operationId: 'op-1', playerId: 'sub-1', productId: PRODUCT }

  it('la misma operacion con el mismo cuerpo responde igual y cuenta una sola entrega', async () => {
    const grants = new InMemoryEpicGrants()

    await expect(grants.grant(request)).resolves.toEqual({ kind: 'GRANTED' })
    await expect(grants.grant(request)).resolves.toEqual({ kind: 'GRANTED' })
    expect(grants.granted()).toEqual([request])
  })

  it('la misma operacion con otro cuerpo es un 409, como en Player/Inventory', async () => {
    const grants = new InMemoryEpicGrants()
    await grants.grant(request)

    await expect(grants.grant({ ...request, playerId: 'sub-2' })).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'HTTP_409',
    })
    expect(grants.granted()).toEqual([request])
  })
})

describe('InMemoryMasterEncounterRepository (HU-73)', () => {
  const report = { enrollmentId: 'enr_1', playerId: 'sub-1' } as unknown as MissionReport
  const withLine = (): ReportRecord => ({
    report,
    rewards: [
      {
        lineNo: 1,
        kind: 'EPIC',
        reference: EPIC,
        name: 'Velo de Sombras',
        rarity: null,
        quantity: 1,
        status: 'PENDING',
        source: 'HU-73',
        updatedAt: AT,
      },
    ],
  })

  const pending = (enrollmentId: string, nextAttemptAt: Date): MasterEncounterRecord => ({
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
      nextAttemptAt,
      lastError: null,
      grantedAt: null,
      rewardLineNo: 1,
      productId: null,
    },
  })

  const notAppeared = (enrollmentId: string): MasterEncounterRecord => ({
    enrollmentId,
    sequence: 1,
    afterEncounter: 3,
    masterRef: null,
    status: 'NOT_APPEARED',
    epicRef: null,
    levelOffset: null,
    turns: null,
    grant: null,
  })

  it('el cierre repetido no reemplaza lo guardado', async () => {
    const masters = new InMemoryMasterEncounterRepository()
    masters.recordNow([pending('enr_1', AT)])
    masters.recordNow([notAppeared('enr_1')])

    await expect(masters.listByEnrollment('enr_1')).resolves.toEqual([pending('enr_1', AT)])
  })

  it('las entregas por hacer: solo PENDING con el intento vencido, las mas atrasadas primero', async () => {
    const masters = new InMemoryMasterEncounterRepository()
    const later = new Date(AT.getTime() + 60_000)
    masters.recordNow([pending('enr_2', later), notAppeared('enr_3'), pending('enr_1', AT)])
    masters.recordNow([grantConfirmed(pending('enr_4', AT), AT)])

    await expect(masters.pendingGrants(AT, 10)).resolves.toEqual([pending('enr_1', AT)])
    await expect(
      masters.pendingGrants(later, 10).then((items) => items.map((item) => item.enrollmentId)),
    ).resolves.toEqual(['enr_1', 'enr_2'])
    await expect(masters.pendingGrants(later, 1)).resolves.toHaveLength(1)
  })

  it('entregada, la linea EPIC del reporte pasa a CREDITED; rechazada, a FAILED', async () => {
    const done = new Date(AT.getTime() + 1_000)
    const reports = new InMemoryReportRepository()
    const masters = new InMemoryMasterEncounterRepository(reports)
    reports.recordNow(withLine())
    masters.recordNow([pending('enr_1', AT)])

    await expect(
      masters.saveGrant(grantConfirmed(pending('enr_1', AT), done), 0, done),
    ).resolves.toBe(true)
    await expect(reports.findByEnrollment('enr_1')).resolves.toMatchObject({
      rewards: [{ status: 'CREDITED', updatedAt: done }],
    })

    const other = new InMemoryReportRepository()
    const rejecting = new InMemoryMasterEncounterRepository(other)
    other.recordNow(withLine())
    rejecting.recordNow([pending('enr_1', AT)])
    await rejecting.saveGrant(grantRejected(pending('enr_1', AT), 'INVENTORY_REJECTED'), 0, done)
    await expect(other.findByEnrollment('enr_1')).resolves.toMatchObject({
      rewards: [{ status: 'FAILED' }],
    })
  })

  it('un aplazamiento no toca la linea del reporte', async () => {
    const reports = new InMemoryReportRepository()
    const masters = new InMemoryMasterEncounterRepository(reports)
    reports.recordNow(withLine())
    masters.recordNow([pending('enr_1', AT)])

    await masters.saveGrant(grantDeferred(pending('enr_1', AT), 'HTTP_503', AT), 0, AT)
    await expect(reports.findByEnrollment('enr_1')).resolves.toMatchObject({
      rewards: [{ status: 'PENDING' }],
    })
  })

  it('congela el producto una sola vez, con los intentos leidos, y ningun guardado lo borra', async () => {
    const masters = new InMemoryMasterEncounterRepository()
    const base = pending('enr_1', AT)
    const withProduct = (productId: string | null): MasterEncounterRecord => ({
      ...base,
      grant: base.grant === null ? null : { ...base.grant, productId },
    })
    masters.recordNow([base])

    await expect(masters.freezeProduct(withProduct(PRODUCT), 3)).resolves.toBe(false)
    await expect(masters.freezeProduct(withProduct(null), 0)).resolves.toBe(false)
    await expect(masters.freezeProduct(withProduct(PRODUCT), 0)).resolves.toBe(true)
    await expect(masters.freezeProduct(withProduct('otro'), 0)).resolves.toBe(false)

    // Un aplazamiento con el registro leido antes (sin producto) no lo borra.
    await masters.saveGrant(grantDeferred(base, 'INTERNAL_ERROR', AT), 0, AT)
    await expect(masters.listByEnrollment('enr_1')).resolves.toMatchObject([
      { grant: { status: 'PENDING', attempts: 1, productId: PRODUCT } },
    ])
    await expect(masters.freezeProduct(pending('enr_9', AT), 0)).resolves.toBe(false)
  })

  it('si otro proceso se adelanto (otros intentos, ya resuelta o sin fila), no escribe', async () => {
    const masters = new InMemoryMasterEncounterRepository()
    masters.recordNow([pending('enr_1', AT)])

    await expect(
      masters.saveGrant(grantDeferred(pending('enr_1', AT), 'x', AT), 3, AT),
    ).resolves.toBe(false)
    await expect(masters.saveGrant(grantConfirmed(pending('enr_1', AT), AT), 0, AT)).resolves.toBe(
      true,
    )
    await expect(masters.saveGrant(grantConfirmed(pending('enr_1', AT), AT), 0, AT)).resolves.toBe(
      false,
    )
    await expect(masters.saveGrant(grantConfirmed(pending('enr_9', AT), AT), 0, AT)).resolves.toBe(
      false,
    )
  })
})

describe('ScriptedCombatSimulation con el bloque master (HU-73)', () => {
  const request = (master: SimulationRequest['master']): SimulationRequest => ({
    schemaVersion: 1,
    operationId: 'op-1',
    enrollmentId: 'enr_1',
    missionId: 'msn_templo_olvidado',
    difficulty: 'NORMAL',
    enemyStatMultiplier: 1,
    timeBudget: 'PT12H',
    hero: { heroId: 'h', profile: {} },
    strategy: { version: null, rotations: [], fallback: 'BASIC_ATTACK' },
    encounters: [1, 2, 3, 4, 5].map((index) => ({
      index,
      kind: index === 5 ? ('BOSS' as const) : ('REGULAR' as const),
      powerStep: null,
      enemies: [],
    })),
    master,
  })

  const masterOf = async (master: SimulationRequest['master']): Promise<unknown> => {
    const outcome = await new ScriptedCombatSimulation().simulate(request(master))

    return outcome.kind === 'SIMULATED' ? outcome.result.summary.master : null
  }

  const block = (probability: number, points: number[]) => ({
    evaluationPoints: points.map((afterEncounter) => ({ afterEncounter })),
    maxAppearances: 1,
    candidates: [
      {
        masterRef: MASTER,
        subtype: 'PICARO_VENENO',
        probability,
        levelOffset: 2,
        profile: null,
        epicRef: EPIC,
      },
    ],
  })

  it('sin bloque, no hay Master', async () => {
    await expect(masterOf(null)).resolves.toEqual({
      appeared: false,
      masterRef: null,
      defeated: false,
    })
  })

  it('no tira dados: con probabilidad menor que 1 evalua cada punto y no aparece', async () => {
    await expect(masterOf(block(0.15, [2, 4]))).resolves.toEqual({
      appeared: false,
      masterRef: null,
      defeated: false,
      evaluations: [
        { afterEncounter: 2, masterRef: MASTER, appeared: false },
        { afterEncounter: 4, masterRef: MASTER, appeared: false },
      ],
      encounters: [],
    })
  })

  it('con probabilidad 1 aparece en el primer punto, el heroe lo derrota y respeta el tope', async () => {
    await expect(masterOf(block(1, [2, 4]))).resolves.toEqual({
      appeared: true,
      masterRef: MASTER,
      defeated: true,
      evaluations: [{ afterEncounter: 2, masterRef: MASTER, appeared: true }],
      encounters: [
        { masterRef: MASTER, afterEncounter: 2, levelOffset: 2, outcome: 'DEFEATED', turns: 0 },
      ],
    })
  })
})

describe('Configuracion de HU-73', () => {
  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'pool',
    COGNITO_CLIENT_ID: 'cliente',
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/missions',
  }

  it('en desarrollo la entrega usa el doble; en produccion, Player/Inventory', () => {
    expect(loadConfig({}).epicGrantsDriver).toBe('memory')
    expect(loadConfig(production).epicGrantsDriver).toBe('http')
    expect(loadConfig({ EPIC_GRANTS_DRIVER: 'http' }).epicGrantsDriver).toBe('http')
  })

  it('prohibe el doble de entregas en produccion y rechaza un valor desconocido', () => {
    expect(() => loadConfig({ ...production, EPIC_GRANTS_DRIVER: 'memory' })).toThrow(
      new ConfigurationError('EPIC_GRANTS_DRIVER no puede ser "memory" con NODE_ENV=production.'),
    )
    expect(() => loadConfig({ EPIC_GRANTS_DRIVER: 'grpc' })).toThrow(ConfigurationError)
  })
})

describe('MissionExecutionScheduler con las entregas de HU-73', () => {
  const logger = (): Logger & { entries: [string, unknown][] } => {
    const entries: [string, unknown][] = []
    const record = (message: string, fields?: unknown): void => {
      entries.push([message, fields])
    }

    return { entries, debug: record, info: record, warn: record, error: record }
  }

  const zero = {
    queued: 0,
    simulated: 0,
    retried: 0,
    settled: 0,
    voided: 0,
    released: 0,
    failed: 0,
  }
  const noEpics = {
    epicsGranted: 0,
    epicsRetried: 0,
    epicsWaiting: 0,
    epicsRejected: 0,
    epicsFailed: 0,
  }

  const scheduler = (log: Logger, epics: typeof noEpics, order: string[]) =>
    new MissionExecutionScheduler(
      {
        run: () => {
          order.push('cierre')
          return Promise.resolve(zero)
        },
      } as unknown as RunMissionExecutions,
      log,
      1_000,
      false,
      {
        run: () => {
          order.push('entregas')
          return Promise.resolve(epics)
        },
      } as unknown as GrantMasterEpics,
    )

  it('entrega despues de cerrar, en el mismo ciclo, y lo registra junto', async () => {
    const log = logger()
    const order: string[] = []

    await scheduler(log, { ...noEpics, epicsGranted: 1 }, order).tick()

    expect(order).toEqual(['cierre', 'entregas'])
    expect(log.entries).toEqual([
      ['mission_execution_cycle', { ...zero, ...noEpics, epicsGranted: 1 }],
    ])
  })

  it('un ciclo sin cambios no se registra', async () => {
    const log = logger()

    await scheduler(log, noEpics, []).tick()

    expect(log.entries).toEqual([])
  })
})
