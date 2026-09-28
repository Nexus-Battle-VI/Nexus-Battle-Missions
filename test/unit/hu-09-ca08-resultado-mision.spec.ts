import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryExperienceRolls } from '../../src/adapters/outbound/combat/InMemoryExperienceRolls'
import { InMemoryExperienceCredits } from '../../src/adapters/outbound/inventory/InMemoryExperienceCredits'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryExperienceRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import type { HeroProfilePort } from '../../src/application/ports/HeroAbilitiesPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  HeroCommitmentPort,
} from '../../src/application/ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import { CoordinateExperienceReward } from '../../src/application/use-cases/CoordinateExperienceReward'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import type { SimulationResult } from '../../src/domain/entities/MissionExecution'

/**
 * HU-09, CA-08 definitivo (Management #18): la recompensa nace de una DERROTA
 * VALIDA DE UN NPC, no de que la mision termine `COMPLETED`.
 *
 *   A. FAILED con NPC derrotados       -> se devenga y se acredita; nada lo revierte.
 *   B. FAILED sin ninguna derrota      -> 0 recompensas, 0 tiradas, 0 acreditaciones.
 *   C. VOIDED (anulada / invalida)     -> 0 recompensas.
 *   D. Simulacion rechazada por Combat -> 0 recompensas.
 *
 * Recorre el cierre real (`RunMissionExecutions`) y la coordinacion real
 * (`CoordinateExperienceReward`) sobre los dobles en memoria: lo unico
 * guionizado es la respuesta de Combat.
 */
const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const PLAYER = 'sub-1'
const KEY = '3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f'

const RESULT: SimulationResult = {
  simulationId: 'sim_ca08',
  seedRef: 'seed_ca08',
  combatOutcome: 'HERO_DEFEATED',
  summary: {
    encountersCompleted: 1,
    encountersTotal: 5,
    totalTurns: 20,
    damageDealt: 100,
    damageTaken: 900,
    minHealthPercent: 0,
    criticalEffects: 0,
    bossDefeated: false,
    master: {
      appeared: false,
      masterRef: null,
      defeated: false,
      // El heroe cae en el primer encuentro: no llega al punto de evaluacion del Master.
      evaluations: [],
      encounters: [],
    },
    simulatedDuration: 'PT1H',
  },
  combatLog: [],
}

const defeated = (seq: number, combatant: string): Record<string, unknown> => ({
  seq,
  type: 'combatantDefeated',
  encounter: 1,
  turn: 1,
  combatant,
})

class FixedClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

class SequenceIds implements IdGeneratorPort {
  private enrollments = 0
  private operations = 0
  newEnrollmentId(): string {
    this.enrollments += 1
    return `enr_${String(this.enrollments)}`
  }
  newOperationId(): string {
    this.operations += 1
    return `op-${String(this.operations)}`
  }
}

