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
import { PostgresLootGrantRepository } from '../../src/adapters/outbound/persistence/PostgresLootGrantRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { EPIC_GRANTS } from '../../src/application/ports/EpicGrantPort'
import { LOOT_GRANT_REPOSITORY } from '../../src/application/ports/LootGrantRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  AppModule,
  MISSION_EXECUTION_SCHEDULER,
} from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'
import { insertDefinition } from '../support/fixtures'

/**
 * PostgreSQL REAL (diseno «misiones jugables», P-J1): el botin del jefe nace en la
 * transaccion del cierre con su linea `PRODUCT`, se entrega una sola vez con su
 * cantidad y la linea cambia a la vez; la migracion 011 impone sus reglas.
 */
const TEMPLO = EXAMPLE_MISSIONS[0]!
const FRAGMENTO = '11111111-1111-4111-8111-111111111111'
const PIEL = '22222222-2222-4222-8222-222222222222'
const AT = new Date('2026-10-01T15:00:00.000Z')

/** El doble de Combat solo deja caer lo de probabilidad 1: Fragmento x3 y Piel. */
const TEMPLO_CON_BOTIN: MissionDefinition = {
  ...TEMPLO,
  masterEncounter: null,
  finalBoss: {
    ...TEMPLO.finalBoss,
    drops: [
      { label: 'Fragmento del Sello Antiguo', probability: 1, rolls: 3, productId: FRAGMENTO },
      { label: 'Armadura «Piel del Guardián»', probability: 1, rolls: 1, productId: PIEL },
      { label: 'Arma «Espada del Templo»', probability: 0.15, rolls: 1, productId: null },
    ],
  },
}

class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
}

