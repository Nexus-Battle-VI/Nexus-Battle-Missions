import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import {
  DIFFICULTY_CLEAR_REPOSITORY,
  type DifficultyClearRepositoryPort,
} from '../../src/application/ports/DifficultyClearRepositoryPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { DifficultyLevel } from '../../src/domain/value-objects/difficulty-level'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * VALIDACION INTEGRADA DE HU-75 (Task HU-75.4, Management #386), sin dobles de la
 * base ni del transporte: PostgreSQL REAL (Testcontainers), servidor Nest REAL con
 * `PERSISTENCE_DRIVER=postgres` y peticiones HTTP reales. Solo se sustituye el JWT
 * de Cognito, que es una frontera externa.
 *
 * Los niveles completados se registran con el MISMO puerto que usara HU-72
 * (`DifficultyClearRepositoryPort.record`), porque la simulacion que los produce
 * todavia no existe. Cada caso cita su escenario del diseno (P-0x) o de la matriz
 * de aislamiento.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-ana': { subject: 'sujeto-ana', email: null, roles: new Set([Role.Player]) },
  'token-beto': { subject: 'sujeto-beto', email: null, roles: new Set([Role.Player]) },
  'token-carla': { subject: 'sujeto-carla', email: null, roles: new Set([Role.Player]) },
  'token-dario': { subject: 'sujeto-dario', email: null, roles: new Set([Role.Player]) },
  'token-eva': { subject: 'sujeto-eva', email: null, roles: new Set([Role.Player]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

/** Textos y valores literales del contrato hu-75-mission-difficulty-v1. */
const LOCK_REASON: Readonly<Record<DifficultyLevel, string | null>> = {
  NORMAL: null,
  HEROIC: 'Debes completar esta misión en Normal al menos una vez.',
  LEGENDARY: 'Debes completar esta misión en Heroico al menos una vez.',
  MYTHIC: 'Debes completar esta misión en Legendario al menos una vez.',
}

const SCALING = [
  ['NORMAL', 1, 'STANDARD'],
  ['HEROIC', 1.5, 'IMPROVED'],
  ['LEGENDARY', 2, 'PREMIUM'],
  ['MYTHIC', null, 'EXCLUSIVE'],
] as const

/** Cuerpo esperado cuando estan libres EXACTAMENTE los niveles indicados. */
const expectedBody = (missionId: string, unlocked: readonly DifficultyLevel[]) => ({
  missionId,
  items: SCALING.map(([difficulty, enemyStatMultiplier, rewardTier]) => {
    const free = unlocked.includes(difficulty)

    return {
      difficulty,
      unlocked: free,
      lockReason: free ? null : LOCK_REASON[difficulty],
      enemyStatMultiplier,
      rewardTier,
    }
  }),
})

const T0 = new Date('2026-09-22T15:00:00.000Z')

describe('HU-75 de punta a punta: HTTP real y PostgreSQL real (Task HU-75.4)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let app: INestApplication
  const ENV_KEYS = [
    'AUTH_MODE',
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'PERSISTENCE_DRIVER',
    'DATABASE_URL',
  ] as const
  const previousEnv: Record<string, string | undefined> = {}

  const buildApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .compile()
    const instance = moduleRef.createNestApplication()
    instance.setGlobalPrefix('api')
    instance.useGlobalPipes(createValidationPipe())
    await instance.init()

    return instance
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    const connectionString = container.getConnectionUri()

    // Paso explicito del despliegue, como `npm run migrate`: el servicio no migra al arrancar.
    db = createDatabase({ connectionString })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }

    for (const key of ENV_KEYS) {
      previousEnv[key] = process.env[key]
    }
    Object.assign(process.env, {
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: connectionString,
    })
    app = await buildApp()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await db.destroy()
    await container.stop()
    for (const key of ENV_KEYS) {
      const value = previousEnv[key]
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  })

  const difficulties = (missionId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/missions/${missionId}/difficulties`)
      .set('Authorization', `Bearer ${token}`)

  const complete = (
    playerId: string,
    missionId: string,
    difficulty: DifficultyLevel,
    completedAt: Date = T0,
  ): Promise<boolean> =>
    app
      .get<DifficultyClearRepositoryPort>(DIFFICULTY_CLEAR_REPOSITORY)
      .record({ playerId, missionId, difficulty, completedAt })

  // Control: si el servicio estuviera usando el doble en memoria, todo lo demas
  // pasaria igual y no probaria la persistencia.
  it('el servicio corre con el repositorio de PostgreSQL, no con el doble en memoria', () => {
    expect(app.get(DIFFICULTY_CLEAR_REPOSITORY).constructor.name).toBe(
      'PostgresDifficultyClearRepository',
    )
  })

  it('P-03 / CA-03: sin progreso solo Normal esta libre y cada bloqueo explica el nivel que falta', async () => {
    const response = await difficulties('msn-p03', 'token-ana')

    expect(response.status).toBe(200)
    expect(response.body).toEqual(expectedBody('msn-p03', ['NORMAL']))
  })

  it('P-02 / CA-02: completar Normal desbloquea Heroico con factor 1.5, y saltar a Legendario sigue bloqueado', async () => {
    await complete('sujeto-ana', 'msn-p02', 'NORMAL')

    expect((await difficulties('msn-p02', 'token-ana')).body).toEqual(
      expectedBody('msn-p02', ['NORMAL', 'HEROIC']),
    )
  })

  it('P-04 / CA-04: con Heroico completado, Legendario queda libre con factor 2 y tabla premium', async () => {
    await complete('sujeto-ana', 'msn-p04', 'NORMAL')
    await complete('sujeto-ana', 'msn-p04', 'HEROIC')

    expect((await difficulties('msn-p04', 'token-ana')).body).toEqual(
      expectedBody('msn-p04', ['NORMAL', 'HEROIC', 'LEGENDARY']),
    )
  })

  it('P-05 / CA-04: con Legendario completado, Mitico queda libre sin multiplicador inventado', async () => {
    for (const level of ['NORMAL', 'HEROIC', 'LEGENDARY'] as const) {
      await complete('sujeto-ana', 'msn-p05', level)
    }

    const response = await difficulties('msn-p05', 'token-ana')

    expect(response.body).toEqual(
      expectedBody('msn-p05', ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC']),
    )
    expect(response.body.items[3]).toMatchObject({
      difficulty: 'MYTHIC',
      enemyStatMultiplier: null,
      rewardTier: 'EXCLUSIVE',
    })
  })

  describe('matriz de aislamiento: nada de esto desbloquea', () => {
    it('Normal completado en OTRA mision', async () => {
      await complete('sujeto-beto', 'msn-otra', 'NORMAL')

      expect((await difficulties('msn-propia', 'token-beto')).body).toEqual(
        expectedBody('msn-propia', ['NORMAL']),
      )
    })

    it('el mismo nivel, Heroico, completado en otra mision', async () => {
      await complete('sujeto-carla', 'msn-otra', 'NORMAL')
      await complete('sujeto-carla', 'msn-otra', 'HEROIC')

      expect((await difficulties('msn-propia', 'token-carla')).body).toEqual(
        expectedBody('msn-propia', ['NORMAL']),
      )
    })

    it('Normal completado por OTRO jugador en esta misma mision', async () => {
      await complete('sujeto-dario', 'msn-compartida', 'NORMAL')

      expect((await difficulties('msn-compartida', 'token-eva')).body).toEqual(
        expectedBody('msn-compartida', ['NORMAL']),
      )
    })

    it('pedir el progreso de otro por la consulta no sirve: el jugador sale del testimonio', async () => {
      await complete('sujeto-dario', 'msn-compartida', 'NORMAL')

      const response = await request(app.getHttpServer())
        .get('/api/v1/missions/msn-compartida/difficulties?playerId=sujeto-dario')
        .set('Authorization', 'Bearer token-eva')

      expect(response.body).toEqual(expectedBody('msn-compartida', ['NORMAL']))
      // Control: dario si ve su propio progreso en la misma mision.
      expect((await difficulties('msn-compartida', 'token-dario')).body).toEqual(
        expectedBody('msn-compartida', ['NORMAL', 'HEROIC']),
      )
    })
  })

  it('registrar dos veces el mismo nivel no duplica, conserva la primera fecha y no cambia lo que ve el jugador', async () => {
    await expect(complete('sujeto-eva', 'msn-idem', 'NORMAL', T0)).resolves.toBe(true)
    await expect(
      complete('sujeto-eva', 'msn-idem', 'NORMAL', new Date('2026-09-23T10:00:00.000Z')),
    ).resolves.toBe(false)

    const { rows } = await sql<{ total: string; primera: Date }>`
      select count(*) as total, min(completed_at) as primera
      from mission_difficulty_clears
      where player_id = ${'sujeto-eva'} and mission_id = ${'msn-idem'}
    `.execute(db)

    expect(rows[0]).toEqual({ total: '1', primera: T0 })
    expect((await difficulties('msn-idem', 'token-eva')).body).toEqual(
      expectedBody('msn-idem', ['NORMAL', 'HEROIC']),
    )
  })

  it('el progreso sobrevive a reiniciar el servicio: vive en PostgreSQL, no en la memoria del proceso', async () => {
    await complete('sujeto-beto', 'msn-reinicio', 'NORMAL')

    await app.close()
    app = await buildApp()

    expect((await difficulties('msn-reinicio', 'token-beto')).body).toEqual(
      expectedBody('msn-reinicio', ['NORMAL', 'HEROIC']),
    )
  })
})
