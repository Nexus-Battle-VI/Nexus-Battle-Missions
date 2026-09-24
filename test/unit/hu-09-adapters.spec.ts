import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { CombatExperienceRollClient } from '../../src/adapters/outbound/combat/CombatExperienceRollClient'
import { PlayerInventoryExperienceClient } from '../../src/adapters/outbound/inventory/PlayerInventoryExperienceClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  canonicalBody,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import type { ExperienceCreditRequest } from '../../src/application/ports/ExperienceCreditPort'
import type { ExperienceRollRequest } from '../../src/application/ports/ExperienceRollPort'

/**
 * HU-09 (Task HU-09.4): los dos clientes salientes, contra un servidor HTTP REAL
 * que comprueba la firma.
 *
 * No es un doble de `fetch`: el servidor verifica el HMAC como lo haria Combat o
 * Player/Inventory, de modo que la prueba cubre lo que de verdad puede romperse
 * -- que se firme el cuerpo canonico, que el servicio se anuncie como `missions`
 * y que cada codigo de respuesta se traduzca al resultado que el contrato manda.
 */
const SECRET = 'secreto-de-pruebas'
const NOW = new Date('2026-10-02T03:00:00.000Z')
const CLOCK = { now: () => NOW }

interface Received {
  readonly path: string
  readonly service: string | undefined
  /** `true` cuando la firma corresponde al cuerpo y al sello recibidos. */
  readonly signed: boolean
  readonly body: unknown
}

let received: Received[] = []
let respond: (path: string, response: ServerResponse, body: unknown) => void = () => undefined

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const handler = (request: IncomingMessage, response: ServerResponse): void => {
  let raw = ''

  request.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8')
  })

  request.on('end', () => {
    const body: unknown = raw.length === 0 ? {} : JSON.parse(raw)
    const path = request.url ?? ''
    const service = request.headers[INTERNAL_SERVICE_HEADER] as string | undefined
    const timestamp = request.headers[INTERNAL_TIMESTAMP_HEADER] as string | undefined
    const signature = request.headers[INTERNAL_SIGNATURE_HEADER] as string | undefined
    const expected =
      timestamp === undefined || service === undefined
        ? null
        : signInternalRequest(SECRET, { service, method: 'POST', path, timestamp, body })

    // Un `fetch` sin firma no llega mas lejos: el servidor responde 401.
    if (signature === undefined || expected === null || signature !== expected) {
      received.push({ path, service, signed: false, body })
      json(response, 401, { code: 'INTERNAL_SIGNATURE_INVALID' })
      return
    }

    received.push({ path, service, signed: true, body })
    respond(path, response, body)
  })
}

const rollsRequest = (): ExperienceRollRequest => ({
  operationId: 'mission:enr-01:xp-rolls',
  enrollmentId: 'enr-01',
  simulationId: 'sim-01',
  heroId: 'hero-01',
  defeats: [
    { encounterId: '1', enemyInstanceId: 'sombra#1', rivalRef: 'sombra' },
    { encounterId: '5', enemyInstanceId: 'guardian#1', rivalRef: 'guardian' },
  ],
})

const creditRequest = (): ExperienceCreditRequest => ({
  operationId: 'mission:enr-01:encounter:1:enemy:sombra#1:hero:hero-01:xp',
  playerId: 'sub-1',
  heroId: 'hero-01',
  amount: 14,
  source: {
    kind: 'MISSION_RIVAL_DEFEAT',
    enrollmentId: 'enr-01',
    simulationId: 'sim-01',
    encounterId: '1',
    enemyInstanceId: 'sombra#1',
    rivalRef: 'sombra',
    roll: 2,
  },
})

