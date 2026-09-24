import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresExecutionRepository } from '../../src/adapters/outbound/persistence/PostgresExecutionRepository'
import {
  insertReport,
  PostgresReportRepository,
} from '../../src/adapters/outbound/persistence/PostgresReportRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import type { MissionClosure } from '../../src/application/ports/ExecutionRepositoryPort'
import { REPORT_REPOSITORY } from '../../src/application/ports/ReportRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  RUN_MISSION_EXECUTIONS,
  simulationRequestFor,
  type RunMissionExecutions,
} from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  closeEnrollment,
  confirmEnrollment,
  enrollmentStartedFact,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import {
  queueExecution,
  recordSimulation,
  requestSimulation,
  settleExecution,
  type MissionExecution,
  type SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import type { ReportRecord, ReportRewardLine } from '../../src/domain/entities/MissionReport'
import { missionReportOf } from '../../src/domain/policies/ReportPolicy'
import {
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../src/domain/policies/SettlementPolicy'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-74.2). Lo que el doble en memoria no puede probar:
 * que la foto vuelve igual de `jsonb`, que nace en la transaccion del cierre y
 * se deshace con ella, que el motor impide modificarla (P-T2) y que la
 * migracion 005 impone sus reglas. Y el servicio completo con
 * `PERSISTENCE_DRIVER=postgres`.
 */
const [TEMPLO_DEF, CAMARA_DEF] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const TEMPLO = TEMPLO_DEF.missionId
const AT = new Date('2026-10-01T15:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')
const LATER = new Date('2026-10-02T04:00:00.000Z')
const PROFILE = { name: 'Kaelen', subtype: 'PICARO_VENENO' }

/** Resultado del fixture P-01 de HU-72, con los campos que presenta el reporte. */
const P01_RESULT: SimulationResult = {
  simulationId: 'sim_p01',
  seedRef: 'seed_p01',
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    damageDealt: 1830,
    damageTaken: 640,
    minHealthPercent: 41.5,
    criticalEffects: 9,
    bossDefeated: true,
    master: { appeared: false, masterRef: null, defeated: false },
    simulatedDuration: 'PT9H40M',
    skillsUsed: [{ abilityId: 'golpe-de-tormenta', count: 22 }],
    enemiesDefeated: [
      { enemyRef: 'sombra-corrompida', count: 10 },
      { enemyRef: 'guardian-eterno', count: 1 },
    ],
  },
  combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' }],
}

const line = (overrides: Partial<ReportRewardLine>): ReportRewardLine => ({
  lineNo: 1,
  kind: 'CREDITS',
  reference: null,
  name: 'Créditos',
  rarity: null,
  quantity: 50,
  status: 'PENDING',
  source: 'HU-10',
  updatedAt: CLOSED,
  ...overrides,
})

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}.`)
  }

  return value
}

/** El tiempo de la mision lo mueve la prueba: no se esperan 12 horas. */
class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
}

describe('Reportes de mision en PostgreSQL (HU-74)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let enrollments: PostgresEnrollmentRepository
  let executions: PostgresExecutionRepository
  let reports: PostgresReportRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO_DEF)
    await insertDefinition(db, CAMARA_DEF)
    enrollments = new PostgresEnrollmentRepository(db)
    executions = new PostgresExecutionRepository(db)
    reports = new PostgresReportRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  /** Una matricula en curso, de otro heroe y, salvo que se diga, de otro jugador. */
  const startEnrollment = async (
    playerId = `pg-${randomUUID()}`,
    definition: MissionDefinition = TEMPLO_DEF,
  ): Promise<MissionEnrollment> => {
    const pending = newPendingEnrollment({
      enrollmentId: `enr_hu74_${randomUUID()}`,
      playerId,
      missionId: definition.missionId,
      heroId: randomUUID(),
      difficulty: 'NORMAL',
      operationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    })
    const confirmed = confirmEnrollment(pending, 'cmt-1', AT, definition.estimatedDurationMinutes)
    await enrollments.insertPending(pending)
    await enrollments.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed))

    return confirmed
  }

  const recordFor = (
    enrollment: MissionEnrollment,
    definition: MissionDefinition = TEMPLO_DEF,
    rewards: readonly ReportRewardLine[] = [],
  ): ReportRecord => ({
    report: missionReportOf({
      enrollment,
      definition,
      result: P01_RESULT,
      settlement: settlementOf(
        'HERO_VICTORIOUS',
        definition.objectives,
        required(simulationFactsOf(P01_RESULT.summary), 'los hechos del resumen'),
      ),
      heroProfile: PROFILE,
      generatedAt: CLOSED,
    }),
    rewards,
  })

  /** Programada, pedida y simulada con el resultado de P-01, lista para cerrar. */
  const simulate = async (enrollment: MissionEnrollment): Promise<MissionExecution> => {
    const starts = await executions.pendingStarts(1_000)
    const start = starts.find((candidate) => candidate.enrollmentId === enrollment.enrollmentId)
    const queued = queueExecution({
      enrollmentId: enrollment.enrollmentId,
      operationId: `sim-${randomUUID()}`,
      endsAt: required(enrollment.endsAt, 'el fin'),
      now: AT,
    })
    await executions.queue(queued, required(start, 'el hecho de inicio').factId)
    const requested = requestSimulation(
      queued,
      simulationRequestFor(queued, enrollment, TEMPLO_DEF, PROFILE),
      AT,
    )
    const simulated = recordSimulation(requested, P01_RESULT, AT)
    await executions.saveTransition(requested, queued.version)
    await executions.saveTransition(simulated, requested.version)

    return simulated
  }

  const closureFor = (
    enrollment: MissionEnrollment,
    simulated: MissionExecution,
  ): MissionClosure => {
    const settlement = settlementOf(
      'HERO_VICTORIOUS',
      TEMPLO_DEF.objectives,
      required(simulationFactsOf(P01_RESULT.summary), 'los hechos del resumen'),
    )

    return {
      enrollment: closeEnrollment(enrollment, 'COMPLETED', CLOSED),
      enrollmentVersion: enrollment.version,
      execution: settleExecution(simulated, settlement, CLOSED),
      executionVersion: simulated.version,
      clear: {
        playerId: enrollment.playerId,
        missionId: TEMPLO,
        difficulty: 'NORMAL',
        completedAt: CLOSED,
      },
      fact: missionSettledFact(enrollment, settlement, P01_RESULT.simulationId, CLOSED),
      masters: [],
      experience: [],
      report: recordFor(enrollment),
    }
  }

  describe('PostgresReportRepository y el cierre', () => {
    it('el cierre escribe la foto en su transaccion y se relee igual (P-T1)', async () => {
      const enrollment = await startEnrollment()
      const closure = closureFor(enrollment, await simulate(enrollment))

      await expect(executions.close(closure)).resolves.toBe(true)
      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toEqual(
        closure.report,
      )
    })

    it('si otro proceso se adelanto, el cierre no deja reporte', async () => {
      const enrollment = await startEnrollment()
      const closure = closureFor(enrollment, await simulate(enrollment))

      await expect(executions.close({ ...closure, executionVersion: 99 })).resolves.toBe(false)
      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toBeNull()
    })

    it('la foto no se modifica: el motor rechaza cualquier UPDATE (P-T2)', async () => {
      const enrollment = await startEnrollment()
      await executions.close(closureFor(enrollment, await simulate(enrollment)))

      await expect(
        sql`update mission_reports set outcome = 'FAILED'
          where enrollment_id = ${enrollment.enrollmentId}`.execute(db),
      ).rejects.toThrow(/mission_reports_inmutable/)
      await expect(
        sql`update mission_reports set snapshot = '{}'::jsonb
          where enrollment_id = ${enrollment.enrollmentId}`.execute(db),
      ).rejects.toThrow(/mission_reports_inmutable/)
    })

    it('R-4: una linea pasa de PENDING a CREDITED y la foto no cambia (CU-74.4)', async () => {
      const enrollment = await startEnrollment()
      const record = recordFor(enrollment, TEMPLO_DEF, [
        line({}),
        line({
          lineNo: 2,
          kind: 'EPIC',
          reference: 'velo-de-sombras',
          name: 'Velo de Sombras',
          quantity: 1,
          source: 'HU-73',
        }),
      ])
      await insertReport(db, record)

      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toEqual(record)
      await expect(
        reports.updateRewardStatus(enrollment.enrollmentId, 1, 'CREDITED', LATER),
      ).resolves.toBe(true)
      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toEqual({
        report: record.report,
        rewards: [line({ status: 'CREDITED', updatedAt: LATER }), record.rewards[1]],
      })
      await expect(
        reports.updateRewardStatus(enrollment.enrollmentId, 9, 'CREDITED', LATER),
      ).resolves.toBe(false)
    })

    it('repetir la escritura no duplica la foto ni sus lineas', async () => {
      const enrollment = await startEnrollment()
      const record = recordFor(enrollment, TEMPLO_DEF, [line({})])

      await insertReport(db, record)
      await insertReport(db, record)

      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toEqual(record)
    })

    it('lista los del jugador, del mas reciente al mas antiguo, cada uno con sus lineas', async () => {
      const playerId = `pg-${randomUUID()}`
      const templo = recordFor(await startEnrollment(playerId), TEMPLO_DEF, [line({})])
      const camara = recordFor(await startEnrollment(playerId, CAMARA_DEF), CAMARA_DEF, [
        line({ quantity: 20 }),
        line({ lineNo: 2, kind: 'EXPERIENCE', name: 'Experiencia', quantity: 300 }),
      ])
      await insertReport(db, templo)
      await insertReport(db, camara)
      await insertReport(db, recordFor(await startEnrollment()))

      // La Camara dura 6 horas y el Templo 12: la Camara termino antes.
      await expect(reports.listByPlayer(playerId)).resolves.toEqual([templo, camara])
      await expect(reports.listByPlayer('pg-sin-reportes')).resolves.toEqual([])
    })
  })

  // Controles de motor: con SQL crudo, saltandose el repositorio.
  describe('restricciones de la migracion 005', () => {
    const insertRow = (table: string, row: Record<string, unknown>) => {
      const columns = Object.keys(row).map((column) => sql.ref(column))

      return sql`insert into ${sql.table(table)} (${sql.join(columns)})
        values (${sql.join(Object.values(row))})`.execute(db)
    }

    const reportRow = async (values: Record<string, unknown> = {}) => {
      const enrollment = await startEnrollment()

      return {
        enrollment_id: enrollment.enrollmentId,
        player_id: enrollment.playerId,
        mission_id: TEMPLO,
        category: 'STORY',
        difficulty: 'NORMAL',
        outcome: 'COMPLETED',
        finished_at: CLOSED,
        schema_version: 1,
        snapshot: '{}',
        generated_at: CLOSED,
        ...values,
      }
    }

    it('una fila coherente entra', async () => {
      await expect(insertRow('mission_reports', await reportRow())).resolves.toBeDefined()
    })

    it.each([
      [
        'un desenlace fuera del reporte',
        { outcome: 'VOIDED' },
        'mission_reports_desenlace_conocido',
      ],
      ['una categoria desconocida', { category: 'RAID' }, 'mission_reports_categoria_conocida'],
      ['un nivel desconocido', { difficulty: 'EXTREMO' }, 'mission_reports_nivel_conocido'],
      ['una version no positiva', { schema_version: 0 }, 'mission_reports_version_positiva'],
      ['una foto que no es un objeto', { snapshot: '[]' }, 'mission_reports_foto_es_objeto'],
    ])('el motor rechaza %s', async (_caso, values, constraint) => {
      await expect(insertRow('mission_reports', await reportRow(values))).rejects.toThrow(
        new RegExp(constraint),
      )
    })

    it('una foto de otra version no se lee a medias: falla con un mensaje claro', async () => {
      const row = await reportRow({ schema_version: 2 })
      await insertRow('mission_reports', row)

      await expect(reports.findByEnrollment(row.enrollment_id)).rejects.toThrow(
        /tiene la version 2; este servicio solo lee la 1/,
      )
    })

    it('el reporte es de una matricula real', async () => {
      await expect(
        insertRow('mission_reports', await reportRow({ enrollment_id: 'enr_inexistente' })),
      ).rejects.toThrow(/foreign key/)
    })

    const rewardRow = async (values: Record<string, unknown> = {}) => {
      const row = await reportRow()
      await insertRow('mission_reports', row)

      return {
        enrollment_id: row.enrollment_id,
        line_no: 1,
        kind: 'CREDITS',
        reference: null,
        name: 'Créditos',
        rarity: null,
        quantity: 50,
        status: 'PENDING',
        source: 'HU-10',
        updated_at: CLOSED,
        ...values,
      }
    }

    it.each([
      ['una linea no positiva', { line_no: 0 }, 'mission_report_rewards_linea_positiva'],
      ['un tipo desconocido', { kind: 'GEMS' }, 'mission_report_rewards_tipo_conocido'],
      ['una cantidad no positiva', { quantity: 0 }, 'mission_report_rewards_cantidad_positiva'],
      ['un estado desconocido', { status: 'LOST' }, 'mission_report_rewards_estado_conocido'],
      ['un origen desconocido', { source: 'HU-99' }, 'mission_report_rewards_origen_conocido'],
    ])('el motor rechaza en una linea %s', async (_caso, values, constraint) => {
      await expect(insertRow('mission_report_rewards', await rewardRow(values))).rejects.toThrow(
        new RegExp(constraint),
      )
    })

    it('una linea por numero y solo de un reporte que existe', async () => {
      const row = await rewardRow()
      await insertRow('mission_report_rewards', row)

      await expect(insertRow('mission_report_rewards', row)).rejects.toThrow(/duplicate key/)
      await expect(
        insertRow('mission_report_rewards', { ...row, enrollment_id: 'enr_inexistente' }),
      ).rejects.toThrow(/foreign key/)
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: matricularse por
   * HTTP, correr el planificador, y leer el reporte, el historial y su resumen.
   * Solo se sustituyen el JWT de Cognito y el reloj.
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
      LOG_LEVEL: 'error',
    }
    const previousEnv: Record<string, string | undefined> = {}
    const identity: VerifiedIdentity = {
      subject: 'sujeto-pg-hu74',
      email: null,
      roles: new Set([Role.Player]),
    }
    const stubVerifier: TokenVerifierPort = {
      verify: (token: string): Promise<VerifiedIdentity> =>
        token === 'token-pg'
          ? Promise.resolve(identity)
          : Promise.reject(new TokenVerificationError()),
    }
    const clock = new MovableClock()
    const hero = randomUUID()
    let app: INestApplication

    beforeAll(async () => {
      // El ciclo recorre toda la tabla: se empieza sin lo que dejaron las pruebas
      // anteriores. PostgreSQL exige truncar a la vez todo lo que referencia a las
      // matriculas, tambien la evidencia del Master de HU-73.
      await sql`truncate mission_master_encounters, mission_report_rewards, mission_reports,
        mission_executions, mission_facts, mission_enrollments, mission_difficulty_clears`.execute(
        db,
      )

      for (const key of [...Object.keys(ENV), 'DATABASE_URL']) {
        previousEnv[key] = process.env[key]
      }
      Object.assign(process.env, ENV, { DATABASE_URL: container.getConnectionUri() })

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TOKEN_VERIFIER)
        .useValue(stubVerifier)
        .overrideProvider(CLOCK)
        .useValue(clock)
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

    const get = (path: string) =>
      request(app.getHttpServer()).get(path).set('Authorization', 'Bearer token-pg')

    it('el servicio corre con el repositorio de PostgreSQL, no con el doble', () => {
      expect(app.get(REPORT_REPOSITORY).constructor.name).toBe('PostgresReportRepository')
    })

    it('R-5 y R-1: en curso no hay reporte; al cerrar, el motor lo guarda y el jugador lo lee', async () => {
      const enrolled = await request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId: hero, difficulty: 'NORMAL', strategyVersion: null })
      expect(enrolled.status).toBe(201)
      const enrollmentId = String(enrolled.body.enrollmentId)
      const endsAt = String(enrolled.body.endsAt)
      const executor = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)

      await executor.run()
      await expect(get(`/api/v1/missions/me/reports/${enrollmentId}`)).resolves.toMatchObject({
        status: 404,
        body: { code: 'REPORT_NOT_AVAILABLE', enrollmentId, endsAt },
      })

      clock.current = new Date(endsAt)
      await executor.run()

      const report = await get(`/api/v1/missions/me/reports/${enrollmentId}`)
      expect(report.status).toBe(200)
      expect(report.body).toMatchObject({
        enrollmentId,
        summary: { outcome: 'COMPLETED', finishedAt: endsAt, simulatedDuration: 'PT12H' },
        enemies: { boss: { defeated: true } },
        rewards: [],
      })

      const history = await get('/api/v1/missions/me/history')
      expect(history.body).toMatchObject({
        items: [{ enrollmentId, outcome: 'COMPLETED', reportAvailable: true }],
        nextCursor: null,
      })
      const summary = await get('/api/v1/missions/me/history/summary')
      expect(summary.body).toMatchObject({
        byCategory: [{ category: 'STORY', completed: 1 }, {}, {}],
        bestTimes: [{ missionId: TEMPLO, simulatedDuration: 'PT12H', enrollmentId }],
        narrativeProgress: [{ chainId: TEMPLO, completed: 1, total: 2 }],
      })

      const { rows } = await sql<{ outcome: string; schema_version: number; kind: string }>`
        select outcome, schema_version, jsonb_typeof(snapshot) as kind
        from mission_reports where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(rows).toEqual([{ outcome: 'COMPLETED', schema_version: 1, kind: 'object' }])
    })
  })
})
