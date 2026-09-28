import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { HeroProfilePort } from '../../src/application/ports/HeroAbilitiesPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  HeroCommitmentPort,
} from '../../src/application/ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import type { CombatSimulationPort } from '../../src/application/ports/CombatSimulationPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import type {
  CompletionRewards,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import type { SimulationResult } from '../../src/domain/entities/MissionExecution'
import {
  completionRewardsOf,
  frozenContentOf,
} from '../../src/domain/policies/CompletionRewardPolicy'
import {
  InvalidMissionContentError,
  missionDefinitionOf,
} from '../../src/domain/policies/MissionContentPolicy'

/**
 * HU-10, Task HU-10.4: la FORMA estructurada de las recompensas de finalizacion
 * (`rewards.completion`), su validacion estricta, su congelacion con la ejecucion y
 * la politica pura de derechos (`hu-10-mission-completion-reward-v1` §4-§6).
 *
 * TODOS LOS MONTOS DE ESTE ARCHIVO SON VALORES DE PRUEBA. Ninguna mision real
 * lleva `rewards.completion` (P-HU10-2/3/4 siguen abiertas): el codigo queda listo
 * para contenido real futuro y no inventa cantidades.
 */
const TEMPLO = EXAMPLE_MISSIONS[0]!
const PRODUCT = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

const completion = (overrides: Partial<CompletionRewards> = {}): CompletionRewards => ({
  schemaVersion: 1,
  experience: { amountByDifficulty: { NORMAL: 11, HEROIC: 22 } },
  entries: [
    {
      key: 'credits-base',
      group: 'GUARANTEED',
      grantOn: ['COMPLETED'],
      reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5, HEROIC: 8 } },
    },
  ],
  ...overrides,
})

const withCompletion = (block: unknown): Record<string, unknown> => ({
  ...(structuredClone(TEMPLO) as unknown as Record<string, unknown>),
  rewards: { ...TEMPLO.rewards, completion: block },
})

const contentOf = (block: CompletionRewards | undefined): MissionDefinition => ({
  ...TEMPLO,
  rewards: block === undefined ? TEMPLO.rewards : { ...TEMPLO.rewards, completion: block },
})

const objectives = (met: Record<string, boolean | null>) =>
  Object.entries(met).map(([id, value]) => ({ id, met: value }))

