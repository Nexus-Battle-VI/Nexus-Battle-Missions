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
const REPORTS = '/api/v1/missions/me/reports'
const HISTORY = '/api/v1/missions/me/history'

interface Enrolled {
  readonly enrollmentId: string
  readonly startedAt: string
  readonly endsAt: string
}

describe('Reporte e historial por HTTP (Task HU-74.2)', () => {
  const clock = new MovableClock()
  let app: INestApplication
  let restore: () => void
  let normal: Enrolled
  let heroic: Enrolled
  let whileRunning: request.Response

  const get = (path: string, token = 'token-jugador-1') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)

  const enroll = async (difficulty: string): Promise<Enrolled> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/missions/${TEMPLO}/enrollments`)
      .set('Authorization', 'Bearer token-jugador-1')
      .set('Idempotency-Key', randomUUID())
      .send({ heroId: HERO, difficulty, strategyVersion: null })
    expect(response.status).toBe(201)

    return response.body as Enrolled
  }

  // Dos misiones del Templo, Normal y despues Heroico, cada una hasta su cierre.
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
    const executions = app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS)

    normal = await enroll('NORMAL')
    await executions.run()
    whileRunning = await get(`${REPORTS}/${normal.enrollmentId}`)
    clock.current = new Date(normal.endsAt)
    await executions.run()

    heroic = await enroll('HEROIC')
    await executions.run()
    clock.current = new Date(heroic.endsAt)
    await executions.run()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  it('R-5: mientras la mision sigue en curso, REPORT_NOT_AVAILABLE con su fin (CA-04)', () => {
    expect(whileRunning.status).toBe(404)
    expect(whileRunning.body).toEqual({
      statusCode: 404,
      code: 'REPORT_NOT_AVAILABLE',
      message: 'La misión sigue en curso. El reporte estará listo cuando termine.',
      enrollmentId: normal.enrollmentId,
      endsAt: normal.endsAt,
    })
  })

  it('R-1: terminada, el reporte trae los bloques del contrato (CA-01 y CA-02)', async () => {
    const response = await get(`${REPORTS}/${normal.enrollmentId}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      schemaVersion: 1,
      enrollmentId: normal.enrollmentId,
      mission: {
        missionId: TEMPLO,
        name: 'El Templo Olvidado',
        category: 'STORY',
        difficulty: 'NORMAL',
      },
      summary: {
        outcome: 'COMPLETED',
        outcomeReason: null,
        hero: { heroId: HERO, name: 'Guerrero de prueba', subtype: 'GUERRERO_ARMAS' },
        startedAt: normal.startedAt,
        finishedAt: normal.endsAt,
        // El doble de Combat devuelve el presupuesto de tiempo como duracion.
        simulatedDuration: 'PT12H',
      },
      combatStats: { encountersCompleted: 5, encountersTotal: 5, skillsUsed: [] },
      enemies: {
        defeated: [
          { enemyRef: 'sombra-corrompida', name: 'Sombras Corrompidas', count: 10 },
          { enemyRef: 'guardian-de-piedra', name: 'Guardianes de Piedra', count: 5 },
          { enemyRef: 'espectro-ancestral', name: 'Espectros Ancestrales', count: 3 },
        ],
        boss: { enemyRef: 'guardian-eterno', name: 'El Guardián Eterno', defeated: true },
        masters: [],
      },
      generatedAt: normal.endsAt,
    })
    expect(
      (response.body.objectives as { id: string; met: boolean | null }[]).map(({ id, met }) => [
        id,
        met,
      ]),
    ).toEqual([
      ['obj_guardian', true],
      ['obj_camaras', true],
      ['obj_vida', true],
      ['obj_master', null],
      // P-J1: Combat (y su doble) informa el botin; sin fragmentos, el objetivo no se cumple.
      ['obj_fragmentos', false],
    ])
    expect(response.body).not.toHaveProperty('playerId')
  })

  it('R-6: la experiencia de cada derrota llega al reporte, aun sin acreditar (HU-09.5)', async () => {
    const response = await get(`${REPORTS}/${normal.enrollmentId}`)
    const rewards = response.body.rewards as Record<string, unknown>[]

    // Una linea por NPC derrotado -- 10 + 5 + 3 regulares y el jefe -- y ninguna con
    // importe todavia: la tirada la pide el barrido de HU-09, que aqui no corre.
    expect(rewards).toHaveLength(19)
    expect(rewards[0]).toEqual({
      kind: 'EXPERIENCE',
      reference: 'sombra-corrompida#1',
      name: 'Sombras Corrompidas',
      rarity: null,
      quantity: 0,
      status: 'PENDING',
      source: 'HU-09',
    })
    expect(response.body.experience).toEqual({
      defeats: 19,
      totalXp: 0,
      credited: 0,
      pending: 19,
      failed: 0,
      level: null,
      currentXp: null,
      maxLevel: null,
      levelsGained: 0,
      leveledUp: false,
    })
  })

  it('el historial lista las terminadas y pagina con el cursor opaco', async () => {
    const first = await get(`${HISTORY}?limit=1`)

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      items: [
        {
          enrollmentId: heroic.enrollmentId,
          missionId: TEMPLO,
          name: 'El Templo Olvidado',
          category: 'STORY',
          difficulty: 'HEROIC',
          outcome: 'COMPLETED',
          finishedAt: heroic.endsAt,
          simulatedDuration: 'PT12H',
          reportAvailable: true,
        },
      ],
    })
    expect(first.body.nextCursor).toEqual(expect.any(String))

    const second = await get(`${HISTORY}?limit=1&cursor=${String(first.body.nextCursor)}`)

    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({
      items: [{ enrollmentId: normal.enrollmentId, difficulty: 'NORMAL' }],
      nextCursor: null,
    })
  })

  it('H-1: el resumen trae estadisticas, mejores tiempos y progreso narrativo (CA-05)', async () => {
    const response = await get(`${HISTORY}/summary`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      byCategory: [
        {
          category: 'STORY',
          completed: 2,
          failed: 0,
          abandoned: 0,
          damageDealt: 0,
          damageTaken: 0,
        },
        {
          category: 'CHALLENGE',
          completed: 0,
          failed: 0,
          abandoned: 0,
          damageDealt: 0,
          damageTaken: 0,
        },
        {
          category: 'EXPLORATION',
          completed: 0,
          failed: 0,
          abandoned: 0,
          damageDealt: 0,
          damageTaken: 0,
        },
      ],
      bestTimes: [
        {
          missionId: TEMPLO,
          missionName: 'El Templo Olvidado',
          difficulty: 'NORMAL',
          simulatedDuration: 'PT12H',
          enrollmentId: normal.enrollmentId,
        },
        {
          missionId: TEMPLO,
          missionName: 'El Templo Olvidado',
          difficulty: 'HEROIC',
          simulatedDuration: 'PT12H',
          enrollmentId: heroic.enrollmentId,
        },
      ],
      epicCollection: [],
      // El catalogo de ejemplo no tiene epicas enlazadas a productos: el album esta vacio.
      epicAlbum: [],
      lootCollection: [],
      narrativeProgress: [
        {
          chainId: TEMPLO,
          missions: [TEMPLO, CAMARA],
          missionNames: ['El Templo Olvidado', 'La Cámara Sellada'],
          completed: 1,
          total: 2,
        },
      ],
    })
  })

  it('R-6: otro jugador no ve el reporte ni el historial (P-T8)', async () => {
    const report = await get(`${REPORTS}/${normal.enrollmentId}`, 'token-jugador-2')

    expect(report.status).toBe(404)
    expect(report.body).toMatchObject({ code: 'REPORT_NOT_FOUND' })
    await expect(get(HISTORY, 'token-jugador-2')).resolves.toMatchObject({
      status: 200,
      body: { items: [], nextCursor: null },
    })
  })

  it.each([
    ['un identificador de matricula mal formado', `${REPORTS}/enr.x`, 'enrollmentId'],
    ['limit cero', `${HISTORY}?limit=0`, 'limit'],
    ['limit por encima de 50', `${HISTORY}?limit=51`, 'limit'],
    ['limit que no es un numero', `${HISTORY}?limit=muchos`, 'limit'],
    ['un cursor con caracteres ajenos', `${HISTORY}?cursor=no%20vale`, 'cursor'],
    ['un cursor que no dio el servicio', `${HISTORY}?cursor=bm8tZXMtdW4tY3Vyc29y`, 'cursor'],
    ['un jugador en la consulta', `${HISTORY}?playerId=sub-2`, 'playerId'],
  ])('rechaza %s con VALIDATION_ERROR', async (_caso, path, field) => {
    const response = await get(path)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'La solicitud tiene datos que faltan o no son válidos.',
      violations: [expect.objectContaining({ field })],
    })
  })

  it.each([`${REPORTS}/enr_1`, HISTORY, `${HISTORY}/summary`])(
    '%s exige autenticacion y el rol de jugador',
    async (path) => {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(401)
      expect((await get(path, 'token-moderador')).status).toBe(403)
    },
  )
})
