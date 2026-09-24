import 'reflect-metadata'

import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { createValidationPipe } from '../../src/adapters/inbound/http/validation.pipe'
import {
  HERO_COMMITMENTS,
  type CommitHeroOutcome,
  type CommitHeroRequest,
  type HeroCommitmentPort,
} from '../../src/application/ports/HeroCommitmentPort'
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

const buildApp = async (commitments?: HeroCommitmentPort): Promise<INestApplication> => {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(stubVerifier)

  if (commitments !== undefined) {
    builder = builder.overrideProvider(HERO_COMMITMENTS).useValue(commitments)
  }

  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  return app
}

const TEMPLO = 'msn_templo_olvidado'
const CAMARA = 'msn_camara_sellada'
const HERO_A = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_B = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const HOUR_MS = 3_600_000

interface EnrollOptions {
  readonly token?: string
  /** `null` omite la cabecera; sin valor se usa una clave nueva. */
  readonly key?: string | null
}

const enroll = (
  app: INestApplication,
  missionId: string,
  body: object,
  options: EnrollOptions = {},
) => {
  const call = request(app.getHttpServer())
    .post(`/api/v1/missions/${missionId}/enrollments`)
    .set('Authorization', `Bearer ${options.token ?? 'token-jugador-1'}`)

  return options.key === null
    ? call.send(body)
    : call.set('Idempotency-Key', options.key ?? randomUUID()).send(body)
}

