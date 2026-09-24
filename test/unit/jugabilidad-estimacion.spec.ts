import { toMissionsHttpException } from '../../src/adapters/inbound/http/missions-error.mapper'
import { CombatEstimateClient } from '../../src/adapters/outbound/combat/CombatEstimateClient'
import { ScriptedCombatEstimates } from '../../src/adapters/outbound/combat/ScriptedCombatEstimates'
import {
  canonicalBody,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'
import { InMemoryHeroAbilities } from '../../src/adapters/outbound/inventory/InMemoryHeroAbilities'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { HeroProfileOutcome } from '../../src/application/ports/HeroAbilitiesPort'
import type {
  CombatEstimate,
  EstimateCallOutcome,
  MissionEstimatePort,
} from '../../src/application/ports/MissionEstimatePort'
import { EstimateMissionSuccess } from '../../src/application/use-cases/EstimateMissionSuccess'
import { buildSimulationRequest } from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import type { SimulationRequest } from '../../src/domain/entities/MissionExecution'
import {
  EstimateUnavailableError,
  HeroNotOwnedError,
  MissionNotFoundError,
} from '../../src/domain/errors/mission-errors'
import {
  ESTIMATE_RUNS,
  estimateOperationId,
  riskLabelOf,
  riskOf,
} from '../../src/domain/policies/EstimatePolicy'
import { UnknownDifficultyError } from '../../src/domain/value-objects/difficulty-level'
import type { Rotation } from '../../src/domain/value-objects/rotation'

const [TEMPLO] = EXAMPLE_MISSIONS as [MissionDefinition]
const PLAYER = 'sub-1'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const AT = new Date('2026-10-01T15:00:00.000Z')

const ROTATIONS: readonly Rotation[] = [
  { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'golpe-de-tormenta' }] },
]

const ESTIMATE: CombatEstimate = {
  runs: 30,
  victories: 22,
  defeats: 6,
  timeouts: 2,
  winRate: 0.73,
  averageTurns: 41.4,
  averageDamageTaken: 18.25,
  averageMinHealthPercent: 35.5,
  masterAppearanceRate: 0.17,
  abilities: [
    { abilityId: 'golpe-de-tormenta', name: 'Golpe de tormenta', usable: true, reason: null },
    {
      abilityId: 'pare-de-fuego',
      name: 'Pare de fuego',
      usable: false,
      reason: 'un efecto condicionado no se evalua: Combat no recibe la condicion.',
    },
  ],
}

/** Guarda lo que se pide a Combat y responde lo que se le diga. */
class RecordingEstimates implements MissionEstimatePort {
  readonly calls: { request: SimulationRequest; runs: number }[] = []

  constructor(private readonly outcome: EstimateCallOutcome) {}

  estimate(request: SimulationRequest, runs: number): Promise<EstimateCallOutcome> {
    this.calls.push({ request, runs })
    return Promise.resolve(this.outcome)
  }
}

const heroesAnswering = (outcome: HeroProfileOutcome) => ({
  profileOf: () => Promise.resolve(outcome),
})

const setup = (
  options: {
    readonly outcome?: EstimateCallOutcome
    readonly hero?: HeroProfileOutcome
  } = {},
) => {
  const heroes = new InMemoryHeroAbilities()
  const strategies = new InMemoryStrategyRepository()
  const estimates = new RecordingEstimates(
    options.outcome ?? { kind: 'ESTIMATED', estimate: ESTIMATE },
  )
  const useCase = new EstimateMissionSuccess(
    new InMemoryMissionCatalog(EXAMPLE_MISSIONS),
    options.hero === undefined ? heroes : heroesAnswering(options.hero),
    strategies,
    estimates,
  )

  return { useCase, estimates, strategies, heroes }
}

const QUERY = { playerId: PLAYER, missionId: TEMPLO.missionId, heroId: HERO, difficulty: 'HEROIC' }

describe('Riesgo de una estimacion (P-J7)', () => {
  it.each([
    [100, 'LOW', 'Favorable'],
    [80, 'LOW', 'Favorable'],
    [79, 'MEDIUM', 'Pareja'],
    [50, 'MEDIUM', 'Pareja'],
    [49, 'HIGH', 'Arriesgada'],
    [20, 'HIGH', 'Arriesgada'],
    [19, 'EXTREME', 'Muy arriesgada'],
    [0, 'EXTREME', 'Muy arriesgada'],
  ] as const)('con %s %% de victorias el riesgo es %s (%s)', (percent, risk, label) => {
    expect(riskOf(percent)).toBe(risk)
    expect(riskLabelOf(risk)).toBe(label)
  })

  it('la operacion es la misma para la misma pregunta y cambia con cada dato', () => {
    const base = {
      playerId: PLAYER,
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'NORMAL' as const,
      strategyVersion: null,
    }
    const id = estimateOperationId(base)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(estimateOperationId({ ...base })).toBe(id)
    expect(
      new Set([
        id,
        estimateOperationId({ ...base, playerId: 'sub-2' }),
        estimateOperationId({ ...base, heroId: 'otro' }),
        estimateOperationId({ ...base, difficulty: 'HEROIC' }),
        estimateOperationId({ ...base, strategyVersion: 1 }),
      ]).size,
    ).toBe(5)
  })
})