describe('Entrega del botin en PostgreSQL (P-J1)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    await insertDefinition(db, TEMPLO_CON_BOTIN)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

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
      subject: 'sujeto-pg-botin',
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

    it('el servicio usa el repositorio de PostgreSQL', () => {
      expect(app.get(LOOT_GRANT_REPOSITORY).constructor.name).toBe('PostgresLootGrantRepository')
    })

    it('el botin se entrega una vez, con su cantidad, y la linea del reporte queda CREDITED', async () => {
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

      const { rows } = await sql<{ label: string; quantity: number; status: string }>`
        select label, quantity, status from mission_loot_grants
        where enrollment_id = ${enrollmentId} order by line_no
      `.execute(db)
      expect(rows).toEqual([
        { label: 'Fragmento del Sello Antiguo', quantity: 3, status: 'GRANTED' },
        { label: 'Armadura «Piel del Guardián»', quantity: 1, status: 'GRANTED' },
      ])
      expect(grants.granted()).toEqual([
        expect.objectContaining({ productId: FRAGMENTO, quantity: 3 }),
        expect.objectContaining({ productId: PIEL, quantity: 1 }),
      ])

      const report = await request(app.getHttpServer())
        .get(`/api/v1/missions/me/reports/${enrollmentId}`)
        .set('Authorization', 'Bearer token-pg')
      expect(report.status).toBe(200)
      const products = (report.body.rewards as { kind: string }[]).filter(
        (line) => line.kind === 'PRODUCT',
      )
      expect(products).toEqual([
        expect.objectContaining({
          name: 'Fragmento del Sello Antiguo',
          status: 'CREDITED',
          source: 'HU-72',
        }),
        expect.objectContaining({
          name: 'Armadura «Piel del Guardián»',
          status: 'CREDITED',
          source: 'HU-72',
        }),
      ])
    })
  })

  describe('PostgresLootGrantRepository y la migracion 011', () => {
    /** Una matricula con su reporte y una linea PRODUCT, escritas a mano. */
    const withReportLine = async (): Promise<string> => {
      const enrollmentId = `enr_botin_${randomUUID()}`
      await sql`insert into mission_enrollments (enrollment_id, player_id, mission_id, hero_id,
          difficulty, status, operation_id, idempotency_key, request_fingerprint, requested_at,
          started_at, ends_at, finished_at, version)
        values (${enrollmentId}, 'p1', ${TEMPLO.missionId}, ${randomUUID()}, 'NORMAL', 'COMPLETED',
          ${randomUUID()}, ${randomUUID()}, 'huella', ${AT}, ${AT}, ${AT}, ${AT}, 3)`.execute(db)
      await sql`insert into mission_reports (enrollment_id, player_id, mission_id, category,
          difficulty, outcome, finished_at, schema_version, snapshot, generated_at)
        values (${enrollmentId}, 'p1', ${TEMPLO.missionId}, 'STORY', 'NORMAL', 'COMPLETED', ${AT},
          1, '{}', ${AT})`.execute(db)
      await sql`insert into mission_report_rewards (enrollment_id, line_no, kind, reference, name,
          rarity, quantity, status, source, updated_at)
        values (${enrollmentId}, 1, 'PRODUCT', 'Fragmento', 'Fragmento', null, 2, 'PENDING',
          'HU-72', ${AT})`.execute(db)
      return enrollmentId
    }

    const row = (enrollmentId: string, overrides: Record<string, unknown> = {}) => ({
      enrollment_id: enrollmentId,
      line_no: 1,
      label: 'Fragmento',
      quantity: 2,
      operation_id: randomUUID(),
      status: 'PENDING' as const,
      attempts: 0,
      next_attempt_at: AT,
      last_error: null,
      granted_at: null,
      product_id: null,
      ...overrides,
    })

    it('congela el producto una sola vez y la entrega mueve la linea del reporte', async () => {
      const repository = new PostgresLootGrantRepository(db)
      const enrollmentId = await withReportLine()
      await db.insertInto('mission_loot_grants').values(row(enrollmentId)).execute()
      const [pending] = await repository.listByEnrollment(enrollmentId)
      if (pending === undefined) throw new Error('Falta la entrega.')

      expect(await repository.freezeProduct({ ...pending, productId: FRAGMENTO }, 0)).toBe(true)
      expect(await repository.freezeProduct({ ...pending, productId: PIEL }, 0)).toBe(false)
      expect(await repository.pendingGrants(AT, 10)).toEqual(
        expect.arrayContaining([expect.objectContaining({ enrollmentId, productId: FRAGMENTO })]),
      )

      const delivered = {
        ...pending,
        status: 'GRANTED' as const,
        attempts: 1,
        grantedAt: AT,
        nextAttemptAt: null,
        productId: PIEL,
      }
      expect(await repository.saveGrant(delivered, 0, AT)).toBe(true)
      // Un guardado con los intentos viejos ya no aplica.
      expect(await repository.saveGrant(delivered, 0, AT)).toBe(false)

      const [saved] = await repository.listByEnrollment(enrollmentId)
      expect(saved).toMatchObject({ status: 'GRANTED', productId: FRAGMENTO })
      const { rows } = await sql<{ status: string }>`
        select status from mission_report_rewards where enrollment_id = ${enrollmentId}
      `.execute(db)
      expect(rows).toEqual([{ status: 'CREDITED' }])
    })

    it.each([
      ['una entrega sin su linea del reporte', { line_no: 99 }],
      ['una cantidad de cero', { quantity: 0 }],
      ['un estado desconocido', { status: 'LOST' }],
      ['entregada sin fecha', { status: 'GRANTED', product_id: FRAGMENTO }],
      ['entregada sin producto', { status: 'GRANTED', granted_at: AT }],
    ])('la migracion 011 rechaza %s', async (_case, overrides) => {
      const enrollmentId = await withReportLine()

      await expect(
        sql`insert into mission_loot_grants (enrollment_id, line_no, label, quantity, operation_id,
            status, attempts, next_attempt_at, granted_at, product_id)
          values (${enrollmentId}, ${(overrides as { line_no?: number }).line_no ?? 1}, 'Fragmento',
            ${(overrides as { quantity?: number }).quantity ?? 2}, ${randomUUID()},
            ${(overrides as { status?: string }).status ?? 'PENDING'}, 0, ${AT},
            ${(overrides as { granted_at?: Date }).granted_at ?? null},
            ${(overrides as { product_id?: string }).product_id ?? null})`.execute(db),
      ).rejects.toThrow()
    })

    it('las lineas de botin tienen el origen HU-72; otro origen desconocido se rechaza', async () => {
      const enrollmentId = await withReportLine()

      await expect(
        sql`insert into mission_report_rewards (enrollment_id, line_no, kind, name, quantity,
            status, source, updated_at)
          values (${enrollmentId}, 2, 'PRODUCT', 'X', 1, 'PENDING', 'HU-99', ${AT})`.execute(db),
      ).rejects.toThrow()
    })
  })
})