describe('Tablón, detalle y matrícula por HTTP (Task HU-70.2)', () => {
  let app: INestApplication
  let restore: () => void

  beforeAll(async () => {
    restore = withEnv({
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_pruebas',
      COGNITO_CLIENT_ID: 'cliente-de-pruebas',
      PERSISTENCE_DRIVER: 'memory',
      HERO_COMMITMENTS_DRIVER: 'memory',
      MISSIONS_EXAMPLE_CATALOG: 'true',
      LOG_LEVEL: 'error',
    })
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    restore()
  })

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)

  describe('GET /api/v1/missions', () => {
    it('exige autenticación y el rol de jugador', async () => {
      expect((await request(app.getHttpServer()).get('/api/v1/missions')).status).toBe(401)
      expect((await get('/api/v1/missions', 'token-moderador')).status).toBe(403)
    })

    it('lista las misiones activas con el estado del jugador (CA-07)', async () => {
      const response = await get('/api/v1/missions', 'token-jugador-2')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        items: [
          {
            missionId: TEMPLO,
            name: 'El Templo Olvidado',
            category: 'STORY',
            summary: 'Un templo custodiado por criaturas corrompidas y un guardián milenario.',
            imageRef: null,
            estimatedDuration: 'PT12H',
            recommendedPower: 15,
            highlightedRewards: [{ label: '50 créditos' }, { label: '1 Cofre de Bronce' }],
            playerStatus: 'AVAILABLE',
            canEnroll: true,
            lockReason: null,
            activeEnrollmentId: null,
          },
          {
            missionId: CAMARA,
            name: 'La Cámara Sellada',
            category: 'STORY',
            summary: 'Ejemplo de misión con requisito previo.',
            imageRef: null,
            estimatedDuration: 'PT6H',
            recommendedPower: null,
            highlightedRewards: [{ label: '30 créditos' }, { label: 'Núcleo del Sello' }],
            playerStatus: 'LOCKED',
            canEnroll: false,
            lockReason: 'Completa primero «El Templo Olvidado».',
            activeEnrollmentId: null,
          },
        ],
      })
    })

    it('filtra por categoría y estado', async () => {
      const response = await get('/api/v1/missions?category=STORY&status=LOCKED', 'token-jugador-2')

      expect(response.status).toBe(200)
      expect(response.body.items.map((item: { missionId: string }) => item.missionId)).toEqual([
        CAMARA,
      ])
    })

    it.each([
      ['una categoría fuera del vocabulario', '?category=RAID'],
      ['un estado fuera del vocabulario', '?status=DONE'],
      ['un jugador en la consulta', '?playerId=sub-1'],
    ])('rechaza %s con VALIDATION_ERROR', async (_caso, query) => {
      const response = await get(`/api/v1/missions${query}`, 'token-jugador-2')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'La solicitud tiene datos que faltan o no son válidos.',
      })
    })
  })

  describe('GET /api/v1/missions/:missionId', () => {
    it('trae todo lo que el jugador revisa antes de confirmar (CA-06)', async () => {
      const response = await get(`/api/v1/missions/${TEMPLO}`, 'token-jugador-2')

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        missionId: TEMPLO,
        estimatedDuration: 'PT12H',
        recommendedPower: 15,
        prerequisites: [],
        finalBoss: {
          name: 'El Guardián Eterno',
          heroType: 'GUERRERO_TANQUE',
          stats: { health: 100 },
        },
        masterEncounter: {
          probability: 0.15,
          candidates: [{ name: 'Sombra del Olvido', heroType: 'PICARO_VENENO' }],
        },
        rewards: {
          potential: [
            { label: 'Fragmento del Sello Antiguo', probability: 0.6, rolls: 3 },
            { label: 'Armadura «Piel del Guardián»', probability: 0.2, rolls: 1 },
            { label: 'Arma «Espada del Templo»', probability: 0.15, rolls: 1 },
          ],
        },
        playerStatus: 'AVAILABLE',
        canEnroll: true,
        lockReason: null,
      })
      expect(response.body.objectives).toHaveLength(5)
      expect(response.body.enemies[0]).toEqual({
        name: 'Sombras Corrompidas',
        count: 10,
        description: 'Enemigos básicos con ataque moderado.',
      })
    })

    it('una misión inexistente es MISSION_NOT_FOUND', async () => {
      const response = await get('/api/v1/missions/msn_inexistente', 'token-jugador-2')

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({
        code: 'MISSION_NOT_FOUND',
        missionId: 'msn_inexistente',
      })
    })

    it('un identificador mal formado es VALIDATION_ERROR', async () => {
      const response = await get('/api/v1/missions/msn.x', 'token-jugador-2')

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        violations: [{ field: 'missionId' }],
      })
    })
  })

  describe('POST /api/v1/missions/:missionId/enrollments', () => {
    const body = { heroId: HERO_A, difficulty: 'NORMAL', strategyVersion: null }

    it('exige el rol de jugador', async () => {
      expect((await enroll(app, TEMPLO, body, { token: 'token-moderador' })).status).toBe(403)
    })

    it.each([
      ['sin la cabecera', null],
      ['con una clave que no es un UUID', 'clave-1'],
    ])('rechaza la matrícula %s con IDEMPOTENCY_KEY_REQUIRED', async (_caso, key) => {
      const response = await enroll(app, TEMPLO, body, { key })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    })

    it('valida la cabecera antes de buscar la misión', async () => {
      expect((await enroll(app, 'msn_inexistente', body, { key: null })).status).toBe(400)
    })

    it.each([
      ['sin heroId', { difficulty: 'NORMAL' }],
      ['con un heroId que no es un UUID', { heroId: 'heroe-1', difficulty: 'NORMAL' }],
      ['con un campo que el contrato no admite', { ...body, playerId: 'sub-2' }],
      ['con una versión de estrategia no entera', { ...body, strategyVersion: 1.5 }],
    ])('rechaza el cuerpo %s con VALIDATION_ERROR', async (_caso, invalid) => {
      const response = await enroll(app, TEMPLO, invalid)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it.each([
      ['sin dificultad', { heroId: HERO_A }],
      ['con una dificultad desconocida', { heroId: HERO_A, difficulty: 'EPIC' }],
    ])('responde UNKNOWN_DIFFICULTY %s (HU-75)', async (_caso, invalid) => {
      const response = await enroll(app, TEMPLO, invalid)

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: 'UNKNOWN_DIFFICULTY' })
    })

    it('una misión inexistente es MISSION_NOT_FOUND', async () => {
      const response = await enroll(app, 'msn_inexistente', body)

      expect(response.status).toBe(404)
      expect(response.body).toMatchObject({ code: 'MISSION_NOT_FOUND' })
    })

    it('una misión con requisitos pendientes es MISSION_LOCKED (CA-07)', async () => {
      const response = await enroll(app, CAMARA, body)

      expect(response.status).toBe(422)
      expect(response.body).toEqual({
        statusCode: 422,
        code: 'MISSION_LOCKED',
        message: 'Completa primero «El Templo Olvidado».',
        missionId: CAMARA,
        missingPrerequisites: [TEMPLO],
      })
    })

    it('un nivel sin desbloquear es PROGRESSION_LOCKED (HU-75)', async () => {
      const response = await enroll(app, TEMPLO, { ...body, difficulty: 'HEROIC' })

      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({
        code: 'PROGRESSION_LOCKED',
        requested: 'HEROIC',
        required: 'NORMAL',
      })
    })

    it('sin estrategia guardada, pedir una versión es STRATEGY_VERSION_MISMATCH (HU-71)', async () => {
      const response = await enroll(app, TEMPLO, { ...body, strategyVersion: 1 })

      expect(response.status).toBe(409)
      expect(response.body).toMatchObject({
        code: 'STRATEGY_VERSION_MISMATCH',
        expectedVersion: 1,
        currentVersion: null,
      })
    })

    describe('una matrícula confirmada', () => {
      const key = randomUUID()
      let first: request.Response

      beforeAll(async () => {
        first = await enroll(app, TEMPLO, body, { key })
      })

      it('responde 201 IN_PROGRESS con el fin calculado por el servidor (CA-01)', () => {
        expect(first.status).toBe(201)
        expect(first.body).toMatchObject({
          missionId: TEMPLO,
          heroId: HERO_A,
          difficulty: 'NORMAL',
          status: 'IN_PROGRESS',
        })
        expect(first.body.enrollmentId).toMatch(/^enr_/)
        expect(Date.parse(first.body.endsAt) - Date.parse(first.body.startedAt)).toBe(12 * HOUR_MS)
      })

      it('el tablón la muestra en curso y no deja repetirla', async () => {
        const items = (await get('/api/v1/missions', 'token-jugador-1')).body.items

        expect(items[0]).toMatchObject({
          missionId: TEMPLO,
          playerStatus: 'IN_PROGRESS',
          canEnroll: false,
          activeEnrollmentId: first.body.enrollmentId,
        })
      })

      it('repetir la pulsación con la misma clave devuelve la misma matrícula', async () => {
        const replay = await enroll(app, TEMPLO, body, { key })

        expect(replay.status).toBe(201)
        expect(replay.body).toEqual(first.body)
      })

      it('la clave y el héroe se comparan sin distinguir mayúsculas', async () => {
        const replay = await enroll(
          app,
          TEMPLO,
          { ...body, heroId: HERO_A.toUpperCase() },
          { key: key.toUpperCase() },
        )

        expect(replay.status).toBe(201)
        expect(replay.body.enrollmentId).toBe(first.body.enrollmentId)
      })

      it('la misma clave con otro cuerpo es IDEMPOTENCY_KEY_REUSED', async () => {
        const response = await enroll(app, TEMPLO, { ...body, heroId: HERO_B }, { key })

        expect(response.status).toBe(409)
        expect(response.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
      })

      it('otra pulsación para la misma misión es MISSION_ALREADY_IN_PROGRESS', async () => {
        const response = await enroll(app, TEMPLO, { ...body, heroId: HERO_B })

        expect(response.status).toBe(409)
        expect(response.body).toMatchObject({
          code: 'MISSION_ALREADY_IN_PROGRESS',
          enrollmentId: first.body.enrollmentId,
        })
      })

      it('el héroe en misión no puede entrar en otra: HERO_BUSY (CA-02)', async () => {
        const response = await enroll(app, TEMPLO, body, { token: 'token-jugador-2' })

        expect(response.status).toBe(409)
        expect(response.body).toEqual({
          statusCode: 409,
          code: 'HERO_BUSY',
          message: 'Este héroe ya está en otra misión.',
          heroId: HERO_A,
          busyWith: 'MISSION',
        })
      })
    })
  })

  describe('con Player/Inventory rechazando o sin responder', () => {
    const HERO_LOADOUT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'
    const HERO_BATTLE = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e'
    const HERO_FOREIGN = '3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f'
    const HERO_NOT_READY = '4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a'
    const OUTCOMES = new Map<string, CommitHeroOutcome>([
      [
        HERO_LOADOUT,
        {
          kind: 'REJECTED',
          rejection: { code: 'LOADOUT_INCOMPLETE', missingSlots: [{ family: 'ITEM', missing: 2 }] },
        },
      ],
      [
        HERO_BATTLE,
        { kind: 'REJECTED', rejection: { code: 'HERO_COMMITTED', busyWith: 'BATTLE' } },
      ],
      [HERO_FOREIGN, { kind: 'REJECTED', rejection: { code: 'HERO_NOT_OWNED' } }],
      [
        HERO_NOT_READY,
        {
          kind: 'REJECTED',
          rejection: {
            code: 'HERO_NOT_READY',
            blockers: [{ code: 'EQUIPPED_PRODUCT_NOT_OWNED', slot: 'WEAPON_1' }],
          },
        },
      ],
    ])
    // Cualquier otro heroe: Player/Inventory no confirma (caido o ruta inexistente).
    const scripted: HeroCommitmentPort = {
      commit: (commitRequest: CommitHeroRequest) =>
        Promise.resolve(
          OUTCOMES.get(commitRequest.heroId) ?? { kind: 'UNKNOWN', reason: 'HTTP_503' },
        ),
      release: () => Promise.resolve('UNKNOWN'),
    }
    let scriptedApp: INestApplication

    beforeAll(async () => {
      scriptedApp = await buildApp(scripted)
    })

    afterAll(async () => {
      await scriptedApp.close()
    })

    it.each([
      [
        'mazo incompleto (CA-04)',
        HERO_LOADOUT,
        422,
        { code: 'LOADOUT_INCOMPLETE', missingSlots: [{ family: 'ITEM', missing: 2 }] },
      ],
      [
        'héroe en batalla (CA-03)',
        HERO_BATTLE,
        409,
        { code: 'HERO_BUSY', busyWith: 'BATTLE', message: 'Este héroe está en una batalla.' },
      ],
      ['héroe ajeno', HERO_FOREIGN, 422, { code: 'HERO_NOT_OWNED', heroId: HERO_FOREIGN }],
      [
        'héroe no listo',
        HERO_NOT_READY,
        422,
        {
          code: 'HERO_NOT_READY',
          blockers: [{ code: 'EQUIPPED_PRODUCT_NOT_OWNED', slot: 'WEAPON_1' }],
        },
      ],
    ])(
      'el rechazo por %s llega al jugador y se repite con la misma clave',
      async (_caso, heroId, status, expected) => {
        const key = randomUUID()
        const first = await enroll(scriptedApp, TEMPLO, { heroId, difficulty: 'NORMAL' }, { key })
        const replay = await enroll(scriptedApp, TEMPLO, { heroId, difficulty: 'NORMAL' }, { key })

        expect(first.status).toBe(status)
        expect(first.body).toMatchObject(expected)
        expect(replay.status).toBe(status)
        expect(replay.body).toEqual(first.body)
      },
    )

    it('sin confirmación responde 503 y la matrícula sigue PENDING, ocupando la misión', async () => {
      const key = randomUUID()
      const pendingBody = { heroId: HERO_A, difficulty: 'NORMAL' }
      const first = await enroll(scriptedApp, TEMPLO, pendingBody, {
        key,
        token: 'token-jugador-2',
      })

      expect(first.status).toBe(503)
      expect(first.body).toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        enrollmentStatus: 'PENDING',
        message: 'No pudimos confirmar la reserva del héroe. Vuelve a intentarlo en unos segundos.',
      })
      expect(first.body.enrollmentId).toMatch(/^enr_/)

      const replay = await enroll(scriptedApp, TEMPLO, pendingBody, {
        key,
        token: 'token-jugador-2',
      })
      expect(replay.status).toBe(503)
      expect(replay.body.enrollmentId).toBe(first.body.enrollmentId)

      const board = await request(scriptedApp.getHttpServer())
        .get('/api/v1/missions')
        .set('Authorization', 'Bearer token-jugador-2')
      expect(board.body.items[0]).toMatchObject({
        playerStatus: 'IN_PROGRESS',
        activeEnrollmentId: first.body.enrollmentId,
      })
    })
  })
})
