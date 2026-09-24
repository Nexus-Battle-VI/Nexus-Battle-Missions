import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { EPIC_GRANTS } from '../../src/application/ports/EpicGrantPort'
import {
  MASTER_ENCOUNTER_REPOSITORY,
  type MasterEncounterRepositoryPort,
} from '../../src/application/ports/MasterEncounterRepositoryPort'
import { MISSION_CATALOG } from '../../src/application/ports/MissionCatalogPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import { epicGrantOperationId } from '../../src/domain/policies/MasterPolicy'
import {
  AppModule,
  MISSION_EXECUTION_SCHEDULER,
} from '../../src/infrastructure/bootstrap/app.module'
import type { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'

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

const TEMPLO = EXAMPLE_MISSIONS[0]!
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const MASTER = 'sombra-del-olvido'
const EPIC = 'velo-de-sombras'
const PRODUCT = '11111111-1111-4111-8111-111111111111'
const candidate = TEMPLO.masterEncounter?.candidates[0]

if (candidate === undefined) {
  throw new Error('El Templo del ejemplo no tiene Master')
}

/**
 * El Templo con un Master que aparece siempre (el doble de Combat lo saca con
 * probabilidad 1 y el heroe lo derrota) y con la epica ya como producto de
 * Catalog. El resto del catalogo es el del ejemplo.
 */
const TEMPLO_CON_MASTER: MissionDefinition = {
  ...TEMPLO,
  masterEncounter: {
    evaluationPoints: [{ afterEncounter: 3 }],
    maxAppearances: 1,
    candidates: [
      {
        ...candidate,
        probabilityByHeroType: { '*': 1 },
        epic: { ...candidate.epic, productId: PRODUCT },
      },
    ],
  },
}

interface Enrolled {
  readonly enrollmentId: string
  readonly endsAt: string
}

describe('Master y epica de punta a punta (Task HU-73.2)', () => {
  const clock = new MovableClock()
  const grants = new InMemoryEpicGrants()
  let app: INestApplication
  let restore: () => void
  let enrolled: Enrolled
  let masters: MasterEncounterRepositoryPort
  let scheduler: MissionExecutionScheduler

  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', 'Bearer token-jugador-1')

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
      HERO_COMMITMENTS_DRIVER: 'memory',
      HERO_ABILITIES_DRIVER: 'memory',
      COMBAT_SIMULATION_DRIVER: 'memory',
      EPIC_GRANTS_DRIVER: 'memory',
      LOG_LEVEL: 'error',
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(MISSION_CATALOG)
      .useValue(new InMemoryMissionCatalog([TEMPLO_CON_MASTER, ...EXAMPLE_MISSIONS.slice(1)]))
      .overrideProvider(EPIC_GRANTS)
      .useValue(grants)
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(createValidationPipe())
    await app.init()
    masters = app.get<MasterEncounterRepositoryPort>(MASTER_ENCOUNTER_REPOSITORY)
    scheduler = app.get<MissionExecutionScheduler>(MISSION_EXECUTION_SCHEDULER)

    const response = await request(app.getHttpServer())
      .post(`/api/v1/missions/${TEMPLO.missionId}/enrollments`)
      .set('Authorization', 'Bearer token-jugador-1')
      .set('Idempotency-Key', randomUUID())
      .send({ heroId: HERO, difficulty: 'NORMAL', strategyVersion: null })
    expect(response.status).toBe(201)
    enrolled = response.body as Enrolled

    // Un ciclo simula; al llegar endsAt, el siguiente cierra y entrega la epica.
    await scheduler.tick()
    clock.current = new Date(enrolled.endsAt)
    await scheduler.tick()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('el detalle muestra la probabilidad por subtipo del heroe (HU-70 con HU-73)', async () => {
    const response = await get(`/api/v1/missions/${TEMPLO.missionId}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      masterEncounter: {
        probability: 1,
        candidates: [
          {
            name: 'Sombra del Olvido',
            heroType: 'PICARO_VENENO',
            probabilityByHeroType: { '*': 1 },
          },
        ],
      },
    })
  })

  it('CA-01: el encuentro queda registrado y la epica, entregada una sola vez', async () => {
    const [record, ...others] = await masters.listByEnrollment(enrolled.enrollmentId)

    expect(others).toEqual([])
    expect(record).toMatchObject({
      sequence: 1,
      afterEncounter: 3,
      masterRef: MASTER,
      status: 'APPEARED_DEFEATED',
      epicRef: EPIC,
      levelOffset: 2,
      grant: { status: 'GRANTED', attempts: 1 },
    })
    expect(grants.granted()).toEqual([
      {
        operationId: epicGrantOperationId(enrolled.enrollmentId, MASTER, 1),
        playerId: 'sub-1',
        productId: PRODUCT,
      },
    ])

    // Otro ciclo no vuelve a pedirla.
    await scheduler.tick()
    expect(grants.granted()).toHaveLength(1)
  })

  it('el reporte muestra al Master derrotado, el objetivo cumplido y la epica acreditada', async () => {
    const response = await get(`/api/v1/missions/me/reports/${enrolled.enrollmentId}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      summary: { outcome: 'COMPLETED' },
      enemies: {
        masters: [{ masterRef: MASTER, name: 'Sombra del Olvido', status: 'APPEARED_DEFEATED' }],
      },
      rewards: [
        {
          kind: 'EPIC',
          reference: EPIC,
          name: 'Velo de Sombras',
          quantity: 1,
          status: 'CREDITED',
          source: 'HU-73',
        },
      ],
    })
    const objectives = response.body.objectives as { id: string; met: boolean | null }[]
    expect(objectives.find((objective) => objective.id === 'obj_master')?.met).toBe(true)
  })

  it('la coleccion de epicas del historial la incluye (CA-05 de HU-74)', async () => {
    const response = await get('/api/v1/missions/me/history/summary')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      epicCollection: [
        { epicRef: EPIC, name: 'Velo de Sombras', masterRef: MASTER, status: 'CREDITED' },
      ],
    })
  })
})
