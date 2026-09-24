import { InMemoryExperienceRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { InMemoryExperienceRolls } from '../../src/adapters/outbound/combat/InMemoryExperienceRolls'
import { InMemoryExperienceCredits } from '../../src/adapters/outbound/inventory/InMemoryExperienceCredits'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../../src/application/ports/EnrollmentRepositoryPort'
import type {
  ExperienceCreditOutcome,
  ExperienceCreditPort,
  ExperienceCreditRequest,
} from '../../src/application/ports/ExperienceCreditPort'
import type {
  ExperienceRollOutcome,
  ExperienceRollPort,
  ExperienceRollRequest,
} from '../../src/application/ports/ExperienceRollPort'
import { CoordinateExperienceReward } from '../../src/application/use-cases/CoordinateExperienceReward'
import { pendingReward, type ExperienceReward } from '../../src/domain/entities/ExperienceReward'
import type { MissionEnrollment } from '../../src/domain/entities/MissionEnrollment'

/**
 * HU-09 (Task HU-09.4): la coordinacion de la recompensa de experiencia
 * (`hu-09-experience-reward-v1` §5.2, §7 y §9).
 *
 * Lo que se comprueba es la REGLA DE ORDEN y las tres garantias del contrato:
 * una tirada por derrota, un reintento que no vuelve a tirar, un rechazo
 * definitivo que no arrastra a las demas, y que la formula se aplique en un unico
 * punto.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')
/** Reloj movil: el reintento espera un escalonado, asi que hay que poder avanzarlo. */
let now = NOW
const clock: ClockPort = { now: () => now }

beforeEach(() => {
  now = NOW
})

/** Avanza el reloj lo suficiente para que venza el escalonado de reintento. */
const advanceClock = (): void => {
  now = new Date(NOW.getTime() + 30 * 60_000)
}

const enrollmentOf = (status: MissionEnrollment['status']): MissionEnrollment =>
  ({
    enrollmentId: 'enr_01JB8Y3K7Q',
    playerId: 'sub-jugador-1',
    heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
    missionId: 'templo',
    difficulty: 'NORMAL',
    status,
    version: 1,
  }) as MissionEnrollment

const enrollmentsOf = (status: MissionEnrollment['status']): EnrollmentRepositoryPort =>
  ({
    // Devuelve la matricula pedida: estas pruebas no miden la ausencia de matricula.
    findById: (enrollmentId: string) => Promise.resolve({ ...enrollmentOf(status), enrollmentId }),
  }) as unknown as EnrollmentRepositoryPort

const rewardOf = (encounterId: string, enemyInstanceId: string): ExperienceReward =>
  pendingReward({
    enrollmentId: 'enr_01JB8Y3K7Q',
    playerId: 'sub-jugador-1',
    heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
    simulationId: 'sim_01JB8Y4B',
    defeat: { encounterId, enemyInstanceId, rivalRef: enemyInstanceId.split('#')[0] ?? 'rival' },
    now: NOW,
  })

/** Registra lo que se le pide, para poder afirmar CUANTAS veces se tira. */
class RecordingRolls implements ExperienceRollPort {
  readonly requests: ExperienceRollRequest[] = []

  constructor(private readonly inner: ExperienceRollPort = new InMemoryExperienceRolls()) {}

  rollDefeats(request: ExperienceRollRequest): Promise<ExperienceRollOutcome> {
    this.requests.push(request)

    return this.inner.rollDefeats(request)
  }
}

/** Devuelve lo que se le diga, para ejercitar rechazos y respuestas raras. */
class StubRolls implements ExperienceRollPort {
  constructor(private readonly outcome: ExperienceRollOutcome) {}

  rollDefeats(): Promise<ExperienceRollOutcome> {
    return Promise.resolve(this.outcome)
  }
}

class StubCredits implements ExperienceCreditPort {
  readonly requests: ExperienceCreditRequest[] = []
  readonly rejected = new Set<string>()
  readonly unknown = new Set<string>()

  credit(request: ExperienceCreditRequest): Promise<ExperienceCreditOutcome> {
    this.requests.push(request)

    if (this.rejected.has(request.source.enemyInstanceId)) {
      return Promise.resolve({ kind: 'REJECTED', reason: 'EXPERIENCE_GRANT_REJECTED' })
    }

    if (this.unknown.has(request.source.enemyInstanceId)) {
      return Promise.resolve({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    }

    return Promise.resolve({ kind: 'CREDITED', progression: null })
  }
}

const scenario = (options: {
  readonly status?: MissionEnrollment['status']
  readonly rewards: readonly ExperienceReward[]
  readonly rolls?: ExperienceRollPort
  readonly credits?: ExperienceCreditPort
}) => {
  const repository = new InMemoryExperienceRewardRepository()
  repository.insert(options.rewards)

  const rolls = options.rolls ?? new RecordingRolls()
  const credits = options.credits ?? new StubCredits()
  const useCase = new CoordinateExperienceReward(
    repository,
    enrollmentsOf(options.status ?? 'IN_PROGRESS'),
    rolls,
    credits,
    clock,
    { batchSize: 50 },
  )

  return { repository, rolls, credits, useCase }
}

describe('HU-09 — coordinacion de la recompensa de experiencia', () => {
  it('tira UNA vez por derrota y acredita cada una con su clave', async () => {
    const rewards = [
      rewardOf('1', 'sombra-corrompida#1'),
      rewardOf('1', 'sombra-corrompida#2'),
      rewardOf('5', 'guardian-eterno#1'),
    ]
    const { repository, rolls, credits, useCase } = scenario({ rewards })

    const summary = await useCase.run()

    // Un solo lote por mision, con las tres derrotas en el orden de la bitacora.
    const requests = (rolls as RecordingRolls).requests
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      operationId: 'mission:enr_01JB8Y3K7Q:xp-rolls',
      enrollmentId: 'enr_01JB8Y3K7Q',
      simulationId: 'sim_01JB8Y4B',
      heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
      defeats: [
        { encounterId: '1', enemyInstanceId: 'sombra-corrompida#1', rivalRef: 'sombra-corrompida' },
        { encounterId: '1', enemyInstanceId: 'sombra-corrompida#2', rivalRef: 'sombra-corrompida' },
        { encounterId: '5', enemyInstanceId: 'guardian-eterno#1', rivalRef: 'guardian-eterno' },
      ],
    })

    expect((credits as StubCredits).requests).toHaveLength(3)
    expect((credits as StubCredits).requests.map((request) => request.operationId)).toEqual([
      'mission:enr_01JB8Y3K7Q:encounter:1:enemy:sombra-corrompida#1:hero:7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60:xp',
      'mission:enr_01JB8Y3K7Q:encounter:1:enemy:sombra-corrompida#2:hero:7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60:xp',
      'mission:enr_01JB8Y3K7Q:encounter:5:enemy:guardian-eterno#1:hero:7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60:xp',
    ])

    expect(summary).toMatchObject({
      rollsResolved: 1,
      rewardsRolled: 3,
      rewardsCredited: 3,
      rewardsRejected: 0,
      rewardsRetried: 0,
    })

    const stored = await repository.listByEnrollment('enr_01JB8Y3K7Q')
    expect(stored.every((reward) => reward.status === 'CREDITED')).toBe(true)
    expect(stored.every((reward) => reward.creditedAt !== null)).toBe(true)
  })

  it('el importe acreditado es el de la formula, entero, cara a cara', async () => {
    const rewards = [
      rewardOf('1', 'enemigo#1'),
      rewardOf('1', 'enemigo#2'),
      rewardOf('1', 'enemigo#3'),
    ]
    // El doble reparte caras 1, 2, 3; la formula da 12, 14 y 17.
    const { credits, useCase } = scenario({ rewards })

    await useCase.run()

    expect((credits as StubCredits).requests.map((request) => request.amount)).toEqual([12, 14, 17])
    expect((credits as StubCredits).requests.map((request) => request.source.roll)).toEqual([
      1, 2, 3,
    ])
    expect(
      (credits as StubCredits).requests.every((request) => Number.isInteger(request.amount)),
    ).toBe(true)
    expect((credits as StubCredits).requests[0]?.source).toMatchObject({
      kind: 'MISSION_RIVAL_DEFEAT',
      enrollmentId: 'enr_01JB8Y3K7Q',
      simulationId: 'sim_01JB8Y4B',
      encounterId: '1',
      enemyInstanceId: 'enemigo#1',
      rivalRef: 'enemigo',
    })
  })

  it('UN REINTENTO NO VUELVE A TIRAR: lo ya tirado solo se acredita', async () => {
    const credits = new StubCredits()
    // La acreditacion falla en el primer ciclo: la tirada si se hace.
    credits.unknown.add('enemigo#1')
    const { repository, rolls, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1')],
      credits,
    })

    const first = await useCase.run()

    expect(first).toMatchObject({ rollsResolved: 1, rewardsRolled: 1, rewardsCredited: 0 })
    expect((await repository.listByEnrollment('enr_01JB8Y3K7Q'))[0]).toMatchObject({
      status: 'ROLLED',
      roll: 1,
      amount: 12,
    })

    credits.unknown.clear()
    advanceClock()
    const second = await useCase.run()

    // Ni una tirada mas: el lote ya estaba resuelto.
    expect((rolls as RecordingRolls).requests).toHaveLength(1)
    expect(second).toMatchObject({ rollsResolved: 0, rewardsCredited: 1, rewardsRetried: 0 })
  })

  it('si la acreditacion no responde, la recompensa se aplaza y se reintenta con la MISMA clave', async () => {
    const credits = new StubCredits()
    credits.unknown.add('enemigo#1')
    const { repository, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1')],
      credits,
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsRetried: 1, rewardsCredited: 0 })
    const stored = await repository.listByEnrollment('enr_01JB8Y3K7Q')
    expect(stored[0]).toMatchObject({ status: 'ROLLED', lastError: 'HTTP_503' })
    expect(stored[0]?.nextAttemptAt).not.toBeNull()
  })

  it('la MISMA clave en el reintento: la acreditacion se pide igual las dos veces', async () => {
    const credits = new StubCredits()
    credits.unknown.add('enemigo#1')
    const { useCase } = scenario({ rewards: [rewardOf('1', 'enemigo#1')], credits })

    await useCase.run()
    credits.unknown.clear()
    advanceClock()
    await useCase.run()

    expect(credits.requests).toHaveLength(2)
    expect(credits.requests[0]?.operationId).toBe(credits.requests[1]?.operationId)
    expect(credits.requests[0]?.amount).toBe(credits.requests[1]?.amount)
  })

  it('un RECHAZO definitivo de Combat deja las recompensas FAILED con su motivo', async () => {
    const { repository, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1'), rewardOf('1', 'enemigo#2')],
      rolls: new StubRolls({ kind: 'REJECTED', reason: 'DUPLICATE_DEFEAT' }),
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsRejected: 2, rewardsRolled: 0, rewardsCredited: 0 })
    const stored = await repository.listByEnrollment('enr_01JB8Y3K7Q')
    expect(stored.every((reward) => reward.status === 'FAILED')).toBe(true)
    expect(stored.every((reward) => reward.lastError === 'DUPLICATE_DEFEAT')).toBe(true)
  })

  it('CONTROL: un rechazo en UNA derrota NO arrastra a las demas', async () => {
    const credits = new StubCredits()
    credits.rejected.add('enemigo#2')
    const { repository, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1'), rewardOf('1', 'enemigo#2'), rewardOf('1', 'enemigo#3')],
      credits,
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsCredited: 2, rewardsRejected: 1 })
    const stored = await repository.listByEnrollment('enr_01JB8Y3K7Q')
    expect(stored.map((reward) => reward.status)).toEqual(['CREDITED', 'FAILED', 'CREDITED'])
    expect(stored[1]?.lastError).toBe('EXPERIENCE_GRANT_REJECTED')
  })

  it('una respuesta de Combat SIN la tirada de alguna derrota se aplaza entera', async () => {
    const { repository, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1'), rewardOf('1', 'enemigo#2')],
      // Solo devuelve una de las dos caras: no se completa a ojo.
      rolls: new StubRolls({
        kind: 'ROLLED',
        rolls: [{ encounterId: '1', enemyInstanceId: 'enemigo#1', roll: 3 }],
      }),
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsRolled: 0, rewardsRetried: 2 })
    const stored = await repository.listByEnrollment('enr_01JB8Y3K7Q')
    expect(stored.every((reward) => reward.status === 'PENDING')).toBe(true)
    expect(stored.every((reward) => reward.lastError === 'INCOMPLETE_ROLLS')).toBe(true)
  })

  it('si Combat no responde, no se marca nada como fallido: se reintenta', async () => {
    const { repository, useCase } = scenario({
      rewards: [rewardOf('1', 'enemigo#1')],
      rolls: new StubRolls({ kind: 'UNKNOWN', reason: 'HTTP_503' }),
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsRetried: 1, rewardsRejected: 0 })
    expect((await repository.listByEnrollment('enr_01JB8Y3K7Q'))[0]).toMatchObject({
      status: 'PENDING',
      lastError: 'HTTP_503',
    })
  })

  it('una mision ANULADA no acredita: sus recompensas quedan FAILED (CA-08)', async () => {
    const { repository, useCase } = scenario({
      status: 'VOIDED',
      rewards: [rewardOf('1', 'enemigo#1')],
    })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rewardsRejected: 1, rewardsCredited: 0 })
    expect((await repository.listByEnrollment('enr_01JB8Y3K7Q'))[0]).toMatchObject({
      status: 'FAILED',
      lastError: 'MISSION_VOIDED',
    })
  })

  it('sin recompensas vencidas no hace NADA: ni tira ni acredita', async () => {
    const { rolls, credits, useCase } = scenario({ rewards: [] })

    const summary = await useCase.run()

    expect(summary).toMatchObject({ rollsResolved: 0, rewardsCredited: 0 })
    expect((rolls as RecordingRolls).requests).toEqual([])
    expect((credits as StubCredits).requests).toEqual([])
  })

  it('las recompensas de DOS misiones se resuelven con un lote cada una', async () => {
    const other = {
      ...rewardOf('1', 'enemigo#1'),
      enrollmentId: 'enr-otra',
      playerId: 'sub-otro',
    }
    const { rolls, useCase } = scenario({ rewards: [rewardOf('1', 'enemigo#1'), other] })

    await useCase.run()

    expect((rolls as RecordingRolls).requests.map((request) => request.operationId)).toEqual([
      'mission:enr_01JB8Y3K7Q:xp-rolls',
      'mission:enr-otra:xp-rolls',
    ])
  })
})

