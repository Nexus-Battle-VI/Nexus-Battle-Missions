import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
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

const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

describe('Probabilidad de exito por HTTP (P-J7)', () => {
  let app: INestApplication
  let restore: () => void

  const estimate = (query: string, missionId = TEMPLO) =>
    request(app.getHttpServer())
      .get(`/api/v1/missions/${missionId}/estimate${query}`)
      .set('Authorization', 'Bearer token-jugador-1')

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
      HERO_COMMITMENTS_DRIVER: 'memory',
      HERO_ABILITIES_DRIVER: 'memory',
      COMBAT_SIMULATION_DRIVER: 'memory',
      MISSIONS_EXAMPLE_CATALOG: 'true',
      LOG_LEVEL: 'error',
    })
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
    restore()
  })

  it('estima con el doble de desarrollo: todo victorias y las habilidades del heroe', async () => {
    const response = await estimate(`?heroId=${HERO}&difficulty=NORMAL`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      missionId: TEMPLO,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      runs: 30,
      successPercent: 100,
      defeatPercent: 0,
      timeoutPercent: 0,
      risk: 'LOW',
      riskLabel: 'Favorable',
    })
    expect(response.body.abilities).toHaveLength(3)
  })

  it('un nivel que falta o no existe es 400 UNKNOWN_DIFFICULTY', async () => {
    for (const query of [`?heroId=${HERO}`, `?heroId=${HERO}&difficulty=FACIL`]) {
      const response = await estimate(query)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'UNKNOWN_DIFFICULTY' })
    }
  })

  it('un heroe que no es un UUID es un error de validacion', async () => {
    const response = await estimate('?heroId=no-es-uuid&difficulty=NORMAL')

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('una mision que no existe es 404 MISSION_NOT_FOUND', async () => {
    const response = await estimate(`?heroId=${HERO}&difficulty=NORMAL`, 'msn_nada')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: 'MISSION_NOT_FOUND' })
  })

  it('sin testimonio no hay estimacion', async () => {
    const response = await request(app.getHttpServer()).get(
      `/api/v1/missions/${TEMPLO}/estimate?heroId=${HERO}&difficulty=NORMAL`,
    )

    expect(response.status).toBe(401)
  })
})
