import { ScriptedCombatSimulation } from '../../src/adapters/outbound/combat/ScriptedCombatSimulation'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { PlayerInventoryEpicGrantClient } from '../../src/adapters/outbound/inventory/PlayerInventoryEpicGrantClient'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryExperienceRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { InMemoryLootGrantRepository } from '../../src/adapters/outbound/persistence/InMemoryLootGrantRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
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
import type { MissionCatalogPort } from '../../src/application/ports/MissionCatalogPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { GetMissionReport } from '../../src/application/use-cases/GetMissionReport'
import { GrantMissionLoot } from '../../src/application/use-cases/GrantMissionLoot'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import {
  InvalidLootTransitionError,
  lootConfirmed,
  lootDeferred,
  lootRejected,
  type LootGrantRecord,
} from '../../src/domain/entities/LootGrantRecord'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  dropProductOf,
  lootGrantOperationId,
  lootRewardsOf,
} from '../../src/domain/policies/LootPolicy'
import { strategyOf } from '../../src/domain/policies/ReportPolicy'

const AT = new Date('2026-10-01T15:00:00.000Z')
const TEMPLO = EXAMPLE_MISSIONS[0]!
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const FRAGMENTO = '11111111-1111-4111-8111-111111111111'
const PIEL = '22222222-2222-4222-8222-222222222222'

/**
 * El Templo con botin seguro: el doble de Combat solo deja caer lo de probabilidad
 * 1. Fragmento (3 tiradas) y Piel caen; la Espada (15 %) no. Sin Master.
 */
const templo = (products: { fragmento?: string | null; piel?: string | null } = {}) => ({
  ...TEMPLO,
  masterEncounter: null,
  finalBoss: {
    ...TEMPLO.finalBoss,
    drops: [
      {
        label: 'Fragmento del Sello Antiguo',
        probability: 1,
        rolls: 3,
        productId: products.fragmento === undefined ? FRAGMENTO : products.fragmento,
      },
      {
        label: 'Armadura «Piel del Guardián»',
        probability: 1,
        rolls: 1,
        productId: products.piel === undefined ? PIEL : products.piel,
      },
      { label: 'Arma «Espada del Templo»', probability: 0.15, rolls: 1, productId: null },
    ],
  },
})

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
}

