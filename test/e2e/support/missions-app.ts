import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import { sql, type Kysely } from 'kysely'
import request from 'supertest'

import { createValidationPipe } from '../../../src/adapters/inbound/http/validation.pipe'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../../src/application/ports/TokenVerifierPort'
import {
  RUN_MISSION_EXECUTIONS,
  type ExecutionCycleSummary,
  type RunMissionExecutions,
} from '../../../src/application/use-cases/RunMissionExecutions'
import {
  AppModule,
  DATABASE,
  EXPERIENCE_REWARD_SCHEDULER,
} from '../../../src/infrastructure/bootstrap/app.module'
import type { Database } from '../../../src/adapters/outbound/persistence/schema'
import type { ExperienceRewardScheduler } from '../../../src/infrastructure/scheduling/ExperienceRewardScheduler'

/**
 * La app REAL de Missions para la cadena de HU-09 (Task HU-09.6).
 *
 * Se sustituyen SOLO dos cosas, y las dos estan declaradas en la evidencia:
 *   - el verificador de testimonio (no hay Cognito en la cadena);
 *   - el resultado de la simulacion, que en la variante real se deja como el
 *     doble de desarrollo porque Combat todavia no produce bitacoras.
 *
 * EL RELOJ NO SE SUSTITUYE, y es deliberado: los clientes internos firman con el
 * reloj de Missions y Combat y Player/Inventory aceptan un sello de ±30 s, asi que
 * adelantarlo horas romperia la cadena. El tiempo se maneja con dos datos de
 * partida: la VENTANA DE LA MATRICULA se desplaza al pasado
 * (`shiftEnrollmentWindow`) y el ESCALONADO DE REINTENTO se vence escribiendo
 * `next_attempt_at` (`makeRewardsDue`).
 *
 * Todo lo demas es produccion: PostgreSQL real, los adaptadores de PostgreSQL,
 * los clientes HTTP firmados hacia Combat y Player/Inventory y el barrido real.
 */

/** El token con el que el verificador sustituido reconoce al jugador. */
export const CHAIN_TOKEN = 'token-cadena-hu-09'

export interface BootOptions {
  readonly databaseUrl: string
  readonly combatBaseUrl: string
  readonly playerInventoryBaseUrl: string
  readonly secret: string
  /** Sujeto del testimonio: es el `playerId` de todo el escenario. */
  readonly subject: string
  /** Sustituciones adicionales, siempre declaradas por el escenario que las pide. */
  readonly overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder
}

export interface MissionsApp {
  readonly app: INestApplication
  readonly db: Kysely<Database>
  /** Un ciclo completo de HU-72: encolar, simular, cerrar y liberar. */
  run: () => Promise<ExecutionCycleSummary>
  /** Un ciclo del barrido de experiencia (HU-09). */
  tick: () => Promise<void>
  get: (path: string) => request.Test
  post: (path: string, body: object) => request.Test
  close: () => Promise<void>
}

const ENV_KEYS = [
  'AUTH_MODE',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'PERSISTENCE_DRIVER',
  'DATABASE_URL',
  'HERO_COMMITMENTS_DRIVER',
  'HERO_ABILITIES_DRIVER',
  'COMBAT_SIMULATION_DRIVER',
  'EPIC_GRANTS_DRIVER',
  'EXPERIENCE_REWARDS_DRIVER',
  'COMBAT_BASE_URL',
  'PLAYER_INVENTORY_BASE_URL',
  'INTERNAL_SERVICE_AUTH_SECRET',
  'INTERNAL_HTTP_TIMEOUT_MS',
  'LOG_LEVEL',
] as const

const previousEnv: Record<string, string | undefined> = {}

/**
 * Fija el entorno de la cadena UNA vez, antes de compilar el primer modulo: la
 * configuracion se lee al construir el modulo y no cambia despues.
 */
