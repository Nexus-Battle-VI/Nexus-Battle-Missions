import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryExperienceRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { InMemoryLootGrantRepository } from '../../src/adapters/outbound/persistence/InMemoryLootGrantRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryMissionCompletionRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryMissionCompletionRewardRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CompletionExperienceCreditOutcome,
  CompletionExperienceCreditPort,
  CompletionExperienceCreditRequest,
} from '../../src/application/ports/CompletionExperienceCreditPort'
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
import type {
  WalletCreditOutcome,
  WalletCreditPort,
  WalletCreditRequest,
} from '../../src/application/ports/WalletCreditPort'
import type { CombatSimulationPort } from '../../src/application/ports/CombatSimulationPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { GetMissionReport } from '../../src/application/use-cases/GetMissionReport'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import { CoordinateMissionCompletionReward } from '../../src/application/use-cases/CoordinateMissionCompletionReward'
import {
  completionDeliveryKey,
  completionOperationIdOf,
  completionRewardLogicalKey,
  COMPLETION_REWARD_NAMESPACE,
} from '../../src/domain/entities/MissionCompletionRewardDelivery'
import { uuidV5 } from '../../src/domain/value-objects/deterministic-uuid'
import type {
  CompletionRewards,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import type { SimulationResult } from '../../src/domain/entities/MissionExecution'
import { completionRewardsOf } from '../../src/domain/policies/CompletionRewardPolicy'
import { completionRewardDeliveriesOf } from '../../src/domain/policies/CompletionRewardDeliveryPolicy'

const TEMPLO = EXAMPLE_MISSIONS[0]!
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const PRODUCT = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f61'
const AT = new Date('2026-10-01T15:00:00.000Z')

const completion = (overrides: Partial<CompletionRewards> = {}): CompletionRewards => ({
  schemaVersion: 1,
  experience: { amountByDifficulty: { NORMAL: 11 } },
  entries: [
    {
      key: 'credits-base',
      group: 'GUARANTEED',
      grantOn: ['COMPLETED'],
      reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5 } },
    },
  ],
  ...overrides,
})