class SequenceIds implements IdGeneratorPort {
  private count = 0
  newEnrollmentId(): string {
    this.count += 1
    return `enr_${String(this.count)}`
  }
  newOperationId(): string {
    this.count += 1
    return `op-${String(this.count)}`
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

/** Player/Inventory: el doble idempotente, salvo las respuestas que la prueba encole. */
class Grants implements EpicGrantPort {
  readonly calls: EpicGrantRequest[] = []
  readonly answers: EpicGrantOutcome[] = []
  private readonly double = new InMemoryEpicGrants()
  grant(request: EpicGrantRequest): Promise<EpicGrantOutcome> {
    this.calls.push(request)
    const answer = this.answers.shift()
    return answer === undefined ? this.double.grant(request) : Promise.resolve(answer)
  }
}

const setup = (definition: MissionDefinition = templo()) => {
  const catalog = new Catalog([definition])
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const reports = new InMemoryReportRepository()
  const loot = new InMemoryLootGrantRepository(reports)
  const grants = new Grants()
  const clock = new MovableClock()
  const errors: unknown[] = []
  const executor = new RunMissionExecutions(
    new InMemoryExecutionRepository(
      enrollments,
      clears,
      reports,
      new InMemoryMasterEncounterRepository(reports),
      new InMemoryExperienceRewardRepository(reports),
      loot,
    ),
    enrollments,
    catalog,
    new Profiles(),
    new ScriptedCombatSimulation(),
    new Commitments(),
    new SequenceIds(),
    clock,
  )
  const lootWith = (source: EnrollmentRepositoryPort = enrollments) =>
    new GrantMissionLoot(loot, source, catalog, grants, clock, {
      batchSize: 50,
      onError: (_id, error) => errors.push(error),
    })
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    new InMemoryStrategyRepository(),
    new Commitments(),
    new SequenceIds(),
    clock,
  )

  const play = async (): Promise<string> => {
    const enrolled = await enroll.execute({
      playerId: 'sub-1',
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: 'key-1',
    })
    await executor.run()
    clock.current = new Date(enrolled.endsAt ?? clock.current)
    await executor.run()
    return enrolled.enrollmentId
  }

  return {
    catalog,
    enrollments,
    loot,
    grants,
    clock,
    errors,
    play,
    deliver: lootWith(),
    lootWith,
    report: new GetMissionReport(reports, enrollments),
  }
}

const productLines = async (report: GetMissionReport, enrollmentId: string) => {
  const view = await report.execute('sub-1', enrollmentId)
  return view.rewards.filter((line) => line.kind === 'PRODUCT')
}

describe('Entrega del botin del jefe (P-J1)', () => {
  it('el cierre deja una linea PRODUCT por botin, detras de las demas, y la entrega llega una vez', async () => {
    const { play, deliver, grants, report } = setup()
    const enrollmentId = await play()
    const view = await report.execute('sub-1', enrollmentId)
    const products = view.rewards.filter((line) => line.kind === 'PRODUCT')
    const others = view.rewards.filter((line) => line.kind !== 'PRODUCT')

    expect(products.map((line) => [line.name, line.quantity, line.status, line.source])).toEqual([
      ['Fragmento del Sello Antiguo', 3, 'PENDING', 'HU-72'],
      ['Armadura «Piel del Guardián»', 1, 'PENDING', 'HU-72'],
    ])
    expect(others.length).toBeGreaterThan(0)

    expect(await deliver.run()).toEqual({
      lootGranted: 2,
      lootRetried: 0,
      lootWaiting: 0,
      lootRejected: 0,
      lootFailed: 0,
    })
    expect(grants.calls).toEqual([
      {
        operationId: lootGrantOperationId(enrollmentId, 'Fragmento del Sello Antiguo'),
        playerId: 'sub-1',
        productId: FRAGMENTO,
        quantity: 3,
      },
      {
        operationId: lootGrantOperationId(enrollmentId, 'Armadura «Piel del Guardián»'),
        playerId: 'sub-1',
        productId: PIEL,
        quantity: 1,
      },
    ])
    expect((await productLines(report, enrollmentId)).map((line) => line.status)).toEqual([
      'CREDITED',
      'CREDITED',
    ])

    // Nada queda pendiente: un segundo ciclo no vuelve a pedir la entrega.
    await deliver.run()
    expect(grants.calls).toHaveLength(2)
  })

  it('sin producto enlazado espera; cuando el administrador lo enlaza, se entrega', async () => {
    const { play, deliver, grants, catalog, clock, loot, report } = setup(
      templo({ fragmento: null }),
    )
    const enrollmentId = await play()

    expect(await deliver.run()).toMatchObject({ lootGranted: 1, lootWaiting: 1 })
    const waiting = (await loot.listByEnrollment(enrollmentId)).find(
      (grant) => grant.label === 'Fragmento del Sello Antiguo',
    )
    expect(waiting).toMatchObject({ status: 'PENDING', lastError: 'LOOT_PRODUCT_MISSING' })

    catalog.definitions = [templo()]
    clock.current = new Date(clock.current.getTime() + 60_000)
    expect(await deliver.run()).toMatchObject({ lootGranted: 1 })
    expect(grants.calls.at(-1)).toMatchObject({ productId: FRAGMENTO, quantity: 3 })
    expect((await productLines(report, enrollmentId)).map((line) => line.status)).toEqual([
      'CREDITED',
      'CREDITED',
    ])
  })

  it('un rechazo definitivo deja la linea en FAILED y no se reintenta', async () => {
    const { play, deliver, grants, report } = setup(templo({ piel: null }))
    const enrollmentId = await play()
    grants.answers.push({ kind: 'REJECTED', reason: 'PRODUCT_NOT_FOUND' })

    expect(await deliver.run()).toMatchObject({ lootRejected: 1, lootWaiting: 1 })
    expect((await productLines(report, enrollmentId))[0]).toMatchObject({ status: 'FAILED' })
  })

  it('sin respuesta, se aplaza y el reintento lleva la misma operacion', async () => {
    const { play, deliver, grants, clock } = setup(templo({ piel: null }))
    await play()
    grants.answers.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })

    expect(await deliver.run()).toMatchObject({ lootRetried: 1 })
    clock.current = new Date(clock.current.getTime() + 60_000)
    expect(await deliver.run()).toMatchObject({ lootGranted: 1 })
    expect(grants.calls[0]?.operationId).toBe(grants.calls[1]?.operationId)
  })

