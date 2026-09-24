import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import { InMemoryEpicGrants } from '../../src/adapters/outbound/inventory/InMemoryEpicGrants'
import { APPROVED_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/approved-achievements'
import { EXAMPLE_ACHIEVEMENTS } from '../../src/adapters/outbound/persistence/example-achievements'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { StaticAchievementCatalog } from '../../src/adapters/outbound/persistence/StaticAchievementCatalog'
import {
  ACHIEVEMENT_CATALOG,
  type AchievementCatalogPort,
} from '../../src/application/ports/AchievementCatalogPort'
import { CLOCK, type ClockPort } from '../../src/application/ports/ClockPort'
import { EPIC_GRANTS } from '../../src/application/ports/EpicGrantPort'
import { MISSION_CATALOG } from '../../src/application/ports/MissionCatalogPort'
import { RECOGNITION_GRANTS } from '../../src/application/ports/RecognitionGrantPort'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import type { AchievementDefinition } from '../../src/domain/entities/Achievement'
import type {
  MasterEncounter,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import { achievementGrantOperationId } from '../../src/domain/policies/AchievementPolicy'
import {
  AppModule,
  MISSION_EXECUTION_SCHEDULER,
} from '../../src/infrastructure/bootstrap/app.module'
import type { MissionExecutionScheduler } from '../../src/infrastructure/scheduling/MissionExecutionScheduler'

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

const ENV = {
  AUTH_MODE: 'jwt',
  COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
  COGNITO_CLIENT_ID: 'cliente-de-pruebas',
  PERSISTENCE_DRIVER: 'memory',
  HERO_COMMITMENTS_DRIVER: 'memory',
  HERO_ABILITIES_DRIVER: 'memory',
  COMBAT_SIMULATION_DRIVER: 'memory',
  EPIC_GRANTS_DRIVER: 'memory',
  LOG_LEVEL: 'error',
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

const PRODUCT = '11111111-1111-4111-8111-111111111111'
const BANNER = '33333333-3333-4333-8333-333333333333'
const [TEMPLO_BASE, CAMARA_BASE] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const candidate = TEMPLO_BASE.masterEncounter?.candidates[0]

if (candidate === undefined) {
  throw new Error('El Templo del ejemplo no tiene Master')
}

/** Un Master que el doble de Combat saca siempre (probabilidad 1) y que el heroe derrota. */
const masterAt = (afterEncounter: number, masterRef: string, epicRef: string): MasterEncounter => ({
  evaluationPoints: [{ afterEncounter }],
  maxAppearances: 1,
  candidates: [
    {
      ...candidate,
      masterRef,
      name: masterRef,
      probabilityByHeroType: { '*': 1 },
      epic: { ...candidate.epic, epicRef, name: epicRef, productId: PRODUCT },
    },
  ],
})

/** Los dos Master y las dos epicas de los fixtures del contrato de HU-76. */
const MISSIONS: readonly MissionDefinition[] = [
  { ...TEMPLO_BASE, masterEncounter: masterAt(3, 'sombra-del-olvido', 'velo-de-sombras') },
  { ...CAMARA_BASE, masterEncounter: masterAt(1, 'centinela-carmesi', 'furia-carmesi') },
]

/** El catalogo del contrato con el umbral de L-4 y el estandarte ya como producto. */
const CATALOG: readonly AchievementDefinition[] = EXAMPLE_ACHIEVEMENTS.map(
  (definition): AchievementDefinition => {
    if (definition.achievementId === 'ach_templo_veloz') {
      return {
        ...definition,
        rule: {
          criterion: 'RECORD_TIME',
          missionId: 'msn_templo_olvidado',
          maxSimulatedDuration: 'PT9H',
          difficulty: null,
        },
      }
    }

    return definition.achievementId === 'ach_coleccionista'
      ? {
          ...definition,
          recognition: { kind: 'COSMETIC_PRODUCT', name: definition.name, productId: BANNER },
        }
      : definition
  },
)

interface Item {
  readonly achievementId: string
  readonly status: string
  readonly progress: { readonly current: number; readonly target: number }
  readonly unlockedAt: string | null
  readonly recognition: {
    readonly kind: string
    readonly name: string
    readonly status: string | null
  }
}

const item = (
  achievementId: string,
  status: string,
  current: number,
  target: number,
  unlockedAt: string | null = null,
  recognitionStatus: string | null = null,
) => {
  const definition = CATALOG.find(
    (candidateDefinition) => candidateDefinition.achievementId === achievementId,
  )

  if (definition === undefined) {
    throw new Error(`Falta ${achievementId}`)
  }

  return {
    achievementId,
    name: definition.name,
    criterion: definition.rule.criterion,
    status,
    progress: { current, target },
    unlockedAt,
    recognition: {
      kind: definition.recognition.kind,
      name: definition.recognition.name,
      status: recognitionStatus,
    },
  }
}

const compile = async (overrides: {
  readonly catalog?: AchievementCatalogPort
  readonly clock?: ClockPort
  readonly epics?: InMemoryEpicGrants
  readonly recognitions?: InMemoryEpicGrants
}): Promise<INestApplication> => {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)
    .overrideProvider(MISSION_CATALOG)
    .useValue(new InMemoryMissionCatalog(MISSIONS))

  if (overrides.clock !== undefined) {
    builder = builder.overrideProvider(CLOCK).useValue(overrides.clock)
  }
  if (overrides.catalog !== undefined) {
    builder = builder.overrideProvider(ACHIEVEMENT_CATALOG).useValue(overrides.catalog)
  }
  if (overrides.epics !== undefined) {
    builder = builder.overrideProvider(EPIC_GRANTS).useValue(overrides.epics)
  }
  if (overrides.recognitions !== undefined) {
    builder = builder.overrideProvider(RECOGNITION_GRANTS).useValue(overrides.recognitions)
  }

  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  return app
}

describe('Logros de misiones por HTTP (Task HU-76.2)', () => {
  const clock = new MovableClock()
  const epics = new InMemoryEpicGrants()
  const recognitions = new InMemoryEpicGrants()
  let app: INestApplication
  let restore: () => void
  let afterTemplo: { readonly items: readonly Item[] }
  let afterCamara: { readonly items: readonly Item[] }
  let afterAnotherCycle: { readonly items: readonly Item[] }
  let temploClosedAt: string
  let camaraClosedAt: string

  const get = (path: string, token = 'token-jugador-1') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)

  const achievements = async () => {
    const response = await get('/api/v1/missions/me/achievements')

    expect(response.status).toBe(200)

    return response.body as { readonly items: readonly Item[] }
  }

  /** Matricularse por HTTP y correr el ciclo: simula, y al llegar `endsAt`, cierra y evalua. */
  const play = async (missionId: string): Promise<string> => {
    const scheduler = app.get<MissionExecutionScheduler>(MISSION_EXECUTION_SCHEDULER)
    const response = await request(app.getHttpServer())
      .post(`/api/v1/missions/${missionId}/enrollments`)
      .set('Authorization', 'Bearer token-jugador-1')
      .set('Idempotency-Key', randomUUID())
      .send({ heroId: randomUUID(), difficulty: 'NORMAL', strategyVersion: null })

    expect(response.status).toBe(201)
    await scheduler.tick()
    clock.current = new Date((response.body as { readonly endsAt: string }).endsAt)
    await scheduler.tick()

    return clock.current.toISOString()
  }

  beforeAll(async () => {
    restore = withEnv(ENV)
    app = await compile({
      clock,
      catalog: new StaticAchievementCatalog(CATALOG),
      epics,
      recognitions,
    })

    temploClosedAt = await play('msn_templo_olvidado')
    afterTemplo = await achievements()
    camaraClosedAt = await play('msn_camara_sellada')
    afterCamara = await achievements()
    await app.get<MissionExecutionScheduler>(MISSION_EXECUTION_SCHEDULER).tick()
    afterAnotherCycle = await achievements()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('tras el Templo: sin rasguños desbloqueado y el resto con su progreso, en el orden del contrato', () => {
    // «Sin un rasguño» sale de la evidencia del doble de Combat, que nunca recibe
    // dano: comprueba el camino, no acredita CA-02.
    expect(afterTemplo.items).toEqual([
      item('ach_sin_rasgunos', 'UNLOCKED', 1, 1, temploClosedAt, 'RECORDED'),
      item('ach_historia_completa', 'IN_PROGRESS', 1, 2),
      item('ach_desafio_completo', 'LOCKED', 0, 0),
      item('ach_exploracion_completa', 'LOCKED', 0, 0),
      item('ach_cazador_de_master', 'IN_PROGRESS', 1, 2),
      item('ach_templo_veloz', 'LOCKED', 0, 1),
      item('ach_coleccionista', 'IN_PROGRESS', 1, 2),
    ])
  })

  it('tras la Camara: historia, cazador y coleccion desbloqueados, y el cosmetico entregado una vez', () => {
    expect(afterCamara.items).toEqual([
      item('ach_historia_completa', 'UNLOCKED', 2, 2, camaraClosedAt, 'RECORDED'),
      item('ach_cazador_de_master', 'UNLOCKED', 2, 2, camaraClosedAt, 'RECORDED'),
      item('ach_coleccionista', 'UNLOCKED', 2, 2, camaraClosedAt, 'CREDITED'),
      item('ach_sin_rasgunos', 'UNLOCKED', 1, 1, temploClosedAt, 'RECORDED'),
      item('ach_desafio_completo', 'LOCKED', 0, 0),
      item('ach_exploracion_completa', 'LOCKED', 0, 0),
      item('ach_templo_veloz', 'LOCKED', 0, 1),
    ])
    expect(recognitions.granted()).toEqual([
      {
        operationId: achievementGrantOperationId('sub-1', 'ach_coleccionista'),
        playerId: 'sub-1',
        productId: BANNER,
      },
    ])
    // Las epicas van por su propio doble: dos entregas, ninguna del cosmetico.
    expect(epics.granted().map((grant) => grant.productId)).toEqual([PRODUCT, PRODUCT])
  })

  it('otro ciclo no cambia nada (P-05)', () => {
    expect(afterAnotherCycle).toEqual(afterCamara)
    expect(recognitions.granted()).toHaveLength(1)
  })

  it('cada jugador ve solo lo suyo, y un playerId en la consulta se ignora', async () => {
    const response = await get('/api/v1/missions/me/achievements?playerId=sub-1', 'token-jugador-2')

    expect(response.status).toBe(200)
    expect((response.body as { items: readonly Item[] }).items).toEqual([
      item('ach_historia_completa', 'LOCKED', 0, 2),
      item('ach_desafio_completo', 'LOCKED', 0, 0),
      item('ach_exploracion_completa', 'LOCKED', 0, 0),
      item('ach_cazador_de_master', 'LOCKED', 0, 2),
      item('ach_sin_rasgunos', 'LOCKED', 0, 1),
      item('ach_templo_veloz', 'LOCKED', 0, 1),
      item('ach_coleccionista', 'LOCKED', 0, 2),
    ])
  })

  it.each([
    ['sin token', null, 401],
    ['con un token que no es valido', 'token-falso', 401],
    ['sin el rol PLAYER', 'token-moderador', 403],
  ])('responde %s con %s', async (_caso, token, status) => {
    const call = request(app.getHttpServer()).get('/api/v1/missions/me/achievements')
    const response = await (token === null ? call : call.set('Authorization', `Bearer ${token}`))

    expect(response.status).toBe(status)
  })
})

describe('Logros de misiones por HTTP: catalogo y cableado (Task HU-76.2)', () => {
  let restore: () => void

  beforeAll(() => {
    restore = withEnv(ENV)
  })

  afterAll(() => {
    restore()
  })

  it('con el catalogo aprobado responde 200 con sus siete logros, y el cosmetico usa el cliente de las epicas', async () => {
    const app = await compile({})

    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/missions/me/achievements')
        .set('Authorization', 'Bearer token-jugador-1')
      const items = (
        response.body as { items: readonly { achievementId: string; status: string }[] }
      ).items

      expect(response.status).toBe(200)
      // Decision 1 del PO (2026-09-24): los siete del contrato; un jugador nuevo no tiene ninguno.
      expect(items.map((item) => item.achievementId)).toEqual(
        APPROVED_ACHIEVEMENTS.map((definition) => definition.achievementId),
      )
      expect(items.filter((item) => item.status === 'UNLOCKED')).toEqual([])
      expect(app.get(RECOGNITION_GRANTS)).toBe(app.get(EPIC_GRANTS))
    } finally {
      await app.close()
    }
  })

  it('con MISSIONS_EXAMPLE_CATALOG=true carga los siete logros de ejemplo', async () => {
    const restoreExample = withEnv({ MISSIONS_EXAMPLE_CATALOG: 'true' })
    const app = await compile({})

    try {
      const catalog = app.get<AchievementCatalogPort>(ACHIEVEMENT_CATALOG)

      await expect(catalog.list()).resolves.toEqual(EXAMPLE_ACHIEVEMENTS)
    } finally {
      await app.close()
      restoreExample()
    }
  })
})
