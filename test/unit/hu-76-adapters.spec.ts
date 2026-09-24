import { randomUUID } from 'node:crypto'

import { EXAMPLE_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/example-achievements'
import { InMemoryAchievementEvidence } from '../../src/adapters/outbound/persistence/InMemoryAchievementEvidence'
import { InMemoryAchievementRepository } from '../../src/adapters/outbound/persistence/InMemoryAchievementRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMasterEncounterRepository } from '../../src/adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { StaticAchievementCatalog } from '../../src/adapters/outbound/persistence/StaticAchievementCatalog'
import type {
  EvaluationCheckpoint,
  PlayerToEvaluate,
} from '../../src/application/ports/AchievementRepositoryPort'
import type { EvaluateMissionAchievements } from '../../src/application/use-cases/EvaluateMissionAchievements'
import type { GrantAchievementRecognitions } from '../../src/application/use-cases/GrantAchievementRecognitions'
import type { GrantMasterEpics } from '../../src/application/use-cases/GrantMasterEpics'
import type { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import {
  recognitionCredited,
  recognitionDeferred,
  type AchievementUnlock,
  type RecognitionGrant,
} from '../../src/domain/entities/Achievement'
import {
  grantConfirmed,
  type EpicGrantStatus,
  type MasterEncounterRecord,
} from '../../src/domain/entities/MasterEncounterRecord'
import {
  closeEnrollment,
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import { voidedSettlement } from '../../src/domain/entities/MissionExecution'
import type { ReportOutcome, ReportRecord } from '../../src/domain/entities/MissionReport'
import { InvalidAchievementCatalogError } from '../../src/domain/errors/achievement-errors'
import { achievementGrantOperationId } from '../../src/domain/policies/AchievementPolicy'
import { missionSettledFact } from '../../src/domain/policies/SettlementPolicy'
import type { Logger } from '../../src/infrastructure/observability/logger'
import { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'

const AT = new Date('2026-10-01T15:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')
const NOW = new Date('2026-10-02T04:00:00.000Z')
const TEMPLO_ID = 'msn_templo_olvidado'
const FINGERPRINT = '6f1c2a8e-1d3b-5c4a-9e7f-0a1b2c3d4e5f'
const OTHER_FINGERPRINT = '7a2d3b9f-2e4c-5d5b-8f80-1b2c3d4e5f60'
const PRODUCT = '11111111-1111-4111-8111-111111111111'
const OTHER_PRODUCT = '22222222-2222-4222-8222-222222222222'

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}`)
  }

  return value
}

const later = (ms: number): Date => new Date(NOW.getTime() + ms)

/** Una matricula en curso del jugador, con su hecho de inicio. */
const start = async (
  enrollments: InMemoryEnrollmentRepository,
  playerId: string,
  enrollmentId: string,
): Promise<MissionEnrollment> => {
  const pending = newPendingEnrollment({
    enrollmentId,
    playerId,
    missionId: TEMPLO_ID,
    heroId: randomUUID(),
    difficulty: 'NORMAL',
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestFingerprint: 'fp',
    strategyVersion: null,
    requestedAt: AT,
  })
  const confirmed = confirmEnrollment(pending, 'cmt-1', AT, 720)

  await enrollments.insertPending(pending)
  await enrollments.saveTransition(confirmed, pending.version, enrollmentStartedFact(confirmed))

  return confirmed
}

/** Una matricula cerrada con su `MissionSettled`, como la deja el cierre de HU-72. */
const settle = async (
  enrollments: InMemoryEnrollmentRepository,
  playerId: string,
  enrollmentId: string,
  outcome: 'COMPLETED' | 'FAILED' | 'VOIDED' = 'COMPLETED',
): Promise<void> => {
  const started = await start(enrollments, playerId, enrollmentId)
  const settlement =
    outcome === 'VOIDED'
      ? voidedSettlement('INVALID_SIMULATION_RESULT')
      : { outcome, reason: null, objectives: [] }

  await enrollments.saveTransition(
    closeEnrollment(started, outcome, CLOSED),
    started.version,
    missionSettledFact(started, settlement, null, CLOSED),
  )
}

/** Un Master derrotado con la entrega de su epica en el estado dado. */
const defeated = (
  enrollmentId: string,
  sequence: number,
  masterRef: string,
  status: EpicGrantStatus = 'PENDING',
): MasterEncounterRecord => ({
  enrollmentId,
  sequence,
  afterEncounter: 3,
  masterRef,
  status: 'APPEARED_DEFEATED',
  epicRef: `epica-${masterRef}`,
  levelOffset: 2,
  turns: 14,
  grant: {
    operationId: randomUUID(),
    status,
    attempts: status === 'PENDING' ? 0 : 1,
    nextAttemptAt: status === 'PENDING' ? AT : null,
    lastError: null,
    grantedAt: status === 'GRANTED' ? CLOSED : null,
    rewardLineNo: null,
    productId: status === 'GRANTED' ? PRODUCT : null,
  },
})

const unlockFor = (
  playerId: string,
  achievementId: string,
  grant: Partial<RecognitionGrant> = {},
): AchievementUnlock => ({
  playerId,
  achievementId,
  achievementVersion: 1,
  criterion: 'ALL_MASTER_EPICS',
  name: 'Estandarte del Coleccionista',
  progress: { current: 2, target: 2 },
  proof: { refs: ['epica-a', 'epica-b'], enrollmentIds: ['enr_1', 'enr_2'] },
  unlockedAt: NOW,
  recognition: {
    kind: 'COSMETIC_PRODUCT',
    name: 'Estandarte del Coleccionista',
    status: 'PENDING',
  },
  grant: {
    operationId: achievementGrantOperationId(playerId, achievementId),
    attempts: 0,
    nextAttemptAt: NOW,
    lastError: null,
    productId: null,
    creditedAt: null,
    ...grant,
  },
})

const badgeFor = (playerId: string, achievementId: string): AchievementUnlock => ({
  ...unlockFor(playerId, achievementId),
  criterion: 'FLAWLESS_MISSION',
  name: 'Sin un rasguño',
  progress: { current: 1, target: 1 },
  recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
  grant: null,
})

const withProduct = (unlock: AchievementUnlock, productId: string): AchievementUnlock => ({
  ...unlock,
  grant: { ...required(unlock.grant, 'la entrega'), productId },
})

const checkpoint = (values: Partial<EvaluationCheckpoint> = {}): EvaluationCheckpoint => ({
  settledSeen: 1,
  epicsGrantedSeen: 0,
  fingerprint: FINGERPRINT,
  evaluatedAt: NOW,
  ...values,
})

const idsOf = (players: readonly PlayerToEvaluate[]): readonly string[] =>
  players.map((player) => player.playerId)

describe('InMemoryAchievementRepository (doble de HU-76)', () => {
  const setup = () => {
    const enrollments = new InMemoryEnrollmentRepository()
    const masters = new InMemoryMasterEncounterRepository()

    return {
      enrollments,
      masters,
      repository: new InMemoryAchievementRepository(enrollments, masters),
    }
  }

  describe('a quien evaluar', () => {
    it('elige a quien tiene algun MissionSettled, tambien anulado, con sus conteos', async () => {
      const { enrollments, masters, repository } = setup()

      await settle(enrollments, 'sub-a', 'enr_a1')
      await settle(enrollments, 'sub-a', 'enr_a2', 'FAILED')
      await settle(enrollments, 'sub-b', 'enr_b1', 'VOIDED')
      // Solo iniciada: todavia no hay nada que evaluar.
      await start(enrollments, 'sub-c', 'enr_c1')
      masters.recordNow([
        defeated('enr_a1', 1, 'sombra', 'GRANTED'),
        defeated('enr_a2', 1, 'centinela'),
        defeated('enr_c1', 1, 'sombra', 'GRANTED'),
      ])

      await expect(repository.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'sub-a', settled: 2, epicsGranted: 1, attempts: 0 },
        { playerId: 'sub-b', settled: 1, epicsGranted: 0, attempts: 0 },
      ])
    })

    it('al dia no lo elige; si cambia un conteo o la huella, si', async () => {
      const { enrollments, masters, repository } = setup()

      await settle(enrollments, 'sub-a', 'enr_a1')
      const epic = defeated('enr_a1', 1, 'sombra')
      masters.recordNow([epic])
      await repository.recordEvaluation('sub-a', [], checkpoint())
      await expect(repository.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([])

      // Otra huella: el catalogo, el contenido o la politica cambiaron.
      expect(idsOf(await repository.playersToEvaluate(NOW, OTHER_FINGERPRINT, 10))).toEqual([
        'sub-a',
      ])

      // Otra mision cerrada.
      await settle(enrollments, 'sub-a', 'enr_a2')
      await expect(repository.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'sub-a', settled: 2, epicsGranted: 0, attempts: 0 },
      ])
      await repository.recordEvaluation('sub-a', [], checkpoint({ settledSeen: 2 }))

      // Una epica entregada despues, sin otra mision.
      await masters.saveGrant(grantConfirmed(epic, CLOSED), 0, CLOSED)
      await expect(repository.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'sub-a', settled: 2, epicsGranted: 1, attempts: 0 },
      ])
    })

    it('no elige a quien espera un reintento hasta que vence', async () => {
      const { enrollments, repository } = setup()
      const retry = { attempts: 1, nextAttemptAt: later(5_000), lastError: 'INTERNAL_ERROR' }

      await settle(enrollments, 'sub-a', 'enr_a1')
      await repository.deferEvaluation('sub-a', retry)

      await expect(repository.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([])
      await expect(repository.playersToEvaluate(later(5_000), FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'sub-a', settled: 1, epicsGranted: 0, attempts: 1 },
      ])
      expect(repository.evaluationOf('sub-a')).toEqual({
        settledSeen: 0,
        epicsGrantedSeen: 0,
        fingerprint: null,
        evaluatedAt: null,
        ...retry,
      })
    })

    it('primero los nunca evaluados; despues, los evaluados hace mas tiempo; con limite', async () => {
      const { enrollments, repository } = setup()

      for (const playerId of ['sub-d', 'sub-c', 'sub-b', 'sub-a']) {
        await settle(enrollments, playerId, `enr_${playerId}`)
      }
      await repository.recordEvaluation('sub-a', [], checkpoint({ settledSeen: 0 }))
      await repository.recordEvaluation(
        'sub-c',
        [],
        checkpoint({ settledSeen: 0, evaluatedAt: later(-60_000) }),
      )

      expect(idsOf(await repository.playersToEvaluate(NOW, FINGERPRINT, 10))).toEqual([
        'sub-b',
        'sub-d',
        'sub-c',
        'sub-a',
      ])
      expect(idsOf(await repository.playersToEvaluate(NOW, FINGERPRINT, 2))).toEqual([
        'sub-b',
        'sub-d',
      ])
    })
  })

  describe('desbloqueos y punto de control', () => {
    it('guarda cada logro una sola vez por jugador y devuelve solo los nuevos', async () => {
      const { repository } = setup()
      const first = [badgeFor('sub-a', 'ach_sin_rasgunos'), unlockFor('sub-a', 'ach_coleccionista')]
      const again = [
        { ...badgeFor('sub-a', 'ach_sin_rasgunos'), unlockedAt: later(1_000) },
        badgeFor('sub-a', 'ach_historia_completa'),
      ]

      await expect(repository.recordEvaluation('sub-a', first, checkpoint())).resolves.toEqual(
        first,
      )
      await expect(
        repository.recordEvaluation('sub-a', again, checkpoint({ settledSeen: 2 })),
      ).resolves.toEqual([again[1]])

      await expect(repository.unlocksOf('sub-a')).resolves.toEqual([first[1], again[1], first[0]])
      await expect(repository.unlocksOf('sub-b')).resolves.toEqual([])
      expect(repository.evaluationOf('sub-a')).toEqual({
        settledSeen: 2,
        epicsGrantedSeen: 0,
        fingerprint: FINGERPRINT,
        evaluatedAt: NOW,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      })
    })

    it('un aplazamiento conserva lo visto y la huella; una evaluacion lo borra', async () => {
      const { repository } = setup()
      const retry = { attempts: 2, nextAttemptAt: later(30_000), lastError: 'INTERNAL_ERROR' }

      await repository.recordEvaluation(
        'sub-a',
        [],
        checkpoint({ settledSeen: 3, epicsGrantedSeen: 1 }),
      )
      await repository.deferEvaluation('sub-a', retry)
      expect(repository.evaluationOf('sub-a')).toEqual({
        settledSeen: 3,
        epicsGrantedSeen: 1,
        fingerprint: FINGERPRINT,
        evaluatedAt: NOW,
        ...retry,
      })

      await repository.recordEvaluation('sub-a', [], checkpoint({ settledSeen: 4 }))
      expect(repository.evaluationOf('sub-a')).toMatchObject({
        settledSeen: 4,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      })
      expect(repository.evaluationOf('sub-z')).toBeNull()
    })
  })

  describe('la entrega de los cosmeticos', () => {
    it('solo los cosmeticos PENDING con el intento vencido, los mas atrasados primero', async () => {
      const { repository } = setup()
      const early = unlockFor('sub-a', 'ach_a', { nextAttemptAt: later(-1_000) })
      const onTime = unlockFor('sub-b', 'ach_b')
      const future = unlockFor('sub-c', 'ach_c', { nextAttemptAt: later(5_000) })
      const credited: AchievementUnlock = {
        ...unlockFor('sub-d', 'ach_d', {
          nextAttemptAt: null,
          creditedAt: CLOSED,
          productId: PRODUCT,
        }),
        recognition: { kind: 'COSMETIC_PRODUCT', name: 'Estandarte', status: 'CREDITED' },
      }

      for (const unlock of [onTime, future, credited, early, badgeFor('sub-e', 'ach_e')]) {
        await repository.recordEvaluation(unlock.playerId, [unlock], checkpoint())
      }

      await expect(repository.pendingRecognitionGrants(NOW, 10)).resolves.toEqual([early, onTime])
      await expect(repository.pendingRecognitionGrants(NOW, 1)).resolves.toEqual([early])
    })

    it('congela el producto una vez y ningun guardado lo cambia', async () => {
      const { repository } = setup()
      const pending = unlockFor('sub-a', 'ach_coleccionista')

      await repository.recordEvaluation('sub-a', [pending], checkpoint())
      await expect(
        repository.freezeRecognitionProduct(withProduct(pending, PRODUCT), 1),
      ).resolves.toBe(false)
      await expect(
        repository.freezeRecognitionProduct(withProduct(pending, PRODUCT), 0),
      ).resolves.toBe(true)
      await expect(
        repository.freezeRecognitionProduct(withProduct(pending, OTHER_PRODUCT), 0),
      ).resolves.toBe(false)

      const deferred = recognitionDeferred(withProduct(pending, OTHER_PRODUCT), 'HTTP_503', NOW)
      await expect(repository.saveRecognitionGrant(deferred, 1)).resolves.toBe(false)
      await expect(repository.saveRecognitionGrant(deferred, 0)).resolves.toBe(true)

      const stored = required((await repository.unlocksOf('sub-a'))[0], 'el desbloqueo')
      expect(stored.grant).toEqual({
        operationId: achievementGrantOperationId('sub-a', 'ach_coleccionista'),
        attempts: 1,
        nextAttemptAt: later(5_000),
        lastError: 'HTTP_503',
        productId: PRODUCT,
        creditedAt: null,
      })
    })

    it('solo cambia la entrega: lo desbloqueado queda congelado', async () => {
      const { repository } = setup()
      const pending = withProduct(unlockFor('sub-a', 'ach_coleccionista'), PRODUCT)

      await repository.recordEvaluation('sub-a', [pending], checkpoint())
      await expect(
        repository.saveRecognitionGrant(
          {
            ...recognitionCredited(pending, CLOSED),
            name: 'Otro nombre',
            progress: { current: 9, target: 9 },
            grant: {
              ...required(recognitionCredited(pending, CLOSED).grant, 'la entrega'),
              operationId: 'otra',
            },
          },
          0,
        ),
      ).resolves.toBe(true)

      await expect(repository.unlocksOf('sub-a')).resolves.toEqual([
        {
          ...pending,
          recognition: { ...pending.recognition, status: 'CREDITED' },
          grant: {
            ...required(pending.grant, 'la entrega'),
            attempts: 1,
            nextAttemptAt: null,
            creditedAt: CLOSED,
          },
        },
      ])
      // Ya no esta pendiente: nada mas se escribe.
      await expect(
        repository.saveRecognitionGrant(recognitionDeferred(pending, 'X', NOW), 1),
      ).resolves.toBe(false)
      await expect(repository.freezeRecognitionProduct(pending, 1)).resolves.toBe(false)
    })

    it('no escribe sobre lo que no existe, sobre una insignia ni sin entrega o producto', async () => {
      const { repository } = setup()
      const pending = unlockFor('sub-a', 'ach_coleccionista')
      const badge = badgeFor('sub-a', 'ach_sin_rasgunos')
      const broken: AchievementUnlock = { ...unlockFor('sub-a', 'ach_roto'), grant: null }

      await expect(repository.saveRecognitionGrant(pending, 0)).resolves.toBe(false)
      await expect(
        repository.freezeRecognitionProduct(withProduct(pending, PRODUCT), 0),
      ).resolves.toBe(false)

      await repository.recordEvaluation('sub-a', [pending, badge, broken], checkpoint())

      await expect(repository.saveRecognitionGrant(badge, 0)).resolves.toBe(false)
      await expect(repository.saveRecognitionGrant({ ...pending, grant: null }, 0)).resolves.toBe(
        false,
      )
      await expect(repository.saveRecognitionGrant(withProduct(pending, PRODUCT), 3)).resolves.toBe(
        false,
      )
      await expect(repository.freezeRecognitionProduct(pending, 0)).resolves.toBe(false)
      await expect(
        repository.saveRecognitionGrant(unlockFor('sub-a', 'ach_roto'), 0),
      ).resolves.toBe(false)
      await expect(
        repository.freezeRecognitionProduct(
          withProduct(unlockFor('sub-a', 'ach_roto'), PRODUCT),
          0,
        ),
      ).resolves.toBe(false)
      await expect(repository.pendingRecognitionGrants(later(60_000), 10)).resolves.toEqual([
        pending,
      ])
    })
  })
})

describe('InMemoryAchievementEvidence (doble de HU-76)', () => {
  const reportFor = (
    playerId: string,
    enrollmentId: string,
    outcome: ReportOutcome,
    finishedAt: Date,
    damageTaken: number | null = 0,
  ): ReportRecord => ({
    report: {
      schemaVersion: 1,
      enrollmentId,
      playerId,
      mission: {
        missionId: TEMPLO_ID,
        name: 'El Templo Olvidado',
        category: 'STORY',
        difficulty: 'NORMAL',
      },
      summary: {
        outcome,
        outcomeReason: null,
        hero: { heroId: randomUUID(), name: null, subtype: null },
        startedAt: AT,
        finishedAt,
        simulatedDuration: 'PT9H',
      },
      combatStats: {
        encountersCompleted: 5,
        encountersTotal: 5,
        totalTurns: null,
        damageDealt: null,
        damageTaken,
        criticalEffects: null,
        skillsUsed: [],
      },
      enemies: {
        defeated: [],
        boss: { enemyRef: 'guardian-eterno', name: 'El Guardián Eterno', defeated: true },
        masters: [],
      },
      objectives: [],
      generatedAt: finishedAt,
    },
    rewards: [],
  })

  const setup = () => {
    const enrollments = new InMemoryEnrollmentRepository()
    const reports = new InMemoryReportRepository()
    const masters = new InMemoryMasterEncounterRepository(reports)

    return {
      enrollments,
      reports,
      masters,
      evidence: new InMemoryAchievementEvidence(enrollments, reports, masters),
    }
  }

  it('solo los reportes COMPLETED del jugador, del mas antiguo al mas reciente', async () => {
    const { reports, evidence } = setup()

    reports.recordNow(reportFor('sub-a', 'enr_2', 'COMPLETED', CLOSED, null))
    reports.recordNow(reportFor('sub-a', 'enr_1', 'COMPLETED', AT))
    reports.recordNow(reportFor('sub-a', 'enr_3', 'FAILED', AT))
    reports.recordNow(reportFor('sub-b', 'enr_4', 'COMPLETED', AT))

    await expect(evidence.completedReportsOf('sub-a')).resolves.toEqual([
      {
        enrollmentId: 'enr_1',
        missionId: TEMPLO_ID,
        difficulty: 'NORMAL',
        finishedAt: AT,
        damageTaken: 0,
        simulatedDuration: 'PT9H',
        encountersCompleted: 5,
        encountersTotal: 5,
      },
      {
        enrollmentId: 'enr_2',
        missionId: TEMPLO_ID,
        difficulty: 'NORMAL',
        finishedAt: CLOSED,
        damageTaken: null,
        simulatedDuration: 'PT9H',
        encountersCompleted: 5,
        encountersTotal: 5,
      },
    ])
  })

  it('los Master derrotados en las matriculas COMPLETED o FAILED del jugador, en orden', async () => {
    const { enrollments, masters, evidence } = setup()

    await settle(enrollments, 'sub-a', 'enr_a1')
    await settle(enrollments, 'sub-a', 'enr_a2', 'FAILED')
    await settle(enrollments, 'sub-a', 'enr_a3', 'VOIDED')
    await start(enrollments, 'sub-a', 'enr_a4')
    await settle(enrollments, 'sub-b', 'enr_b1')
    masters.recordNow([
      defeated('enr_a2', 2, 'centinela', 'GRANTED'),
      {
        enrollmentId: 'enr_a2',
        sequence: 1,
        afterEncounter: 1,
        masterRef: 'fugaz',
        status: 'APPEARED_ESCAPED',
        epicRef: null,
        levelOffset: 2,
        turns: 3,
        grant: null,
      },
      defeated('enr_a1', 1, 'sombra'),
      // Datos que el motor no admite, leidos sin fiarse: sin nombre no cuenta; sin entrega, si.
      { ...defeated('enr_a1', 2, 'anonimo'), masterRef: null },
      { ...defeated('enr_a1', 3, 'sin-entrega'), grant: null },
      defeated('enr_a3', 1, 'anulado'),
      defeated('enr_a4', 1, 'en-curso'),
      defeated('enr_b1', 1, 'ajeno', 'GRANTED'),
    ])

    await expect(evidence.defeatedMastersOf('sub-a')).resolves.toEqual([
      {
        enrollmentId: 'enr_a1',
        sequence: 1,
        masterRef: 'sombra',
        epicRef: 'epica-sombra',
        grantStatus: 'PENDING',
      },
      {
        enrollmentId: 'enr_a1',
        sequence: 3,
        masterRef: 'sin-entrega',
        epicRef: 'epica-sin-entrega',
        grantStatus: null,
      },
      {
        enrollmentId: 'enr_a2',
        sequence: 2,
        masterRef: 'centinela',
        epicRef: 'epica-centinela',
        grantStatus: 'GRANTED',
      },
    ])
  })
})

describe('StaticAchievementCatalog', () => {
  it('carga un catalogo valido y devuelve una copia en cada lectura', async () => {
    const catalog = new StaticAchievementCatalog(EXAMPLE_ACHIEVEMENTS)
    const first = await catalog.list()

    expect(first).toEqual(EXAMPLE_ACHIEVEMENTS)
    expect(first).not.toBe(await catalog.list())
  })

  it('sin definiciones no hay logros', async () => {
    await expect(new StaticAchievementCatalog().list()).resolves.toEqual([])
  })

  it('un catalogo roto impide construirlo, y con el, arrancar', () => {
    const broken = { ...required(EXAMPLE_ACHIEVEMENTS[0], 'un logro'), version: 0 }

    expect(() => new StaticAchievementCatalog([broken])).toThrow(InvalidAchievementCatalogError)
  })
})

describe('MissionExecutionScheduler con los logros de HU-76', () => {
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
  const noAchievements = {
    achievementPlayersEvaluated: 0,
    achievementsUnlocked: 0,
    achievementEvaluationsFailed: 0,
  }
  const noRecognitions = {
    recognitionsCredited: 0,
    recognitionsRetried: 0,
    recognitionsWaiting: 0,
    recognitionsRejected: 0,
    recognitionsFailed: 0,
  }

  const step = (name: string, order: string[], result: object) => ({
    run: () => {
      order.push(name)
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
  })

  const scheduler = (
    log: Logger,
    order: string[],
    results: {
      readonly executions?: object
      readonly epics?: object
      readonly achievements?: object
      readonly recognitions?: object
    } = {},
  ) =>
    new MissionExecutionScheduler(
      step('cierre', order, results.executions ?? zero) as unknown as RunMissionExecutions,
      log,
      1_000,
      false,
      step('entregas', order, results.epics ?? noEpics) as unknown as GrantMasterEpics,
      step(
        'logros',
        order,
        results.achievements ?? noAchievements,
      ) as unknown as EvaluateMissionAchievements,
      step(
        'reconocimientos',
        order,
        results.recognitions ?? noRecognitions,
      ) as unknown as GrantAchievementRecognitions,
    )

  it('evalua los logros y entrega los cosmeticos despues de las epicas, y lo registra junto', async () => {
    const log = logger()
    const order: string[] = []

    await scheduler(log, order, {
      achievements: { ...noAchievements, achievementPlayersEvaluated: 1, achievementsUnlocked: 2 },
      recognitions: { ...noRecognitions, recognitionsCredited: 1 },
    }).tick()

    expect(order).toEqual(['cierre', 'entregas', 'logros', 'reconocimientos'])
    expect(log.entries).toEqual([
      [
        'mission_execution_cycle',
        {
          ...zero,
          ...noEpics,
          ...noAchievements,
          achievementPlayersEvaluated: 1,
          achievementsUnlocked: 2,
          ...noRecognitions,
          recognitionsCredited: 1,
        },
      ],
    ])
  })

  it('si el cierre falla, las epicas, los logros y los cosmeticos corren igual', async () => {
    const log = logger()
    const order: string[] = []

    await scheduler(log, order, {
      executions: new Error('db caida'),
      epics: { ...noEpics, epicsGranted: 1 },
    }).tick()

    expect(order).toEqual(['cierre', 'entregas', 'logros', 'reconocimientos'])
    expect(log.entries).toEqual([
      ['mission_execution_failed', { step: 'executions', detail: 'db caida' }],
      [
        'mission_execution_cycle',
        { ...noEpics, epicsGranted: 1, ...noAchievements, ...noRecognitions },
      ],
    ])
  })

  it('un paso de logros que falla no borra lo que hicieron los demas', async () => {
    const log = logger()

    await scheduler(log, [], {
      executions: { ...zero, settled: 1 },
      achievements: new Error('sin base'),
      recognitions: new Error('sin red'),
    }).tick()

    expect(log.entries).toEqual([
      ['mission_execution_failed', { step: 'achievements', detail: 'sin base' }],
      ['mission_execution_failed', { step: 'recognitions', detail: 'sin red' }],
      ['mission_execution_cycle', { ...zero, settled: 1, ...noEpics }],
    ])
  })

  it('un fallo de las epicas se registra con su paso', async () => {
    const log = logger()

    await scheduler(log, [], { epics: new Error('inventario caido') }).tick()

    expect(log.entries).toEqual([
      ['mission_execution_failed', { step: 'epics', detail: 'inventario caido' }],
    ])
  })

  it('un ciclo sin cambios no se registra', async () => {
    const log = logger()

    await scheduler(log, []).tick()

    expect(log.entries).toEqual([])
  })
})
