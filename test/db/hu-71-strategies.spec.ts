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
import { PostgresStrategyRepository } from '../../src/adapters/outbound/persistence/PostgresStrategyRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { STRATEGY_REPOSITORY } from '../../src/application/ports/StrategyRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import { newPendingEnrollment } from '../../src/domain/entities/MissionEnrollment'
import type { MissionStrategy } from '../../src/domain/entities/MissionStrategy'
import type { Rotation } from '../../src/domain/value-objects/rotation'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { COURSE_STRATEGY, insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (Task HU-71.2). Lo que no se puede probar con el doble en
 * memoria: que el bloqueo optimista vive en UNA escritura y aguanta guardados
 * simultaneos, y que la migracion 003 impone en el motor el limite de tres
 * rotaciones (CA-04) y la coherencia de la copia congelada en la matricula.
 */
const [TEMPLO_DEF] = EXAMPLE_MISSIONS as [MissionDefinition]
const TEMPLO = TEMPLO_DEF.missionId
const AT = new Date('2026-10-01T14:55:00.000Z')
const ONLY_BASIC: readonly Rotation[] = [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }]

let sequence = 0

/** Cada llamada es de otro jugador y otro heroe, salvo lo que se fije. */
const strategy = (overrides: Partial<MissionStrategy> = {}): MissionStrategy => {
  sequence += 1

  return {
    playerId: `pg-${String(sequence)}`,
    heroId: randomUUID(),
    missionId: TEMPLO,
    version: 1,
    rotations: COURSE_STRATEGY,
    updatedAt: AT,
    ...overrides,
  }
}

