import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresExecutionRepository } from '../../src/adapters/outbound/persistence/PostgresExecutionRepository'
import { PostgresMissionCatalog } from '../../src/adapters/outbound/persistence/PostgresMissionCatalog'
import {
  insertMasterEncounters,
  PostgresMasterEncounterRepository,
} from '../../src/adapters/outbound/persistence/PostgresMasterEncounterRepository'
import { PostgresReportRepository } from '../../src/adapters/outbound/persistence/PostgresReportRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { EPIC_GRANTS } from '../../src/application/ports/EpicGrantPort'
import type { MissionClosure } from '../../src/application/ports/ExecutionRepositoryPort'
import { MASTER_ENCOUNTER_REPOSITORY } from '../../src/application/ports/MasterEncounterRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { simulationRequestFor } from '../../src/application/use-cases/RunMissionExecutions'
import {
  grantConfirmed,
  grantDeferred,
  grantRejected,
  type MasterEncounterRecord,
} from '../../src/domain/entities/MasterEncounterRecord'
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
import { epicRewardsOf, masterEncounterRecordsOf } from '../../src/domain/policies/MasterPolicy'
import { missionReportOf } from '../../src/domain/policies/ReportPolicy'
import {
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../src/domain/policies/SettlementPolicy'
import {
  AppModule,
  MISSION_EXECUTION_SCHEDULER,
} from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-73.2). Lo que el doble en memoria no puede probar:
 * que la evidencia del Master nace en la transaccion del cierre y se deshace con
 * ella, que la entrega y la linea `EPIC` del reporte cambian juntas, que la
 * migracion 006 impone sus reglas en el motor y el servicio completo con
 * `PERSISTENCE_DRIVER=postgres`.
 */
const [TEMPLO, CAMARA] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const MASTER = 'sombra-del-olvido'
const EPIC = 'velo-de-sombras'
const PRODUCT = '11111111-1111-4111-8111-111111111111'
const AT = new Date('2026-10-01T15:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')
const LATER = new Date('2026-10-02T04:00:00.000Z')
const PROFILE = { name: 'Kaelen', subtype: 'PICARO_VENENO' }

