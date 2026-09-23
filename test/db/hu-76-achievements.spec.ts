import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/example-achievements'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresAchievementEvidence } from '../../src/adapters/outbound/persistence/PostgresAchievementEvidence'
import { PostgresAchievementRepository } from '../../src/adapters/outbound/persistence/PostgresAchievementRepository'
import { PostgresDifficultyClearRepository } from '../../src/adapters/outbound/persistence/PostgresDifficultyClearRepository'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { insertMasterEncounters } from '../../src/adapters/outbound/persistence/PostgresMasterEncounterRepository'
import { PostgresMissionCatalog } from '../../src/adapters/outbound/persistence/PostgresMissionCatalog'
import { insertReport } from '../../src/adapters/outbound/persistence/PostgresReportRepository'
import { StaticAchievementCatalog } from '../../src/adapters/outbound/persistence/StaticAchievementCatalog'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { ACHIEVEMENT_CATALOG } from '../../src/application/ports/AchievementCatalogPort'
import { ACHIEVEMENT_EVIDENCE } from '../../src/application/ports/AchievementEvidencePort'
import {
  ACHIEVEMENT_REPOSITORY,
  type EvaluationCheckpoint,
} from '../../src/application/ports/AchievementRepositoryPort'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { EPIC_GRANTS } from '../../src/application/ports/EpicGrantPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { EvaluateMissionAchievements } from '../../src/application/use-cases/EvaluateMissionAchievements'
import { GetMissionAchievements } from '../../src/application/use-cases/GetMissionAchievements'
import {
  recognitionCredited,
  recognitionDeferred,
  type AchievementUnlock,
} from '../../src/domain/entities/Achievement'
import type {
  EpicGrantStatus,
  MasterEncounterRecord,
} from '../../src/domain/entities/MasterEncounterRecord'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  closeEnrollment,
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import { voidedSettlement } from '../../src/domain/entities/MissionExecution'
import type { MissionReport, ReportOutcome } from '../../src/domain/entities/MissionReport'
import { achievementGrantOperationId } from '../../src/domain/policies/AchievementPolicy'
import { missionSettledFact } from '../../src/domain/policies/SettlementPolicy'
import {
  AppModule,
  MISSION_EXECUTION_SCHEDULER,
} from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-76.2). Lo que los dobles en memoria no pueden probar:
 * que la migracion 007 impone sus reglas en el motor (CA-03 incluido), que la
 * deteccion de a quien evaluar y la lectura tolerante de los reportes funcionan
 * con SQL de verdad, que las escrituras son idempotentes y condicionales con dos
 * procesos a la vez, que `mission_facts.processed_at` sigue siendo solo de HU-72
 * y el servicio completo con `PERSISTENCE_DRIVER=postgres`.
 */
const [TEMPLO, CAMARA] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const AT = new Date('2026-10-01T15:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')
const NOW = new Date('2026-10-02T04:00:00.000Z')
const LATER_CREDIT = new Date('2026-10-02T05:00:00.000Z')
const PRODUCT = '11111111-1111-4111-8111-111111111111'
const OTHER_PRODUCT = '22222222-2222-4222-8222-222222222222'
const FINGERPRINT = '6f1c2a8e-1d3b-5c4a-9e7f-0a1b2c3d4e5f'
const OTHER_FINGERPRINT = '7a2d3b9f-2e4c-5d5b-8f80-1b2c3d4e5f60'