describe('EstimateMissionSuccess (P-J7)', () => {
  it('pide a Combat la misma solicitud que la mision real, con la estrategia guardada', async () => {
    const { useCase, estimates, strategies, heroes } = setup()
    await strategies.save(
      {
        playerId: PLAYER,
        heroId: HERO,
        missionId: TEMPLO.missionId,
        version: 1,
        rotations: ROTATIONS,
        updatedAt: AT,
      },
      null,
    )

    await useCase.execute(QUERY)

    const profile = await heroes.profileOf(PLAYER, HERO)
    const operationId = estimateOperationId({
      playerId: PLAYER,
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'HEROIC',
      strategyVersion: 1,
    })
    expect(estimates.calls).toEqual([
      {
        runs: ESTIMATE_RUNS,
        request: buildSimulationRequest({
          operationId,
          enrollmentId: `estimate:${operationId}`,
          missionId: TEMPLO.missionId,
          difficulty: 'HEROIC',
          durationMinutes: TEMPLO.estimatedDurationMinutes,
          heroId: HERO,
          heroProfile: profile.kind === 'FOUND' ? profile.profile : {},
          strategyVersion: 1,
          rotations: ROTATIONS,
          definition: TEMPLO,
        }),
      },
    ])
  })

  it('devuelve porcentajes enteros, el riesgo y las habilidades que no sirven', async () => {
    const { useCase } = setup()

    await expect(useCase.execute(QUERY)).resolves.toEqual({
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'HEROIC',
      strategyVersion: null,
      runs: 30,
      successPercent: 73,
      defeatPercent: 20,
      timeoutPercent: 7,
      risk: 'MEDIUM',
      riskLabel: 'Pareja',
      averageTurns: 41,
      averageMinHealthPercent: 36,
      masterAppearancePercent: 17,
      abilities: ESTIMATE.abilities,
    })
  })

  it('sin estrategia estima solo con el ataque basico', async () => {
    const { useCase, estimates } = setup()

    await useCase.execute({ ...QUERY, difficulty: 'NORMAL' })

    expect(estimates.calls[0]?.request.strategy).toEqual({
      version: null,
      rotations: [],
      fallback: 'BASIC_ATTACK',
    })
  })

  it('un nivel que no existe es UNKNOWN_DIFFICULTY y no se llama a Combat', async () => {
    const { useCase, estimates } = setup()

    await expect(useCase.execute({ ...QUERY, difficulty: 'IMPOSIBLE' })).rejects.toBeInstanceOf(
      UnknownDifficultyError,
    )
    await expect(useCase.execute({ ...QUERY, difficulty: '' })).rejects.toBeInstanceOf(
      UnknownDifficultyError,
    )
    expect(estimates.calls).toEqual([])
  })

  it('una mision que no existe es MISSION_NOT_FOUND', async () => {
    const { useCase } = setup()

    await expect(useCase.execute({ ...QUERY, missionId: 'msn_nada' })).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
  })

  it('un heroe ajeno es HERO_NOT_OWNED', async () => {
    const { useCase, estimates } = setup({ hero: { kind: 'NOT_OWNED' } })

    await expect(useCase.execute(QUERY)).rejects.toBeInstanceOf(HeroNotOwnedError)
    expect(estimates.calls).toEqual([])
  })

  it('sin perfil del heroe o sin respuesta de Combat no hay estimacion', async () => {
    await expect(
      setup({ hero: { kind: 'UNKNOWN', reason: 'TIMEOUT' } }).useCase.execute(QUERY),
    ).rejects.toBeInstanceOf(EstimateUnavailableError)

    const failed = setup({ outcome: { kind: 'UNAVAILABLE', reason: 'HTTP_503' } }).useCase
    await expect(failed.execute(QUERY)).rejects.toMatchObject({
      name: 'EstimateUnavailableError',
      reason: 'HTTP_503',
    })
  })

  it('ESTIMATE_UNAVAILABLE es un 503 con un mensaje para el jugador y sin el motivo interno', () => {
    const exception = toMissionsHttpException(new EstimateUnavailableError('NOT_CONFIGURED'))

    expect(exception.getStatus()).toBe(503)
    expect(exception.getResponse()).toEqual({
      statusCode: 503,
      code: 'ESTIMATE_UNAVAILABLE',
      message: 'No pudimos calcular la probabilidad de éxito ahora. Puedes enviar al héroe igual.',
    })
  })
})

