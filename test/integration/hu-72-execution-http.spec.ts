import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import {
  COMBAT_SIMULATION,
  type CombatSimulationPort,
} from '../../src/application/ports/CombatSimulationPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  RUN_MISSION_EXECUTIONS,
  type ExecutionCycleSummary,
  type RunMissionExecutions,
} from '../../src/application/use-cases/RunMissionExecutions'
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

/** El tiempo de la mision lo mueve la prueba: no se esperan 12 horas. */
class MovableClock implements ClockPort {
  current = new Date('2026-10-01T15:00:00.000Z')
  now(): Date {
    return this.current
  }
}

const TEMPLO = 'msn_templo_olvidado'
const CAMARA = 'msn_camara_sellada'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const GRACE_MS = 30 * 60_000

const buildApp = async (
  clock: ClockPort,
  combat?: CombatSimulationPort,
): Promise<INestApplication> => {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)
    .overrideProvider(CLOCK)
    .useValue(clock)

  if (combat !== undefined) {
    builder = builder.overrideProvider(COMBAT_SIMULATION).useValue(combat)
  }

  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  return app
}

const enroll = (app: INestApplication, difficulty = 'NORMAL') =>
  request(app.getHttpServer())
    .post(`/api/v1/missions/${TEMPLO}/enrollments`)
    .set('Authorization', 'Bearer token-jugador-1')
    .set('Idempotency-Key', randomUUID())
    .send({ heroId: HERO, difficulty, strategyVersion: null })

const get = (app: INestApplication, path: string) =>
  request(app.getHttpServer()).get(path).set('Authorization', 'Bearer token-jugador-1')

const cardOf = async (app: INestApplication, missionId: string) => {
  const response = await get(app, '/api/v1/missions')
  const cards = response.body.items as { missionId: string }[]

  return cards.find((card) => card.missionId === missionId)
}

const unlockedLevels = async (app: INestApplication): Promise<string[]> => {
  const response = await get(app, `/api/v1/missions/${TEMPLO}/difficulties`)
  const items = response.body.items as { difficulty: string; unlocked: boolean }[]

  return items.filter((item) => item.unlocked).map((item) => item.difficulty)
}

const cycle = (counts: Partial<ExecutionCycleSummary>): ExecutionCycleSummary => ({
  queued: 0,
  simulated: 0,
  retried: 0,
  settled: 0,
  voided: 0,
  released: 0,
  failed: 0,
  ...counts,
})

describe('Simulacion y cierre de una mision, de la matricula al tablero (Task HU-72.2)', () => {
  let restore: () => void

  beforeAll(() => {
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
  })

  afterAll(() => {
    restore()
  })

  it('P-01: sellada hasta endsAt, se completa, desbloquea Heroico y la Camara, y libera al heroe', async () => {
    const clock = new MovableClock()
    const app = await buildApp(clock)

    try {
      const enrolled = await enroll(app)
      expect(enrolled.status).toBe(201)
      const executions = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)

      await expect(executions.run()).resolves.toEqual(cycle({ queued: 1, simulated: 1 }))
      // P-S9: el resultado existe, pero el jugador sigue viendo la mision en curso.
      await expect(cardOf(app, TEMPLO)).resolves.toMatchObject({
        playerStatus: 'IN_PROGRESS',
        activeEnrollmentId: enrolled.body.enrollmentId,
      })

      clock.current = new Date(enrolled.body.endsAt as string)
      await expect(executions.run()).resolves.toEqual(cycle({ settled: 1, released: 1 }))

      await expect(cardOf(app, TEMPLO)).resolves.toMatchObject({
        playerStatus: 'COMPLETED',
        canEnroll: true,
        activeEnrollmentId: null,
      })
      await expect(cardOf(app, CAMARA)).resolves.toMatchObject({ playerStatus: 'AVAILABLE' })
      await expect(unlockedLevels(app)).resolves.toEqual(['NORMAL', 'HEROIC'])
      // El compromiso se libero: el mismo heroe vuelve a entrar, ahora en Heroico.
      await expect(enroll(app, 'HEROIC')).resolves.toMatchObject({ status: 201 })
    } finally {
      await app.close()
    }
  })

  it('T-04: si Combat rechaza, la mision se anula sin contar como resultado y el heroe queda libre', async () => {
    const clock = new MovableClock()
    const rejecting: CombatSimulationPort = {
      simulate: () => Promise.resolve({ kind: 'REJECTED', code: 'INVALID_STRATEGY' }),
    }
    const app = await buildApp(clock, rejecting)

    try {
      expect((await enroll(app)).status).toBe(201)

      await expect(app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS).run()).resolves.toEqual(
        cycle({ queued: 1, voided: 1, released: 1 }),
      )
      await expect(cardOf(app, TEMPLO)).resolves.toMatchObject({
        playerStatus: 'AVAILABLE',
        canEnroll: true,
        activeEnrollmentId: null,
      })
      await expect(cardOf(app, CAMARA)).resolves.toMatchObject({ playerStatus: 'LOCKED' })
      await expect(unlockedLevels(app)).resolves.toEqual(['NORMAL'])
      await expect(enroll(app)).resolves.toMatchObject({ status: 201 })
    } finally {
      await app.close()
    }
  })

  it('sin Combat configurado la mision espera, y se anula al vencer el plazo (P-S8)', async () => {
    const restoreDriver = withEnv({ COMBAT_SIMULATION_DRIVER: 'http' })
    const clock = new MovableClock()
    const app = await buildApp(clock)

    try {
      const enrolled = await enroll(app)
      const executions = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)

      await expect(executions.run()).resolves.toEqual(cycle({ queued: 1, retried: 1 }))
      await expect(cardOf(app, TEMPLO)).resolves.toMatchObject({ playerStatus: 'IN_PROGRESS' })

      clock.current = new Date(new Date(enrolled.body.endsAt as string).getTime() + GRACE_MS + 1)
      await expect(executions.run()).resolves.toEqual(cycle({ voided: 1, released: 1 }))
      await expect(cardOf(app, TEMPLO)).resolves.toMatchObject({ playerStatus: 'AVAILABLE' })
    } finally {
      await app.close()
      restoreDriver()
    }
  })
})
