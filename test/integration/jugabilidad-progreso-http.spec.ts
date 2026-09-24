import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  RUN_MISSION_EXECUTIONS,
  type RunMissionExecutions,
} from '../../src/application/use-cases/RunMissionExecutions'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador-1': { subject: 'sub-1', email: null, roles: new Set([Role.Player]) },
  'token-jugador-2': { subject: 'sub-2', email: null, roles: new Set([Role.Player]) },
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

class MovableClock implements ClockPort {
  current = new Date('2026-10-01T15:00:00.000Z')
  now(): Date {
    return this.current
  }
}

const TEMPLO = 'msn_templo_olvidado'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

interface ProgressBody {
  readonly status: string
  readonly progressPercent: number
  readonly remainingSeconds: number | null
  readonly finished: boolean
  readonly reportAvailable: boolean
  readonly simulated: boolean
  readonly lastSeq: number
  readonly entries: readonly { readonly seq: number; readonly kind: string }[]
}

describe('Misiones en curso y su progreso por HTTP (P-J6)', () => {
  const clock = new MovableClock()
  let app: INestApplication
  let restore: () => void
  let executions: RunMissionExecutions

  const get = (path: string, token = 'token-jugador-1') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)

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
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
    executions = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('sigue una mision desde la matricula hasta el reporte', async () => {
    expect((await get('/api/v1/missions/me/active')).body).toMatchObject({ items: [] })

    const enrolled = await request(app.getHttpServer())
      .post(`/api/v1/missions/${TEMPLO}/enrollments`)
      .set('Authorization', 'Bearer token-jugador-1')
      .set('Idempotency-Key', randomUUID())
      .send({ heroId: HERO, difficulty: 'NORMAL', strategyVersion: null })
    expect(enrolled.status).toBe(201)
    const enrollmentId = String(enrolled.body.enrollmentId)
    const endsAt = new Date(String(enrolled.body.endsAt))
    const startedAt = new Date(String(enrolled.body.startedAt))

    // Recien matriculada: en curso, sin bitacora todavia.
    const before = await get(`/api/v1/missions/me/progress/${enrollmentId}`)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ status: 'IN_PROGRESS', simulated: false, entries: [] })

    // Combat simula; a mitad de camino se ve el avance y no el desenlace.
    await executions.run()
    clock.current = new Date((startedAt.getTime() + endsAt.getTime()) / 2)

    const active = await get('/api/v1/missions/me/active')
    expect(active.body).toMatchObject({
      serverTime: clock.current.toISOString(),
      items: [
        {
          enrollmentId,
          missionId: TEMPLO,
          missionName: 'El Templo Olvidado',
          category: 'STORY',
          difficulty: 'NORMAL',
          status: 'IN_PROGRESS',
          progressPercent: 50,
          remainingSeconds: 6 * 60 * 60,
        },
      ],
    })

    const midway = (await get(`/api/v1/missions/me/progress/${enrollmentId}`)).body as ProgressBody
    expect(midway).toMatchObject({ simulated: true, finished: false, reportAvailable: false })
    expect(midway.entries.length).toBeGreaterThan(0)
    expect(midway.entries.some((entry) => entry.kind === 'MISSION_FINISHED')).toBe(false)

    // `after` devuelve solo lo nuevo.
    const again = (
      await get(`/api/v1/missions/me/progress/${enrollmentId}?after=${String(midway.lastSeq)}`)
    ).body as ProgressBody
    expect(again.entries).toEqual([])

    // Nadie mas ve la mision.
    expect(
      (await get(`/api/v1/missions/me/progress/${enrollmentId}`, 'token-jugador-2')).status,
    ).toBe(404)
    expect((await get('/api/v1/missions/me/active', 'token-jugador-2')).body).toMatchObject({
      items: [],
    })

    // Al terminar se ve todo, con el desenlace, y el reporte ya se puede abrir.
    clock.current = endsAt
    await executions.run()
    const done = (await get(`/api/v1/missions/me/progress/${enrollmentId}`)).body as ProgressBody
    expect(done).toMatchObject({
      status: 'COMPLETED',
      finished: true,
      reportAvailable: true,
      progressPercent: 100,
      remainingSeconds: null,
    })
    expect(done.entries.at(-1)).toMatchObject({ kind: 'MISSION_FINISHED', victory: true })
    expect((await get('/api/v1/missions/me/active')).body).toMatchObject({ items: [] })
  })

  it('valida la matricula y el cursor', async () => {
    const missing = await get('/api/v1/missions/me/progress/enr_no_existe')
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ code: 'ENROLLMENT_NOT_FOUND' })

    expect((await get('/api/v1/missions/me/progress/enr_x?after=-1')).status).toBe(400)
    expect((await get('/api/v1/missions/me/progress/enr.x')).status).toBe(400)
    expect((await request(app.getHttpServer()).get('/api/v1/missions/me/active')).status).toBe(401)
  })
})