describe('CombatEstimateClient (P-J7)', () => {
  const PATH = '/api/internal/v1/combat/simulations/estimates'
  const REQUEST = buildSimulationRequest({
    operationId: 'op-estimacion',
    enrollmentId: 'estimate:op-estimacion',
    missionId: TEMPLO.missionId,
    difficulty: 'NORMAL',
    durationMinutes: TEMPLO.estimatedDurationMinutes,
    heroId: HERO,
    heroProfile: { subtype: 'GUERRERO_ARMAS', abilities: [] },
    strategyVersion: null,
    rotations: [],
    definition: TEMPLO,
  })
  const withoutSnapshot = (() => {
    const copy = { ...REQUEST }
    Reflect.deleteProperty(copy, 'contentSnapshot')
    return copy
  })()

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const clientReturning = (respond: () => Response | Error) => {
    const calls: { url: string; init: RequestInit }[] = []
    const failures: { event: string; detail: Readonly<Record<string, unknown>> }[] = []
    const fetchImpl = ((url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      const response = respond()
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }) as unknown as typeof fetch
    const client = new CombatEstimateClient({
      baseUrl: 'http://combat:3004',
      secret: 'secreto',
      clock: { now: () => AT },
      timeoutMs: 1_000,
      fetchImpl,
      onFailure: (event, detail) => failures.push({ event, detail }),
    })

    return { client, calls, failures }
  }

  it('firma un POST con las corridas y la solicitud sin el contenido, y lee la estimacion', async () => {
    const { client, calls, failures } = clientReturning(() => json(200, ESTIMATE))

    await expect(client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'ESTIMATED',
      estimate: ESTIMATE,
    })

    const payload = { runs: 30, request: withoutSnapshot }
    const [call] = calls
    expect(call?.url).toBe(`http://combat:3004${PATH}`)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.body).toBe(canonicalBody(payload))
    expect(call?.init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-internal-service': 'missions',
      'x-internal-timestamp': String(AT.getTime()),
      'x-internal-signature': signInternalRequest('secreto', {
        service: 'missions',
        method: 'POST',
        path: PATH,
        timestamp: String(AT.getTime()),
        body: payload,
      }),
    })
    expect(failures).toEqual([])
  })

  it.each([
    ['una tasa mayor que 1', { ...ESTIMATE, winRate: 1.5 }],
    ['sin corridas', { ...ESTIMATE, runs: 0 }],
    ['un conteo con decimales', { ...ESTIMATE, victories: 2.5 }],
    ['sin habilidades', { ...ESTIMATE, abilities: undefined }],
    ['una habilidad incompleta', { ...ESTIMATE, abilities: [{ abilityId: 'x' }] }],
    ['un cuerpo que no es objeto', ['no']],
  ])('un 200 con %s no se muestra', async (_caso, body) => {
    const { client, failures } = clientReturning(() => json(200, body))

    await expect(client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      reason: 'INVALID_RESPONSE',
    })
    expect(failures).toEqual([
      { event: 'combat_estimacion_invalida', detail: { path: PATH, status: 200 } },
    ])
  })

  it('un rechazo con codigo lo conserva; sin codigo queda el estado', async () => {
    const rejected = clientReturning(() => json(422, { code: 'CONTENT_INVALID' }))
    await expect(rejected.client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      reason: 'CONTENT_INVALID',
    })
    expect(rejected.failures).toEqual([
      {
        event: 'combat_sin_estimacion',
        detail: { path: PATH, status: 422, code: 'CONTENT_INVALID' },
      },
    ])

    const down = clientReturning(() => json(503, {}))
    await expect(down.client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      reason: 'HTTP_503',
    })
  })

  it('un error de red o un tiempo agotado dejan la estimacion sin mostrar', async () => {
    const network = clientReturning(() => new TypeError('fetch failed'))
    await expect(network.client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      reason: 'NETWORK',
    })

    const timeout = new Error('tiempo agotado')
    timeout.name = 'TimeoutError'
    const slow = clientReturning(() => timeout)
    await expect(slow.client.estimate(REQUEST, 30)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      reason: 'TIMEOUT',
    })
    expect(slow.failures).toEqual([
      { event: 'combat_estimacion_inalcanzable', detail: { path: PATH, reason: 'TIMEOUT' } },
    ])
  })
})

describe('ScriptedCombatEstimates (desarrollo)', () => {
  const requestWith = (heroProfile: Readonly<Record<string, unknown>>) =>
    buildSimulationRequest({
      operationId: 'op',
      enrollmentId: 'estimate:op',
      missionId: TEMPLO.missionId,
      difficulty: 'NORMAL',
      durationMinutes: TEMPLO.estimatedDurationMinutes,
      heroId: HERO,
      heroProfile,
      strategyVersion: null,
      rotations: [],
      definition: TEMPLO,
    })

  it('coincide con la simulacion fija: todo victorias y toda habilidad usable', async () => {
    const profile = await new InMemoryHeroAbilities(['golpe-de-tormenta']).profileOf(PLAYER, HERO)
    const request = requestWith(profile.kind === 'FOUND' ? profile.profile : {})

    await expect(new ScriptedCombatEstimates().estimate(request, 10)).resolves.toMatchObject({
      kind: 'ESTIMATED',
      estimate: {
        runs: 10,
        victories: 10,
        winRate: 1,
        abilities: [
          { abilityId: 'golpe-de-tormenta', name: 'golpe de tormenta', usable: true, reason: null },
        ],
      },
    })
  })

  it('un perfil sin habilidades no inventa ninguna', async () => {
    await expect(new ScriptedCombatEstimates().estimate(requestWith({}), 5)).resolves.toMatchObject(
      { estimate: { abilities: [] } },
    )
  })
})
