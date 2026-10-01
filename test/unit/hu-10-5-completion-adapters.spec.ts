import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { PlayerInventoryCompletionExperienceClient } from '../../src/adapters/outbound/inventory/PlayerInventoryCompletionExperienceClient'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { WalletMissionRewardClient } from '../../src/adapters/outbound/wallet/WalletMissionRewardClient'
import type { CompletionExperienceCreditRequest } from '../../src/application/ports/CompletionExperienceCreditPort'
import type { WalletCreditRequest } from '../../src/application/ports/WalletCreditPort'

/**
 * HU-10 (Task HU-10.5): los dos clientes salientes de la liquidacion de
 * finalizacion, contra un servidor HTTP REAL que comprueba la firma -- el mismo
 * patron de `hu-09-adapters.spec.ts`, porque lo que puede romperse aqui es lo
 * mismo: el cuerpo canonico firmado, el servicio anunciado como `missions`, la
 * ruta exacta del contrato y la traduccion de cada codigo al desenlace que el
 * contrato manda.
 */
const SECRET = 'secreto-de-pruebas'
const NOW = new Date('2026-10-02T03:00:00.000Z')
const CLOCK = { now: () => NOW }

interface Received {
  readonly path: string
  readonly service: string | undefined
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

    if (signature === undefined || expected === null || signature !== expected) {
      received.push({ path, service, signed: false, body })
      json(response, 401, { code: 'INTERNAL_SIGNATURE_INVALID' })
      return
    }

    received.push({ path, service, signed: true, body })
    respond(path, response, body)
  })
}

const xpRequest = (): CompletionExperienceCreditRequest => ({
  operationId: 'mission:enr-01:reward:completion:xp',
  playerId: 'sub-1',
  heroId: 'hero-01',
  amount: 11,
  source: {
    kind: 'MISSION_COMPLETION',
    enrollmentId: 'enr-01',
    missionId: 'mission-templo',
    simulationId: 'sim-01',
    difficulty: 'NORMAL',
    missionOutcome: 'COMPLETED',
  },
})

const creditsRequest = (): WalletCreditRequest => ({
  operationId: 'mission:enr-01:reward:guaranteed:credits-base',
  playerId: 'sub-1',
  enrollmentId: 'enr-01',
  missionId: 'mission-templo',
  difficulty: 'NORMAL',
  rewardKey: 'guaranteed:credits-base',
  creditsAmount: 5,
  occurredAt: NOW,
})