describe('HU-10.4 — validacion de rewards.completion', () => {
  it('1. un contenido SIN completion sigue siendo valido y no genera derechos', () => {
    expect(() => missionDefinitionOf(structuredClone(TEMPLO), TEMPLO.missionId)).not.toThrow()

    const result = completionRewardsOf({
      content: TEMPLO,
      difficulty: 'NORMAL',
      outcome: 'COMPLETED',
      objectives: [],
    })

    expect(result.entitlements).toEqual([])
    expect(result.reason).toBe('NO_COMPLETION_CONFIG')
  })

  it('2. un bloque valido se acepta y se conserva TAL CUAL', () => {
    const block = completion({
      entries: [
        {
          key: 'credits-base',
          group: 'GUARANTEED',
          grantOn: ['COMPLETED', 'FAILED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5 } },
        },
        {
          key: 'sello-x',
          group: 'GUARANTEED',
          grantOn: ['COMPLETED'],
          reward: {
            kind: 'PRODUCT',
            productId: PRODUCT,
            quantityByDifficulty: { NORMAL: 1, MYTHIC: 3 },
          },
        },
        {
          key: 'vida-alta',
          group: 'OBJECTIVE_BONUS',
          grantOn: ['COMPLETED'],
          objectiveId: 'obj_vida',
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 2 } },
        },
        {
          key: 'primera-vez',
          group: 'FIRST_TIME',
          grantOn: ['COMPLETED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 1 } },
        },
      ],
    })

    const saved = missionDefinitionOf(withCompletion(block), TEMPLO.missionId)

    expect(saved.rewards.completion).toEqual(block)
  })

  it.each([
    ['3. schemaVersion distinta', () => ({ ...completion(), schemaVersion: 2 })],
    ['schemaVersion ausente', () => ({ experience: completion().experience })],
    ['un campo que el contrato no declara', () => ({ ...completion(), multiplier: 2 })],
    ['no es un objeto', () => 'completion'],
    [
      'XP con un campo extra',
      () => completion({ experience: { amountByDifficulty: { NORMAL: 5 }, bonus: 1 } as never }),
    ],
    ['XP sin ninguna dificultad', () => completion({ experience: { amountByDifficulty: {} } })],
    [
      '6. XP fraccionaria',
      () => completion({ experience: { amountByDifficulty: { NORMAL: 1.5 } } }),
    ],
    ['6. XP cero', () => completion({ experience: { amountByDifficulty: { NORMAL: 0 } } })],
    ['6. XP negativa', () => completion({ experience: { amountByDifficulty: { NORMAL: -3 } } })],
    [
      '8. una dificultad fuera del vocabulario',
      () => completion({ experience: { amountByDifficulty: { EASY: 5 } as never } }),
    ],
    [
      'una dificultad en minusculas',
      () => completion({ experience: { amountByDifficulty: { normal: 5 } as never } }),
    ],
  ])('rechaza: %s', (_label, build) => {
    expect(() => missionDefinitionOf(withCompletion(build()), TEMPLO.missionId)).toThrow(
      InvalidMissionContentError,
    )
  })

  const entry = (overrides: Record<string, unknown> = {}) => ({
    key: 'entrada',
    group: 'GUARANTEED',
    grantOn: ['COMPLETED'],
    reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5 } },
    ...overrides,
  })

  it.each([
    ['4. claves duplicadas', [entry(), entry()]],
    ['una clave con mayusculas', [entry({ key: 'Creditos' })]],
    ['una clave de un caracter', [entry({ key: 'a' })]],
    ['una clave con guion bajo', [entry({ key: 'a_b' })]],
    ['un grupo desconocido', [entry({ group: 'BONUS' })]],
    ['sin grantOn (no hay valor por defecto)', [entry({ grantOn: undefined })]],
    ['grantOn vacio', [entry({ grantOn: [] })]],
    ['grantOn con un desenlace que no liquida', [entry({ grantOn: ['VOIDED'] })]],
    ['grantOn con ABANDONED', [entry({ grantOn: ['ABANDONED'] })]],
    ['grantOn con duplicados', [entry({ grantOn: ['COMPLETED', 'COMPLETED'] })]],
    ['una bonificacion sin objectiveId', [entry({ group: 'OBJECTIVE_BONUS' })]],
    [
      'una bonificacion con un objetivo que no existe',
      [entry({ group: 'OBJECTIVE_BONUS', objectiveId: 'obj_fantasma' })],
    ],
    ['un objectiveId en un grupo que no es bonificacion', [entry({ objectiveId: 'obj_vida' })]],
    ['un campo de mas en la entrada', [entry({ label: '50 creditos' })]],
    ['7. un tipo EPIC (es de HU-73)', [entry({ reward: { kind: 'EPIC', productId: PRODUCT } })]],
    ['un tipo LOOT (es de HU-72)', [entry({ reward: { kind: 'LOOT', label: 'x' } })]],
    ['un tipo EXPERIENCE por entrada', [entry({ reward: { kind: 'EXPERIENCE' } })]],
    [
      'creditos con importe fraccionario',
      [entry({ reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 2.5 } } })],
    ],
    [
      'creditos con importe cero',
      [entry({ reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 0 } } })],
    ],
    [
      'creditos sin ninguna dificultad',
      [entry({ reward: { kind: 'CREDITS', amountByDifficulty: {} } })],
    ],
    [
      'producto con un UUID invalido',
      [
        entry({
          reward: { kind: 'PRODUCT', productId: 'no-es-uuid', quantityByDifficulty: { NORMAL: 1 } },
        }),
      ],
    ],
    [
      '7. producto con cantidad 0',
      [
        entry({
          reward: { kind: 'PRODUCT', productId: PRODUCT, quantityByDifficulty: { NORMAL: 0 } },
        }),
      ],
    ],
    [
      'producto con cantidad 10000',
      [
        entry({
          reward: { kind: 'PRODUCT', productId: PRODUCT, quantityByDifficulty: { NORMAL: 10_000 } },
        }),
      ],
    ],
    [
      'producto con cantidad fraccionaria',
      [
        entry({
          reward: { kind: 'PRODUCT', productId: PRODUCT, quantityByDifficulty: { NORMAL: 1.5 } },
        }),
      ],
    ],
    [
      'un campo de mas en la recompensa',
      [
        entry({
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 1 }, chest: 'bronce' },
        }),
      ],
    ],
  ])('rechaza una entrada con %s', (_label, entries) => {
    expect(() =>
      missionDefinitionOf(withCompletion({ schemaVersion: 1, entries }), TEMPLO.missionId),
    ).toThrow(InvalidMissionContentError)
  })

  it('las etiquetas de texto no se parsean: siguen siendo informativas y no generan derechos', () => {
    // El Templo trae «50 creditos» como TEXTO. Sin `completion`, nada se liquida.
    expect(TEMPLO.rewards.guaranteed.map((reward) => reward.label)).toContain('50 créditos')
    expect(
      completionRewardsOf({
        content: TEMPLO,
        difficulty: 'NORMAL',
        outcome: 'COMPLETED',
        objectives: [],
      }).entitlements,
    ).toEqual([])
  })
})