const later = (ms: number): Date => new Date(NOW.getTime() + ms)

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}.`)
  }

  return value
}

class FixedClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
}

const checkpoint = (values: Partial<EvaluationCheckpoint> = {}): EvaluationCheckpoint => ({
  settledSeen: 1,
  epicsGrantedSeen: 0,
  fingerprint: FINGERPRINT,
  evaluatedAt: NOW,
  ...values,
})

const cosmeticFor = (playerId: string, achievementId = 'ach_coleccionista'): AchievementUnlock => ({
  playerId,
  achievementId,
  achievementVersion: 1,
  criterion: 'ALL_MASTER_EPICS',
  name: 'Estandarte del Coleccionista',
  progress: { current: 2, target: 2 },
  proof: { refs: ['furia-carmesi', 'velo-de-sombras'], enrollmentIds: ['enr_1', 'enr_2'] },
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
  },
})

const badgeFor = (playerId: string, achievementId = 'ach_sin_rasgunos'): AchievementUnlock => ({
  ...cosmeticFor(playerId, achievementId),
  criterion: 'FLAWLESS_MISSION',
  name: 'Sin un rasguño',
  progress: { current: 1, target: 1 },
  proof: { refs: [TEMPLO.missionId], enrollmentIds: ['enr_1'] },
  recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
  grant: null,
})

const withProduct = (unlock: AchievementUnlock, productId: string): AchievementUnlock => ({
  ...unlock,
  grant: { ...required(unlock.grant, 'la entrega'), productId },
})

describe('Logros de misiones en PostgreSQL (HU-76)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let enrollments: PostgresEnrollmentRepository
  let clears: PostgresDifficultyClearRepository
  let achievements: PostgresAchievementRepository
  let evidence: PostgresAchievementEvidence

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO)
    await insertDefinition(db, CAMARA)
    enrollments = new PostgresEnrollmentRepository(db)
    clears = new PostgresDifficultyClearRepository(db)
    achievements = new PostgresAchievementRepository(db)
    evidence = new PostgresAchievementEvidence(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  /** Cada prueba empieza sin datos: la deteccion recorre toda la tabla. */
  const reset = async (): Promise<void> => {
    await sql`truncate mission_achievement_unlocks, mission_achievement_evaluations,
      mission_master_encounters, mission_report_rewards, mission_reports, mission_executions,
      mission_facts, mission_enrollments, mission_difficulty_clears`.execute(db)
  }

  /** Una matricula iniciada, con su hecho de inicio. */
  const start = async (
    playerId: string,
    missionId = TEMPLO.missionId,
  ): Promise<MissionEnrollment> => {
    const pending = newPendingEnrollment({
      enrollmentId: `enr_hu76_${randomUUID()}`,
      playerId,
      missionId,
      heroId: randomUUID(),
      difficulty: 'NORMAL',
      operationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    })
    const confirmed = confirmEnrollment(pending, 'cmt-1', AT, TEMPLO.estimatedDurationMinutes)

    await enrollments.insertPending(pending)
    await enrollments.saveTransition(confirmed, pending.version, enrollmentStartedFact(confirmed))

    return confirmed
  }

  /** Cerrada con su `MissionSettled` en la misma transaccion, como en el cierre de HU-72. */
  const settle = async (
    playerId: string,
    outcome: 'COMPLETED' | 'FAILED' | 'VOIDED' = 'COMPLETED',
    missionId = TEMPLO.missionId,
  ): Promise<MissionEnrollment> => {
    const started = await start(playerId, missionId)
    const closed = closeEnrollment(started, outcome, CLOSED)
    const settlement =
      outcome === 'VOIDED'
        ? voidedSettlement('INVALID_SIMULATION_RESULT')
        : { outcome, reason: null, objectives: [] }

    await enrollments.saveTransition(
      closed,
      started.version,
      missionSettledFact(started, settlement, null, CLOSED),
    )

    return closed
  }

  const reportOf = (
    enrollment: MissionEnrollment,
    outcome: ReportOutcome,
    combatStats: Partial<MissionReport['combatStats']> = {},
    finishedAt = CLOSED,
  ): MissionReport => ({
    schemaVersion: 1,
    enrollmentId: enrollment.enrollmentId,
    playerId: enrollment.playerId,
    mission: {
      missionId: enrollment.missionId,
      name: TEMPLO.name,
      category: 'STORY',
      difficulty: enrollment.difficulty,
    },
    summary: {
      outcome,
      outcomeReason: null,
      hero: { heroId: enrollment.heroId, name: null, subtype: null },
      startedAt: AT,
      finishedAt,
      simulatedDuration: 'PT9H40M',
    },
    combatStats: {
      encountersCompleted: 5,
      encountersTotal: 5,
      totalTurns: null,
      damageDealt: null,
      damageTaken: 0,
      criticalEffects: null,
      skillsUsed: [],
      ...combatStats,
    },
    enemies: {
      defeated: [],
      boss: { enemyRef: 'guardian-eterno', name: 'El Guardián Eterno', defeated: true },
      masters: [],
    },
    objectives: [],
    generatedAt: finishedAt,
  })

  /** Completada, con su clear y su reporte, en una sola funcion (el cierre las escribe juntas). */
  const completed = async (
    playerId: string,
    combatStats: Partial<MissionReport['combatStats']> = {},
    finishedAt = CLOSED,
  ): Promise<MissionEnrollment> => {
    const enrollment = await settle(playerId)

    await clears.record({
      playerId,
      missionId: enrollment.missionId,
      difficulty: 'NORMAL',
      completedAt: finishedAt,
    })
    await insertReport(db, {
      report: reportOf(enrollment, 'COMPLETED', combatStats, finishedAt),
      rewards: [],
    })

    return enrollment
  }

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

  const count = async (
    table: 'mission_achievement_unlocks' | 'mission_achievement_evaluations',
  ) => {
    const { rows } = await sql<{
      n: number
    }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)

    return rows[0]?.n ?? 0
  }

  // Controles de motor: con SQL crudo, saltandose el repositorio.
  describe('restricciones de la migracion 007', () => {
    const insertInto = (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row).map((column) => sql.ref(column))

      return sql`insert into ${sql.table(table)} (${sql.join(columns)})
        values (${sql.join(Object.values(row))})`.execute(db)
    }

    /** Una insignia registrada, coherente. */
    const badge = (values: Record<string, unknown> = {}) => ({
      player_id: `pg-${randomUUID()}`,
      achievement_id: 'ach_sin_rasgunos',
      achievement_version: 1,
      criterion: 'FLAWLESS_MISSION',
      name: 'Sin un rasguño',
      progress_current: 1,
      progress_target: 1,
      proof: JSON.stringify({ refs: [], enrollmentIds: [] }),
      unlocked_at: NOW,
      recognition_kind: 'BADGE',
      recognition_name: 'Sin un rasguño',
      recognition_status: 'RECORDED',
      grant_operation_id: null,
      grant_attempts: 0,
      grant_next_attempt_at: null,
      grant_last_error: null,
      grant_product_id: null,
      credited_at: null,
      ...values,
    })

    /** Un cosmetico pendiente de entregar, coherente. */
    const cosmetic = (values: Record<string, unknown> = {}) =>
      badge({
        achievement_id: 'ach_coleccionista',
        criterion: 'ALL_MASTER_EPICS',
        name: 'Estandarte',
        progress_current: 2,
        progress_target: 2,
        recognition_kind: 'COSMETIC_PRODUCT',
        recognition_name: 'Estandarte',
        recognition_status: 'PENDING',
        grant_operation_id: randomUUID(),
        grant_next_attempt_at: NOW,
        ...values,
      })

    const credited = (values: Record<string, unknown> = {}) =>
      cosmetic({
        recognition_status: 'CREDITED',
        grant_attempts: 1,
        grant_next_attempt_at: null,
        grant_product_id: PRODUCT,
        credited_at: LATER_CREDIT,
        ...values,
      })

    const evaluation = (values: Record<string, unknown> = {}) => ({
      player_id: `pg-${randomUUID()}`,
      settled_seen: 1,
      epics_granted_seen: 0,
      catalog_fingerprint: FINGERPRINT,
      evaluated_at: NOW,
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      ...values,
    })

    it('las filas coherentes entran', async () => {
      await expect(insertInto('mission_achievement_unlocks', badge())).resolves.toBeDefined()
      await expect(insertInto('mission_achievement_unlocks', cosmetic())).resolves.toBeDefined()
      await expect(insertInto('mission_achievement_unlocks', credited())).resolves.toBeDefined()
      await expect(
        insertInto(
          'mission_achievement_unlocks',
          cosmetic({
            recognition_status: 'FAILED',
            grant_attempts: 1,
            grant_next_attempt_at: null,
          }),
        ),
      ).resolves.toBeDefined()
      await expect(
        insertInto('mission_achievement_evaluations', evaluation()),
      ).resolves.toBeDefined()
      // Aplazado sin haberse evaluado nunca.
      await expect(
        insertInto(
          'mission_achievement_evaluations',
          evaluation({
            settled_seen: 0,
            catalog_fingerprint: null,
            evaluated_at: null,
            attempts: 1,
            next_attempt_at: NOW,
            last_error: 'INTERNAL_ERROR',
          }),
        ),
      ).resolves.toBeDefined()
    })

    it.each([
      ['un id de logro con mayusculas', () => badge({ achievement_id: 'Ach_X' }), 'logro_valido'],
      ['un criterio desconocido', () => badge({ criterion: 'PVP_WINS' }), 'criterio_conocido'],
      ['una version 0', () => badge({ achievement_version: 0 }), 'version_positiva'],
      [
        'un objetivo vacio (0 de 0, CA-03)',
        () => badge({ progress_current: 0, progress_target: 0 }),
        'progreso_completo',
      ],
      [
        'un progreso parcial (1 de 2, CA-03)',
        () => badge({ progress_current: 1, progress_target: 2 }),
        'progreso_completo',
      ],
      ['una prueba que no es objeto', () => badge({ proof: '[]' }), 'prueba_es_objeto'],
      ['un nombre en blanco', () => badge({ name: '  ' }), 'nombres_presentes'],
      ['un reconocimiento sin nombre', () => badge({ recognition_name: '' }), 'nombres_presentes'],
      [
        'un tipo de reconocimiento desconocido',
        () => badge({ recognition_kind: 'EMOTE' }),
        'reconocimiento_conocido',
      ],
      [
        'un estado de reconocimiento desconocido',
        () => cosmetic({ recognition_status: 'LOST', grant_next_attempt_at: null }),
        'estado_de_reconocimiento',
      ],
      [
        'una insignia pendiente de entrega',
        () => badge({ recognition_status: 'PENDING', grant_next_attempt_at: NOW }),
        'registrado_si_no_es_producto',
      ],
      [
        'un cosmetico registrado sin entrega',
        () => cosmetic({ recognition_status: 'RECORDED', grant_next_attempt_at: null }),
        'registrado_si_no_es_producto',
      ],
      [
        'una insignia con entrega',
        () => badge({ grant_operation_id: randomUUID() }),
        'entrega_solo_de_producto',
      ],
      [
        'un cosmetico sin entrega',
        () => cosmetic({ grant_operation_id: null }),
        'entrega_solo_de_producto',
      ],
      [
        'un pendiente sin proximo intento',
        () => cosmetic({ grant_next_attempt_at: null }),
        'proximo_intento_si_pendiente',
      ],
      [
        'un entregado con proximo intento',
        () => credited({ grant_next_attempt_at: NOW }),
        'proximo_intento_si_pendiente',
      ],
      ['un entregado sin fecha', () => credited({ credited_at: null }), 'acreditado_con_fecha'],
      [
        'una fecha de entrega sin estar entregado',
        () => cosmetic({ credited_at: NOW }),
        'acreditado_con_fecha',
      ],
      [
        'un entregado sin producto',
        () => credited({ grant_product_id: null }),
        'acreditado_con_producto',
      ],
      [
        'un producto sin entrega',
        () => badge({ grant_product_id: PRODUCT }),
        'producto_de_entrega',
      ],
      ['intentos negativos', () => cosmetic({ grant_attempts: -1 }), 'intentos'],
    ])('el motor rechaza %s', async (_caso, row, constraint) => {
      await expect(insertInto('mission_achievement_unlocks', row())).rejects.toThrow(
        new RegExp(`mission_achievement_unlocks_${constraint}`),
      )
    })

    it.each([
      ['conteos negativos', { settled_seen: -1 }, 'conteos_no_negativos'],
      ['intentos negativos', { attempts: -1 }, 'intentos'],
      ['un reintento sin fallo', { next_attempt_at: NOW }, 'reintento_tras_fallo'],
      [
        'un fallo sin reintento',
        { attempts: 1, last_error: 'INTERNAL_ERROR' },
        'reintento_tras_fallo',
      ],
      ['una evaluacion sin huella', { catalog_fingerprint: null }, 'evaluada_con_huella'],
      ['una huella sin evaluacion', { evaluated_at: null }, 'evaluada_con_huella'],
    ])('el motor rechaza en el punto de control %s', async (_caso, values, constraint) => {
      await expect(
        insertInto('mission_achievement_evaluations', evaluation(values)),
      ).rejects.toThrow(new RegExp(`mission_achievement_evaluations_${constraint}`))
    })

    it('un logro una sola vez por jugador, y cada entrega con su propia operacion', async () => {
      const row = cosmetic()
      await insertInto('mission_achievement_unlocks', row)

      await expect(insertInto('mission_achievement_unlocks', row)).rejects.toThrow(
        /mission_achievement_unlocks_pk/,
      )
      await expect(
        insertInto('mission_achievement_unlocks', { ...row, player_id: `pg-${randomUUID()}` }),
      ).rejects.toThrow(/mission_achievement_unlocks_grant_operation_id_key/)
    })
  })

  describe('PostgresAchievementRepository: a quien evaluar', () => {
    beforeEach(reset)

    it('elige a quien tiene algun MissionSettled, tambien anulado, con sus conteos', async () => {
      const first = await settle('pg-a')
      const second = await settle('pg-a', 'FAILED')
      await settle('pg-b', 'VOIDED')
      // Solo iniciada: no hay nada que evaluar.
      const started = await start('pg-c')
      await insertMasterEncounters(db, [
        defeated(first.enrollmentId, 1, 'sombra', 'GRANTED'),
        defeated(second.enrollmentId, 1, 'centinela'),
        defeated(started.enrollmentId, 1, 'sombra', 'GRANTED'),
      ])

      await expect(achievements.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'pg-a', settled: 2, epicsGranted: 1, attempts: 0 },
        { playerId: 'pg-b', settled: 1, epicsGranted: 0, attempts: 0 },
      ])
    })

    it('al dia no lo elige; si cambia un conteo o la huella, si', async () => {
      const first = await settle('pg-a')
      const epic = defeated(first.enrollmentId, 1, 'sombra')
      await insertMasterEncounters(db, [epic])
      await achievements.recordEvaluation('pg-a', [], checkpoint())

      await expect(achievements.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([])
      await expect(achievements.playersToEvaluate(NOW, OTHER_FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'pg-a', settled: 1, epicsGranted: 0, attempts: 0 },
      ])

      await settle('pg-a')
      await expect(achievements.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'pg-a', settled: 2, epicsGranted: 0, attempts: 0 },
      ])
      await achievements.recordEvaluation('pg-a', [], checkpoint({ settledSeen: 2 }))

      // La epica se entrega despues, sin otra mision.
      await sql`update mission_master_encounters
        set grant_status = 'GRANTED', granted_at = ${CLOSED}, grant_product_id = ${PRODUCT},
          grant_attempts = 1, grant_next_attempt_at = null
        where enrollment_id = ${first.enrollmentId}`.execute(db)
      await expect(achievements.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'pg-a', settled: 2, epicsGranted: 1, attempts: 0 },
      ])
    })

    it('un aplazamiento lo aparta hasta que vence y conserva lo visto', async () => {
      await settle('pg-a')
      await achievements.deferEvaluation('pg-a', {
        attempts: 1,
        nextAttemptAt: later(5_000),
        lastError: 'INTERNAL_ERROR',
      })

      await expect(achievements.playersToEvaluate(NOW, FINGERPRINT, 10)).resolves.toEqual([])
      await expect(achievements.playersToEvaluate(later(5_000), FINGERPRINT, 10)).resolves.toEqual([
        { playerId: 'pg-a', settled: 1, epicsGranted: 0, attempts: 1 },
      ])

      await achievements.recordEvaluation(
        'pg-a',
        [],
        checkpoint({ settledSeen: 7, epicsGrantedSeen: 3 }),
      )
      await achievements.deferEvaluation('pg-a', {
        attempts: 1,
        nextAttemptAt: later(5_000),
        lastError: 'INTERNAL_ERROR',
      })
      const { rows } = await sql<{
        settled_seen: number
        epics_granted_seen: number
        catalog_fingerprint: string | null
        attempts: number
      }>`select settled_seen, epics_granted_seen, catalog_fingerprint, attempts
        from mission_achievement_evaluations where player_id = 'pg-a'`.execute(db)
      expect(rows).toEqual([
        { settled_seen: 7, epics_granted_seen: 3, catalog_fingerprint: FINGERPRINT, attempts: 1 },
      ])
    })

    it('primero los nunca evaluados; despues, los evaluados hace mas tiempo; con limite', async () => {
      for (const playerId of ['pg-d', 'pg-c', 'pg-b', 'pg-a']) {
        await settle(playerId)
      }
      await achievements.recordEvaluation('pg-a', [], checkpoint({ settledSeen: 0 }))
      await achievements.recordEvaluation(
        'pg-c',
        [],
        checkpoint({ settledSeen: 0, evaluatedAt: later(-60_000) }),
      )

      const ids = async (limit: number) =>
        (await achievements.playersToEvaluate(NOW, FINGERPRINT, limit)).map(
          (player) => player.playerId,
        )

      await expect(ids(10)).resolves.toEqual(['pg-b', 'pg-d', 'pg-c', 'pg-a'])
      await expect(ids(2)).resolves.toEqual(['pg-b', 'pg-d'])
    })
  })

  describe('PostgresAchievementRepository: desbloqueos y entregas', () => {
    beforeEach(reset)

    it('guarda cada logro una sola vez por jugador, con la prueba en jsonb, y devuelve solo los nuevos', async () => {
      const first = [badgeFor('pg-a'), cosmeticFor('pg-a')]
      const again = [
        { ...badgeFor('pg-a'), unlockedAt: later(1_000) },
        badgeFor('pg-a', 'ach_historia_completa'),
      ]

      await expect(achievements.recordEvaluation('pg-a', first, checkpoint())).resolves.toEqual(
        first,
      )
      await expect(
        achievements.recordEvaluation('pg-a', again, checkpoint({ settledSeen: 2 })),
      ).resolves.toEqual([again[1]])
      await expect(achievements.unlocksOf('pg-a')).resolves.toEqual([first[1], again[1], first[0]])
      await expect(achievements.unlocksOf('pg-b')).resolves.toEqual([])
    })

    it('un conflicto en el operationId de la entrega tambien se ignora, sin romper la transaccion', async () => {
      const first = cosmeticFor('pg-a')
      await achievements.recordEvaluation('pg-a', [first], checkpoint())

      // El operationId sale del jugador y del logro: repetirlo es repetir el desbloqueo.
      const clash: AchievementUnlock = {
        ...cosmeticFor('pg-a', 'ach_otro'),
        grant: required(first.grant, 'la entrega'),
      }

      await expect(
        achievements.recordEvaluation(
          'pg-a',
          [clash, badgeFor('pg-a')],
          checkpoint({ settledSeen: 2 }),
        ),
      ).resolves.toEqual([badgeFor('pg-a')])
      await expect(count('mission_achievement_unlocks')).resolves.toBe(2)
    })

    it('varias evaluaciones a la vez del mismo cosmetico dejan una fila y ninguna falla (P-05)', async () => {
      const unlock = cosmeticFor('pg-a')

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          achievements.recordEvaluation('pg-a', [unlock], checkpoint()),
        ),
      )

      expect(results.flat()).toEqual([unlock])
      await expect(count('mission_achievement_unlocks')).resolves.toBe(1)
    })

    it('en una transaccion: si un desbloqueo no cumple el motor, no se guarda nada', async () => {
      const partial: AchievementUnlock = {
        ...badgeFor('pg-a'),
        progress: { current: 1, target: 2 },
      }

      await expect(achievements.recordEvaluation('pg-a', [partial], checkpoint())).rejects.toThrow(
        /mission_achievement_unlocks_progreso_completo/,
      )
      await expect(achievements.unlocksOf('pg-a')).resolves.toEqual([])
      await expect(count('mission_achievement_evaluations')).resolves.toBe(0)
    })

    it('la entrega: el producto se congela una vez, cada guardado exige los intentos leidos y el motor exige producto al acreditar', async () => {
      const pending = cosmeticFor('pg-a')
      await achievements.recordEvaluation('pg-a', [pending, badgeFor('pg-a')], checkpoint())

      await expect(achievements.pendingRecognitionGrants(NOW, 10)).resolves.toEqual([pending])
      await expect(
        achievements.saveRecognitionGrant(recognitionCredited(pending, NOW), 0),
      ).rejects.toThrow(/mission_achievement_unlocks_acreditado_con_producto/)

      await expect(achievements.freezeRecognitionProduct(pending, 0)).resolves.toBe(false)
      await expect(
        achievements.freezeRecognitionProduct(withProduct(pending, PRODUCT), 1),
      ).resolves.toBe(false)
      await expect(
        achievements.freezeRecognitionProduct(withProduct(pending, PRODUCT), 0),
      ).resolves.toBe(true)
      await expect(
        achievements.freezeRecognitionProduct(withProduct(pending, OTHER_PRODUCT), 0),
      ).resolves.toBe(false)

      const deferred = recognitionDeferred(withProduct(pending, OTHER_PRODUCT), 'HTTP_503', NOW)
      await expect(achievements.saveRecognitionGrant(deferred, 1)).resolves.toBe(false)
      await expect(achievements.saveRecognitionGrant(deferred, 0)).resolves.toBe(true)
      await expect(achievements.saveRecognitionGrant({ ...pending, grant: null }, 1)).resolves.toBe(
        false,
      )

      const [stored] = await achievements.pendingRecognitionGrants(later(5_000), 10)
      expect(stored).toEqual({
        ...pending,
        grant: {
          ...required(pending.grant, 'la entrega'),
          attempts: 1,
          nextAttemptAt: later(5_000),
          lastError: 'HTTP_503',
          productId: PRODUCT,
        },
      })
      await expect(achievements.pendingRecognitionGrants(NOW, 10)).resolves.toEqual([])

      const done = recognitionCredited(required(stored, 'la entrega guardada'), later(6_000))
      await expect(achievements.saveRecognitionGrant(done, 1)).resolves.toBe(true)
      await expect(achievements.saveRecognitionGrant(done, 2)).resolves.toBe(false)
      await expect(achievements.unlocksOf('pg-a')).resolves.toContainEqual(
        expect.objectContaining({
          achievementId: 'ach_coleccionista',
          recognition: expect.objectContaining({ status: 'CREDITED' }) as unknown,
          grant: expect.objectContaining({
            creditedAt: later(6_000),
            productId: PRODUCT,
          }) as unknown,
        }),
      )
    })
  })

  describe('PostgresAchievementEvidence: lectura tolerante', () => {
    beforeEach(reset)

    it('solo los reportes COMPLETED del jugador, en orden, y sin lanzar por la foto', async () => {
      const flawless = await completed('pg-a', {}, AT)
      const odd = await settle('pg-a')
      const other = await settle('pg-a')
      const failed = await settle('pg-a', 'FAILED')
      await completed('pg-b')
      await insertReport(db, { report: reportOf(failed, 'FAILED'), rewards: [] })
      // Una foto con un dato raro y otra de una version que este servicio no conoce.
      await sql`insert into mission_reports (enrollment_id, player_id, mission_id, category, difficulty,
          outcome, finished_at, schema_version, snapshot, generated_at)
        values
          (${odd.enrollmentId}, 'pg-a', ${TEMPLO.missionId}, 'STORY', 'NORMAL', 'COMPLETED', ${later(1_000)},
            1, ${JSON.stringify({ combatStats: { damageTaken: '0', encountersTotal: 5 }, summary: {} })}, ${CLOSED}),
          (${other.enrollmentId}, 'pg-a', ${TEMPLO.missionId}, 'STORY', 'HEROIC', 'COMPLETED', ${later(2_000)},
            2, ${JSON.stringify({ combatStats: { damageTaken: 0, encountersCompleted: 5, encountersTotal: 5 } })}, ${CLOSED})
      `.execute(db)

      await expect(evidence.completedReportsOf('pg-a')).resolves.toEqual([
        {
          enrollmentId: flawless.enrollmentId,
          missionId: TEMPLO.missionId,
          difficulty: 'NORMAL',
          finishedAt: AT,
          damageTaken: 0,
          simulatedDuration: 'PT9H40M',
          encountersCompleted: 5,
          encountersTotal: 5,
        },
        {
          enrollmentId: odd.enrollmentId,
          missionId: TEMPLO.missionId,
          difficulty: 'NORMAL',
          finishedAt: later(1_000),
          damageTaken: null,
          simulatedDuration: null,
          encountersCompleted: null,
          encountersTotal: 5,
        },
        {
          enrollmentId: other.enrollmentId,
          missionId: TEMPLO.missionId,
          difficulty: 'HEROIC',
          finishedAt: later(2_000),
          damageTaken: null,
          simulatedDuration: null,
          encountersCompleted: null,
          encountersTotal: null,
        },
      ])
    })

    it('un reporte de otra version no rompe la consulta de logros', async () => {
      const enrollment = await settle('pg-a')
      await sql`insert into mission_reports (enrollment_id, player_id, mission_id, category, difficulty,
          outcome, finished_at, schema_version, snapshot, generated_at)
        values (${enrollment.enrollmentId}, 'pg-a', ${TEMPLO.missionId}, 'STORY', 'NORMAL', 'COMPLETED',
          ${CLOSED}, 2, ${JSON.stringify({ otraForma: true })}, ${CLOSED})`.execute(db)
      const query = new GetMissionAchievements(
        new StaticAchievementCatalog(EXAMPLE_ACHIEVEMENTS),
        achievements,
        evidence,
        clears,
        new PostgresMissionCatalog(db),
      )

      await expect(query.execute('pg-a')).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ achievementId: 'ach_sin_rasgunos', status: 'LOCKED' }),
        ]) as unknown,
      })
    })

    it('los Master derrotados en las matriculas COMPLETED o FAILED del jugador', async () => {
      const first = await settle('pg-a')
      const second = await settle('pg-a', 'FAILED')
      const started = await start('pg-a')
      const foreign = await settle('pg-b')
      await insertMasterEncounters(db, [
        defeated(second.enrollmentId, 2, 'centinela', 'GRANTED'),
        {
          enrollmentId: second.enrollmentId,
          sequence: 1,
          afterEncounter: 1,
          masterRef: 'fugaz',
          status: 'APPEARED_ESCAPED',
          epicRef: null,
          levelOffset: 2,
          turns: 3,
          grant: null,
        },
        defeated(first.enrollmentId, 1, 'sombra'),
        defeated(started.enrollmentId, 1, 'en-curso'),
        defeated(foreign.enrollmentId, 1, 'ajeno', 'GRANTED'),
      ])

      const found = await evidence.defeatedMastersOf('pg-a')

      expect(found).toHaveLength(2)
      expect(found).toEqual(
        expect.arrayContaining([
          {
            enrollmentId: first.enrollmentId,
            sequence: 1,
            masterRef: 'sombra',
            epicRef: 'epica-sombra',
            grantStatus: 'PENDING',
          },
          {
            enrollmentId: second.enrollmentId,
            sequence: 2,
            masterRef: 'centinela',
            epicRef: 'epica-centinela',
            grantStatus: 'GRANTED',
          },
        ]),
      )
    })
  })

  describe('la evaluacion contra el motor', () => {
    beforeEach(reset)

    const evaluator = () =>
      new EvaluateMissionAchievements(
        new StaticAchievementCatalog(EXAMPLE_ACHIEVEMENTS),
        achievements,
        evidence,
        clears,
        new PostgresMissionCatalog(db),
        new FixedClock(NOW),
      )

    it('dos evaluadores a la vez dejan una sola fila por logro (P-05)', async () => {
      await completed('pg-a')

      const [one, two] = await Promise.all([evaluator().run(), evaluator().run()])

      expect(one.achievementsUnlocked + two.achievementsUnlocked).toBe(1)
      await expect(count('mission_achievement_unlocks')).resolves.toBe(1)
      await expect(achievements.unlocksOf('pg-a')).resolves.toEqual([
        expect.objectContaining({
          achievementId: 'ach_sin_rasgunos',
          recognition: expect.objectContaining({ status: 'RECORDED' }) as unknown,
        }),
      ])
    })

    it('L-9: borrar los puntos de control y reevaluar no crea nada nuevo', async () => {
      await completed('pg-a')
      await expect(evaluator().run()).resolves.toMatchObject({ achievementsUnlocked: 1 })

      await sql`delete from mission_achievement_evaluations`.execute(db)
      await expect(evaluator().run()).resolves.toEqual({
        achievementPlayersEvaluated: 1,
        achievementsUnlocked: 0,
        achievementEvaluationsFailed: 0,
      })
      await expect(count('mission_achievement_unlocks')).resolves.toBe(1)
    })

    it('no marca los MissionSettled: processed_at sigue siendo solo de HU-72 (HU-10)', async () => {
      await completed('pg-a')
      await settle('pg-b', 'VOIDED')
      await evaluator().run()

      const { rows } = await sql<{
        pending: number
      }>`select count(*)::int as pending from mission_facts
        where type = 'MissionSettled' and processed_at is null`.execute(db)
      expect(rows).toEqual([{ pending: 2 }])
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: matricularse por
   * HTTP, correr el ciclo del planificador y leer los logros. Solo se sustituyen
   * el JWT, el reloj, la entrega en Player/Inventory y el catalogo de logros.
   */
  describe('de punta a punta por HTTP', () => {
    const ENV = {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'postgres',
      HERO_COMMITMENTS_DRIVER: 'memory',
      HERO_ABILITIES_DRIVER: 'memory',
      COMBAT_SIMULATION_DRIVER: 'memory',
      EPIC_GRANTS_DRIVER: 'memory',
      LOG_LEVEL: 'error',
    }
    const previousEnv: Record<string, string | undefined> = {}
    const identity: VerifiedIdentity = {
      subject: 'sujeto-pg-hu76',
      email: null,
      roles: new Set([Role.Player]),
    }
    const stubVerifier: TokenVerifierPort = {
      verify: (token: string): Promise<VerifiedIdentity> =>
        token === 'token-pg'
          ? Promise.resolve(identity)
          : Promise.reject(new TokenVerificationError()),
    }
    const clock = new FixedClock(AT)
    let app: INestApplication

    beforeAll(async () => {
      await reset()

      for (const key of [...Object.keys(ENV), 'DATABASE_URL']) {
        previousEnv[key] = process.env[key]
      }
      Object.assign(process.env, ENV, { DATABASE_URL: container.getConnectionUri() })

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TOKEN_VERIFIER)
        .useValue(stubVerifier)
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(EPIC_GRANTS)
        .useValue(new InMemoryEpicGrants())
        .overrideProvider(ACHIEVEMENT_CATALOG)
        .useValue(new StaticAchievementCatalog(EXAMPLE_ACHIEVEMENTS))
        .compile()
      app = moduleRef.createNestApplication()
      app.setGlobalPrefix('api')
      app.useGlobalPipes(createValidationPipe())
      await app.init()
    })

    afterAll(async () => {
      await app.close()
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key)
        } else {
          process.env[key] = value
        }
      }
    })

    it('el servicio corre con los adaptadores de PostgreSQL, no con los dobles', () => {
      expect(app.get(ACHIEVEMENT_REPOSITORY).constructor.name).toBe('PostgresAchievementRepository')
      expect(app.get(ACHIEVEMENT_EVIDENCE).constructor.name).toBe('PostgresAchievementEvidence')
    })

    it('CA-01: tras el ciclo, el logro queda en el motor y la consulta lo muestra', async () => {
      const enrolled = await request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO.missionId}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId: randomUUID(), difficulty: 'NORMAL', strategyVersion: null })
      expect(enrolled.status).toBe(201)
      const scheduler = app.get<MissionExecutionScheduler>(MISSION_EXECUTION_SCHEDULER)

      await scheduler.tick()
      clock.current = new Date((enrolled.body as { readonly endsAt: string }).endsAt)
      await scheduler.tick()
      await scheduler.tick()

      const { rows } = await sql<{ achievement_id: string; recognition_status: string }>`
        select achievement_id, recognition_status from mission_achievement_unlocks
        where player_id = 'sujeto-pg-hu76'`.execute(db)
      // El doble de Combat nunca recibe dano: comprueba el camino, no acredita CA-02.
      expect(rows).toEqual([{ achievement_id: 'ach_sin_rasgunos', recognition_status: 'RECORDED' }])

      const response = await request(app.getHttpServer())
        .get('/api/v1/missions/me/achievements')
        .set('Authorization', 'Bearer token-pg')
      expect(response.status).toBe(200)
      expect((response.body as { items: readonly unknown[] }).items[0]).toEqual({
        achievementId: 'ach_sin_rasgunos',
        name: 'Sin un rasguño',
        criterion: 'FLAWLESS_MISSION',
        status: 'UNLOCKED',
        progress: { current: 1, target: 1 },
        unlockedAt: clock.current.toISOString(),
        recognition: { kind: 'BADGE', name: 'Sin un rasguño', status: 'RECORDED' },
      })

      const { rows: facts } = await sql<{ processed: boolean }>`
        select processed_at is not null as processed from mission_facts
        where type = 'MissionSettled'`.execute(db)
      expect(facts).toEqual([{ processed: false }])
    })
  })
})