describe('HU-09 — el doble de desarrollo de Combat', () => {
  it('reparte caras ciclicas y es idempotente por operationId', async () => {
    const rolls = new InMemoryExperienceRolls()
    const request = {
      operationId: 'mission:enr-1:xp-rolls',
      enrollmentId: 'enr-1',
      simulationId: 'sim-1',
      heroId: 'hero-1',
      defeats: [
        { encounterId: '1', enemyInstanceId: 'a#1', rivalRef: 'a' },
        { encounterId: '1', enemyInstanceId: 'a#2', rivalRef: 'a' },
      ],
    }

    const first = await rolls.rollDefeats(request)
    const replay = await rolls.rollDefeats(request)

    expect(first).toEqual(replay)
    expect(first.kind === 'ROLLED' && first.rolls.map((roll) => roll.roll)).toEqual([1, 2])
  })

  it('el doble de acreditacion acumula y no duplica por operationId', async () => {
    const credits = new InMemoryExperienceCredits()
    const request = {
      operationId: 'op-1',
      playerId: 'sub-1',
      heroId: 'hero-1',
      amount: 25,
      source: {
        kind: 'MISSION_RIVAL_DEFEAT' as const,
        enrollmentId: 'enr-1',
        simulationId: 'sim-1',
        encounterId: '1',
        enemyInstanceId: 'a#1',
        rivalRef: 'a',
        roll: 5,
      },
    }

    await credits.credit(request)
    await credits.credit(request)

    expect(credits.totalOf('sub-1', 'hero-1')).toBe(25)
  })
})