describe('Estrategias en PostgreSQL (HU-71)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresStrategyRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO_DEF)
    repository = new PostgresStrategyRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  describe('PostgresStrategyRepository', () => {
    it('guarda la primera version y la relee igual, con sus rotaciones en jsonb', async () => {
      const saved = strategy()

      await expect(repository.save(saved, null)).resolves.toEqual({ kind: 'SAVED' })
      await expect(repository.find(saved.playerId, saved.heroId, TEMPLO)).resolves.toEqual(saved)
    })

    it('el bloqueo optimista vive en la escritura', async () => {
      const first = strategy()
      const second = { ...first, version: 2, rotations: ONLY_BASIC }
      await repository.save(first, null)

      await expect(repository.save(first, null)).resolves.toEqual({
        kind: 'VERSION_CONFLICT',
        currentVersion: 1,
      })
      await expect(repository.save(second, 1)).resolves.toEqual({ kind: 'SAVED' })
      await expect(repository.save({ ...second, rotations: COURSE_STRATEGY }, 1)).resolves.toEqual({
        kind: 'VERSION_CONFLICT',
        currentVersion: 2,
      })
      await expect(repository.find(first.playerId, first.heroId, TEMPLO)).resolves.toEqual(second)
    })

    it('reemplazar una que no existe es conflicto sin version actual', async () => {
      await expect(repository.save(strategy({ version: 4 }), 3)).resolves.toEqual({
        kind: 'VERSION_CONFLICT',
        currentVersion: null,
      })
    })

    it('T-01: dos ediciones simultaneas sobre la misma version dejan una sola', async () => {
      const first = strategy()
      await repository.save(first, null)

      const results = await Promise.all([
        repository.save({ ...first, version: 2, rotations: ONLY_BASIC }, 1),
        repository.save({ ...first, version: 2 }, 1),
      ])

      expect(results).toContainEqual({ kind: 'SAVED' })
      expect(results).toContainEqual({ kind: 'VERSION_CONFLICT', currentVersion: 2 })
    })

    it('dos primeras versiones simultaneas dejan una sola', async () => {
      const first = strategy()

      const results = await Promise.all([
        repository.save(first, null),
        repository.save({ ...first, rotations: ONLY_BASIC }, null),
      ])

      expect(results).toContainEqual({ kind: 'SAVED' })
      expect(results).toContainEqual({ kind: 'VERSION_CONFLICT', currentVersion: 1 })
    })

    // Controles de motor: con SQL crudo, saltandose el repositorio.
    const insertRaw = (rotations: string, version = 1, missionId = TEMPLO) => sql`
      insert into mission_strategies (player_id, hero_id, mission_id, rotations, version, updated_at)
      values (${`pg-crudo-${randomUUID()}`}, ${randomUUID()}, ${missionId}, ${rotations}::jsonb, ${version}, now())
    `

    it.each([
      ['cuatro rotaciones (CA-04)', JSON.stringify([...COURSE_STRATEGY, ...ONLY_BASIC])],
      ['ninguna rotacion', '[]'],
      ['algo que no es una lista', '{"priority":"HIGH"}'],
    ])('el motor rechaza %s', async (_caso, rotations) => {
      await expect(insertRaw(rotations).execute(db)).rejects.toThrow(
        /mission_strategies_entre_una_y_tres/,
      )
    })

    it('el motor rechaza una version no positiva y una mision fuera del catalogo', async () => {
      await expect(insertRaw(JSON.stringify(ONLY_BASIC), 0).execute(db)).rejects.toThrow(
        /mission_strategies_version_positiva/,
      )
      await expect(
        insertRaw(JSON.stringify(ONLY_BASIC), 1, 'msn_inexistente').execute(db),
      ).rejects.toThrow(/foreign key/)
    })
  })

  describe('copia congelada en la matricula (migracion 003)', () => {
    const insertEnrollment = async () => {
      const enrollment = newPendingEnrollment({
        enrollmentId: `enr_hu71_${randomUUID()}`,
        playerId: `pg-matricula-${randomUUID()}`,
        missionId: TEMPLO,
        heroId: randomUUID(),
        difficulty: 'NORMAL',
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestFingerprint: 'fp',
        strategyVersion: 1,
        rotations: COURSE_STRATEGY,
        requestedAt: AT,
      })
      const enrollments = new PostgresEnrollmentRepository(db)
      await enrollments.insertPending(enrollment)

      return { enrollment, enrollments }
    }

    it('guarda y relee la copia con su version', async () => {
      const { enrollment, enrollments } = await insertEnrollment()

      await expect(enrollments.findById(enrollment.enrollmentId)).resolves.toMatchObject({
        strategyVersion: 1,
        rotations: COURSE_STRATEGY,
      })
    })

    it.each([
      ['una version sin copia', sql`rotations = '[]'::jsonb`],
      ['una copia sin version', sql`strategy_version = null`],
      [
        'cuatro rotaciones',
        sql`rotations = ${JSON.stringify([...COURSE_STRATEGY, ...ONLY_BASIC])}::jsonb`,
      ],
    ])('el motor rechaza %s', async (_caso, assignment) => {
      const { enrollment } = await insertEnrollment()

      await expect(
        sql`update mission_enrollments set ${assignment} where enrollment_id = ${enrollment.enrollmentId}`.execute(
          db,
        ),
      ).rejects.toThrow(/mission_enrollments_estrategia_congelada/)
    })
  })

  /**
   * El servicio completo con `PERSISTENCE_DRIVER=postgres`: guardar por HTTP,
   * matricularse con esa version y comprobar en el motor que la copia no cambia
   * al editar la estrategia. Solo se sustituye el JWT de Cognito.
   */
  describe('de punta a punta por HTTP', () => {
    const ENV = {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'postgres',
      HERO_COMMITMENTS_DRIVER: 'memory',
      HERO_ABILITIES_DRIVER: 'memory',
      LOG_LEVEL: 'error',
    }
    const previousEnv: Record<string, string | undefined> = {}
    const identity: VerifiedIdentity = {
      subject: 'sujeto-pg-hu71',
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

    it('el servicio corre con el repositorio de PostgreSQL, no con el doble', () => {
      expect(app.get(STRATEGY_REPOSITORY).constructor.name).toBe('PostgresStrategyRepository')
    })

    it('la matricula congela la version guardada y editarla despues no la cambia', async () => {
      const heroId = randomUUID()
      const path = `/api/v1/missions/${TEMPLO}/strategies/${heroId}`
      const server = app.getHttpServer()

      const created = await request(server)
        .put(path)
        .set('Authorization', 'Bearer token-pg')
        .send({ expectedVersion: null, rotations: COURSE_STRATEGY })
      expect(created.status).toBe(201)

      const enrolled = await request(server)
        .post(`/api/v1/missions/${TEMPLO}/enrollments`)
        .set('Authorization', 'Bearer token-pg')
        .set('Idempotency-Key', randomUUID())
        .send({ heroId, difficulty: 'NORMAL', strategyVersion: 1 })
      expect(enrolled.status).toBe(201)
      const enrollmentId = String(enrolled.body.enrollmentId)

      const edited = await request(server)
        .put(path)
        .set('Authorization', 'Bearer token-pg')
        .send({ expectedVersion: 1, rotations: ONLY_BASIC })
      expect(edited.status).toBe(200)

      const { rows } = await sql<{ strategy_version: number; rotations: Rotation[] }>`
        select strategy_version, rotations from mission_enrollments where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(rows).toEqual([{ strategy_version: 1, rotations: COURSE_STRATEGY }])
    })
  })
})