  it('nunca entrega en una mision anulada', async () => {
    const { play, lootWith, enrollments, grants } = setup(templo({ piel: null }))
    await play()
    // La entrega solo lee la matricula: basta con ese metodo.
    const voided = {
      findById: async (id: string) => {
        const enrollment = await enrollments.findById(id)
        return enrollment === null ? null : { ...enrollment, status: 'VOIDED' }
      },
    } as unknown as EnrollmentRepositoryPort

    // Las dos entregas pendientes (Fragmento y Piel) se rechazan sin llamar al inventario.
    expect(await lootWith(voided).run()).toMatchObject({ lootRejected: 2 })
    expect(grants.calls).toHaveLength(0)
  })

  it('una matricula que desaparecio se informa y la entrega se aplaza', async () => {
    const { play, lootWith, errors, loot } = setup(templo({ piel: null }))
    const enrollmentId = await play()
    const missing = { findById: () => Promise.resolve(null) }

    expect(await lootWith(missing as unknown as EnrollmentRepositoryPort).run()).toMatchObject({
      lootFailed: 2,
    })
    expect(errors).toHaveLength(2)
    expect((await loot.listByEnrollment(enrollmentId))[0]).toMatchObject({
      status: 'PENDING',
      lastError: 'INTERNAL_ERROR',
      attempts: 1,
    })
  })
})

const grant = (overrides: Partial<LootGrantRecord> = {}): LootGrantRecord => ({
  enrollmentId: 'enr_1',
  lineNo: 20,
  label: 'Fragmento',
  quantity: 2,
  operationId: lootGrantOperationId('enr_1', 'Fragmento'),
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: AT,
  lastError: null,
  grantedAt: null,
  productId: null,
  ...overrides,
})

describe('Politica del botin (P-J1)', () => {
  it('numera las lineas desde la primera libre y congela el producto que ya se conoce', () => {
    const { records, rewards } = lootRewardsOf({
      enrollmentId: 'enr_1',
      loot: [
        { label: 'Fragmento', quantity: 3, productId: null },
        { label: 'Piel', quantity: 1, productId: PIEL },
      ],
      definition: { finalBoss: { drops: [{ label: 'Fragmento', productId: FRAGMENTO }] } },
      firstLineNo: 20,
      now: AT,
    })

    expect(rewards.map((line) => [line.lineNo, line.kind, line.source])).toEqual([
      [20, 'PRODUCT', 'HU-72'],
      [21, 'PRODUCT', 'HU-72'],
    ])
    expect(records.map((record) => record.productId)).toEqual([FRAGMENTO, PIEL])
    expect(records[0]?.operationId).toBe(lootGrantOperationId('enr_1', 'Fragmento'))
    expect(records[0]?.operationId).not.toBe(records[1]?.operationId)
  })

  it('lee el producto del contenido sin fiarse de su forma', () => {
    expect(dropProductOf(null, 'X')).toBeNull()
    expect(dropProductOf({ finalBoss: 'roto' }, 'X')).toBeNull()
    expect(dropProductOf({ finalBoss: { drops: [{ label: 'X', productId: '' }] } }, 'X')).toBeNull()
    expect(
      dropProductOf({ finalBoss: { drops: [null, { label: 'X', productId: PIEL }] } }, 'X'),
    ).toBe(PIEL)
  })

  it('solo una entrega pendiente cambia de estado', () => {
    const delivered = lootConfirmed(grant(), AT)
    expect(delivered).toMatchObject({ status: 'GRANTED', attempts: 1, grantedAt: AT })
    expect(lootRejected(grant(), 'NO')).toMatchObject({ status: 'REJECTED', lastError: 'NO' })
    expect(lootDeferred(grant(), 'HTTP_503', AT).nextAttemptAt?.getTime()).toBeGreaterThan(
      AT.getTime(),
    )
    expect(() => lootConfirmed(delivered, AT)).toThrow(InvalidLootTransitionError)
  })

  it('el cliente de entregas manda la cantidad (1 si no se indica)', async () => {
    const bodies: unknown[] = []
    const client = new PlayerInventoryEpicGrantClient({
      baseUrl: 'http://inventory',
      secret: 'secreto',
      clock: { now: () => AT },
      timeoutMs: 1000,
      fetchImpl: (_url, init) => {
        const raw = typeof init?.body === 'string' ? init.body : '{}'
        const body = JSON.parse(raw) as { operationId: string }
        bodies.push(body)
        return Promise.resolve(
          new Response(JSON.stringify({ applied: true, operationId: body.operationId }), {
            status: 200,
          }),
        )
      },
    })

    await client.grant({ operationId: 'op-1', playerId: 'p', productId: PIEL, quantity: 3 })
    await client.grant({ operationId: 'op-2', playerId: 'p', productId: PIEL })

    expect(bodies).toEqual([
      { operationId: 'op-1', playerId: 'p', items: [{ productId: PIEL, quantity: 3 }] },
      { operationId: 'op-2', playerId: 'p', items: [{ productId: PIEL, quantity: 1 }] },
    ])
  })
})

