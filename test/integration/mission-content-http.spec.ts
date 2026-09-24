import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import {
  MISSION_CATALOG,
  type MissionCatalogPort,
} from '../../src/application/ports/MissionCatalogPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const identities: Record<string, VerifiedIdentity> = {
  admin: { subject: 'admin', email: null, roles: new Set([Role.Administrator]) },
  player: { subject: 'player', email: null, roles: new Set([Role.Player]) },
}
const verifier: TokenVerifierPort = {
  verify(token: string): Promise<VerifiedIdentity> {
    const identity = identities[token]
    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

describe('editable mission content over HTTP', () => {
  let app: INestApplication
  const prior: Record<string, string | undefined> = {}
  const env = {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'pool-test',
    COGNITO_CLIENT_ID: 'client-test',
    PERSISTENCE_DRIVER: 'memory',
    MISSIONS_EXAMPLE_CATALOG: 'true',
    LOG_LEVEL: 'error',
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(env)) {
      prior[key] = process.env[key]
      process.env[key] = value
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('only an administrator can save a playable boss definition', async () => {
    const mission = EXAMPLE_MISSIONS[0]!
    const path = `/api/v1/admin/missions/${mission.missionId}`
    const edited = {
      ...mission,
      finalBoss: {
        ...mission.finalBoss,
        profile: { ...mission.finalBoss.profile, maxHealth: 120 },
        drops: [{ label: 'Trofeo nuevo', probability: 1, rolls: 2, productId: null }],
      },
    }
    expect(
      (
        await request(app.getHttpServer())
          .put(path)
          .set('Authorization', 'Bearer player')
          .send(edited)
      ).status,
    ).toBe(403)
    const saved = await request(app.getHttpServer())
      .put(path)
      .set('Authorization', 'Bearer admin')
      .send(edited)
    expect(saved.status).toBe(200)
    expect(saved.body.finalBoss.profile.maxHealth).toBe(120)
    const catalog = app.get<MissionCatalogPort>(MISSION_CATALOG)
    expect((await catalog.findActive(mission.missionId))?.finalBoss.drops?.[0]?.label).toBe(
      'Trofeo nuevo',
    )
  })

  it('rejects an invalid profile without replacing the saved content', async () => {
    const mission = EXAMPLE_MISSIONS[0]!
    const path = `/api/v1/admin/missions/${mission.missionId}`
    const catalog = app.get<MissionCatalogPort>(MISSION_CATALOG)
    const before = await catalog.findActive(mission.missionId)
    const response = await request(app.getHttpServer())
      .put(path)
      .set('Authorization', 'Bearer admin')
      .send({ ...mission, finalBoss: { ...mission.finalBoss, profile: null } })
    expect(response.status).toBe(400)
    expect(await catalog.findActive(mission.missionId)).toEqual(before)
  })
})
