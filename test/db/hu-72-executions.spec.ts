import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresDifficultyClearRepository } from '../../src/adapters/outbound/persistence/PostgresDifficultyClearRepository'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresExecutionRepository } from '../../src/adapters/outbound/persistence/PostgresExecutionRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import {
  EXECUTION_REPOSITORY,
  type MissionClosure,
} from '../../src/application/ports/ExecutionRepositoryPort'
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
  type ExecutionCycleSummary,
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
  markHeroReleased,
  queueExecution,
  recordSimulation,
  requestSimulation,
  settleExecution,
  voidedSettlement,
  voidExecution,
  type MissionExecution,
  type SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import {
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../src/domain/policies/SettlementPolicy'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-72.2). Lo que el doble en memoria no puede probar:
 * que el cierre escribe matricula, ejecucion, clear y hecho en UNA transaccion
 * y deshace todo si otro proceso se adelanto; que dos planificadores a la vez no
 * duplican un hecho ni un clear (T-03); que la solicitud y el resultado vuelven
 * iguales de `jsonb`, y que la migracion 004 impone sus reglas en el motor.
 */
const [TEMPLO_DEF] = EXAMPLE_MISSIONS as [MissionDefinition]
const TEMPLO = TEMPLO_DEF.missionId
const AT = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')
const DEADLINE = new Date(ENDS.getTime() + 30 * 60_000)
const PROFILE = { subtype: 'GUERRERO_ARMAS', level: 12 }

/** Resultado del fixture P-01 del contrato de HU-72. */
const P01_RESULT: SimulationResult = {
  simulationId: 'sim_p01',
  seedRef: 'seed_p01',
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    minHealthPercent: 41.5,
    bossDefeated: true,
    master: { appeared: false, masterRef: null, defeated: false },
  },
  combatLog: [{ seq: 1, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS' }],
}

/** El tiempo de la mision lo mueve la prueba: no se esperan 12 horas. */
class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
}

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}.`)
  }

  return value
}

const cycle = (counts: Partial<ExecutionCycleSummary>): ExecutionCycleSummary => ({
  queued: 0,
  simulated: 0,
  retried: 0,
  settled: 0,
  voided: 0,
  released: 0,
  failed: 0,
  ...counts,
})

describe('Ejecuciones de mision en PostgreSQL (HU-72)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let enrollments: PostgresEnrollmentRepository
  let executions: PostgresExecutionRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO_DEF)
    enrollments = new PostgresEnrollmentRepository(db)
    executions = new PostgresExecutionRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  /** Una matricula en curso de otro jugador y otro heroe, con su hecho sin procesar. */
  const startEnrollment = async (): Promise<MissionEnrollment> => {
    const pending = newPendingEnrollment({
      enrollmentId: `enr_hu72_${randomUUID()}`,
      playerId: `pg-${randomUUID()}`,
      missionId: TEMPLO,
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
    await enrollments.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed))

    return confirmed
  }

  const queuedFor = (enrollment: MissionEnrollment): MissionExecution =>
    queueExecution({
      enrollmentId: enrollment.enrollmentId,
      operationId: `sim-${randomUUID()}`,
      endsAt: required(enrollment.endsAt, 'el fin'),
      now: AT,
    })

  const queue = async (enrollment: MissionEnrollment): Promise<MissionExecution> => {
    const starts = await executions.pendingStarts(1_000)
    const start = starts.find((candidate) => candidate.enrollmentId === enrollment.enrollmentId)
    const queued = queuedFor(enrollment)
    await executions.queue(queued, required(start, 'el hecho de inicio').factId)

    return queued
  }

  const requestedFrom = (queued: MissionExecution, enrollment: MissionEnrollment) =>
    requestSimulation(queued, simulationRequestFor(queued, enrollment, TEMPLO_DEF, PROFILE), AT)

  /** Programada, pedida y simulada con el resultado de P-01. */
  const simulate = async (enrollment: MissionEnrollment): Promise<MissionExecution> => {
    const queued = await queue(enrollment)
    const requested = requestedFrom(queued, enrollment)
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
      enrollment: closeEnrollment(enrollment, 'COMPLETED', ENDS),
      enrollmentVersion: enrollment.version,
      execution: settleExecution(simulated, settlement, ENDS),
      executionVersion: simulated.version,
      clear: {
        playerId: enrollment.playerId,
        missionId: TEMPLO,
        difficulty: 'NORMAL',
        completedAt: ENDS,
      },
      fact: missionSettledFact(enrollment, settlement, P01_RESULT.simulationId, ENDS),
      masters: [],
      experience: [],
      report: null,
    }
  }

  const settledFacts = async (enrollmentId: string): Promise<number> => {
    const { rows } = await sql<{ total: number }>`
      select count(*)::int as total from mission_facts
      where type = 'MissionSettled' and enrollment_id = ${enrollmentId}
    `.execute(db)

    return rows[0]?.total ?? 0
  }

  const clearsOf = async (playerId: string): Promise<number> => {
    const { rows } = await sql<{ total: number }>`
      select count(*)::int as total from mission_difficulty_clears where player_id = ${playerId}
    `.execute(db)

    return rows[0]?.total ?? 0
  }

  const ids = (list: readonly MissionExecution[]) => list.map((execution) => execution.enrollmentId)

  describe('PostgresExecutionRepository', () => {
    it('programa una sola ejecucion por hecho y marca el hecho como procesado', async () => {
      const enrollment = await startEnrollment()
      const [start] = (await executions.pendingStarts(1_000)).filter(
        (candidate) => candidate.enrollmentId === enrollment.enrollmentId,
      )
      const first = queuedFor(enrollment)

      await executions.queue(first, required(start, 'el hecho').factId)
      await executions.queue(queuedFor(enrollment), required(start, 'el hecho').factId)

      await expect(executions.findById(enrollment.enrollmentId)).resolves.toEqual(first)
      expect(
        (await executions.pendingStarts(1_000)).map((candidate) => candidate.enrollmentId),
      ).not.toContain(enrollment.enrollmentId)
    })

    it('la solicitud congelada y el resultado vuelven iguales de jsonb', async () => {
      const enrollment = await startEnrollment()
      const queued = await queue(enrollment)
      const requested = requestedFrom(queued, enrollment)

      await expect(executions.saveTransition(requested, 0)).resolves.toBe(true)
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toEqual(requested)

      const simulated = recordSimulation(requested, P01_RESULT, AT)
      await expect(executions.saveTransition(simulated, 1)).resolves.toBe(true)
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toEqual(simulated)
    })

    it('T-02: dos transiciones simultaneas sobre la misma version dejan una sola', async () => {
      const enrollment = await startEnrollment()
      const queued = await queue(enrollment)

      const results = await Promise.all([
        executions.saveTransition(requestedFrom(queued, enrollment), 0),
        executions.saveTransition(requestedFrom(queued, enrollment), 0),
      ])

      expect(results.filter(Boolean)).toHaveLength(1)
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'REQUESTED',
        attempts: 1,
        version: 1,
      })
    })

    it('due, closable y awaitingRelease encuentran lo que toca', async () => {
      const enrollment = await startEnrollment()
      await queue(enrollment)
      const id = enrollment.enrollmentId

      expect(ids(await executions.due(new Date(AT.getTime() - 1), 1_000))).not.toContain(id)
      expect(ids(await executions.due(AT, 1_000))).toContain(id)

      const other = await startEnrollment()
      const simulated = await simulate(other)
      expect(ids(await executions.due(DEADLINE, 1_000))).not.toContain(other.enrollmentId)
      expect(ids(await executions.closable(new Date(ENDS.getTime() - 1), 1_000))).not.toContain(
        other.enrollmentId,
      )
      expect(ids(await executions.closable(ENDS, 1_000))).toContain(other.enrollmentId)

      await executions.close(closureFor(other, simulated))
      const closed = required(await executions.findById(other.enrollmentId), 'la ejecucion')
      expect(ids(await executions.awaitingRelease(1_000))).toContain(other.enrollmentId)

      await expect(
        executions.saveTransition(markHeroReleased(closed, ENDS), closed.version),
      ).resolves.toBe(true)
      expect(ids(await executions.awaitingRelease(1_000))).not.toContain(other.enrollmentId)
    })

    it('cierra en una transaccion: matricula, ejecucion, clear y hecho (CU-72.2)', async () => {
      const enrollment = await startEnrollment()
      const simulated = await simulate(enrollment)
      const closure = closureFor(enrollment, simulated)

      await expect(executions.close(closure)).resolves.toBe(true)

      await expect(enrollments.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'COMPLETED',
        finishedAt: ENDS,
        version: 2,
      })
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toEqual(closure.execution)
      await expect(
        new PostgresDifficultyClearRepository(db).clearedLevels(enrollment.playerId, TEMPLO),
      ).resolves.toEqual(new Set(['NORMAL']))
      const { rows } = await sql<{ payload: Record<string, unknown> }>`
        select payload from mission_facts
        where type = 'MissionSettled' and enrollment_id = ${enrollment.enrollmentId}
      `.execute(db)
      expect(rows).toEqual([{ payload: JSON.parse(JSON.stringify(closure.fact.payload)) }])
    })

    it('si la ejecucion cambio, el cierre deshace tambien la matricula', async () => {
      const enrollment = await startEnrollment()
      const simulated = await simulate(enrollment)
      const closure = closureFor(enrollment, simulated)

      // La matricula se actualiza primero; la ejecucion con otra version aborta todo.
      await expect(executions.close({ ...closure, executionVersion: 99 })).resolves.toBe(false)

      await expect(enrollments.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'IN_PROGRESS',
        finishedAt: null,
        version: 1,
      })
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'SIMULATED',
      })
      await expect(settledFacts(enrollment.enrollmentId)).resolves.toBe(0)
      await expect(clearsOf(enrollment.playerId)).resolves.toBe(0)
    })

    it('T-03: dos cierres simultaneos dejan un solo hecho y un solo clear', async () => {
      const enrollment = await startEnrollment()
      const closure = closureFor(enrollment, await simulate(enrollment))

      const results = await Promise.all([executions.close(closure), executions.close(closure)])

      expect(results.filter(Boolean)).toHaveLength(1)
      await expect(settledFacts(enrollment.enrollmentId)).resolves.toBe(1)
      await expect(clearsOf(enrollment.playerId)).resolves.toBe(1)
    })

    it('anula una mision: VOIDED se guarda en la matricula, sin clear (P-S7)', async () => {
      const enrollment = await startEnrollment()
      const queued = await queue(enrollment)

      await expect(
        executions.close({
          enrollment: closeEnrollment(enrollment, 'VOIDED', AT),
          enrollmentVersion: enrollment.version,
          execution: voidExecution(queued, 'INVALID_STRATEGY', AT),
          executionVersion: queued.version,
          clear: null,
          fact: missionSettledFact(enrollment, voidedSettlement('INVALID_STRATEGY'), null, AT),
          masters: [],
          experience: [],
          report: null,
        }),
      ).resolves.toBe(true)

      await expect(enrollments.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'VOIDED',
      })
      await expect(executions.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'VOIDED',
        settlement: { outcome: 'VOIDED', reason: 'INVALID_STRATEGY', objectives: [] },
      })
      await expect(settledFacts(enrollment.enrollmentId)).resolves.toBe(1)
      await expect(clearsOf(enrollment.playerId)).resolves.toBe(0)
    })

    it('anula una ejecucion ya simulada y conserva su resultado para auditoria', async () => {
      const enrollment = await startEnrollment()
      const simulated = await simulate(enrollment)
      const voided = voidExecution(simulated, 'MISSION_NOT_FOUND', ENDS)

      await expect(
        executions.close({
          enrollment: closeEnrollment(enrollment, 'VOIDED', ENDS),
          enrollmentVersion: enrollment.version,
          execution: voided,
          executionVersion: simulated.version,
          clear: null,
          fact: missionSettledFact(
            enrollment,
            voidedSettlement('MISSION_NOT_FOUND'),
            P01_RESULT.simulationId,
            ENDS,
          ),
          masters: [],
          experience: [],
          report: null,
        }),
      ).resolves.toBe(true)

      await expect(executions.findById(enrollment.enrollmentId)).resolves.toEqual(voided)
      await expect(clearsOf(enrollment.playerId)).resolves.toBe(0)
    })
  })

  // Controles de motor: con SQL crudo, saltandose el repositorio.
  describe('restricciones de la migracion 004', () => {
    const insertRaw = async (values: Record<string, unknown>) => {
      const enrollment = await startEnrollment()
      const row: Record<string, unknown> = {
        enrollment_id: enrollment.enrollmentId,
        operation_id: `sim-${randomUUID()}`,
        status: 'QUEUED',
        deadline_at: DEADLINE,
        ...values,
      }
      const columns = Object.keys(row).map((column) => sql.ref(column))

      return sql`insert into mission_executions (${sql.join(columns)})
        values (${sql.join(Object.values(row))})`.execute(db)
    }

    const SEALED = {
      request: '{}',
      simulation_id: 'sim_x',
      combat_outcome: 'HERO_VICTORIOUS',
      summary: '{}',
      combat_log: '[]',
      simulated_at: AT,
    }

    it('una fila coherente entra', async () => {
      await expect(insertRaw({})).resolves.toBeDefined()
    })

    it.each([
      ['un estado desconocido', { status: 'PERDIDA' }, 'mission_executions_estado_conocido'],
      [
        'un resultado de Combat desconocido',
        { combat_outcome: 'DRAW' },
        'mission_executions_resultado_conocido',
      ],
      ['un desenlace desconocido', { outcome: 'LOST' }, 'mission_executions_desenlace_conocido'],
      ['una solicitud sin cuerpo', { status: 'REQUESTED' }, 'mission_executions_solicitud_enviada'],
      [
        'un resultado sin resumen',
        { ...SEALED, status: 'SIMULATED', summary: null },
        'mission_executions_resultado_sellado',
      ],
      [
        'un cierre sin desenlace',
        { ...SEALED, status: 'SETTLED', settled_at: ENDS },
        'mission_executions_cierre_completo',
      ],
      [
        'una anulacion sin fecha',
        { status: 'VOIDED', outcome: 'VOIDED' },
        'mission_executions_cierre_completo',
      ],
      [
        'un heroe liberado sin cierre',
        { hero_released_at: ENDS },
        'mission_executions_liberacion_tras_cierre',
      ],
    ])('el motor rechaza %s', async (_caso, values, constraint) => {
      await expect(insertRaw(values)).rejects.toThrow(new RegExp(constraint))
    })

    it('una ejecucion por matricula, con un operationId propio y de una matricula real', async () => {
      const enrollment = await startEnrollment()
      const operationId = `sim-${randomUUID()}`
      const insert = (enrollmentId: string, operation: string) => sql`
        insert into mission_executions (enrollment_id, operation_id, status, deadline_at)
        values (${enrollmentId}, ${operation}, 'QUEUED', ${DEADLINE})
      `

      await insert(enrollment.enrollmentId, operationId).execute(db)
      await expect(
        insert(enrollment.enrollmentId, `sim-${randomUUID()}`).execute(db),
      ).rejects.toThrow(/duplicate key/)
      await expect(
        insert((await startEnrollment()).enrollmentId, operationId).execute(db),
      ).rejects.toThrow(/duplicate key/)
      await expect(insert('enr_inexistente', `sim-${randomUUID()}`).execute(db)).rejects.toThrow(
        /foreign key/,
      )
    })

    it('la matricula admite VOIDED y sigue rechazando un estado desconocido', async () => {
      const voided = await startEnrollment()
      const unknown = await startEnrollment()

      await expect(
        sql`update mission_enrollments set status = 'VOIDED', finished_at = now()
          where enrollment_id = ${voided.enrollmentId}`.execute(db),
      ).resolves.toBeDefined()
      await expect(
        sql`update mission_enrollments set status = 'CANCELLED'
          where enrollment_id = ${unknown.enrollmentId}`.execute(db),
      ).rejects.toThrow(/mission_enrollments_estado_conocido/)
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: matricularse por
   * HTTP, correr el ciclo del planificador y ver el cierre en el tablero y en el
   * motor. Solo se sustituyen el JWT de Cognito y el reloj.
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
      subject: 'sujeto-pg-hu72',
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
    const HERO_PG = randomUUID()
    let app: INestApplication

    beforeAll(async () => {
      // El ciclo recorre toda la tabla: se empieza sin lo que dejaron las pruebas
      // anteriores. PostgreSQL exige truncar a la vez todo lo que referencia a las
      // matriculas, tambien los reportes de HU-74 y la evidencia del Master de HU-73.
      await sql`truncate mission_experience_rewards, mission_master_encounters, mission_report_rewards, mission_reports,
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

    const enroll = (difficulty: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId: HERO_PG, difficulty, strategyVersion: null })

    const get = (path: string) =>
      request(app.getHttpServer()).get(path).set('Authorization', 'Bearer token-pg')

    it('el servicio corre con el repositorio de PostgreSQL, no con el doble', () => {
      expect(app.get(EXECUTION_REPOSITORY).constructor.name).toBe('PostgresExecutionRepository')
    })

    it('P-01: matricula, simula, cierra y libera; el motor guarda la ejecucion y el hecho', async () => {
      const enrolled = await enroll('NORMAL')
      expect(enrolled.status).toBe(201)
      const enrollmentId = String(enrolled.body.enrollmentId)
      const executor = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)

      await expect(executor.run()).resolves.toEqual(cycle({ queued: 1, simulated: 1 }))
      expect((await get('/api/v1/missions')).body.items).toContainEqual(
        expect.objectContaining({ missionId: TEMPLO, playerStatus: 'IN_PROGRESS' }),
      )

      clock.current = new Date(String(enrolled.body.endsAt))
      await expect(executor.run()).resolves.toEqual(cycle({ settled: 1, released: 1 }))

      expect((await get('/api/v1/missions')).body.items).toContainEqual(
        expect.objectContaining({ missionId: TEMPLO, playerStatus: 'COMPLETED', canEnroll: true }),
      )
      const levels = (await get(`/api/v1/missions/${TEMPLO}/difficulties`)).body.items as {
        difficulty: string
        unlocked: boolean
      }[]
      expect(levels.filter((level) => level.unlocked).map((level) => level.difficulty)).toEqual([
        'NORMAL',
        'HEROIC',
      ])

      const { rows: execution } = await sql<{
        status: string
        outcome: string
        released: boolean
      }>`
        select status, outcome, hero_released_at is not null as released
        from mission_executions where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(execution).toEqual([{ status: 'SETTLED', outcome: 'COMPLETED', released: true }])
      const { rows: facts } = await sql<{ type: string; processed: boolean }>`
        select type, processed_at is not null as processed
        from mission_facts where enrollment_id = ${enrollmentId} order by fact_id
      `.execute(db)
      expect(facts).toEqual([
        { type: 'MissionEnrollmentStarted', processed: true },
        { type: 'MissionSettled', processed: false },
      ])

      // El compromiso se libero: el mismo heroe vuelve a entrar, ahora en Heroico.
      expect((await enroll('HEROIC')).status).toBe(201)
    })
  })
})
