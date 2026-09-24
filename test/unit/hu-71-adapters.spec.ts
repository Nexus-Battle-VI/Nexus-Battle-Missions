import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'

import { toMissionsHttpException } from '../../src/adapters/inbound/http/missions-error.mapper'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import {
  EXAMPLE_HERO_ABILITIES,
  InMemoryHeroAbilities,
} from '../../src/adapters/outbound/inventory/InMemoryHeroAbilities'
import { PlayerInventoryAbilitiesClient } from '../../src/adapters/outbound/inventory/PlayerInventoryAbilitiesClient'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { MissionStrategy } from '../../src/domain/entities/MissionStrategy'
import {
  HeroAbilitiesUnavailableError,
  InvalidRotationError,
  StrategyNotFoundError,
  StrategyVersionConflictError,
  TooManyRotationsError,
  UnknownAbilityError,
} from '../../src/domain/errors/strategy-errors'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import { COURSE_STRATEGY } from '../support/fixtures'

const AT = new Date('2026-10-01T15:00:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

const strategy = (overrides: Partial<MissionStrategy> = {}): MissionStrategy => ({
  playerId: 'sub-1',
  heroId: HERO,
  missionId: TEMPLO,
  version: 1,
  rotations: COURSE_STRATEGY,
  updatedAt: AT,
  ...overrides,
})

describe('InMemoryStrategyRepository (HU-71)', () => {
  it('crea solo con null y reemplaza solo la version esperada', async () => {
    const repository = new InMemoryStrategyRepository()

    await expect(repository.save(strategy(), null)).resolves.toEqual({ kind: 'SAVED' })
    await expect(repository.save(strategy(), null)).resolves.toEqual({
      kind: 'VERSION_CONFLICT',
      currentVersion: 1,
    })
    await expect(repository.save(strategy({ version: 2 }), 1)).resolves.toEqual({ kind: 'SAVED' })
    await expect(repository.save(strategy({ version: 2 }), 1)).resolves.toEqual({
      kind: 'VERSION_CONFLICT',
      currentVersion: 2,
    })
    await expect(repository.find('sub-1', HERO, TEMPLO)).resolves.toMatchObject({ version: 2 })
  })

  it('reemplazar una que no existe es conflicto sin version actual', async () => {
    await expect(
      new InMemoryStrategyRepository().save(strategy({ version: 4 }), 3),
    ).resolves.toEqual({ kind: 'VERSION_CONFLICT', currentVersion: null })
  })

  it('la clave es jugador, heroe y mision', async () => {
    const repository = new InMemoryStrategyRepository()
    await repository.save(strategy(), null)

    await expect(repository.find('sub-2', HERO, TEMPLO)).resolves.toBeNull()
    await expect(repository.find('sub-1', 'otro', TEMPLO)).resolves.toBeNull()
    await expect(repository.find('sub-1', HERO, 'msn_otra')).resolves.toBeNull()
  })
})

describe('InMemoryHeroAbilities (HU-71)', () => {
  it('por defecto el heroe tiene las habilidades del ejemplo del curso', async () => {
    await expect(new InMemoryHeroAbilities().abilitiesOf()).resolves.toEqual({
      kind: 'FOUND',
      abilityIds: new Set(EXAMPLE_HERO_ABILITIES),
    })
  })

  it('admite otra lista', async () => {
    await expect(new InMemoryHeroAbilities(['x']).abilitiesOf()).resolves.toEqual({
      kind: 'FOUND',
      abilityIds: new Set(['x']),
    })
  })
})

describe('PlayerInventoryAbilitiesClient (HU-71)', () => {
  const clock = { now: (): Date => AT }
  const PATH = `/api/internal/v1/players/sub-1/heroes/${HERO}`

  const clientReturning = (response: Response | Error) => {
    const calls: { url: string; init: RequestInit }[] = []
    const failures: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
    const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new PlayerInventoryAbilitiesClient({
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

  it('firma un GET con la ruta completa y cuerpo vacio, y lee las habilidades', async () => {
    const { client, calls } = clientReturning(
      json(200, {
        heroId: HERO.toUpperCase(),
        abilities: [{ abilityId: 'a', name: 'A' }, { abilityId: 'b' }],
        ready: true,
      }),
    )

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'FOUND',
      abilityIds: new Set(['a', 'b']),
    })

    const call = calls[0]!
    const headers = call.init.headers as Record<string, string>
    expect(call.url).toBe(`http://player-inventory:3002${PATH}`)
    expect(call.init.method).toBe('GET')
    expect(call.init.body).toBeUndefined()
    expect(headers['x-internal-service']).toBe('missions')
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('secreto', {
        service: 'missions',
        method: 'GET',
        path: PATH,
        timestamp: String(AT.getTime()),
        body: {},
      }),
    )
  })

  it('un heroe sin habilidades es una lista vacia valida', async () => {
    const { client } = clientReturning(json(200, { heroId: HERO, abilities: [] }))

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'FOUND',
      abilityIds: new Set(),
    })
  })

  it.each([
    ['de otro heroe', json(200, { heroId: 'otro', abilities: [] })],
    ['sin abilities', json(200, { heroId: HERO })],
    ['con una habilidad sin abilityId', json(200, { heroId: HERO, abilities: [{ name: 'x' }] })],
    ['sin JSON', new Response('ok', { status: 200 })],
  ])('un 200 %s no se da por bueno', async (_caso, response) => {
    const { client, failures } = clientReturning(response)

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    })
    expect(failures.map((failure) => failure.event)).toEqual([
      'player_inventory_respuesta_invalida',
    ])
  })

  it('el 404 de negocio dice que el heroe no es del jugador', async () => {
    const { client } = clientReturning(json(404, { code: 'HERO_NOT_OWNED' }))

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({ kind: 'NOT_OWNED' })
  })

  it('el 404 de la ruta inexistente NO significa «no es suyo»', async () => {
    const { client, failures } = clientReturning(
      json(404, { message: `Cannot GET ${PATH}`, error: 'Not Found', statusCode: 404 }),
    )

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'HTTP_404',
    })
    expect(failures.map((failure) => failure.event)).toEqual(['player_inventory_sin_habilidades'])
  })

  it.each([401, 409, 503])('un %i es un resultado desconocido', async (status) => {
    const { client } = clientReturning(json(status, {}))

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: `HTTP_${String(status)}`,
    })
  })

  it('un error de red es desconocido y el registro no lleva identificadores', async () => {
    const { client, failures } = clientReturning(new TypeError('fetch failed'))

    await expect(client.abilitiesOf('sub-1', HERO)).resolves.toEqual({
      kind: 'UNKNOWN',
      reason: 'NETWORK',
    })
    expect(failures).toEqual([
      {
        event: 'player_inventory_inalcanzable',
        detail: {
          route: 'GET /api/internal/v1/players/{playerId}/heroes/{heroId}',
          reason: 'TypeError',
        },
      },
    ])
  })
})

