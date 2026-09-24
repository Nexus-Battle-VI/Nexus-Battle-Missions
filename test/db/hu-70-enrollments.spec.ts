import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { InMemoryHeroCommitments } from '../../src/adapters/outbound/inventory/InMemoryHeroCommitments'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresDifficultyClearRepository } from '../../src/adapters/outbound/persistence/PostgresDifficultyClearRepository'
import { PostgresEnrollmentRepository } from '../../src/adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresMissionCatalog } from '../../src/adapters/outbound/persistence/PostgresMissionCatalog'
import { PostgresStrategyRepository } from '../../src/adapters/outbound/persistence/PostgresStrategyRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { RandomIdGenerator } from '../../src/adapters/outbound/system/RandomIdGenerator'
import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { ENROLLMENT_REPOSITORY } from '../../src/application/ports/EnrollmentRepositoryPort'
import { MISSION_CATALOG } from '../../src/application/ports/MissionCatalogPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { EnrollInMission } from '../../src/application/use-cases/EnrollInMission'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  confirmEnrollment,
  enrollmentStartedFact,
  expireEnrollment,
  newPendingEnrollment,
  rejectEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import { EnrollmentPendingError } from '../../src/domain/errors/mission-errors'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-70.2). Lo que se prueba aqui no se puede probar con
 * los dobles en memoria: que las invariantes de la matricula viven en el MOTOR
 * (indices unicos parciales, CHECK y claves foraneas de la migracion 002), que
 * se sostienen con escrituras concurrentes y que la transicion y su hecho se
 * guardan en la misma transaccion.
 */
const [TEMPLO_DEF, CAMARA_DEF] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const TEMPLO = TEMPLO_DEF.missionId
const CAMARA = CAMARA_DEF.missionId
const RETIRED: MissionDefinition = {
  ...TEMPLO_DEF,
  missionId: 'msn_retirada',
  name: 'Zeta retirada',
  active: false,
}
const AT = new Date('2026-10-01T15:00:00.000Z')

let sequence = 0

/** Cada llamada es de otro jugador, otro heroe y otra clave, salvo lo que se fije. */
const pending = (overrides: Partial<MissionEnrollment> = {}): MissionEnrollment => {
  sequence += 1

  return {
    ...newPendingEnrollment({
      enrollmentId: `enr_pg_${String(sequence)}`,
      playerId: `pg-${String(sequence)}`,
      missionId: TEMPLO,
      heroId: randomUUID(),
      difficulty: 'NORMAL',
      operationId: `op-pg-${String(sequence)}`,
      idempotencyKey: randomUUID(),
      requestFingerprint: 'fp',
      strategyVersion: null,
      requestedAt: AT,
    }),
    ...overrides,
  }
}