describe('HU-10.4 — politica pura de derechos', () => {
  const evaluate = (
    block: CompletionRewards | undefined,
    overrides: { difficulty?: string; outcome?: string; met?: Record<string, boolean | null> } = {},
  ) =>
    completionRewardsOf({
      content: contentOf(block),
      difficulty: overrides.difficulty ?? 'NORMAL',
      outcome: overrides.outcome ?? 'COMPLETED',
      objectives: objectives(overrides.met ?? {}),
    })

  it('9. COMPLETED da la XP de finalizacion y los creditos que declaran COMPLETED', () => {
    const result = evaluate(completion())

    expect(result.entitlements).toEqual([
      { rewardKey: 'completion:xp', kind: 'EXPERIENCE', group: 'COMPLETION', amount: 11 },
      {
        rewardKey: 'guaranteed:credits-base',
        kind: 'CREDITS',
        group: 'GUARANTEED',
        entryKey: 'credits-base',
        amount: 5,
      },
    ])
    expect(result.reason).toBeNull()
  })

  it('10. FAILED da la XP de finalizacion', () => {
    const result = evaluate(completion(), { outcome: 'FAILED' })

    expect(result.entitlements.map((right) => right.rewardKey)).toEqual(['completion:xp'])
  })

  it('11. FAILED NO da creditos si la entrada no declara FAILED en grantOn', () => {
    const result = evaluate(completion(), { outcome: 'FAILED' })

    expect(result.entitlements.some((right) => right.kind === 'CREDITS')).toBe(false)
  })

  it('12. FAILED SI da creditos si la entrada declara FAILED en grantOn', () => {
    const block = completion({
      entries: [
        {
          key: 'credits-base',
          group: 'GUARANTEED',
          grantOn: ['COMPLETED', 'FAILED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 5 } },
        },
      ],
    })

    const result = evaluate(block, { outcome: 'FAILED' })

    expect(result.entitlements.map((right) => right.rewardKey)).toEqual([
      'completion:xp',
      'guaranteed:credits-base',
    ])
  })

  it('un producto garantizado da su cantidad congelada', () => {
    const block = completion({
      entries: [
        {
          key: 'sello-x',
          group: 'GUARANTEED',
          grantOn: ['COMPLETED'],
          reward: {
            kind: 'PRODUCT',
            productId: PRODUCT,
            quantityByDifficulty: { NORMAL: 2 },
          },
        },
      ],
    })

    expect(evaluate(block).entitlements).toContainEqual({
      rewardKey: 'guaranteed:sello-x',
      kind: 'PRODUCT',
      group: 'GUARANTEED',
      entryKey: 'sello-x',
      productId: PRODUCT,
      quantity: 2,
    })
  })

  describe('bonificaciones por objetivo', () => {
    const block = completion({
      entries: [
        {
          key: 'vida-alta',
          group: 'OBJECTIVE_BONUS',
          grantOn: ['COMPLETED'],
          objectiveId: 'obj_vida',
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 2 } },
        },
      ],
    })

    it('13. objetivo cumplido (met true) da derecho', () => {
      expect(
        evaluate(block, { met: { obj_vida: true } }).entitlements.map((r) => r.rewardKey),
      ).toContain('objective-bonus:vida-alta')
    })

    it.each([false, null])('14. objetivo con met %s NO da derecho', (met) => {
      expect(
        evaluate(block, { met: { obj_vida: met } }).entitlements.map((r) => r.rewardKey),
      ).not.toContain('objective-bonus:vida-alta')
    })

    it('un objetivo sin resultado tampoco da derecho', () => {
      expect(evaluate(block, { met: {} }).entitlements.map((r) => r.rewardKey)).not.toContain(
        'objective-bonus:vida-alta',
      )
    })
  })

  it('15. FIRST_TIME NO es liquidable mientras «primera vez» siga sin definirse', () => {
    const block = completion({
      entries: [
        {
          key: 'primera-vez',
          group: 'FIRST_TIME',
          grantOn: ['COMPLETED'],
          reward: { kind: 'CREDITS', amountByDifficulty: { NORMAL: 1 } },
        },
      ],
    })

    const result = evaluate(block)

    expect(result.entitlements.map((right) => right.rewardKey)).toEqual(['completion:xp'])
    expect(result.skipped).toEqual([{ key: 'primera-vez', reason: 'FIRST_TIME_UNDEFINED' }])
  })

  describe('desenlaces', () => {
    it.each([
      ['IN_PROGRESS'],
      ['VOIDED'],
      ['16. ABANDONED'],
      ['17. un desenlace desconocido'],
      ['completed'],
      [''],
    ])('%s NO liquida (falla cerrado)', (outcome) => {
      const result = evaluate(completion(), { outcome: outcome.replace(/^\d+\. /u, '') })

      expect(result.entitlements).toEqual([])
      expect(result.reason).toBe('OUTCOME_NOT_LIQUIDABLE')
    })
  })

  describe('dificultad: sin valor por defecto ni interpolacion', () => {
    it('8. si la dificultad ejecutada no figura, NO hay derecho (ni se usa otra)', () => {
      // NORMAL y HEROIC configuradas; se ejecuta LEGENDARY.
      const result = evaluate(completion(), { difficulty: 'LEGENDARY' })

      expect(result.entitlements).toEqual([])
      expect(result.difficulty).toBe('LEGENDARY')
    })

    it('si falta NORMAL no se usa HEROIC', () => {
      const block = completion({
        experience: { amountByDifficulty: { HEROIC: 99 } },
        entries: [],
      })

      expect(evaluate(block, { difficulty: 'NORMAL' }).entitlements).toEqual([])
      expect(evaluate(block, { difficulty: 'HEROIC' }).entitlements).toHaveLength(1)
    })

    it('cada dificultad toma SU valor: no se multiplica ni se interpola', () => {
      expect(evaluate(completion(), { difficulty: 'NORMAL' }).entitlements[0]).toMatchObject({
        amount: 11,
      })
      expect(evaluate(completion(), { difficulty: 'HEROIC' }).entitlements[0]).toMatchObject({
        amount: 22,
      })
    })

    it('una dificultad desconocida no liquida', () => {
      const result = evaluate(completion(), { difficulty: 'EASY' })

      expect(result.entitlements).toEqual([])
      expect(result.reason).toBe('UNKNOWN_DIFFICULTY')
    })

    it('rewardTier se congela como EVIDENCIA y no altera los montos', () => {
      const normal = evaluate(completion(), { difficulty: 'NORMAL' })
      const heroic = evaluate(completion(), { difficulty: 'HEROIC' })

      expect(normal.rewardTier).toBe('STANDARD')
      expect(heroic.rewardTier).toBe('IMPROVED')
      // Los montos son los del contenido, no una funcion del tier.
      expect(normal.entitlements[0]).toMatchObject({ amount: 11 })
      expect(heroic.entitlements[0]).toMatchObject({ amount: 22 })
    })
  })

  describe('snapshot ausente', () => {
    it('sin contenido congelado NO hay derechos (SNAPSHOT_MISSING), sin otra fuente', () => {
      const result = completionRewardsOf({
        content: null,
        difficulty: 'NORMAL',
        outcome: 'COMPLETED',
        objectives: [],
      })

      expect(result.entitlements).toEqual([])
      expect(result.reason).toBe('SNAPSHOT_MISSING')
    })

    it('frozenContentOf devuelve SOLO el snapshot de la ejecucion: sin fallback', () => {
      expect(frozenContentOf(undefined)).toBeNull()
      expect(frozenContentOf(null)).toBeNull()
      expect(frozenContentOf({})).toBeNull()
      expect(frozenContentOf({ contentSnapshot: TEMPLO })).toBe(TEMPLO)
    })
  })

  it('18. no hay lineas de botin ni de epica: solo XP, creditos y productos configurados', () => {
    const kinds = new Set(
      evaluate(completion(), { met: {} }).entitlements.map((right) => right.kind),
    )

    for (const kind of kinds) expect(['EXPERIENCE', 'CREDITS', 'PRODUCT']).toContain(kind)
  })

  it('es pura: el mismo contenido y las mismas entradas dan el mismo resultado, sin mutar', () => {
    const block = completion()
    const before = JSON.stringify(block)

    expect(evaluate(block)).toEqual(evaluate(block))
    expect(JSON.stringify(block)).toBe(before)
  })
})

