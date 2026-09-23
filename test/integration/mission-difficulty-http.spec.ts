import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

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
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador-1': { subject: 'sub-1', email: null, roles: new Set([Role.Player]) },
  'token-jugador-2': { subject: 'sub-2', email: null, roles: new Set([Role.Player]) },
  'token-moderador': { subject: 'sub-mod', email: null, roles: new Set([Role.Moderator]) },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const withEnv = (values: Record<string, string>): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

const buildApp = async (clears?: DifficultyClearRepositoryPort): Promise<INestApplication> => {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)

  if (clears !== undefined) {
    builder = builder.overrideProvider(DIFFICULTY_CLEAR_REPOSITORY).useValue(clears)
  }

  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  )
  await app.init()

  return app
}

const pathOf = (missionId: string): string => `/api/v1/missions/${missionId}/difficulties`
const AT = new Date('2026-09-22T15:00:00.000Z')

describe('GET /api/v1/missions/:missionId/difficulties (Task HU-75.2)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
    })
    app = await buildApp()

    // Un unico hecho: sub-1 completo msn-a en Normal. Todo lo demas debe seguir
    // bloqueado, y eso es lo que prueban los controles de aislamiento.
    await app
      .get<DifficultyClearRepositoryPort>(DIFFICULTY_CLEAR_REPOSITORY)
      .record({ playerId: 'sub-1', missionId: 'msn-a', difficulty: 'NORMAL', completedAt: AT })
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const get = (missionId: string, token?: string) => {
    const call = request(app.getHttpServer()).get(pathOf(missionId))

    return token === undefined ? call : call.set('Authorization', `Bearer ${token}`)
  }

  const unlocked = (body: { items: { difficulty: string; unlocked: boolean }[] }): string[] =>
    body.items.filter((item) => item.unlocked).map((item) => item.difficulty)

  it('rechaza sin testimonio', async () => {
    expect((await get('msn-a')).status).toBe(401)
  })

  it('rechaza un testimonio invalido', async () => {
    expect((await get('msn-a', 'token-falso')).status).toBe(401)
  })

  it('exige el rol de jugador', async () => {
    expect((await get('msn-a', 'token-moderador')).status).toBe(403)
  })

  it('un jugador sin progreso recibe los cuatro niveles con solo Normal libre', async () => {
    const response = await get('msn-a', 'token-jugador-2')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ missionId: 'msn-a' })
    expect(response.body.items).toEqual([
      {
        difficulty: 'NORMAL',
        unlocked: true,
        lockReason: null,
        enemyStatMultiplier: 1,
        rewardTier: 'STANDARD',
      },
      {
        difficulty: 'HEROIC',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Normal al menos una vez.',
        enemyStatMultiplier: 1.5,
        rewardTier: 'IMPROVED',
      },
      {
        difficulty: 'LEGENDARY',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Heroico al menos una vez.',
        enemyStatMultiplier: 2,
        rewardTier: 'PREMIUM',
      },
      {
        difficulty: 'MYTHIC',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Legendario al menos una vez.',
        enemyStatMultiplier: null,
        rewardTier: 'EXCLUSIVE',
      },
    ])
  })

  it('quien completo Normal en esa mision ve Heroico desbloqueado', async () => {
    const response = await get('msn-a', 'token-jugador-1')

    expect(response.status).toBe(200)
    expect(unlocked(response.body)).toEqual(['NORMAL', 'HEROIC'])
  })

  it('el mismo jugador no hereda ese progreso en otra mision', async () => {
    expect(unlocked((await get('msn-b', 'token-jugador-1')).body)).toEqual(['NORMAL'])
  })

  it('el jugador sale del testimonio: pedir el de otro por la consulta no sirve', async () => {
    const response = await request(app.getHttpServer())
      .get(`${pathOf('msn-a')}?playerId=sub-1`)
      .set('Authorization', 'Bearer token-jugador-2')

    expect(response.status).toBe(200)
    expect(unlocked(response.body)).toEqual(['NORMAL'])
  })

  it.each([
    ['demasiado largo', 'm'.repeat(65)],
    ['con caracteres fuera del patron', 'msn.a'],
  ])('rechaza un identificador de mision %s', async (_caso, missionId) => {
    expect((await get(missionId, 'token-jugador-1')).status).toBe(400)
  })

  describe('con el almacen caido', () => {
    let broken: INestApplication

    beforeAll(async () => {
      broken = await buildApp({
        clearedLevels: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
        record: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
      })
    })

    afterAll(async () => {
      await broken.close()
    })

    it('responde 503 en lugar de aparentar que no hay progreso', async () => {
      const response = await request(broken.getHttpServer())
        .get(pathOf('msn-a'))
        .set('Authorization', 'Bearer token-jugador-1')

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' })
    })
  })
})