class GrantingCommitments implements HeroCommitmentPort {
  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    return Promise.resolve({ kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` })
  }
  release(): Promise<'RELEASED'> {
    return Promise.resolve('RELEASED')
  }
}

const profiles: HeroProfilePort = {
  profileOf: () =>
    Promise.resolve({
      kind: 'FOUND' as const,
      profile: { heroId: HERO, subtype: 'GUERRERO_ARMAS', level: 1 },
    }),
}

/** Cuenta cuantas veces se pidio una tirada: sin derrotas no debe pedirse ninguna. */
class CountingRolls extends InMemoryExperienceRolls {
  calls = 0

  override rollDefeats(...args: Parameters<InMemoryExperienceRolls['rollDefeats']>) {
    this.calls += 1

    return super.rollDefeats(...args)
  }
}

const setup = (combatOutcome: SimulationCallOutcome) => {
  const catalog = new InMemoryMissionCatalog(EXAMPLE_MISSIONS)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const strategies = new InMemoryStrategyRepository()
  const reports = new InMemoryReportRepository()
  const rewards = new InMemoryExperienceRewardRepository(reports)
  const executions = new InMemoryExecutionRepository(
    enrollments,
    clears,
    reports,
    new InMemoryMasterEncounterRepository(reports),
    rewards,
  )
  const commitments = new GrantingCommitments()
  const ids = new SequenceIds()
  const clock = new FixedClock(AT)
  const combat: CombatSimulationPort = { simulate: () => Promise.resolve(combatOutcome) }
  const executor = new RunMissionExecutions(
    executions,
    enrollments,
    catalog,
    profiles,
    combat,
    commitments,
    ids,
    clock,
    { batchSize: 50 },
  )
  const rolls = new CountingRolls()
  const credits = new InMemoryExperienceCredits()
  const coordinator = new CoordinateExperienceReward(rewards, enrollments, rolls, credits, clock, {
    batchSize: 50,
  })
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    strategies,
    commitments,
    ids,
    clock,
  )

  /** Matricula, simula, llega a `endsAt`, cierra y coordina la experiencia. */
  const play = async (): Promise<void> => {
    await enroll.execute({
      playerId: PLAYER,
      missionId: TEMPLO,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: KEY,
    })
    await executor.run()
    clock.current = ENDS
    await executor.run()
    await coordinator.run()
  }

  return { enrollments, rewards, rolls, credits, coordinator, play, clock }
}

describe('HU-09 CA-08 — la recompensa nace de la derrota valida de un NPC', () => {
  it('A. FAILED con NPC derrotados: la XP se devenga, se acredita y nada la revierte', async () => {
    const { enrollments, rewards, rolls, credits, coordinator, play } = setup({
      kind: 'SIMULATED',
      result: {
        ...RESULT,
        combatLog: [
          { seq: 1, type: 'encounterStarted', encounter: 1 },
          defeated(2, 'sombra-corrompida#1'),
          defeated(3, 'sombra-corrompida#2'),
          { seq: 4, type: 'simulationFinished', combatOutcome: 'HERO_DEFEATED' },
        ],
      },
    })

    await play()

    // La mision termino FAILED, y aun asi hay recompensa por cada NPC derrotado.
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'FAILED' })

    const stored = await rewards.listByEnrollment('enr_1')

    expect(stored).toHaveLength(2)
    expect(stored.every((reward) => reward.status === 'CREDITED')).toBe(true)
    expect(rolls.calls).toBe(1)
    // Caras 1 y 2 del doble => 12 + 14 (redondeo al entero mas proximo).
    expect(stored.map((reward) => reward.amount)).toEqual([12, 14])
    expect(credits.totalOf(PLAYER, HERO)).toBe(26)

    // Nada lo revierte: otro barrido no vuelve a tirar ni a acreditar.
    await coordinator.run()

    expect(rolls.calls).toBe(1)
    expect(credits.totalOf(PLAYER, HERO)).toBe(26)
    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'FAILED' })
  })

  it('B. FAILED SIN ninguna derrota: 0 recompensas, 0 tiradas, 0 acreditaciones', async () => {
    const { enrollments, rewards, rolls, credits, play } = setup({
      kind: 'SIMULATED',
      result: {
        ...RESULT,
        combatLog: [
          { seq: 1, type: 'encounterStarted', encounter: 1 },
          { seq: 2, type: 'simulationFinished', combatOutcome: 'HERO_DEFEATED' },
        ],
      },
    })

    await play()

    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'FAILED' })
    expect(await rewards.listByEnrollment('enr_1')).toEqual([])
    expect(rolls.calls).toBe(0)
    expect(credits.totalOf(PLAYER, HERO)).toBe(0)
  })

  it('C. VOIDED (resultado invalido): no devenga ninguna recompensa', async () => {
    // Un resultado sin los hechos necesarios se anula, aunque su bitacora traiga bajas.
    const { enrollments, rewards, rolls, credits, play } = setup({
      kind: 'SIMULATED',
      result: {
        ...RESULT,
        summary: { encountersCompleted: 1 },
        combatLog: [defeated(1, 'sombra-corrompida#1')],
      },
    })

    await play()

    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'VOIDED' })
    expect(await rewards.listByEnrollment('enr_1')).toEqual([])
    expect(rolls.calls).toBe(0)
    expect(credits.totalOf(PLAYER, HERO)).toBe(0)
  })

  it('D. simulacion rechazada por Combat: la mision se anula y no devenga nada', async () => {
    const { enrollments, rewards, rolls, credits, play } = setup({
      kind: 'REJECTED',
      code: 'INVALID_STRATEGY',
    })

    await play()

    await expect(enrollments.findById('enr_1')).resolves.toMatchObject({ status: 'VOIDED' })
    expect(await rewards.listByEnrollment('enr_1')).toEqual([])
    expect(rolls.calls).toBe(0)
    expect(credits.totalOf(PLAYER, HERO)).toBe(0)
  })
})