describe('Errores de HU-71 en HTTP', () => {
  it.each([
    [
      new TooManyRotationsError(3, 4),
      UnprocessableEntityException,
      { code: 'TOO_MANY_ROTATIONS', max: 3, received: 4 },
    ],
    [
      new InvalidRotationError([{ field: 'rotations[1].priority', reason: 'PRIORITY_GAP' }], 'm'),
      UnprocessableEntityException,
      {
        code: 'INVALID_ROTATION',
        violations: [{ field: 'rotations[1].priority', reason: 'PRIORITY_GAP' }],
      },
    ],
    [
      new UnknownAbilityError(['x'], 'm'),
      UnprocessableEntityException,
      { code: 'UNKNOWN_ABILITY', abilityIds: ['x'] },
    ],
    [
      new StrategyVersionConflictError(1, 2),
      ConflictException,
      { code: 'VERSION_CONFLICT', expectedVersion: 1, currentVersion: 2 },
    ],
    [
      new StrategyNotFoundError(TEMPLO, HERO),
      NotFoundException,
      { code: 'STRATEGY_NOT_FOUND', missionId: TEMPLO, heroId: HERO },
    ],
    [
      new HeroAbilitiesUnavailableError(),
      ServiceUnavailableException,
      { code: 'DEPENDENCY_UNAVAILABLE' },
    ],
  ])('%p responde su codigo estable', (error, type, body) => {
    const exception = toMissionsHttpException(error)

    expect(exception).toBeInstanceOf(type)
    expect(exception.getResponse()).toMatchObject({ ...body, message: error.message })
  })
})

describe('Configuracion de HU-71', () => {
  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'pool',
    COGNITO_CLIENT_ID: 'cliente',
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/missions',
  }

  it('en desarrollo las habilidades usan el doble; en produccion, Player/Inventory', () => {
    expect(loadConfig({}).heroAbilitiesDriver).toBe('memory')
    expect(loadConfig(production).heroAbilitiesDriver).toBe('http')
    expect(loadConfig({ HERO_ABILITIES_DRIVER: 'http' }).heroAbilitiesDriver).toBe('http')
  })

  it('prohibe el doble de habilidades en produccion', () => {
    expect(() => loadConfig({ ...production, HERO_ABILITIES_DRIVER: 'memory' })).toThrow(
      new ConfigurationError(
        'HERO_ABILITIES_DRIVER no puede ser "memory" con NODE_ENV=production.',
      ),
    )
  })

  it('rechaza un valor desconocido', () => {
    expect(() => loadConfig({ HERO_ABILITIES_DRIVER: 'grpc' })).toThrow(ConfigurationError)
  })
})