/** El Templo sin Master ni botin: asi las lineas HU-10 son faciles de ubicar. */
const templo = (block: CompletionRewards = completion()): MissionDefinition => ({
  ...TEMPLO,
  masterEncounter: null,
  finalBoss: { ...TEMPLO.finalBoss, drops: [] },
  rewards: { ...TEMPLO.rewards, completion: block },
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

const commitments: HeroCommitmentPort = {
  commit: (request: CommitHeroRequest): Promise<CommitHeroOutcome> =>
    Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` }),
  release: () => Promise.resolve('RELEASED' as const),
}

const profiles: HeroProfilePort = {
  profileOf: (): Promise<HeroProfileOutcome> =>
    Promise.resolve({
      kind: 'FOUND',
      profile: { heroId: HERO, subtype: 'GUERRERO_ARMAS', level: 1 },
    }),
}

/** Gana todos los encuentros (CA-06): COMPLETED mientras los objetivos principales se cumplan. */
const victorious: CombatSimulationPort = {
  simulate: (request) =>
    Promise.resolve({
      kind: 'SIMULATED',
      result: {
        simulationId: `sim_${request.operationId}`,
        seedRef: null,
        combatOutcome: 'HERO_VICTORIOUS',
        summary: {
          encountersCompleted: request.encounters.length,
          encountersTotal: request.encounters.length,
          totalTurns: 1,
          damageDealt: 10,
          damageTaken: 0,
          minHealthPercent: 100,
          criticalEffects: 0,
          enemiesDefeated: [],
          bossDefeated: true,
          master: { appeared: false, masterRef: null, defeated: false },
          loot: [],
          simulatedDuration: request.timeBudget,
        },
        combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' }],
      },
    }),
}

/** El heroe cae (CA-04): FAILED siempre, sin importar los objetivos. */
const defeated: CombatSimulationPort = {
  simulate: (request) =>
    Promise.resolve({
      kind: 'SIMULATED',
      result: {
        simulationId: `sim_${request.operationId}`,
        seedRef: null,
        combatOutcome: 'HERO_DEFEATED',
        summary: {
          encountersCompleted: 0,
          encountersTotal: request.encounters.length,
          totalTurns: 1,
          damageDealt: 0,
          damageTaken: 100,
          minHealthPercent: 0,
          criticalEffects: 0,
          enemiesDefeated: [],
          bossDefeated: false,
          master: { appeared: false, masterRef: null, defeated: false },
          loot: [],
          simulatedDuration: request.timeBudget,
        },
        combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_DEFEATED' }],
      } satisfies SimulationResult,
    }),
}

const setup = (definition: MissionDefinition, combat: CombatSimulationPort = victorious) => {
  const catalog = new Catalog([definition])
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const reports = new InMemoryReportRepository()
  const deliveries = new InMemoryMissionCompletionRewardRepository(reports)
  const clock = new MovableClock()
  const executions = new InMemoryExecutionRepository(
    enrollments,
    clears,
    reports,
    new InMemoryMasterEncounterRepository(reports),
    new InMemoryExperienceRewardRepository(reports),
    new InMemoryLootGrantRepository(reports),
    deliveries,
  )
  const executor = new RunMissionExecutions(
    executions,
    enrollments,
    catalog,
    profiles,
    combat,
    commitments,
    new SequenceIds(),
    clock,
    { batchSize: 50 },
  )
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    new InMemoryStrategyRepository(),
    commitments,
    new SequenceIds(),
    clock,
  )
  const report = new GetMissionReport(reports, enrollments)

  const play = async (): Promise<string> => {
    const enrolled = await enroll.execute({
      playerId: 'sub-1',
      missionId: definition.missionId,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: `key-${String(Math.random())}`,
    })
    await executor.run()
    const endsAt = enrolled.endsAt === null ? clock.current : new Date(enrolled.endsAt)
    clock.current = new Date(endsAt.getTime() + 1)
    await executor.run()
    return enrolled.enrollmentId
  }

  return { catalog, enrollments, executions, executor, deliveries, clock, play, report }
}

describe('HU-10.5 — el cierre liquida la finalizacion dentro de su transaccion', () => {
  it('COMPLETED deja una entrega PENDING por XP y por cada credito con grantOn COMPLETED, detras de las demas', async () => {
    const { play, deliveries, report } = setup(templo())
    const enrollmentId = await play()

    const pending = await deliveries.listByEnrollment(enrollmentId)
    expect(
      pending.map((d) => ({ kind: d.kind, rewardKey: d.rewardKey, status: d.status })),
    ).toEqual([
      { kind: 'EXPERIENCE', rewardKey: 'completion:xp', status: 'PENDING' },
      { kind: 'CREDITS', rewardKey: 'guaranteed:credits-base', status: 'PENDING' },
    ])

    const view = await report.execute('sub-1', enrollmentId)
    const hu10Lines = view.rewards.filter((line) => line.source === 'HU-10')

    expect(hu10Lines.map((line) => line.kind)).toEqual(['EXPERIENCE', 'CREDITS'])
    // Las lineas HU-10 van AL FINAL (contrato §7): son exactamente el sufijo.
    expect(view.rewards.slice(view.rewards.length - hu10Lines.length)).toEqual(hu10Lines)
  })

  it('FAILED da la XP pero NO los creditos que no declaran FAILED en grantOn', async () => {
    const { play, deliveries } = setup(templo(), defeated)
    const enrollmentId = await play()

    const pending = await deliveries.listByEnrollment(enrollmentId)
    expect(pending.map((d) => d.kind)).toEqual(['EXPERIENCE'])
  })

  it('FAILED SI da el credito cuya entrada declara FAILED en grantOn', async () => {
    const block = completion({
      entries: [
        {
          key: 'consuelo',
          group: 'GUARANTEED',
          grantOn: ['COMPLETED', 'FAILED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 2 } },
        },
      ],
    })
    const { play, deliveries } = setup(templo(block), defeated)
    const enrollmentId = await play()

    const pending = await deliveries.listByEnrollment(enrollmentId)
    expect(pending.map((d) => d.kind)).toEqual(['EXPERIENCE', 'CREDITS'])
  })

  it('un objetivo de bonificacion cumplido da su entrega; no cumplido o sin evaluar, no', async () => {
    const objectiveId = TEMPLO.objectives.find((o) => o.primary)?.id ?? TEMPLO.objectives[0]!.id
    const block = completion({
      entries: [
        {
          key: 'bono',
          group: 'OBJECTIVE_BONUS',
          grantOn: ['COMPLETED'],
          objectiveId,
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 3 } },
        },
      ],
    })
    const { play, deliveries, report } = setup(templo(block))
    const enrollmentId = await play()

    const kinds = (await deliveries.listByEnrollment(enrollmentId)).map((d) => d.rewardKey)
    const view = await report.execute('sub-1', enrollmentId)
    const met = view.objectives.find((o) => o.id === objectiveId)?.met === true

    // La decision la toma `CompletionRewardPolicy` sobre el MISMO resultado que ya
    // quedo en el reporte: si el objetivo quedo cumplido, hay entrega; si no, no.
    expect(kinds.includes('objective-bonus:bono')).toBe(met)
  })

  it('FIRST_TIME NO se liquida aunque este configurado (P-HU10-4 sigue abierta)', async () => {
    const block = completion({
      entries: [
        {
          key: 'bienvenida',
          group: 'FIRST_TIME',
          grantOn: ['COMPLETED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 1 } },
        },
      ],
    })
    const { play, deliveries } = setup(templo(block))
    const enrollmentId = await play()

    const kinds = (await deliveries.listByEnrollment(enrollmentId)).map((d) => d.rewardKey)
    expect(kinds).not.toContain('first-time:bienvenida')
  })

  it('sin snapshot congelado NO hay derecho: la politica (base de la entrega) devuelve vacio', () => {
    // El camino end-to-end sin snapshot ya lo cubre `hu-10-completion-rewards.spec.ts`
    // (HU-10.4); aqui se confirma que `completionRewardDeliveriesOf` -- lo nuevo de
    // HU-10.5 -- no inventa nada cuando la politica no da ningun derecho.
    const evaluation = completionRewardsOf({
      content: null,
      difficulty: 'NORMAL',
      outcome: 'COMPLETED',
      objectives: [],
    })

    expect(evaluation.entitlements).toEqual([])

    const { deliveries, lines } = completionRewardDeliveriesOf({
      enrollmentId: 'enr-9',
      playerId: 'sub-1',
      heroId: HERO,
      missionId: 'm',
      simulationId: 's',
      difficulty: 'NORMAL',
      missionOutcome: 'COMPLETED',
      entitlements: evaluation.entitlements,
      firstLineNo: 1,
      settledAt: AT,
    })

    expect(deliveries).toEqual([])
    expect(lines).toEqual([])
  })

  it('cerrar dos veces la misma ejecucion no crea una segunda entrega ni una segunda linea', async () => {
    const { play, executor, deliveries, report } = setup(templo())
    const enrollmentId = await play()
    const before = await deliveries.listByEnrollment(enrollmentId)

    // Un segundo ciclo no encuentra nada "closable" (la matricula ya no esta
    // IN_PROGRESS), asi que no reintenta el cierre -- la idempotencia de verdad la
    // cubre `hu-72-executions.spec.ts` (T-03) sobre el MISMO closure concurrente.
    await executor.run()

    const after = await deliveries.listByEnrollment(enrollmentId)
    expect(after).toEqual(before)
    expect(
      (await report.execute('sub-1', enrollmentId)).rewards.filter((l) => l.source === 'HU-10'),
    ).toHaveLength(before.length)
  })
})

describe('HU-10.5 — identificadores de operacion exactos (contrato §12)', () => {
  it('la clave logica es mission:{enrollmentId}:reward:{rewardKey}', () => {
    expect(completionRewardLogicalKey('enr-9', 'completion:xp')).toBe(
      'mission:enr-9:reward:completion:xp',
    )
  })

  it('XP y creditos viajan con la clave logica TAL CUAL; producto, con su UUID v5 propio', () => {
    const base = {
      enrollmentId: 'enr-9',
      playerId: 'sub-1',
      heroId: HERO,
      missionId: 'm',
      simulationId: 's',
      difficulty: 'NORMAL' as const,
      missionOutcome: 'COMPLETED' as const,
      settledAt: AT,
      status: 'PENDING' as const,
      attempts: 0,
      nextAttemptAt: AT,
      lastError: null,
      creditedAt: null,
      reportLineNo: 1,
    }

    expect(
      completionOperationIdOf({
        ...base,
        kind: 'EXPERIENCE',
        rewardKey: 'completion:xp',
        amount: 11,
      }),
    ).toBe('mission:enr-9:reward:completion:xp')

    expect(
      completionOperationIdOf({
        ...base,
        kind: 'CREDITS',
        rewardKey: 'guaranteed:credits-base',
        amount: 5,
      }),
    ).toBe('mission:enr-9:reward:guaranteed:credits-base')

    const productKey = 'guaranteed:sello'
    expect(
      completionOperationIdOf({
        ...base,
        kind: 'PRODUCT',
        rewardKey: productKey,
        productId: PRODUCT,
        quantity: 1,
      }),
    ).toBe(uuidV5(COMPLETION_REWARD_NAMESPACE, completionRewardLogicalKey('enr-9', productKey)))
  })

  it('el espacio de nombres del producto es el CONTRACTUAL, distinto del de HU-72/HU-73', () => {
    expect(COMPLETION_REWARD_NAMESPACE).toBe('7565c40b-1f2b-4854-bfde-124bf8c7db44')
  })

  it('la clave de almacenamiento combina matricula y rewardKey', () => {
    expect(completionDeliveryKey({ enrollmentId: 'enr-9', rewardKey: 'completion:xp' })).toBe(
      'enr-9::completion:xp',
    )
  })
})

describe('HU-10.5 — CompletionRewardDeliveryPolicy: solo empaqueta, no decide', () => {
  it('cada entregable nace PENDING, listo para su primer intento en settledAt', () => {
    const { deliveries, lines } = completionRewardDeliveriesOf({
      enrollmentId: 'enr-9',
      playerId: 'sub-1',
      heroId: HERO,
      missionId: 'm',
      simulationId: 's',
      difficulty: 'NORMAL',
      missionOutcome: 'COMPLETED',
      entitlements: [
        { rewardKey: 'completion:xp', kind: 'EXPERIENCE', group: 'COMPLETION', amount: 11 },
      ],
      firstLineNo: 5,
      settledAt: AT,
    })

    expect(deliveries).toEqual([
      expect.objectContaining({ status: 'PENDING', attempts: 0, nextAttemptAt: AT, amount: 11 }),
    ])
    expect(lines).toEqual([
      expect.objectContaining({
        lineNo: 5,
        source: 'HU-10',
        status: 'PENDING',
        quantity: 11,
        progression: null,
      }),
    ])
  })

  it('un producto usa la clave de la entrada como nombre legible (HU-10.4 no trae etiqueta)', () => {
    const { lines } = completionRewardDeliveriesOf({
      enrollmentId: 'enr-9',
      playerId: 'sub-1',
      heroId: HERO,
      missionId: 'm',
      simulationId: 's',
      difficulty: 'NORMAL',
      missionOutcome: 'COMPLETED',
      entitlements: [
        {
          rewardKey: 'guaranteed:sello',
          kind: 'PRODUCT',
          group: 'GUARANTEED',
          entryKey: 'sello',
          productId: PRODUCT,
          quantity: 2,
        },
      ],
      firstLineNo: 1,
      settledAt: AT,
    })

    expect(lines[0]).toMatchObject({ name: 'sello', quantity: 2 })
  })
})

describe('HU-10.5 — coordinacion: clasificacion, idempotencia y fallos parciales', () => {
  class FakeXp implements CompletionExperienceCreditPort {
    readonly calls: CompletionExperienceCreditRequest[] = []
    readonly answers: CompletionExperienceCreditOutcome[] = []
    credit(request: CompletionExperienceCreditRequest): Promise<CompletionExperienceCreditOutcome> {
      this.calls.push(request)
      return Promise.resolve(this.answers.shift() ?? { kind: 'CREDITED', progression: null })
    }
  }

  class FakeWallet implements WalletCreditPort {
    readonly calls: WalletCreditRequest[] = []
    readonly answers: WalletCreditOutcome[] = []
    readonly byOperationId = new Set<string>()
    credit(request: WalletCreditRequest): Promise<WalletCreditOutcome> {
      this.calls.push(request)
      const answer = this.answers.shift()
      if (answer !== undefined) return Promise.resolve(answer)
      // Doble idempotente por defecto, como el Wallet real.
      return Promise.resolve({ kind: 'CREDITED' })
    }
  }

  const products = new InMemoryEpicGrants()

  const delivery = (
    overrides: Partial<{ kind: 'EXPERIENCE' | 'CREDITS'; rewardKey: string; amount: number }> = {},
  ) => ({
    enrollmentId: 'enr-9',
    playerId: 'sub-1',
    heroId: HERO,
    missionId: 'm',
    simulationId: 's',
    difficulty: 'NORMAL' as const,
    missionOutcome: 'COMPLETED' as const,
    rewardKey: overrides.rewardKey ?? 'completion:xp',
    settledAt: AT,
    status: 'PENDING' as const,
    attempts: 0,
    nextAttemptAt: AT,
    lastError: null,
    creditedAt: null,
    reportLineNo: null,
    kind: overrides.kind ?? ('EXPERIENCE' as const),
    amount: overrides.amount ?? 11,
  })

  const repo = (seed: ReturnType<typeof delivery>[]) => {
    const deliveries = new InMemoryMissionCompletionRewardRepository()
    deliveries.insert(seed)
    return deliveries
  }

  class MutableClock implements ClockPort {
    current = AT
    now(): Date {
      return this.current
    }
  }

  it('CREDITED marca la entrega acreditada y nunca se vuelve a pedir en el siguiente ciclo', async () => {
    const xp = new FakeXp()
    const wallet = new FakeWallet()
    const deliveries = repo([delivery()])
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      new MutableClock(),
    )

    expect(await coordinate.run()).toMatchObject({ xpCredited: 1 })
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('CREDITED')

    await coordinate.run()
    expect(xp.calls).toHaveLength(1)
  })

  it('un rechazo definitivo deja la linea FAILED y no se vuelve a reintentar', async () => {
    const xp = new FakeXp()
    xp.answers.push({ kind: 'REJECTED', reason: 'EXPERIENCE_GRANT_REJECTED' })
    const wallet = new FakeWallet()
    const deliveries = repo([delivery()])
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      new MutableClock(),
    )

    expect(await coordinate.run()).toMatchObject({ rejected: 1 })
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('FAILED')

    await coordinate.run()
    expect(xp.calls).toHaveLength(1)
  })

  it('un resultado incierto se reintenta con el MISMO operationId', async () => {
    const xp = new FakeXp()
    xp.answers.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    const wallet = new FakeWallet()
    const deliveries = repo([delivery()])
    const clock = new MutableClock()
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      clock,
      {
        batchSize: 50,
      },
    )

    expect(await coordinate.run()).toMatchObject({ retried: 1 })
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('PENDING')

    // El reintento solo queda "debido" cuando su `nextAttemptAt` ya paso.
    clock.current = new Date(clock.current.getTime() + 60_000)
    expect(await coordinate.run()).toMatchObject({ xpCredited: 1 })
    expect(xp.calls[0]?.operationId).toBe(xp.calls[1]?.operationId)
  })

  it('creditos: un fallo de red seguido de exito acredita UNA sola vez (sin duplicar saldo)', async () => {
    const xp = new FakeXp()
    const wallet = new FakeWallet()
    wallet.answers.push({ kind: 'UNKNOWN', reason: 'NETWORK' })
    const deliveries = repo([
      delivery({ kind: 'CREDITS', rewardKey: 'guaranteed:credits-base', amount: 5 }),
    ])
    const clock = new MutableClock()
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      clock,
    )

    await coordinate.run()
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('PENDING')

    // Reintento: Wallet ya habia aplicado la operacion en su lado (simulado por el
    // doble idempotente por defecto); Missions solo necesita que CREDITED llegue.
    clock.current = new Date(clock.current.getTime() + 60_000)
    await coordinate.run()
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('CREDITED')
    expect(wallet.calls[0]?.operationId).toBe(wallet.calls[1]?.operationId)
  })

  it('fallos parciales: lo acreditado no se repite; solo se reintenta lo pendiente', async () => {
    const xp = new FakeXp()
    const wallet = new FakeWallet()
    wallet.answers.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    const deliveries = repo([
      delivery({ rewardKey: 'completion:xp' }),
      delivery({ kind: 'CREDITS', rewardKey: 'guaranteed:credits-base', amount: 5 }),
    ])
    const clock = new MutableClock()
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      clock,
    )

    const first = await coordinate.run()
    expect(first).toMatchObject({ xpCredited: 1, retried: 1 })

    clock.current = new Date(clock.current.getTime() + 60_000)
    const second = await coordinate.run()
    expect(second).toMatchObject({ xpCredited: 0, creditsCredited: 1 })
    // La XP ya CREDITED no se volvio a pedir en el segundo ciclo.
    expect(xp.calls).toHaveLength(1)
  })

  it('producto: reutiliza el mismo cliente/contrato de la epica y el botin (GRANTED -> CREDITED)', async () => {
    const xp = new FakeXp()
    const wallet = new FakeWallet()
    const deliveries = repo([
      {
        ...delivery(),
        kind: 'PRODUCT' as const,
        rewardKey: 'guaranteed:sello',
        productId: PRODUCT,
        quantity: 2,
        amount: undefined,
      } as unknown as ReturnType<typeof delivery>,
    ])
    const coordinate = new CoordinateMissionCompletionReward(
      deliveries,
      xp,
      wallet,
      products,
      new MutableClock(),
    )

    expect(await coordinate.run()).toMatchObject({ productsCredited: 1 })
    expect((await deliveries.listByEnrollment('enr-9'))[0]?.status).toBe('CREDITED')
  })
})