describe('HU-09 — clientes internos firmados', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer(handler)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  beforeEach(() => {
    received = []
    respond = (_path, response) => {
      json(response, 200, {})
    }
  })

  const rollsClient = (): CombatExperienceRollClient =>
    new CombatExperienceRollClient({ baseUrl, secret: SECRET, clock: CLOCK, timeoutMs: 2_000 })

  const creditsClient = (): PlayerInventoryExperienceClient =>
    new PlayerInventoryExperienceClient({
      baseUrl,
      secret: SECRET,
      clock: CLOCK,
      timeoutMs: 2_000,
    })

  it('el lote de tiradas se pide firmado, como `missions`, con el cuerpo del contrato', async () => {
    respond = (_path, response) => {
      json(response, 200, {
        schemaVersion: 1,
        operationId: 'mission:enr-01:xp-rolls',
        applied: true,
        rolls: [
          {
            encounterId: '1',
            enemyInstanceId: 'sombra#1',
            roll: 3,
            persistedAt: NOW.toISOString(),
          },
          {
            encounterId: '5',
            enemyInstanceId: 'guardian#1',
            roll: 8,
            persistedAt: NOW.toISOString(),
          },
        ],
      })
    }

    const outcome = await rollsClient().rollDefeats(rollsRequest())

    expect(received).toHaveLength(1)
    expect(received[0]?.path).toBe('/api/internal/v1/combat/experience-rolls')
    expect(received[0]?.service).toBe('missions')
    expect(received[0]?.signed).toBe(true)
    expect(received[0]?.body).toEqual({
      schemaVersion: 1,
      operationId: 'mission:enr-01:xp-rolls',
      enrollmentId: 'enr-01',
      simulationId: 'sim-01',
      heroId: 'hero-01',
      defeats: [
        { encounterId: '1', enemyInstanceId: 'sombra#1', rivalRef: 'sombra' },
        { encounterId: '5', enemyInstanceId: 'guardian#1', rivalRef: 'guardian' },
      ],
    })
    expect(outcome).toEqual({
      kind: 'ROLLED',
      rolls: [
        { encounterId: '1', enemyInstanceId: 'sombra#1', roll: 3 },
        { encounterId: '5', enemyInstanceId: 'guardian#1', roll: 8 },
      ],
    })
  })

  it.each([
    [409, 'OPERATION_ID_REUSED'],
    [422, 'DUPLICATE_DEFEAT'],
    [400, 'SCHEMA_INVALID'],
  ])('el rechazo %i de Combat es definitivo (%s)', async (status, code) => {
    respond = (_path, response) => {
      json(response, status, { code })
    }

    const outcome = await rollsClient().rollDefeats(rollsRequest())

    expect(outcome).toEqual({ kind: 'REJECTED', reason: code })
  })

  it('un 401 de Combat tambien es rechazo definitivo', async () => {
    // El servidor responde 401 a cualquier peticion sin firma valida; para
    // provocarlo se usa un secreto distinto en el cliente.
    const wrong = new CombatExperienceRollClient({
      baseUrl,
      secret: 'otro-secreto',
      clock: CLOCK,
      timeoutMs: 2_000,
    })

    const outcome = await wrong.rollDefeats(rollsRequest())

    expect(received[0]?.signed).toBe(false)
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'INTERNAL_SIGNATURE_INVALID' })
  })

  it('un 503 de Combat es DESCONOCIDO: la recompensa se reintentara', async () => {
    respond = (_path, response) => {
      json(response, 503, { code: 'ROLL_UNAVAILABLE' })
    }

    expect(await rollsClient().rollDefeats(rollsRequest())).toEqual({
      kind: 'UNKNOWN',
      reason: 'HTTP_503',
    })
  })

  it.each([
    [
      'sin la tirada de una derrota',
      {
        schemaVersion: 1,
        operationId: 'mission:enr-01:xp-rolls',
        applied: true,
        rolls: [{ encounterId: '1', enemyInstanceId: 'sombra#1', roll: 3 }],
      },
    ],
    [
      'con una cara fuera del dado',
      {
        schemaVersion: 1,
        operationId: 'mission:enr-01:xp-rolls',
        applied: true,
        rolls: [
          { encounterId: '1', enemyInstanceId: 'sombra#1', roll: 9 },
          { encounterId: '5', enemyInstanceId: 'guardian#1', roll: 8 },
        ],
      },
    ],
    [
      'con otra operacion',
      {
        schemaVersion: 1,
        operationId: 'mission:otra:xp-rolls',
        applied: true,
        rolls: [
          { encounterId: '1', enemyInstanceId: 'sombra#1', roll: 3 },
          { encounterId: '5', enemyInstanceId: 'guardian#1', roll: 8 },
        ],
      },
    ],
  ])('una respuesta de Combat %s NO se acepta: es desconocida', async (_label, body) => {
    respond = (_path, response) => {
      json(response, 200, body)
    }

    expect(await rollsClient().rollDefeats(rollsRequest())).toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
  })

  it('la acreditacion se pide firmada, a la ruta del contrato y con el importe entero', async () => {
    respond = (_path, response) => {
      json(response, 200, {
        operationId: creditRequest().operationId,
        applied: true,
        heroId: 'hero-01',
        level: 2,
        currentXp: 14,
        leveledUp: false,
        levelsGained: 0,
        nextLevel: { status: 'AVAILABLE', forNextLevel: 3, amount: 400 },
        maxLevel: 8,
      })
    }

    const outcome = await creditsClient().credit(creditRequest())

    // HU-09.5: del `200` se lee ademas la progresion del heroe.
    expect(outcome).toEqual({
      kind: 'CREDITED',
      progression: { level: 2, currentXp: 14, maxLevel: 8, levelsGained: 0 },
    })
    expect(received[0]?.path).toBe('/api/internal/v1/players/sub-1/heroes/hero-01/experience')
    expect(received[0]?.service).toBe('missions')
    expect(received[0]?.signed).toBe(true)
    expect(received[0]?.body).toEqual({
      schemaVersion: 1,
      operationId: creditRequest().operationId,
      amount: 14,
      source: {
        kind: 'MISSION_RIVAL_DEFEAT',
        enrollmentId: 'enr-01',
        simulationId: 'sim-01',
        encounterId: '1',
        enemyInstanceId: 'sombra#1',
        rivalRef: 'sombra',
        roll: 2,
      },
    })
  })

  it('un 200 con la progresion ilegible SIGUE siendo una acreditacion (HU-09.5)', async () => {
    respond = (_path, response) => {
      json(response, 200, {
        operationId: creditRequest().operationId,
        applied: true,
        // Sin `maxLevel` ni `levelsGained`: el heroe subio, pero no se puede contar.
        level: 3,
        currentXp: 640,
      })
    }

    // El `200` y la clave dicen que la experiencia entro; no poder leer el nivel no
    // autoriza a decir que el inventario del jugador no cambio.
    expect(await creditsClient().credit(creditRequest())).toEqual({
      kind: 'CREDITED',
      progression: null,
    })
  })

  it.each([
    [422, 'EXPERIENCE_GRANT_REJECTED'],
    [409, 'EXPERIENCE_GRANT_CONFLICT'],
    [400, 'SCHEMA_INVALID'],
  ])('el rechazo %i de Player/Inventory es definitivo (%s)', async (status, code) => {
    respond = (_path, response) => {
      json(response, status, { code })
    }

    expect(await creditsClient().credit(creditRequest())).toEqual({
      kind: 'REJECTED',
      reason: code,
    })
  })

  it('un 503 de Player/Inventory es DESCONOCIDO: no se da por acreditada', async () => {
    respond = (_path, response) => {
      json(response, 503, { code: 'PLAYER_INVENTORY_UNAVAILABLE' })
    }

    expect(await creditsClient().credit(creditRequest())).toEqual({
      kind: 'UNKNOWN',
      reason: 'HTTP_503',
    })
  })

  it('una respuesta 200 con OTRA operacion no se acepta como acreditada', async () => {
    respond = (_path, response) => {
      json(response, 200, { operationId: 'otra-operacion', applied: true })
    }

    expect(await creditsClient().credit(creditRequest())).toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
  })

  it('un servidor inalcanzable es DESCONOCIDO, nunca un rechazo', async () => {
    const offline = new PlayerInventoryExperienceClient({
      baseUrl: 'http://127.0.0.1:1',
      secret: SECRET,
      clock: CLOCK,
      timeoutMs: 500,
    })

    expect(await offline.credit(creditRequest())).toEqual({ kind: 'UNKNOWN', reason: 'NETWORK' })
  })

  it('CONTROL: el cuerpo que se firma es el canonico, no el orden en que se escribio', () => {
    // Si el cliente firmara el objeto tal cual, el servidor -- que reordena las
    // claves al canonicalizar -- rechazaria toda peticion.
    expect(canonicalBody({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(received.every((entry) => entry.signed)).toBe(true)
  })
})