export const useChainEnv = (options: Omit<BootOptions, 'subject' | 'overrides'>): void => {
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key]
  }

  Object.assign(process.env, {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_cadena',
    COGNITO_CLIENT_ID: 'cliente-cadena',
    PERSISTENCE_DRIVER: 'postgres',
    DATABASE_URL: options.databaseUrl,
    HERO_COMMITMENTS_DRIVER: 'memory',
    HERO_ABILITIES_DRIVER: 'memory',
    // EL RESULTADO DE LA SIMULACION SE SUSTITUYE, Y NO PORQUE COMBAT NO EXISTA.
    // El ingreso de simulacion de Combat esta en `develop` (HU-72, PR #44). Lo que
    // pasa es que RECHAZA el contenido con `422 MISSION_CONTENT_INVALID`: lo primero
    // que valida es `hero.profile.effectiveStats` y `hero.profile.subtype`, y el
    // perfil que Missions puede enviar hoy es el doble de `HERO_ABILITIES_DRIVER`,
    // que no trae ni una cosa ni la otra. Ese perfil real es `HU-71.2` (Player
    // Inventory PR #48) y sigue sin estar en `develop`.
    //
    // Comprobado de verdad, no supuesto: con `http` en esta linea, la ejecucion
    // termina en `VOIDED` con `outcome_reason = MISSION_CONTENT_INVALID`. El dia que
    // `HU-71.2` entre, esto pasa a `http` y la sustitucion se cae sola.
    COMBAT_SIMULATION_DRIVER: 'memory',
    EPIC_GRANTS_DRIVER: 'memory',
    EXPERIENCE_REWARDS_DRIVER: 'http',
    COMBAT_BASE_URL: options.combatBaseUrl,
    PLAYER_INVENTORY_BASE_URL: options.playerInventoryBaseUrl,
    INTERNAL_SERVICE_AUTH_SECRET: options.secret,
    INTERNAL_HTTP_TIMEOUT_MS: '5000',
    LOG_LEVEL: 'error',
  })
}

export const restoreChainEnv = (): void => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key)
    } else {
      process.env[key] = value
    }
  }
}

/**
 * Deja el estado de las misiones como recien migrado, entre escenarios.
 *
 * LAS TABLAS SE DESCUBREN SOLAS, y es deliberado. La primera version llevaba la
 * lista escrita a mano, y la migracion `009-mission-achievements` la dejo
 * incompleta: el sintoma no fue «faltan filas», fue un `truncate` que revienta
 * con «cannot truncate a table referenced in a foreign key constraint», porque
 * las tablas nuevas referencian a las viejas. Una lista que hay que acordarse de
 * ampliar en cada migracion es una lista que se olvida.
 *
 * Se CONSERVA `mission_definitions`: es el catalogo, y las migraciones
 * `010-playable-missions` y `012-content-v2` lo siembran. Lo que cada escenario
 * tiene que dejar limpio es el estado jugado —matriculas, ejecuciones, informes,
 * recompensas, logros, botin—, no el contenido.
 */
export const truncateMissionTables = async (db: Kysely<Database>): Promise<void> => {
  const { rows } = await sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = current_schema()
      and table_type = 'BASE TABLE'
      and table_name not like 'kysely\_%'
      and table_name <> 'mission_definitions'
    order by table_name`.execute(db)

  if (rows.length === 0) {
    return
  }

  await sql`truncate ${sql.join(
    rows.map((row) => sql.id(row.table_name)),
    sql`, `,
  )} cascade`.execute(db)
}

export const bootMissions = async (options: BootOptions): Promise<MissionsApp> => {
  const identity: VerifiedIdentity = {
    subject: options.subject,
    email: null,
    roles: new Set([Role.Player]),
  }
  const verifier: TokenVerifierPort = {
    verify: (token: string): Promise<VerifiedIdentity> =>
      token === CHAIN_TOKEN
        ? Promise.resolve(identity)
        : Promise.reject(new TokenVerificationError()),
  }

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(verifier)

  const moduleRef = await (
    options.overrides === undefined ? builder : options.overrides(builder)
  ).compile()
  const app = moduleRef.createNestApplication()

  app.setGlobalPrefix('api')
  app.useGlobalPipes(createValidationPipe())
  await app.init()

  const server = app.getHttpServer()

  return {
    app,
    db: app.get<Kysely<Database>>(DATABASE),
    run: () => app.get<RunMissionExecutions>(RUN_MISSION_EXECUTIONS).run(),
    tick: () => app.get<ExperienceRewardScheduler>(EXPERIENCE_REWARD_SCHEDULER).tick(),
    get: (path: string) => request(server).get(path).set('Authorization', `Bearer ${CHAIN_TOKEN}`),
    post: (path: string, body: object) =>
      request(server).post(path).set('Authorization', `Bearer ${CHAIN_TOKEN}`).send(body),
    close: async () => {
      await app.close()
    },
  }
}