describe('Matrículas en PostgreSQL (HU-70)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let catalog: PostgresMissionCatalog
  let repository: PostgresEnrollmentRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    for (const definition of [TEMPLO_DEF, CAMARA_DEF, RETIRED]) {
      await insertDefinition(db, definition)
    }
    catalog = new PostgresMissionCatalog(db)
    repository = new PostgresEnrollmentRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const factsOf = async (enrollmentId: string) => {
    const { rows } = await sql<{ type: string; payload: Record<string, unknown> }>`
      select type, payload from mission_facts where enrollment_id = ${enrollmentId}
    `.execute(db)

    return rows
  }

  describe('PostgresMissionCatalog', () => {
    it('devuelve la definicion tal como se guardo, con su contenido jsonb', async () => {
      await expect(catalog.findById(TEMPLO)).resolves.toEqual(TEMPLO_DEF)
      await expect(catalog.findById(CAMARA)).resolves.toEqual(CAMARA_DEF)
    })

    it('lista solo las activas, por nombre', async () => {
      const names = (await catalog.listActive()).map((definition) => definition.name)

      expect(names).toEqual([
        'Camino al Templo',
        'El Templo Olvidado',
        'La Arena de los Caídos',
        'La Cámara Sellada',
        'Travesía por el Bosque Sombrío',
      ])
    })

    it('una retirada no esta activa pero sigue existiendo para el reconciliador', async () => {
      await expect(catalog.findActive(RETIRED.missionId)).resolves.toBeNull()
      await expect(catalog.findById(RETIRED.missionId)).resolves.toMatchObject({ active: false })
      await expect(catalog.findActive('msn_inexistente')).resolves.toBeNull()
      await expect(catalog.findById('msn_inexistente')).resolves.toBeNull()
    })

    it('el motor rechaza una categoria fuera del vocabulario (CHECK)', async () => {
      await expect(
        insertDefinition(db, {
          ...TEMPLO_DEF,
          missionId: 'msn_rara',
          category: 'RAID' as MissionDefinition['category'],
        }),
      ).rejects.toThrow(/mission_definitions_categoria_conocida/)
    })
  })

  describe('PostgresEnrollmentRepository', () => {
    it('guarda y relee una matricula sin perder nada', async () => {
      const enrollment = pending({
        strategyVersion: 2,
        rotations: [
          {
            priority: 'HIGH',
            steps: [{ kind: 'ABILITY', abilityId: 'golpe-de-tormenta' }, { kind: 'BASIC_ATTACK' }],
          },
        ],
      })

      await expect(repository.insertPending(enrollment)).resolves.toEqual({ kind: 'INSERTED' })
      await expect(repository.findById(enrollment.enrollmentId)).resolves.toEqual(enrollment)
      await expect(
        repository.findByIdempotencyKey(enrollment.playerId, enrollment.idempotencyKey),
      ).resolves.toEqual(enrollment)
      await expect(repository.findById('enr_inexistente')).resolves.toBeNull()
      await expect(
        repository.findByIdempotencyKey('otro-jugador', enrollment.idempotencyKey),
      ).resolves.toBeNull()
    })

    it('guarda y relee el motivo de un rechazo (jsonb)', async () => {
      const rejected = rejectEnrollment(
        pending(),
        { code: 'LOADOUT_INCOMPLETE', detail: { missingSlots: [{ family: 'ITEM', missing: 2 }] } },
        AT,
      )

      await repository.insertPending(rejected)

      await expect(repository.findById(rejected.enrollmentId)).resolves.toEqual(rejected)
    })

    // Cada caso viola UN solo indice: con varios, el motor informa el primero
    // que comprueba y la prueba dependeria de ese orden.
    it('traduce cada indice unico violado al conflicto del caso de uso', async () => {
      const first = pending()
      await repository.insertPending(first)

      await expect(
        repository.insertPending(
          pending({
            playerId: first.playerId,
            idempotencyKey: first.idempotencyKey,
            missionId: CAMARA,
          }),
        ),
      ).resolves.toEqual({ kind: 'CONFLICT', reason: 'IDEMPOTENCY_KEY' })
      await expect(repository.insertPending(pending({ heroId: first.heroId }))).resolves.toEqual({
        kind: 'CONFLICT',
        reason: 'HERO_ACTIVE',
      })
      await expect(
        repository.insertPending(pending({ playerId: first.playerId })),
      ).resolves.toEqual({
        kind: 'CONFLICT',
        reason: 'PLAYER_MISSION_ACTIVE',
      })
    })

    it('cualquier otra violacion no se disfraza de conflicto', async () => {
      const first = pending()
      await repository.insertPending(first)

      await expect(
        repository.insertPending(pending({ operationId: first.operationId })),
      ).rejects.toThrow(/mission_enrollments_operation_id_key/)
      await expect(
        repository.insertPending(pending({ missionId: 'msn_inexistente' })),
      ).rejects.toThrow(/foreign key/)
    })

    it('tres matriculas simultaneas del mismo heroe dejan una sola activa (CA-02)', async () => {
      const heroId = randomUUID()

      const results = await Promise.all([
        repository.insertPending(pending({ heroId })),
        repository.insertPending(pending({ heroId })),
        repository.insertPending(pending({ heroId })),
      ])

      expect(results.filter((result) => result.kind === 'INSERTED')).toHaveLength(1)
      expect(results.filter((result) => result.kind === 'CONFLICT')).toEqual([
        { kind: 'CONFLICT', reason: 'HERO_ACTIVE' },
        { kind: 'CONFLICT', reason: 'HERO_ACTIVE' },
      ])
    })

    it('dos matriculas simultaneas del jugador en la misma mision dejan una sola (P-M2)', async () => {
      const playerId = `pg-mision-${randomUUID()}`

      const results = await Promise.all([
        repository.insertPending(pending({ playerId })),
        repository.insertPending(pending({ playerId })),
      ])

      expect(results).toContainEqual({ kind: 'INSERTED' })
      expect(results).toContainEqual({ kind: 'CONFLICT', reason: 'PLAYER_MISSION_ACTIVE' })
    })

    it('dos matriculas simultaneas con la misma clave dejan una sola (P-M3)', async () => {
      const playerId = `pg-clave-${randomUUID()}`
      const idempotencyKey = randomUUID()

      const results = await Promise.all([
        repository.insertPending(pending({ playerId, idempotencyKey })),
        repository.insertPending(pending({ playerId, idempotencyKey, missionId: CAMARA })),
      ])

      expect(results).toContainEqual({ kind: 'INSERTED' })
      expect(results).toContainEqual({ kind: 'CONFLICT', reason: 'IDEMPOTENCY_KEY' })
    })

    // T-01 bajo concurrencia real: el reintento simultaneo de una pulsacion viola
    // la clave, el heroe y la mision a la vez, y el motor informa cualquiera de
    // las tres. Toda respuesta debe ser la MISMA matricula: 201 o, si la primera
    // aun no confirmaba, 503 con ella PENDING. Nunca HERO_BUSY ni
    // MISSION_ALREADY_IN_PROGRESS.
    it('tres envios simultaneos de la misma pulsacion responden la misma matricula', async () => {
      const enroll = new EnrollInMission(
        catalog,
        repository,
        new PostgresDifficultyClearRepository(db),
        new PostgresStrategyRepository(db),
        new InMemoryHeroCommitments(),
        new RandomIdGenerator(),
        new SystemClock(),
      )
      const click = {
        playerId: `pg-carrera-${randomUUID()}`,
        missionId: TEMPLO,
        heroId: randomUUID(),
        difficulty: 'NORMAL',
        strategyVersion: null,
        idempotencyKey: randomUUID(),
      }

      const results = await Promise.allSettled([
        enroll.execute(click),
        enroll.execute(click),
        enroll.execute(click),
      ])
      const { rows } = await sql<{ enrollment_id: string }>`
        select enrollment_id from mission_enrollments where player_id = ${click.playerId}
      `.execute(db)
      const answeredWith = results.map((result) => {
        if (result.status === 'fulfilled') {
          return result.value.enrollmentId
        }

        return result.reason instanceof EnrollmentPendingError
          ? result.reason.enrollmentId
          : String(result.reason)
      })

      expect(rows).toHaveLength(1)
      const enrollmentId = rows[0]!.enrollment_id
      expect(answeredWith).toEqual([enrollmentId, enrollmentId, enrollmentId])
    })

    it('confirma con bloqueo optimista y guarda el hecho una sola vez', async () => {
      const enrollment = pending()
      await repository.insertPending(enrollment)
      const confirmed = confirmEnrollment(enrollment, 'cmt-1', AT, 12 * 60)
      const fact = enrollmentStartedFact(confirmed)

      await expect(repository.saveTransition(confirmed, 5, fact)).resolves.toBe(false)
      await expect(repository.saveTransition(confirmed, 0, fact)).resolves.toBe(true)
      await expect(repository.findById(enrollment.enrollmentId)).resolves.toEqual(confirmed)
      // Un reintento de la misma transicion no duplica el hecho.
      await expect(repository.saveTransition({ ...confirmed, version: 2 }, 1, fact)).resolves.toBe(
        true,
      )
      expect(await factsOf(enrollment.enrollmentId)).toEqual([
        { type: 'MissionEnrollmentStarted', payload: fact.payload },
      ])
    })

    it('si el hecho no se puede guardar, la transicion tampoco (misma transaccion)', async () => {
      const enrollment = pending()
      await repository.insertPending(enrollment)
      const confirmed = confirmEnrollment(enrollment, 'cmt-2', AT, 60)
      const orphan = { ...enrollmentStartedFact(confirmed), enrollmentId: 'enr_inexistente' }

      await expect(repository.saveTransition(confirmed, 0, orphan)).rejects.toThrow(/foreign key/)
      await expect(repository.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        status: 'PENDING',
        version: 0,
      })
    })

    it('una matricula terminada deja de ocupar al heroe y la mision', async () => {
      const enrollment = pending()
      await repository.insertPending(enrollment)
      await expect(repository.findActiveByHero(enrollment.heroId)).resolves.toEqual(enrollment)
      await expect(
        repository.findActiveByPlayerAndMission(enrollment.playerId, TEMPLO),
      ).resolves.toEqual(enrollment)

      await repository.saveTransition(expireEnrollment(enrollment, AT), 0, null)

      await expect(repository.findActiveByHero(enrollment.heroId)).resolves.toBeNull()
      await expect(
        repository.findActiveByPlayerAndMission(enrollment.playerId, TEMPLO),
      ).resolves.toBeNull()
      await expect(
        repository.insertPending(
          pending({ playerId: enrollment.playerId, heroId: enrollment.heroId }),
        ),
      ).resolves.toEqual({ kind: 'INSERTED' })
    })

    it('lista las matriculas del jugador en orden de solicitud', async () => {
      const playerId = `pg-lista-${randomUUID()}`
      const later = pending({ playerId, requestedAt: new Date('2026-10-02T09:00:00.000Z') })
      const earlier = pending({
        playerId,
        missionId: CAMARA,
        requestedAt: new Date('2026-10-01T09:00:00.000Z'),
      })
      await repository.insertPending(later)
      await repository.insertPending(earlier)

      const listed = await repository.listByPlayer(playerId)

      expect(listed.map((item) => item.enrollmentId)).toEqual([
        earlier.enrollmentId,
        later.enrollmentId,
      ])
    })

    // Las demas pruebas solicitan a partir del 1 de octubre: el corte del 30 de
    // septiembre solo alcanza a las tres de este caso.
    it('entrega al reconciliador las pendientes mas viejas antes del corte', async () => {
      const oldest = pending({ requestedAt: new Date('2026-09-30T10:00:00.000Z') })
      const older = pending({ requestedAt: new Date('2026-09-30T11:00:00.000Z') })
      const recent = pending({ requestedAt: new Date('2026-09-30T23:00:00.000Z') })
      for (const enrollment of [recent, older, oldest]) {
        await repository.insertPending(enrollment)
      }
      const cutoff = new Date('2026-09-30T12:00:00.000Z')

      expect(
        (await repository.listPendingRequestedBefore(cutoff, 10)).map((item) => item.enrollmentId),
      ).toEqual([oldest.enrollmentId, older.enrollmentId])
      expect(
        (await repository.listPendingRequestedBefore(cutoff, 1)).map((item) => item.enrollmentId),
      ).toEqual([oldest.enrollmentId])
    })

    // Controles de motor: con SQL crudo, saltandose el repositorio, para
    // demostrar que la base rechaza lo invalido aunque la aplicacion fallara.
    it.each([
      [
        'un estado fuera del vocabulario',
        sql`status = 'LOST'`,
        /mission_enrollments_estado_conocido/,
      ],
      [
        'un nivel fuera del vocabulario',
        sql`difficulty = 'EASY'`,
        /mission_enrollments_nivel_conocido/,
      ],
      [
        'EN CURSO sin compromiso ni fechas',
        sql`status = 'IN_PROGRESS'`,
        /mission_enrollments_en_curso_completa/,
      ],
      ['RECHAZADA sin motivo', sql`status = 'REJECTED'`, /mission_enrollments_rechazo_con_motivo/],
    ])('el motor rechaza %s (CHECK)', async (_caso, assignment, constraint) => {
      const enrollment = pending()
      await repository.insertPending(enrollment)

      await expect(
        sql`update mission_enrollments set ${assignment} where enrollment_id = ${enrollment.enrollmentId}`.execute(
          db,
        ),
      ).rejects.toThrow(constraint)
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: comprueba que la raiz
   * de composicion elige los adaptadores de PostgreSQL y que una matricula por
   * HTTP deja su fila y su hecho en el motor. Solo se sustituye el JWT de Cognito.
   */
  describe('de punta a punta por HTTP', () => {
    const ENV = {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'postgres',
      HERO_COMMITMENTS_DRIVER: 'memory',
      LOG_LEVEL: 'error',
    }
    const previousEnv: Record<string, string | undefined> = {}
    const identity: VerifiedIdentity = {
      subject: 'sujeto-pg-http',
      email: null,
      roles: new Set([Role.Player]),
    }
    const stubVerifier: TokenVerifierPort = {
      verify: (token: string): Promise<VerifiedIdentity> =>
        token === 'token-pg'
          ? Promise.resolve(identity)
          : Promise.reject(new TokenVerificationError()),
    }
    let app: INestApplication

    beforeAll(async () => {
      for (const key of [...Object.keys(ENV), 'DATABASE_URL']) {
        previousEnv[key] = process.env[key]
      }
      Object.assign(process.env, ENV, { DATABASE_URL: container.getConnectionUri() })

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(TOKEN_VERIFIER)
        .useValue(stubVerifier)
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
      expect(app.get(MISSION_CATALOG).constructor.name).toBe('PostgresMissionCatalog')
      expect(app.get(ENROLLMENT_REPOSITORY).constructor.name).toBe('PostgresEnrollmentRepository')
    })

    it('una matricula confirmada queda en el motor con su hecho de inicio', async () => {
      const heroId = randomUUID()
      const response = await request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId, difficulty: 'NORMAL', strategyVersion: null })
      const enrollmentId = String(response.body.enrollmentId)

      expect(response.status).toBe(201)
      const { rows } = await sql<{ status: string; hero_id: string; commitment_id: string | null }>`
        select status, hero_id, commitment_id from mission_enrollments
        where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'IN_PROGRESS', hero_id: heroId })
      expect(rows[0]?.commitment_id).not.toBeNull()
      expect(await factsOf(enrollmentId)).toHaveLength(1)

      const board = await request(app.getHttpServer())
        .get('/api/v1/missions')
        .set('Authorization', 'Bearer token-pg')
      const cards = board.body.items as { readonly missionId: string }[]
      expect(cards.find((card) => card.missionId === TEMPLO)).toMatchObject({
        missionId: TEMPLO,
        playerStatus: 'IN_PROGRESS',
        activeEnrollmentId: enrollmentId,
      })
    })
  })
})