describe('Lo que hizo la estrategia (P-J5)', () => {
  const rotations = [
    {
      priority: 'HIGH' as const,
      steps: [{ kind: 'ABILITY' as const, abilityId: 'golpe' }, { kind: 'BASIC_ATTACK' as const }],
    },
    { priority: 'MEDIUM' as const, steps: [{ kind: 'ABILITY' as const, abilityId: 'cura' }] },
  ]
  const heroAction = (
    action: 'ABILITY' | 'BASIC_ATTACK',
    abilityId: string | null,
    strategy: Readonly<Record<string, unknown>>,
  ) => ({ type: 'heroAction', action, abilityId, strategy })

  it('cuenta usos, saltos con su motivo y ataques basicos, con los nombres congelados', () => {
    const summary = strategyOf({
      rotations,
      heroProfile: { abilities: [{ abilityId: 'golpe', name: 'Golpe con escudo' }] },
      combatLog: [
        heroAction('ABILITY', 'golpe', { rotation: 'HIGH', step: 1, fallback: false, skipped: [] }),
        heroAction('ABILITY', 'cura', {
          rotation: 'MEDIUM',
          step: 1,
          fallback: false,
          skipped: [{ rotation: 'HIGH', step: 1, reason: 'ON_COOLDOWN' }],
        }),
        heroAction('BASIC_ATTACK', null, {
          rotation: 'HIGH',
          step: 2,
          fallback: false,
          skipped: [],
        }),
        heroAction('BASIC_ATTACK', null, {
          rotation: null,
          step: null,
          fallback: true,
          skipped: [
            { rotation: 'HIGH', step: 1, reason: 'NOT_ENOUGH_POWER' },
            { rotation: 'MEDIUM', step: 1, reason: 'ON_COOLDOWN' },
          ],
        }),
        { type: 'enemyAction' },
        'roto',
      ],
    })

    expect(summary).toEqual({
      abilities: [
        {
          abilityId: 'golpe',
          name: 'Golpe con escudo',
          used: 1,
          skipped: { ON_COOLDOWN: 1, NOT_ENOUGH_POWER: 1 },
        },
        { abilityId: 'cura', name: 'cura', used: 1, skipped: { ON_COOLDOWN: 1 } },
      ],
      basicAttacks: 1,
      fallbackAttacks: 1,
    })
  })

  it('sin estrategia guardada no hay bloque', () => {
    expect(strategyOf({ rotations: [], heroProfile: null, combatLog: [] })).toBeNull()
  })
})