describe('HU-10.5 — clientes internos de la liquidacion de finalizacion', () => {
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

  const xpClient = (secret = SECRET): PlayerInventoryCompletionExperienceClient =>
    new PlayerInventoryCompletionExperienceClient({
      baseUrl,
      secret,
      clock: CLOCK,
      timeoutMs: 2_000,
    })

  const walletClient = (secret = SECRET): WalletMissionRewardClient =>
    new WalletMissionRewardClient({ baseUrl, secret, clock: CLOCK, timeoutMs: 2_000 })

  describe('XP de finalizacion en Player/Inventory', () => {
    it('se pide firmada, a la MISMA ruta de HU-09, con origen MISSION_COMPLETION', async () => {
      respond = (_path, response) => {
        json(response, 200, {
          operationId: xpRequest().operationId,
          applied: true,
          level: 2,
          currentXp: 61,
          leveledUp: true,
          levelsGained: 1,
          nextLevel: { status: 'AVAILABLE', forNextLevel: 3, amount: 300 },
          maxLevel: 8,
        })
      }

      const outcome = await xpClient().credit(xpRequest())

      expect(received[0]?.path).toBe('/api/internal/v1/players/sub-1/heroes/hero-01/experience')
      expect(received[0]?.service).toBe('missions')
      expect(received[0]?.signed).toBe(true)
      expect(received[0]?.body).toEqual({
        schemaVersion: 1,
        operationId: xpRequest().operationId,
        amount: 11,
        source: {
          kind: 'MISSION_COMPLETION',
          enrollmentId: 'enr-01',
          missionId: 'mission-templo',
          simulationId: 'sim-01',
          difficulty: 'NORMAL',
          missionOutcome: 'COMPLETED',
        },
      })
      expect(outcome).toEqual({
        kind: 'CREDITED',
        progression: { level: 2, currentXp: 61, maxLevel: 8, levelsGained: 1 },
      })
    })

    it('un 200 repetido (replay, applied: false) tambien es CREDITED', async () => {
      respond = (_path, response) => {
        json(response, 200, {
          operationId: xpRequest().operationId,
          applied: false,
          level: 2,
          currentXp: 61,
        })
      }

      expect(await xpClient().credit(xpRequest())).toEqual({
        kind: 'CREDITED',
        progression: null,
      })
    })

    it.each([
      [400, 'SCHEMA_INVALID'],
      [409, 'EXPERIENCE_GRANT_CONFLICT'],
      [422, 'EXPERIENCE_GRANT_REJECTED'],
    ])('el %i es rechazo DEFINITIVO (%s)', async (status, code) => {
      respond = (_path, response) => {
        json(response, status, { code })
      }

      expect(await xpClient().credit(xpRequest())).toEqual({ kind: 'REJECTED', reason: code })
    })

    it('un 503 es DESCONOCIDO: se reintentara', async () => {
      respond = (_path, response) => {
        json(response, 503, { code: 'PLAYER_INVENTORY_UNAVAILABLE' })
      }

      expect(await xpClient().credit(xpRequest())).toEqual({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    })

    it('DIVERGENCIA DELIBERADA CON HU-09: un 401 aqui es reintentable, no un rechazo', async () => {
      const wrong = xpClient('otro-secreto')

      const outcome = await wrong.credit(xpRequest())

      expect(received[0]?.signed).toBe(false)
      expect(outcome).toEqual({ kind: 'UNKNOWN', reason: 'HTTP_401' })
    })

    it('una respuesta 200 con OTRA operacion no se acepta como acreditada', async () => {
      respond = (_path, response) => {
        json(response, 200, { operationId: 'otra-operacion', applied: true })
      }

      expect(await xpClient().credit(xpRequest())).toEqual({
        kind: 'UNKNOWN',
        reason: 'INVALID_RESPONSE',
      })
    })
  })

  describe('Creditos de mision en Wallet', () => {
    it('se piden firmados, a la ruta PROPIA de mission-reward, con el cuerpo exacto', async () => {
      respond = (_path, response) => {
        json(response, 200, {
          operationId: creditsRequest().operationId,
          applied: true,
          balance: 55,
        })
      }

      const outcome = await walletClient().credit(creditsRequest())

      expect(received[0]?.path).toBe('/api/internal/v1/wallet/credits/mission-reward')
      expect(received[0]?.service).toBe('missions')
      expect(received[0]?.signed).toBe(true)
      expect(received[0]?.body).toEqual({
        schemaVersion: 1,
        operationId: creditsRequest().operationId,
        playerId: 'sub-1',
        reason: 'MISSION_REWARD',
        enrollmentId: 'enr-01',
        missionId: 'mission-templo',
        difficulty: 'NORMAL',
        rewardKey: 'guaranteed:credits-base',
        creditsAmount: 5,
        occurredAt: NOW.toISOString(),
      })
      expect(outcome).toEqual({ kind: 'CREDITED' })
    })

    it('un replay (applied: false) tambien es CREDITED', async () => {
      respond = (_path, response) => {
        json(response, 200, {
          operationId: creditsRequest().operationId,
          applied: false,
          balance: 55,
        })
      }

      expect(await walletClient().credit(creditsRequest())).toEqual({ kind: 'CREDITED' })
    })

    it.each([
      [400, 'SCHEMA_INVALID'],
      [409, 'OPERATION_CONFLICT'],
      [422, 'MISSION_REWARD_INVALID'],
    ])('el %i es rechazo DEFINITIVO (%s)', async (status, code) => {
      respond = (_path, response) => {
        json(response, status, { code })
      }

      expect(await walletClient().credit(creditsRequest())).toEqual({
        kind: 'REJECTED',
        reason: code,
      })
    })

    it('un 503 es DESCONOCIDO: se reintentara con el MISMO operationId', async () => {
      respond = (_path, response) => {
        json(response, 503, { code: 'WALLET_UNAVAILABLE' })
      }

      expect(await walletClient().credit(creditsRequest())).toEqual({
        kind: 'UNKNOWN',
        reason: 'HTTP_503',
      })
    })

    it('un 401 (firma invalida o sin secreto) es DESCONOCIDO, no un rechazo', async () => {
      const wrong = walletClient('otro-secreto')

      expect(await wrong.credit(creditsRequest())).toEqual({
        kind: 'UNKNOWN',
        reason: 'HTTP_401',
      })
    })

    it('el occurredAt viaja EXACTAMENTE como llega: nunca la hora del intento', async () => {
      const frozen = new Date('2026-01-01T00:00:00.000Z')
      respond = (_path, response) => {
        json(response, 200, {
          operationId: creditsRequest().operationId,
          applied: true,
          balance: 1,
        })
      }

      await walletClient().credit({ ...creditsRequest(), occurredAt: frozen })

      expect((received[0]?.body as { occurredAt: string }).occurredAt).toBe(frozen.toISOString())
    })

    it('una respuesta 200 con OTRA operacion no se acepta como acreditada', async () => {
      respond = (_path, response) => {
        json(response, 200, { operationId: 'otra-operacion', applied: true, balance: 1 })
      }

      expect(await walletClient().credit(creditsRequest())).toEqual({
        kind: 'UNKNOWN',
        reason: 'INVALID_RESPONSE',
      })
    })
  })
})
