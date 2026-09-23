import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { HealthController } from '../../adapters/inbound/http/health.controller'
import { MissionBoardController } from '../../adapters/inbound/http/mission-board.controller'
import { MissionDifficultyController } from '../../adapters/inbound/http/mission-difficulty.controller'
import { MissionEnrollmentController } from '../../adapters/inbound/http/mission-enrollment.controller'
import { InMemoryHeroCommitments } from '../../adapters/outbound/inventory/InMemoryHeroCommitments'
import { PlayerInventoryCommitmentClient } from '../../adapters/outbound/inventory/PlayerInventoryCommitmentClient'
import { EXAMPLE_MISSIONS } from '../../adapters/outbound/persistence/example-missions'
import { InMemoryEnrollmentRepository } from '../../adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMissionCatalog } from '../../adapters/outbound/persistence/InMemoryMissionCatalog'
import { PostgresEnrollmentRepository } from '../../adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresMissionCatalog } from '../../adapters/outbound/persistence/PostgresMissionCatalog'
import { RandomIdGenerator } from '../../adapters/outbound/system/RandomIdGenerator'
import {
  ENROLLMENT_REPOSITORY,
  type EnrollmentRepositoryPort,
} from '../../application/ports/EnrollmentRepositoryPort'
import {
  HERO_COMMITMENTS,
  type HeroCommitmentPort,
} from '../../application/ports/HeroCommitmentPort'
import { ID_GENERATOR, type IdGeneratorPort } from '../../application/ports/IdGeneratorPort'
import {
  MISSION_CATALOG,
  type MissionCatalogPort,
} from '../../application/ports/MissionCatalogPort'
import { ENROLL_IN_MISSION, EnrollInMission } from '../../application/use-cases/EnrollInMission'
import { GET_MISSION_DETAIL, GetMissionDetail } from '../../application/use-cases/GetMissionDetail'
import { LIST_MISSION_BOARD, ListMissionBoard } from '../../application/use-cases/ListMissionBoard'
import {
  RECONCILE_PENDING_ENROLLMENTS,
  ReconcilePendingEnrollments,
} from '../../application/use-cases/ReconcilePendingEnrollments'
import { EnrollmentReconcilerScheduler } from '../scheduling/EnrollmentReconcilerScheduler'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { InMemoryDifficultyClearRepository } from '../../adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { PostgresDifficultyClearRepository } from '../../adapters/outbound/persistence/PostgresDifficultyClearRepository'
import type { Database } from '../../adapters/outbound/persistence/schema'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { CLOCK, type ClockPort } from '../../application/ports/ClockPort'
import {
  DIFFICULTY_CLEAR_REPOSITORY,
  type DifficultyClearRepositoryPort,
} from '../../application/ports/DifficultyClearRepositoryPort'
import { TOKEN_VERIFIER, type TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import {
  LIST_MISSION_DIFFICULTIES,
  ListMissionDifficulties,
} from '../../application/use-cases/ListMissionDifficulties'
import {
  AuthMode,
  HeroCommitmentsDriver,
  loadConfig,
  PersistenceDriver,
  type AppConfig,
} from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'
import { describeError } from '../observability/describe-error'
import { createLogger, type Logger } from '../observability/logger'
import { createDatabase, pingDatabase } from '../persistence/database'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const DATABASE = Symbol('Database')
export const DATABASE_LIFECYCLE = Symbol('DatabaseLifecycle')
export const ENROLLMENT_RECONCILER = Symbol('EnrollmentReconcilerScheduler')

const usesPostgres = (config: AppConfig, db: Kysely<Database> | null): db is Kysely<Database> =>
  config.persistenceDriver === PersistenceDriver.Postgres && db !== null

/**
 * Sin URL de Player/Inventory o sin secreto interno, la reserva no puede
 * pedirse. No se inventa una respuesta: queda sin confirmar y la matricula sigue
 * PENDING (503), igual que cuando Player/Inventory no responde.
 */
const unconfiguredCommitments: HeroCommitmentPort = {
  commit: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
  release: () => Promise.resolve('UNKNOWN'),
}

/**
 * Servicios autorizados a llamar a las rutas `@InternalOnly()` de Missions.
 *
 * Es la lista de consumidores que ADR-019 declara. Anadir uno es una decision
 * de arquitectura, no un ajuste de configuracion: por eso vive en codigo, donde
 * cambiarla exige un Pull Request revisado.
 */
export const INTERNAL_CALLERS: readonly string[] = []

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran aqui con
 * fabricas explicitas, de modo que la capa de aplicacion permanece
 * independiente del framework.
 */
@Module({
  controllers: [
    HealthController,
    MissionDifficultyController,
    MissionBoardController,
    MissionEnrollmentController,
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: DATABASE,
      useFactory: (config: AppConfig, logger: Logger): Kysely<Database> | null => {
        if (config.persistenceDriver !== PersistenceDriver.Postgres) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })

          return null
        }

        // `loadConfig` ya garantiza que DATABASE_URL existe con este driver.
        if (config.databaseUrl === null) {
          throw new Error('DATABASE_URL es obligatorio con PERSISTENCE_DRIVER=postgres.')
        }

        // El esquema NO se migra aqui: es un paso explicito, `npm run migrate`.
        return createDatabase({
          connectionString: config.databaseUrl,
          onIdleError: (error) => {
            logger.warn('postgres_idle_connection_error', { detail: describeError(error) })
          },
        })
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: DATABASE_LIFECYCLE,
      useFactory: (db: Kysely<Database> | null): { onModuleDestroy: () => Promise<void> } => ({
        onModuleDestroy: async (): Promise<void> => {
          await db?.destroy()
        },
      }),
      inject: [DATABASE],
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: con
          // AUTH_MODE=disabled el guard que lo usaria no se registra.
          logger.warn('authentication_disabled', {
            detail: 'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion.',
          })

          return {
            verify: (): Promise<never> =>
              Promise.reject(new Error('No hay verificador de testimonios configurado.')),
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // El orden importa: NestJS ejecuta los guards globales en el orden en que se
    // declaran. Primero la identidad, despues los roles, despues el contrato
    // interno, que solo actua sobre rutas `@InternalOnly()`.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        clock: ClockPort,
        logger: Logger,
      ): CanActivate =>
        new InternalServiceGuard({
          reflector,
          secret: config.internalServiceAuthSecret,
          allowedServices: INTERNAL_CALLERS,
          clock,
          logger,
        }),
      inject: [APP_CONFIG, Reflector, CLOCK, LOGGER],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (db: Kysely<Database> | null): readonly ReadinessCheck[] =>
        // Con PostgreSQL la sonda va hasta el motor. En memoria no hay
        // dependencia externa que comprobar, y no se inventa una.
        db === null ? [] : [{ name: 'postgres', check: () => pingDatabase(db) }],
      inject: [DATABASE],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
    {
      // Historial de niveles completados (HU-75). Mismo criterio que la base:
      // PostgreSQL con su driver, el doble en memoria solo en desarrollo.
      provide: DIFFICULTY_CLEAR_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
      ): DifficultyClearRepositoryPort =>
        config.persistenceDriver === PersistenceDriver.Postgres && db !== null
          ? new PostgresDifficultyClearRepository(db)
          : new InMemoryDifficultyClearRepository(),
      inject: [APP_CONFIG, DATABASE],
    },
    {
      provide: LIST_MISSION_DIFFICULTIES,
      useFactory: (clears: DifficultyClearRepositoryPort): ListMissionDifficulties =>
        new ListMissionDifficulties(clears),
      inject: [DIFFICULTY_CLEAR_REPOSITORY],
    },
    // --- HU-70: tablon, detalle y matricula ---
    {
      provide: MISSION_CATALOG,
      useFactory: (config: AppConfig, db: Kysely<Database> | null): MissionCatalogPort =>
        usesPostgres(config, db)
          ? new PostgresMissionCatalog(db)
          : new InMemoryMissionCatalog(config.exampleCatalog ? EXAMPLE_MISSIONS : []),
      inject: [APP_CONFIG, DATABASE],
    },
    {
      provide: ENROLLMENT_REPOSITORY,
      useFactory: (config: AppConfig, db: Kysely<Database> | null): EnrollmentRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresEnrollmentRepository(db)
          : new InMemoryEnrollmentRepository(),
      inject: [APP_CONFIG, DATABASE],
    },
    {
      provide: HERO_COMMITMENTS,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): HeroCommitmentPort => {
        if (config.heroCommitmentsDriver === HeroCommitmentsDriver.Memory) {
          logger.warn('hero_commitments_in_memory', {
            detail:
              'HERO_COMMITMENTS_DRIVER=memory: las reservas del héroe no pasan por Player/Inventory.',
          })

          return new InMemoryHeroCommitments()
        }

        if (config.playerInventoryBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('hero_commitments_not_configured', {
            detail:
              'Falta PLAYER_INVENTORY_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: las matrículas quedarán PENDING.',
          })

          return unconfiguredCommitments
        }

        return new PlayerInventoryCommitmentClient({
          baseUrl: config.playerInventoryBaseUrl,
          secret: config.internalServiceAuthSecret,
          clock,
          timeoutMs: config.internalHttpTimeoutMs,
          onFailure: (event, detail) => {
            logger.warn(event, detail)
          },
        })
      },
      inject: [APP_CONFIG, CLOCK, LOGGER],
    },
    {
      provide: ID_GENERATOR,
      useFactory: (): IdGeneratorPort => new RandomIdGenerator(),
    },
    {
      provide: LIST_MISSION_BOARD,
      useFactory: (
        catalog: MissionCatalogPort,
        enrollments: EnrollmentRepositoryPort,
        clears: DifficultyClearRepositoryPort,
      ): ListMissionBoard => new ListMissionBoard(catalog, enrollments, clears),
      inject: [MISSION_CATALOG, ENROLLMENT_REPOSITORY, DIFFICULTY_CLEAR_REPOSITORY],
    },
    {
      provide: GET_MISSION_DETAIL,
      useFactory: (
        catalog: MissionCatalogPort,
        enrollments: EnrollmentRepositoryPort,
        clears: DifficultyClearRepositoryPort,
      ): GetMissionDetail => new GetMissionDetail(catalog, enrollments, clears),
      inject: [MISSION_CATALOG, ENROLLMENT_REPOSITORY, DIFFICULTY_CLEAR_REPOSITORY],
    },
    {
      provide: ENROLL_IN_MISSION,
      useFactory: (
        catalog: MissionCatalogPort,
        enrollments: EnrollmentRepositoryPort,
        clears: DifficultyClearRepositoryPort,
        commitments: HeroCommitmentPort,
        ids: IdGeneratorPort,
        clock: ClockPort,
      ): EnrollInMission =>
        new EnrollInMission(catalog, enrollments, clears, commitments, ids, clock),
      inject: [
        MISSION_CATALOG,
        ENROLLMENT_REPOSITORY,
        DIFFICULTY_CLEAR_REPOSITORY,
        HERO_COMMITMENTS,
        ID_GENERATOR,
        CLOCK,
      ],
    },
    {
      provide: RECONCILE_PENDING_ENROLLMENTS,
      useFactory: (
        catalog: MissionCatalogPort,
        enrollments: EnrollmentRepositoryPort,
        commitments: HeroCommitmentPort,
        clock: ClockPort,
      ): ReconcilePendingEnrollments =>
        new ReconcilePendingEnrollments(catalog, enrollments, commitments, clock),
      inject: [MISSION_CATALOG, ENROLLMENT_REPOSITORY, HERO_COMMITMENTS, CLOCK],
    },
    {
      provide: ENROLLMENT_RECONCILER,
      useFactory: (
        config: AppConfig,
        reconcile: ReconcilePendingEnrollments,
        logger: Logger,
      ): EnrollmentReconcilerScheduler =>
        new EnrollmentReconcilerScheduler(
          reconcile,
          logger,
          config.enrollmentReconcilerIntervalMs,
          config.enrollmentReconcilerEnabled,
        ),
      inject: [APP_CONFIG, RECONCILE_PENDING_ENROLLMENTS, LOGGER],
    },
  ],
})
export class AppModule {}
