import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  ENROLLMENT_REPOSITORY,
  type EnrollmentRepositoryPort,
} from '../../src/application/ports/EnrollmentRepositoryPort'
import {
  HERO_ABILITIES,
  type HeroAbilitiesPort,
} from '../../src/application/ports/HeroAbilitiesPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { Rotation } from '../../src/domain/value-objects/rotation'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { COURSE_STRATEGY } from '../support/fixtures'

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

const buildApp = async (abilities?: HeroAbilitiesPort): Promise<INestApplication> => {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)

  if (abilities !== undefined) {
    builder = builder.overrideProvider(HERO_ABILITIES).useValue(abilities)
  }

  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  return app
}

const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_C = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e'
const ONLY_BASIC: readonly Rotation[] = [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] }]

const put = (app: INestApplication, path: string, body: object, token = 'token-jugador-1') =>
  request(app.getHttpServer())
    .put(`/api/v1/missions/${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const get = (app: INestApplication, path: string, token = 'token-jugador-1') =>
  request(app.getHttpServer())
    .get(`/api/v1/missions/${path}`)
    .set('Authorization', `Bearer ${token}`)

describe('Estrategia de rotaciones por HTTP (Task HU-71.2)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
      HERO_COMMITMENTS_DRIVER: 'memory',
      HERO_ABILITIES_DRIVER: 'memory',
      MISSIONS_EXAMPLE_CATALOG: 'true',
      LOG_LEVEL: 'error',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const strategyPath = `${TEMPLO}/strategies/${HERO}`

  it('exige autenticacion y el rol de jugador', async () => {
    expect(
      (await request(app.getHttpServer()).get(`/api/v1/missions/${strategyPath}`)).status,
    ).toBe(401)
    expect((await get(app, strategyPath, 'token-moderador')).status).toBe(403)
    expect(
      (await put(app, strategyPath, { rotations: ONLY_BASIC }, 'token-moderador')).status,
    ).toBe(403)
  })

  it('sin estrategia guardada responde STRATEGY_NOT_FOUND', async () => {
    const response = await get(app, strategyPath)

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      code: 'STRATEGY_NOT_FOUND',
      missionId: TEMPLO,
      heroId: HERO,
    })
  })

  it('una mision inexistente es MISSION_NOT_FOUND al leer y al guardar', async () => {
    const path = `msn_inexistente/strategies/${HERO}`

    expect((await get(app, path)).body).toMatchObject({ code: 'MISSION_NOT_FOUND' })
    expect((await put(app, path, { rotations: ONLY_BASIC })).body).toMatchObject({
      code: 'MISSION_NOT_FOUND',
    })
  })

  describe('guardar y consultar', () => {
    let first: request.Response

    beforeAll(async () => {
      first = await put(app, strategyPath, { expectedVersion: null, rotations: COURSE_STRATEGY })
    })

    it('P-01: la primera version responde 201 con la estrategia completa (CA-01)', () => {
      expect(first.status).toBe(201)
      expect(first.body).toEqual({
        missionId: TEMPLO,
        heroId: HERO,
        version: 1,
        rotations: COURSE_STRATEGY,
        updatedAt: expect.any(String) as string,
      })
    })

    it('la consulta devuelve exactamente lo guardado', async () => {
      const response = await get(app, strategyPath)

      expect(response.status).toBe(200)
      expect(response.body).toEqual(first.body)
    })

    it('reemplazar con la version leida responde 200 con la version 2', async () => {
      const response = await put(app, strategyPath, { expectedVersion: 1, rotations: ONLY_BASIC })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ version: 2, rotations: ONLY_BASIC })
    })

    it('T-01: guardar sobre una version vieja es VERSION_CONFLICT', async () => {
      const response = await put(app, strategyPath, {
        expectedVersion: 1,
        rotations: COURSE_STRATEGY,
      })

      expect(response.status).toBe(409)
      expect(response.body).toEqual({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: 'Otra sesión cambió esta estrategia. Recárgala antes de guardar.',
        expectedVersion: 1,
        currentVersion: 2,
      })
    })

    it('P-04: una cuarta rotacion es TOO_MANY_ROTATIONS y no cambia nada (CA-04)', async () => {
      const response = await put(app, strategyPath, {
        expectedVersion: 2,
        rotations: [...COURSE_STRATEGY, { priority: 'LOW', steps: [{ kind: 'BASIC_ATTACK' }] }],
      })

      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({ code: 'TOO_MANY_ROTATIONS', max: 3, received: 4 })
      expect((await get(app, strategyPath)).body).toMatchObject({ version: 2 })
    })

    it('T-02: una habilidad que el heroe no tiene es UNKNOWN_ABILITY', async () => {
      const response = await put(app, strategyPath, {
        expectedVersion: 2,
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'furia-del-dragon' }] },
        ],
      })

      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({
        code: 'UNKNOWN_ABILITY',
        abilityIds: ['furia-del-dragon'],
        message: 'Tu héroe no tiene la habilidad «furia-del-dragon».',
      })
    })

    it('T-03: prioridades con hueco son INVALID_ROTATION', async () => {
      const response = await put(app, strategyPath, {
        expectedVersion: 2,
        rotations: [
          { priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK' }] },
          { priority: 'LOW', steps: [{ kind: 'BASIC_ATTACK' }] },
        ],
      })

      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({
        code: 'INVALID_ROTATION',
        message: 'Las prioridades deben ser Alta, Media y Baja, en ese orden y sin saltos.',
        violations: [{ field: 'rotations[1].priority', reason: 'PRIORITY_GAP' }],
      })
    })

    it('otro jugador no ve ni pisa esta estrategia', async () => {
      expect((await get(app, strategyPath, 'token-jugador-2')).status).toBe(404)

      const own = await put(app, strategyPath, { rotations: COURSE_STRATEGY }, 'token-jugador-2')

      expect(own.status).toBe(201)
      expect(own.body).toMatchObject({ version: 1 })
      expect((await get(app, strategyPath)).body).toMatchObject({
        version: 2,
        rotations: ONLY_BASIC,
      })
    })
  })

  it.each([
    [
      'una prioridad desconocida',
      { rotations: [{ priority: 'URGENT', steps: [{ kind: 'BASIC_ATTACK' }] }] },
    ],
    ['una accion desconocida', { rotations: [{ priority: 'HIGH', steps: [{ kind: 'HEAL' }] }] }],
    [
      'una ABILITY sin abilityId',
      { rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY' }] }] },
    ],
    [
      'un ataque basico con abilityId',
      { rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK', abilityId: 'x' }] }] },
    ],
    [
      'un abilityId mal formado',
      { rotations: [{ priority: 'HIGH', steps: [{ kind: 'ABILITY', abilityId: 'no válido!' }] }] },
    ],
    ['un campo que el contrato no admite', { rotations: ONLY_BASIC, playerId: 'sub-2' }],
    [
      'un campo desconocido en una accion',
      { rotations: [{ priority: 'HIGH', steps: [{ kind: 'BASIC_ATTACK', power: 3 }] }] },
    ],
    ['rotaciones que no son una lista', { rotations: 'HIGH' }],
    ['una version esperada no positiva', { expectedVersion: 0, rotations: ONLY_BASIC }],
  ])('rechaza %s con VALIDATION_ERROR', async (_caso, body) => {
    const response = await put(app, `${TEMPLO}/strategies/${HERO_C}`, body)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('un heroId que no es un UUID es VALIDATION_ERROR', async () => {
    const response = await put(app, `${TEMPLO}/strategies/heroe-1`, { rotations: ONLY_BASIC })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ violations: [{ field: 'heroId' }] })
  })

  describe('la matricula congela la estrategia (CU-71.3)', () => {
    const enroll = (heroId: string, strategyVersion: number | null, token = 'token-jugador-1') =>
      request(app.getHttpServer())
        .post(`/api/v1/missions/${TEMPLO}/enrollments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ heroId, difficulty: 'NORMAL', strategyVersion })

    const stored = (enrollmentId: string) =>
      app.get<EnrollmentRepositoryPort>(ENROLLMENT_REPOSITORY).findById(enrollmentId)

    it('T-04: matricularse con la version vieja es STRATEGY_VERSION_MISMATCH', async () => {
      const response = await enroll(HERO, 1)

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({
        code: 'STRATEGY_VERSION_MISMATCH',
        expectedVersion: 1,
        currentVersion: 2,
      })
    })

    it('con la version guardada congela esa copia, y editarla despues no la cambia', async () => {
      const response = await enroll(HERO, 2)

      expect(response.status).toBe(201)
      const enrollmentId = String(response.body.enrollmentId)
      await expect(stored(enrollmentId)).resolves.toMatchObject({
        strategyVersion: 2,
        rotations: ONLY_BASIC,
      })

      const edited = await put(app, strategyPath, {
        expectedVersion: 2,
        rotations: COURSE_STRATEGY,
      })
      expect(edited.status).toBe(200)
      await expect(stored(enrollmentId)).resolves.toMatchObject({ rotations: ONLY_BASIC })
    })

    it('P-R9: sin estrategia la matricula sigue adelante sin rotaciones', async () => {
      const response = await enroll(HERO_C, null, 'token-jugador-2')

      expect(response.status).toBe(201)
      await expect(stored(String(response.body.enrollmentId))).resolves.toMatchObject({
        strategyVersion: null,
        rotations: [],
      })
    })
  })

  describe('con Player/Inventory sin responder o con un heroe ajeno', () => {
    let unavailable: INestApplication
    let foreign: INestApplication

    beforeAll(async () => {
      unavailable = await buildApp({
        abilitiesOf: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'HTTP_503' }),
      })
      foreign = await buildApp({ abilitiesOf: () => Promise.resolve({ kind: 'NOT_OWNED' }) })
    })

    afterAll(async () => {
      await unavailable.close()
      await foreign.close()
    })

    it('sin respuesta, guardar es 503 DEPENDENCY_UNAVAILABLE y no guarda nada', async () => {
      const response = await put(unavailable, strategyPath, { rotations: ONLY_BASIC })

      expect(response.status).toBe(503)
      expect(response.body).toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        message:
          'No pudimos consultar las habilidades de tu héroe. Vuelve a intentarlo en unos segundos.',
      })
      expect((await get(unavailable, strategyPath)).status).toBe(404)
    })

    it('un heroe ajeno es 422 HERO_NOT_OWNED', async () => {
      const response = await put(foreign, strategyPath, { rotations: ONLY_BASIC })

      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({ code: 'HERO_NOT_OWNED', heroId: HERO })
    })
  })
})