const required = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Falta ${what}.`)
  }

  return value
}

const CANDIDATE = required(TEMPLO.masterEncounter?.candidates[0], 'el Master del Templo')

/** El Templo con un Master que siempre aparece y una epica que ya es producto. */
const TEMPLO_CON_MASTER: MissionDefinition = {
  ...TEMPLO,
  masterEncounter: {
    evaluationPoints: [{ afterEncounter: 3 }],
    maxAppearances: 1,
    candidates: [
      {
        ...CANDIDATE,
        probabilityByHeroType: { '*': 1 },
        epic: { ...CANDIDATE.epic, productId: PRODUCT },
      },
    ],
  },
}

/** M-3: el Master aparece tras el tercer encuentro y el heroe lo derrota. */
const M3_RESULT: SimulationResult = {
  simulationId: 'sim_m3',
  seedRef: null,
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    minHealthPercent: 41.5,
    bossDefeated: true,
    simulatedDuration: 'PT9H40M',
    master: {
      appeared: true,
      masterRef: MASTER,
      defeated: true,
      evaluations: [{ afterEncounter: 3, masterRef: MASTER, appeared: true }],
      encounters: [
        { masterRef: MASTER, afterEncounter: 3, levelOffset: 2, outcome: 'DEFEATED', turns: 14 },
      ],
    },
  },
  combatLog: [],
}

class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
}

describe('Evidencia del Master en PostgreSQL (HU-73)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let enrollments: PostgresEnrollmentRepository
  let executions: PostgresExecutionRepository
  let reports: PostgresReportRepository
  let masters: PostgresMasterEncounterRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO_CON_MASTER)
    await insertDefinition(db, CAMARA)
    enrollments = new PostgresEnrollmentRepository(db)
    executions = new PostgresExecutionRepository(db)
    reports = new PostgresReportRepository(db)
    masters = new PostgresMasterEncounterRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const startEnrollment = async (): Promise<MissionEnrollment> => {
    const pending = newPendingEnrollment({
      enrollmentId: `enr_hu73_${randomUUID()}`,
      playerId: `pg-${randomUUID()}`,
      missionId: TEMPLO.missionId,
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
    await enrollments.saveTransition(confirmed, 0, enrollmentStartedFact(confirmed))

    return confirmed
  }

  /** Programada, pedida con el bloque master y simulada con M-3, lista para cerrar. */
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
      simulationRequestFor(queued, enrollment, TEMPLO_CON_MASTER, PROFILE),
      AT,
    )
    const simulated = recordSimulation(requested, M3_RESULT, AT)
    await executions.saveTransition(requested, queued.version)
    await executions.saveTransition(simulated, requested.version)

    return simulated
  }

  const closureFor = (
    enrollment: MissionEnrollment,
    simulated: MissionExecution,
    enrollmentVersion = enrollment.version,
  ): MissionClosure => {
    const facts = required(simulationFactsOf(M3_RESULT.summary), 'los hechos del resumen')
    const settlement = settlementOf('HERO_VICTORIOUS', TEMPLO.objectives, facts)
    const evidence = required(
      masterEncounterRecordsOf({
        enrollmentId: enrollment.enrollmentId,
        config: TEMPLO_CON_MASTER.masterEncounter,
        sent: simulated.request?.master ?? null,
        summary: M3_RESULT.summary,
        facts,
      }),
      'la evidencia del Master',
    )
    const epics = epicRewardsOf(evidence, TEMPLO_CON_MASTER.masterEncounter, CLOSED)

    return {
      enrollment: closeEnrollment(enrollment, 'COMPLETED', CLOSED),
      enrollmentVersion,
      execution: settleExecution(simulated, settlement, CLOSED),
      executionVersion: simulated.version,
      clear: null,
      fact: missionSettledFact(
        enrollment,
        settlement,
        M3_RESULT.simulationId,
        CLOSED,
        epics.records,
      ),
      masters: epics.records,
      experience: [],
      report: {
        report: missionReportOf({
          enrollment,
          definition: TEMPLO_CON_MASTER,
          result: M3_RESULT,
          settlement,
          heroProfile: PROFILE,
          masters: epics.records,
          generatedAt: CLOSED,
        }),
        rewards: epics.rewards,
      },
    }
  }

  /** La entrega como queda al pedirla: con el producto congelado. */
  const withProduct = (record: MasterEncounterRecord): MasterEncounterRecord => ({
    ...record,
    grant: record.grant === null ? null : { ...record.grant, productId: PRODUCT },
  })

  /** Una mision del Templo cerrada con M-3: su fila del Master, con la entrega pendiente. */
  const closed = async (): Promise<MasterEncounterRecord> => {
    const enrollment = await startEnrollment()
    const closure = closureFor(enrollment, await simulate(enrollment))
    await expect(executions.close(closure)).resolves.toBe(true)

    return required(closure.masters[0], 'la fila del Master')
  }

  describe('PostgresMasterEncounterRepository y el cierre', () => {
    it('el cierre escribe la evidencia en su transaccion y se relee igual (P-X7)', async () => {
      const enrollment = await startEnrollment()
      const closure = closureFor(enrollment, await simulate(enrollment))

      expect(closure.masters).toEqual([
        expect.objectContaining({
          status: 'APPEARED_DEFEATED',
          masterRef: MASTER,
          epicRef: EPIC,
          grant: expect.objectContaining({ status: 'PENDING', rewardLineNo: 1 }) as unknown,
        }),
      ])
      await expect(executions.close(closure)).resolves.toBe(true)
      await expect(masters.listByEnrollment(enrollment.enrollmentId)).resolves.toEqual(
        closure.masters,
      )
      await expect(reports.findByEnrollment(enrollment.enrollmentId)).resolves.toMatchObject({
        report: { enemies: { masters: [{ masterRef: MASTER, status: 'APPEARED_DEFEATED' }] } },
        rewards: [{ lineNo: 1, kind: 'EPIC', reference: EPIC, status: 'PENDING', source: 'HU-73' }],
      })
    })

    it('si otro proceso se adelanto, el cierre no deja evidencia', async () => {
      const enrollment = await startEnrollment()
      const closure = closureFor(enrollment, await simulate(enrollment), enrollment.version + 7)

      await expect(executions.close(closure)).resolves.toBe(false)
      await expect(masters.listByEnrollment(enrollment.enrollmentId)).resolves.toEqual([])
    })

    it('repetir la escritura no duplica ni cambia la evidencia', async () => {
      const record = await closed()

      await insertMasterEncounters(db, [
        { ...record, status: 'APPEARED_ESCAPED', epicRef: null, grant: null },
      ])

      await expect(masters.listByEnrollment(record.enrollmentId)).resolves.toEqual([record])
    })

    it('un contenido sin la clave masterEncounter se lee como mision sin Master', async () => {
      // JSON.stringify omite la clave: el jsonb queda sin ella.
      await insertDefinition(db, {
        ...CAMARA,
        missionId: 'msn_sin_clave_master',
        masterEncounter: undefined as never,
      })

      await expect(
        new PostgresMissionCatalog(db).findById('msn_sin_clave_master'),
      ).resolves.toMatchObject({ masterEncounter: null })
    })

    it('CA-01: entregada, la fila y la linea EPIC del reporte cambian a la vez', async () => {
      const record = await closed()
      const granted = grantConfirmed(withProduct(record), LATER)

      await expect(masters.saveGrant(granted, 0, LATER)).resolves.toBe(true)
      await expect(masters.listByEnrollment(record.enrollmentId)).resolves.toEqual([granted])
      await expect(reports.findByEnrollment(record.enrollmentId)).resolves.toMatchObject({
        rewards: [{ status: 'CREDITED', updatedAt: LATER }],
      })
      // Otro proceso ya la entrego: no se escribe dos veces.
      await expect(masters.saveGrant(granted, 0, LATER)).resolves.toBe(false)
    })

    it('el producto se congela antes del envio, una sola vez, y ningun guardado lo borra', async () => {
      const record = await closed()

      await expect(masters.freezeProduct(withProduct(record), 3)).resolves.toBe(false)
      await expect(masters.freezeProduct(withProduct(record), 0)).resolves.toBe(true)
      await expect(
        masters.freezeProduct(
          {
            ...record,
            grant: record.grant === null ? null : { ...record.grant, productId: 'otro' },
          },
          0,
        ),
      ).resolves.toBe(false)

      // El aplazamiento se guarda con el registro leido antes, sin producto.
      await masters.saveGrant(grantDeferred(record, 'INTERNAL_ERROR', LATER), 0, LATER)
      await expect(masters.listByEnrollment(record.enrollmentId)).resolves.toMatchObject([
        { grant: { status: 'PENDING', attempts: 1, productId: PRODUCT } },
      ])
    })

    it('rechazada, la linea queda FAILED; aplazada, la linea no cambia', async () => {
      const rejected = await closed()
      await masters.saveGrant(grantRejected(rejected, 'INVENTORY_REJECTED'), 0, LATER)
      await expect(reports.findByEnrollment(rejected.enrollmentId)).resolves.toMatchObject({
        rewards: [{ status: 'FAILED' }],
      })

      const deferred = await closed()
      await masters.saveGrant(grantDeferred(withProduct(deferred), 'HTTP_503', LATER), 0, LATER)
      await expect(reports.findByEnrollment(deferred.enrollmentId)).resolves.toMatchObject({
        rewards: [{ status: 'PENDING' }],
      })
      await expect(masters.listByEnrollment(deferred.enrollmentId)).resolves.toMatchObject([
        // El producto queda congelado para el reintento.
        { grant: { status: 'PENDING', attempts: 1, lastError: 'HTTP_503', productId: PRODUCT } },
      ])
    })

    it('las entregas por hacer: solo PENDING con el intento vencido, las mas atrasadas primero', async () => {
      const first = await closed()
      const second = await closed()
      await masters.saveGrant(grantDeferred(second, 'HTTP_503', CLOSED), 0, CLOSED)
      const done = await closed()
      await masters.saveGrant(grantConfirmed(withProduct(done), CLOSED), 0, CLOSED)
      const later = new Date(CLOSED.getTime() + 60_000)

      const due = (await masters.pendingGrants(later, 1_000)).map((item) => item.enrollmentId)

      expect(due).toContain(first.enrollmentId)
      expect(due).toContain(second.enrollmentId)
      expect(due).not.toContain(done.enrollmentId)
      expect(due.indexOf(first.enrollmentId)).toBeLessThan(due.indexOf(second.enrollmentId))
      expect(
        (await masters.pendingGrants(CLOSED, 1_000)).map((item) => item.enrollmentId),
      ).not.toContain(second.enrollmentId)
    })
  })

  // Controles de motor: con SQL crudo, saltandose el repositorio.
  describe('restricciones de la migracion 006', () => {
    const insertRow = (row: Record<string, unknown>) => {
      const columns = Object.keys(row).map((column) => sql.ref(column))

      return sql`insert into mission_master_encounters (${sql.join(columns)})
        values (${sql.join(Object.values(row))})`.execute(db)
    }

    /** Una fila sin aparicion, coherente. */
    const notAppeared = async (values: Record<string, unknown> = {}) => ({
      enrollment_id: (await startEnrollment()).enrollmentId,
      sequence: 1,
      after_encounter: 3,
      master_ref: null,
      status: 'NOT_APPEARED',
      epic_ref: null,
      level_offset: null,
      turns: null,
      grant_operation_id: null,
      grant_status: null,
      grant_attempts: 0,
      grant_next_attempt_at: null,
      grant_last_error: null,
      granted_at: null,
      reward_line_no: null,
      ...values,
    })

    /** Una fila con el Master derrotado y su entrega pendiente, coherente. */
    const defeated = (values: Record<string, unknown> = {}) =>
      notAppeared({
        master_ref: MASTER,
        status: 'APPEARED_DEFEATED',
        epic_ref: EPIC,
        level_offset: 2,
        turns: 14,
        grant_operation_id: randomUUID(),
        grant_status: 'PENDING',
        grant_next_attempt_at: CLOSED,
        reward_line_no: 1,
        ...values,
      })

    it('las filas coherentes entran', async () => {
      await expect(insertRow(await notAppeared())).resolves.toBeDefined()
      await expect(insertRow(await defeated())).resolves.toBeDefined()
      await expect(
        insertRow(await notAppeared({ status: 'NOT_APPLICABLE', after_encounter: null })),
      ).resolves.toBeDefined()
      await expect(
        insertRow(
          await defeated({ grant_status: 'GRANTED', granted_at: LATER, grant_product_id: PRODUCT }),
        ),
      ).resolves.toBeDefined()
    })

    it.each([
      ['un estado desconocido', () => notAppeared({ status: 'MAYBE' }), 'estado_conocido'],
      ['un punto no positivo', () => notAppeared({ sequence: 0 }), 'punto_positivo'],
      ['un encuentro no positivo', () => notAppeared({ after_encounter: 0 }), 'encuentro_positivo'],
      [
        'un punto en NOT_APPLICABLE',
        () => notAppeared({ status: 'NOT_APPLICABLE' }),
        'punto_salvo_no_aplica',
      ],
      [
        'una evaluacion sin punto',
        () => notAppeared({ after_encounter: null }),
        'punto_salvo_no_aplica',
      ],
      ['un Master sin aparicion', () => notAppeared({ master_ref: MASTER }), 'master_si_aparece'],
      ['una aparicion sin Master', () => defeated({ master_ref: null }), 'master_si_aparece'],
      ['una epica sin derrota', () => notAppeared({ epic_ref: EPIC }), 'epica_si_derrotado'],
      [
        'una derrota del Master sin entrega',
        () =>
          defeated({
            grant_operation_id: null,
            grant_status: null,
            grant_next_attempt_at: null,
            reward_line_no: null,
          }),
        'entrega_si_derrotado',
      ],
      [
        'una entrega sin derrota del Master (CA-03)',
        () => defeated({ status: 'APPEARED_HERO_DEFEATED', epic_ref: null }),
        'entrega_si_derrotado',
      ],
      ['una entrega sin estado', () => defeated({ grant_status: null }), 'entrega_con_estado'],
      [
        'un estado de entrega desconocido',
        () => defeated({ grant_status: 'LOST' }),
        'estado_de_entrega',
      ],
      [
        'una entrega GRANTED sin fecha',
        () => defeated({ grant_status: 'GRANTED', grant_product_id: PRODUCT }),
        'entregada_con_fecha',
      ],
      [
        'una fecha de entrega sin GRANTED',
        () => defeated({ granted_at: LATER }),
        'entregada_con_fecha',
      ],
      [
        'un producto sin entrega',
        () => notAppeared({ grant_product_id: PRODUCT }),
        'producto_de_entrega',
      ],
      [
        'una entrega GRANTED sin producto',
        () => defeated({ grant_status: 'GRANTED', granted_at: LATER }),
        'entregada_con_producto',
      ],
      ['intentos negativos', () => defeated({ grant_attempts: -1 }), 'intentos'],
      ['turnos negativos', () => defeated({ turns: -1 }), 'turnos'],
      ['una linea no positiva', () => defeated({ reward_line_no: 0 }), 'linea_positiva'],
    ])('el motor rechaza %s', async (_caso, row, constraint) => {
      await expect(insertRow(await row())).rejects.toThrow(
        new RegExp(`mission_master_encounters_${constraint}`),
      )
    })

    it('una fila por punto, de una matricula real, y cada entrega con su propia operacion', async () => {
      const row = await defeated()
      await insertRow(row)

      await expect(insertRow(row)).rejects.toThrow(/duplicate key/)
      // Con su propia operacion: si no, la UNIQUE salta antes que la foranea.
      await expect(
        insertRow({ ...row, enrollment_id: 'enr_inexistente', grant_operation_id: randomUUID() }),
      ).rejects.toThrow(/mission_master_encounters_enrollment_id_fkey/)
      await expect(insertRow({ ...row, sequence: 2 })).rejects.toThrow(
        /mission_master_encounters_grant_operation_id_key/,
      )
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: matricularse por
   * HTTP, correr el ciclo del planificador (simular, cerrar y entregar) y leer el
   * reporte. Solo se sustituyen el JWT, el reloj y la entrega en Player/Inventory.
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
      subject: 'sujeto-pg-hu73',
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
    const grants = new InMemoryEpicGrants()
    let app: INestApplication

    beforeAll(async () => {
      // El ciclo recorre toda la tabla: se empieza sin lo que dejaron las pruebas
      // anteriores, y PostgreSQL exige truncar a la vez lo que referencia a las matriculas.
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
        .overrideProvider(EPIC_GRANTS)
        .useValue(grants)
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

    it('el servicio corre con el repositorio de PostgreSQL, no con el doble', () => {
      expect(app.get(MASTER_ENCOUNTER_REPOSITORY).constructor.name).toBe(
        'PostgresMasterEncounterRepository',
      )
    })

    it('CA-01: el Master derrotado queda en el motor y la epica se entrega una sola vez', async () => {
      const enrolled = await request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO.missionId}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId: randomUUID(), difficulty: 'NORMAL', strategyVersion: null })
      expect(enrolled.status).toBe(201)
      const enrollmentId = String(enrolled.body.enrollmentId)
      const scheduler = app.get<MissionExecutionScheduler>(MISSION_EXECUTION_SCHEDULER)

      await scheduler.tick()
      clock.current = new Date(String(enrolled.body.endsAt))
      await scheduler.tick()
      await scheduler.tick()

      const { rows } = await sql<{ status: string; grant_status: string; granted: boolean }>`
        select status, grant_status, granted_at is not null as granted
        from mission_master_encounters where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(rows).toEqual([
        { status: 'APPEARED_DEFEATED', grant_status: 'GRANTED', granted: true },
      ])
      expect(grants.granted()).toEqual([
        expect.objectContaining({ playerId: 'sujeto-pg-hu73', productId: PRODUCT }),
      ])

      const report = await request(app.getHttpServer())
        .get(`/api/v1/missions/me/reports/${enrollmentId}`)
        .set('Authorization', 'Bearer token-pg')
      expect(report.status).toBe(200)
      expect(report.body).toMatchObject({
        enemies: { masters: [{ masterRef: MASTER, status: 'APPEARED_DEFEATED' }] },
        rewards: [{ kind: 'EPIC', reference: EPIC, status: 'CREDITED', source: 'HU-73' }],
      })
    })
  })
})