describe('HU-10.4 — la politica no depende de nada externo', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'domain', 'policies', 'CompletionRewardPolicy.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it.each([
    ['aleatoriedad', /Math\.random|randomInt|crypto/u],
    ['el catalogo vivo', /MissionCatalog|catalog\./u],
    ['puertos o adaptadores', /application\/|adapters\/|infrastructure\//u],
    ['red o reloj', /fetch\(|Date\.now|new Date\(/u],
  ])('no usa %s', (_label, pattern) => {
    expect(source).not.toMatch(pattern)
  })
})

describe('HU-10.4 — snapshot: el cambio del catalogo NO altera la ejecucion', () => {
  const AT = new Date('2026-10-01T15:00:00.000Z')
  const ENDS = new Date('2026-10-02T03:00:00.000Z')
  const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

  class FixedClock implements ClockPort {
    constructor(public current: Date) {}
    now(): Date {
      return this.current
    }
  }

  class Ids implements IdGeneratorPort {
    newEnrollmentId(): string {
      return 'enr_1'
    }
    newOperationId(): string {
      return 'op-1'
    }
  }

  const commitments: HeroCommitmentPort = {
    commit: (request: CommitHeroRequest): Promise<CommitHeroOutcome> =>
      Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` }),
    release: () => Promise.resolve('RELEASED' as const),
  }

  const profiles: HeroProfilePort = {
    profileOf: () =>
      Promise.resolve({
        kind: 'FOUND' as const,
        profile: { heroId: HERO, subtype: 'GUERRERO_ARMAS', level: 1 },
      }),
  }

  const result: SimulationResult = {
    simulationId: 'sim_hu10',
    seedRef: 'seed',
    combatOutcome: 'HERO_DEFEATED',
    summary: {
      encountersCompleted: 1,
      encountersTotal: 5,
      totalTurns: 1,
      damageDealt: 0,
      damageTaken: 1,
      minHealthPercent: 0,
      criticalEffects: 0,
      bossDefeated: false,
      master: {
        appeared: false,
        masterRef: null,
        defeated: false,
        evaluations: [],
        encounters: [],
      },
      simulatedDuration: 'PT1H',
    },
    combatLog: [],
  }

  it('19-22. la ejecucion conserva la configuracion A aunque el administrador guarde la B', async () => {
    const configA = completion({ experience: { amountByDifficulty: { NORMAL: 11 } } })
    const configB = completion({ experience: { amountByDifficulty: { NORMAL: 9999 } } })
    const catalog = new InMemoryMissionCatalog([contentOf(configA)])
    const enrollments = new InMemoryEnrollmentRepository()
    const clears = new InMemoryDifficultyClearRepository()
    const reports = new InMemoryReportRepository()
    const executions = new InMemoryExecutionRepository(enrollments, clears, reports)
    const clock = new FixedClock(AT)
    const combat: CombatSimulationPort = {
      simulate: () => Promise.resolve({ kind: 'SIMULATED', result }),
    }
    const executor = new RunMissionExecutions(
      executions,
      enrollments,
      catalog,
      profiles,
      combat,
      commitments,
      new Ids(),
      clock,
      { batchSize: 50 },
    )
    const enroll = new EnrollInMission(
      catalog,
      enrollments,
      clears,
      new InMemoryStrategyRepository(),
      commitments,
      new Ids(),
      clock,
    )

    // 19. Inicia y simula con la configuracion A.
    await enroll.execute({
      playerId: 'sub-1',
      missionId: TEMPLO.missionId,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: '3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f',
    })
    await executor.run()

    // 20. El administrador guarda la B en el catalogo vivo.
    await catalog.save(contentOf(configB))
    expect((await catalog.findById(TEMPLO.missionId))?.rewards.completion).toEqual(configB)

    // 21. La ejecucion conserva la A.
    const frozen = frozenContentOf((await executions.findById('enr_1'))?.request)

    expect(frozen?.rewards.completion).toEqual(configA)

    // 22. La politica, sobre el snapshot, calcula con A (no con la B del catalogo).
    clock.current = ENDS
    await executor.run()

    const rights = completionRewardsOf({
      content: frozenContentOf((await executions.findById('enr_1'))?.request),
      difficulty: 'NORMAL',
      outcome: 'FAILED',
      objectives: [],
    })

    expect(rights.entitlements).toEqual([
      { rewardKey: 'completion:xp', kind: 'EXPERIENCE', group: 'COMPLETION', amount: 11 },
    ])
  })
})
