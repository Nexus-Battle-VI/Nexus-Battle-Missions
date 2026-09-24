import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Kysely } from 'kysely'

import { HealthController } from '../../adapters/inbound/http/health.controller'
import { MissionAchievementController } from '../../adapters/inbound/http/mission-achievement.controller'
import { MissionBoardController } from '../../adapters/inbound/http/mission-board.controller'
import { MissionContentController } from '../../adapters/inbound/http/mission-content.controller'
import { MissionDifficultyController } from '../../adapters/inbound/http/mission-difficulty.controller'
import { MissionEnrollmentController } from '../../adapters/inbound/http/mission-enrollment.controller'
import { MissionReportController } from '../../adapters/inbound/http/mission-report.controller'
import { MissionStrategyController } from '../../adapters/inbound/http/mission-strategy.controller'
import { CombatSimulationClient } from '../../adapters/outbound/combat/CombatSimulationClient'
import { ScriptedCombatSimulation } from '../../adapters/outbound/combat/ScriptedCombatSimulation'
import { InMemoryEpicGrants } from '../../adapters/outbound/inventory/InMemoryEpicGrants'
import { InMemoryHeroAbilities } from '../../adapters/outbound/inventory/InMemoryHeroAbilities'
import { InMemoryHeroCommitments } from '../../adapters/outbound/inventory/InMemoryHeroCommitments'
import { PlayerInventoryAbilitiesClient } from '../../adapters/outbound/inventory/PlayerInventoryAbilitiesClient'
import { PlayerInventoryCommitmentClient } from '../../adapters/outbound/inventory/PlayerInventoryCommitmentClient'
import { PlayerInventoryEpicGrantClient } from '../../adapters/outbound/inventory/PlayerInventoryEpicGrantClient'
import { APPROVED_ACHIEVEMENTS } from '../../adapters/outbound/persistence/approved-achievements'
import { EXAMPLE_ACHIEVEMENTS } from '../../adapters/outbound/persistence/example-achievements'
import { EXAMPLE_MISSIONS } from '../../adapters/outbound/persistence/example-missions'
import { InMemoryAchievementEvidence } from '../../adapters/outbound/persistence/InMemoryAchievementEvidence'
import { InMemoryAchievementRepository } from '../../adapters/outbound/persistence/InMemoryAchievementRepository'
import { InMemoryEnrollmentRepository } from '../../adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryMasterEncounterRepository } from '../../adapters/outbound/persistence/InMemoryMasterEncounterRepository'
import { InMemoryMissionCatalog } from '../../adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryReportRepository } from '../../adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../adapters/outbound/persistence/InMemoryStrategyRepository'
import { PostgresAchievementEvidence } from '../../adapters/outbound/persistence/PostgresAchievementEvidence'
import { PostgresAchievementRepository } from '../../adapters/outbound/persistence/PostgresAchievementRepository'
import { PostgresEnrollmentRepository } from '../../adapters/outbound/persistence/PostgresEnrollmentRepository'
import { PostgresExecutionRepository } from '../../adapters/outbound/persistence/PostgresExecutionRepository'
import { PostgresMasterEncounterRepository } from '../../adapters/outbound/persistence/PostgresMasterEncounterRepository'
import { PostgresMissionCatalog } from '../../adapters/outbound/persistence/PostgresMissionCatalog'
import { PostgresReportRepository } from '../../adapters/outbound/persistence/PostgresReportRepository'
import { PostgresStrategyRepository } from '../../adapters/outbound/persistence/PostgresStrategyRepository'
import { RandomIdGenerator } from '../../adapters/outbound/system/RandomIdGenerator'
import { StaticAchievementCatalog } from '../../adapters/outbound/persistence/StaticAchievementCatalog'
import {
  ACHIEVEMENT_CATALOG,
  type AchievementCatalogPort,
} from '../../application/ports/AchievementCatalogPort'
import {
  ACHIEVEMENT_EVIDENCE,
  type AchievementEvidencePort,
} from '../../application/ports/AchievementEvidencePort'
import {
  ACHIEVEMENT_REPOSITORY,
  type AchievementRepositoryPort,
} from '../../application/ports/AchievementRepositoryPort'
import {
  RECOGNITION_GRANTS,
  type RecognitionGrantPort,
} from '../../application/ports/RecognitionGrantPort'
import {
  EVALUATE_MISSION_ACHIEVEMENTS,
  EvaluateMissionAchievements,
} from '../../application/use-cases/EvaluateMissionAchievements'
import {
  GET_MISSION_ACHIEVEMENTS,
  GetMissionAchievements,
} from '../../application/use-cases/GetMissionAchievements'
import {
  GRANT_ACHIEVEMENT_RECOGNITIONS,
  GrantAchievementRecognitions,
} from '../../application/use-cases/GrantAchievementRecognitions'
import {
  COMBAT_SIMULATION,
  type CombatSimulationPort,
} from '../../application/ports/CombatSimulationPort'
import {
  ENROLLMENT_REPOSITORY,
  type EnrollmentRepositoryPort,
} from '../../application/ports/EnrollmentRepositoryPort'
import { EPIC_GRANTS, type EpicGrantPort } from '../../application/ports/EpicGrantPort'
import {
  EXECUTION_REPOSITORY,
  type ExecutionRepositoryPort,
} from '../../application/ports/ExecutionRepositoryPort'
import {
  HERO_ABILITIES,
  HERO_PROFILES,
  type HeroAbilitiesPort,
  type HeroProfilePort,
} from '../../application/ports/HeroAbilitiesPort'
import {
  HERO_COMMITMENTS,
  type HeroCommitmentPort,
} from '../../application/ports/HeroCommitmentPort'
import { ID_GENERATOR, type IdGeneratorPort } from '../../application/ports/IdGeneratorPort'
import {
  MASTER_ENCOUNTER_REPOSITORY,
  type MasterEncounterRepositoryPort,
} from '../../application/ports/MasterEncounterRepositoryPort'
import {
  MISSION_CATALOG,
  type MissionCatalogPort,
} from '../../application/ports/MissionCatalogPort'
import { MISSION_CONTENT } from '../../application/ports/MissionContentPort'
import {
  REPORT_REPOSITORY,
  type ReportRepositoryPort,
} from '../../application/ports/ReportRepositoryPort'
import {
  STRATEGY_REPOSITORY,
  type StrategyRepositoryPort,
} from '../../application/ports/StrategyRepositoryPort'
import { ENROLL_IN_MISSION, EnrollInMission } from '../../application/use-cases/EnrollInMission'
import { GET_MISSION_DETAIL, GetMissionDetail } from '../../application/use-cases/GetMissionDetail'
import { GRANT_MASTER_EPICS, GrantMasterEpics } from '../../application/use-cases/GrantMasterEpics'
import { GRANT_MISSION_LOOT, GrantMissionLoot } from '../../application/use-cases/GrantMissionLoot'
import { LOOT_GRANTS, type LootGrantPort } from '../../application/ports/LootGrantPort'
import {
  LOOT_GRANT_REPOSITORY,
  type LootGrantRepositoryPort,
} from '../../application/ports/LootGrantRepositoryPort'
import { InMemoryLootGrantRepository } from '../../adapters/outbound/persistence/InMemoryLootGrantRepository'
import { PostgresLootGrantRepository } from '../../adapters/outbound/persistence/PostgresLootGrantRepository'
import {
  COORDINATE_EXPERIENCE_REWARD,
  CoordinateExperienceReward,
} from '../../application/use-cases/CoordinateExperienceReward'
import {
  EXPERIENCE_ROLLS,
  type ExperienceRollPort,
} from '../../application/ports/ExperienceRollPort'
import {
  EXPERIENCE_CREDITS,
  type ExperienceCreditPort,
} from '../../application/ports/ExperienceCreditPort'
import {
  EXPERIENCE_REWARD_REPOSITORY,
  type ExperienceRewardRepositoryPort,
} from '../../application/ports/ExperienceRewardRepositoryPort'
import { CombatExperienceRollClient } from '../../adapters/outbound/combat/CombatExperienceRollClient'
import { InMemoryExperienceRolls } from '../../adapters/outbound/combat/InMemoryExperienceRolls'
import { InMemoryExperienceCredits } from '../../adapters/outbound/inventory/InMemoryExperienceCredits'
import { PlayerInventoryExperienceClient } from '../../adapters/outbound/inventory/PlayerInventoryExperienceClient'
import { InMemoryExperienceRewardRepository } from '../../adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { PostgresExperienceRewardRepository } from '../../adapters/outbound/persistence/PostgresExperienceRewardRepository'
import {
  GET_MISSION_HISTORY_SUMMARY,
  GetMissionHistorySummary,
} from '../../application/use-cases/GetMissionHistorySummary'
import { GET_MISSION_REPORT, GetMissionReport } from '../../application/use-cases/GetMissionReport'
import {
  GET_MISSION_STRATEGY,
  GetMissionStrategy,
} from '../../application/use-cases/GetMissionStrategy'
import { LIST_MISSION_BOARD, ListMissionBoard } from '../../application/use-cases/ListMissionBoard'
import {
  LIST_MISSION_HISTORY,
  ListMissionHistory,
} from '../../application/use-cases/ListMissionHistory'
import {
  RECONCILE_PENDING_ENROLLMENTS,
  ReconcilePendingEnrollments,
} from '../../application/use-cases/ReconcilePendingEnrollments'
import {
  RUN_MISSION_EXECUTIONS,
  RunMissionExecutions,
} from '../../application/use-cases/RunMissionExecutions'
import {
  SAVE_MISSION_STRATEGY,
  SaveMissionStrategy,
} from '../../application/use-cases/SaveMissionStrategy'
import { EnrollmentReconcilerScheduler } from '../scheduling/EnrollmentReconcilerScheduler'
import { MissionExecutionScheduler } from '../scheduling/MissionExecutionScheduler'
import { ExperienceRewardScheduler } from '../scheduling/ExperienceRewardScheduler'
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
  IntegrationDriver,
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
export const MISSION_EXECUTION_SCHEDULER = Symbol('MissionExecutionScheduler')
export const EXPERIENCE_REWARD_SCHEDULER = Symbol('ExperienceRewardScheduler')

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
 * Igual para el heroe: sin configuracion, guardar una estrategia es 503 y la
 * simulacion espera su perfil.
 */
const unconfiguredHeroes: HeroAbilitiesPort & HeroProfilePort = {
  abilitiesOf: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
  profileOf: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
}

/** Y para Combat: la simulacion espera y la mision se anula al vencer su plazo. */
const unconfiguredSimulations: CombatSimulationPort = {
  simulate: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
}

/** Igual para las epicas de HU-73: sin configuracion, la entrega queda pendiente. */
const unconfiguredEpicGrants: EpicGrantPort = {
  grant: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
}

/** HU-09: sin configuracion no se tira, y la recompensa queda esperando. */
const unconfiguredRolls: ExperienceRollPort = {
  rollDefeats: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
}

/** Ni se acredita: la recompensa queda en su estado no terminal y se reintenta. */
const unconfiguredCredits: ExperienceCreditPort = {
  credit: () => Promise.resolve({ kind: 'UNKNOWN', reason: 'NOT_CONFIGURED' }),
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
    MissionContentController,
    MissionEnrollmentController,
    MissionStrategyController,
    MissionReportController,
    MissionAchievementController,
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
      useFactory: (
        clears: DifficultyClearRepositoryPort,
        catalog: MissionCatalogPort,
      ): ListMissionDifficulties => new ListMissionDifficulties(clears, catalog),
      inject: [DIFFICULTY_CLEAR_REPOSITORY, MISSION_CATALOG],
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
    { provide: MISSION_CONTENT, useExisting: MISSION_CATALOG },
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
        if (config.heroCommitmentsDriver === IntegrationDriver.Memory) {
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
        strategies: StrategyRepositoryPort,
        commitments: HeroCommitmentPort,
        ids: IdGeneratorPort,
        clock: ClockPort,
      ): EnrollInMission =>
        new EnrollInMission(catalog, enrollments, clears, strategies, commitments, ids, clock),
      inject: [
        MISSION_CATALOG,
        ENROLLMENT_REPOSITORY,
        DIFFICULTY_CLEAR_REPOSITORY,
        STRATEGY_REPOSITORY,
        HERO_COMMITMENTS,
        ID_GENERATOR,
        CLOCK,
      ],
    },
    // --- HU-71: estrategia de rotaciones ---
    {
      provide: STRATEGY_REPOSITORY,
      useFactory: (config: AppConfig, db: Kysely<Database> | null): StrategyRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresStrategyRepository(db)
          : new InMemoryStrategyRepository(),
      inject: [APP_CONFIG, DATABASE],
    },
    {
      provide: HERO_ABILITIES,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): HeroAbilitiesPort => {
        if (config.heroAbilitiesDriver === IntegrationDriver.Memory) {
          logger.warn('hero_abilities_in_memory', {
            detail:
              'HERO_ABILITIES_DRIVER=memory: las habilidades del héroe no se validan con Player/Inventory.',
          })

          return new InMemoryHeroAbilities()
        }

        if (config.playerInventoryBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('hero_abilities_not_configured', {
            detail:
              'Falta PLAYER_INVENTORY_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: guardar una estrategia responderá 503.',
          })

          return unconfiguredHeroes
        }

        return new PlayerInventoryAbilitiesClient({
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
      provide: GET_MISSION_STRATEGY,
      useFactory: (
        catalog: MissionCatalogPort,
        strategies: StrategyRepositoryPort,
      ): GetMissionStrategy => new GetMissionStrategy(catalog, strategies),
      inject: [MISSION_CATALOG, STRATEGY_REPOSITORY],
    },
    {
      provide: SAVE_MISSION_STRATEGY,
      useFactory: (
        catalog: MissionCatalogPort,
        strategies: StrategyRepositoryPort,
        abilities: HeroAbilitiesPort,
        clock: ClockPort,
      ): SaveMissionStrategy => new SaveMissionStrategy(catalog, strategies, abilities, clock),
      inject: [MISSION_CATALOG, STRATEGY_REPOSITORY, HERO_ABILITIES, CLOCK],
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
    // --- HU-72: simulacion y cierre de la mision ---
    {
      provide: EXECUTION_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        enrollments: EnrollmentRepositoryPort,
        clears: DifficultyClearRepositoryPort,
        reports: ReportRepositoryPort,
        masters: MasterEncounterRepositoryPort,
        experience: ExperienceRewardRepositoryPort,
        loot: LootGrantRepositoryPort,
      ): ExecutionRepositoryPort => {
        if (usesPostgres(config, db)) {
          return new PostgresExecutionRepository(db)
        }

        // En memoria, el cierre escribe a la vez en los dobles de matriculas,
        // clears, reportes y evidencia del Master. Si una prueba los sustituyo,
        // las ejecuciones no los ven.
        const reportsInMemory =
          reports instanceof InMemoryReportRepository ? reports : new InMemoryReportRepository()

        return new InMemoryExecutionRepository(
          enrollments instanceof InMemoryEnrollmentRepository
            ? enrollments
            : new InMemoryEnrollmentRepository(),
          clears instanceof InMemoryDifficultyClearRepository
            ? clears
            : new InMemoryDifficultyClearRepository(),
          reportsInMemory,
          masters instanceof InMemoryMasterEncounterRepository
            ? masters
            : new InMemoryMasterEncounterRepository(reportsInMemory),
          // HU-09 (Task HU-09.5): el cierre inserta aqui las recompensas PENDING, y
          // el barrido que las tira y las acredita lee de ESTE mismo doble. Con uno
          // distinto, en memoria se cerraban misiones cuyas recompensas nadie veia.
          experience instanceof InMemoryExperienceRewardRepository
            ? experience
            : new InMemoryExperienceRewardRepository(reportsInMemory),
          // P-J1: la entrega del botin lee de ESTE mismo doble lo que escribe el cierre.
          loot instanceof InMemoryLootGrantRepository
            ? loot
            : new InMemoryLootGrantRepository(reportsInMemory),
        )
      },
      inject: [
        APP_CONFIG,
        DATABASE,
        ENROLLMENT_REPOSITORY,
        DIFFICULTY_CLEAR_REPOSITORY,
        REPORT_REPOSITORY,
        MASTER_ENCOUNTER_REPOSITORY,
        EXPERIENCE_REWARD_REPOSITORY,
        LOOT_GRANT_REPOSITORY,
      ],
    },
    // El perfil del heroe sale de la misma consulta a Player/Inventory que sus habilidades.
    { provide: HERO_PROFILES, useExisting: HERO_ABILITIES },
    {
      provide: COMBAT_SIMULATION,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): CombatSimulationPort => {
        if (config.combatSimulationDriver === IntegrationDriver.Memory) {
          logger.warn('combat_simulation_in_memory', {
            detail:
              'COMBAT_SIMULATION_DRIVER=memory: Combat no simula las misiones; el resultado es fijo.',
          })

          return new ScriptedCombatSimulation()
        }

        if (config.combatBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('combat_simulation_not_configured', {
            detail:
              'Falta COMBAT_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: las misiones esperarán y se anularán al vencer su plazo.',
          })

          return unconfiguredSimulations
        }

        return new CombatSimulationClient({
          baseUrl: config.combatBaseUrl,
          secret: config.internalServiceAuthSecret,
          clock,
          timeoutMs: config.combatSimulationTimeoutMs,
          onFailure: (event, detail) => {
            logger.warn(event, detail)
          },
        })
      },
      inject: [APP_CONFIG, CLOCK, LOGGER],
    },
    {
      provide: RUN_MISSION_EXECUTIONS,
      useFactory: (
        executions: ExecutionRepositoryPort,
        enrollments: EnrollmentRepositoryPort,
        catalog: MissionCatalogPort,
        heroes: HeroProfilePort,
        combat: CombatSimulationPort,
        commitments: HeroCommitmentPort,
        ids: IdGeneratorPort,
        clock: ClockPort,
        logger: Logger,
      ): RunMissionExecutions =>
        new RunMissionExecutions(
          executions,
          enrollments,
          catalog,
          heroes,
          combat,
          commitments,
          ids,
          clock,
          {
            batchSize: 50,
            onError: (enrollmentId, error) => {
              logger.warn('mission_execution_error', {
                enrollmentId,
                detail: describeError(error),
              })
            },
          },
        ),
      inject: [
        EXECUTION_REPOSITORY,
        ENROLLMENT_REPOSITORY,
        MISSION_CATALOG,
        HERO_PROFILES,
        COMBAT_SIMULATION,
        HERO_COMMITMENTS,
        ID_GENERATOR,
        CLOCK,
        LOGGER,
      ],
    },
    {
      provide: MISSION_EXECUTION_SCHEDULER,
      useFactory: (
        config: AppConfig,
        executions: RunMissionExecutions,
        logger: Logger,
        epics: GrantMasterEpics,
        achievements: EvaluateMissionAchievements,
        recognitions: GrantAchievementRecognitions,
        loot: GrantMissionLoot,
      ): MissionExecutionScheduler =>
        new MissionExecutionScheduler(
          executions,
          logger,
          config.missionExecutionIntervalMs,
          config.missionExecutionEnabled,
          epics,
          achievements,
          recognitions,
          loot,
        ),
      inject: [
        APP_CONFIG,
        RUN_MISSION_EXECUTIONS,
        LOGGER,
        GRANT_MASTER_EPICS,
        EVALUATE_MISSION_ACHIEVEMENTS,
        GRANT_ACHIEVEMENT_RECOGNITIONS,
        GRANT_MISSION_LOOT,
      ],
    },
    // --- Diseno «misiones jugables», P-J1: entrega del botin del jefe ---
    {
      provide: LOOT_GRANT_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        reports: ReportRepositoryPort,
      ): LootGrantRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresLootGrantRepository(db)
          : new InMemoryLootGrantRepository(
              reports instanceof InMemoryReportRepository ? reports : undefined,
            ),
      inject: [APP_CONFIG, DATABASE, REPORT_REPOSITORY],
    },
    // Mismo contrato de entregas de HU-59 y mismo cliente que la epica.
    { provide: LOOT_GRANTS, useExisting: EPIC_GRANTS },
    {
      provide: GRANT_MISSION_LOOT,
      useFactory: (
        grants: LootGrantRepositoryPort,
        enrollments: EnrollmentRepositoryPort,
        catalog: MissionCatalogPort,
        inventory: LootGrantPort,
        clock: ClockPort,
        logger: Logger,
      ): GrantMissionLoot =>
        new GrantMissionLoot(grants, enrollments, catalog, inventory, clock, {
          batchSize: 50,
          onError: (enrollmentId, error) => {
            logger.warn('loot_grant_error', { enrollmentId, detail: describeError(error) })
          },
        }),
      inject: [
        LOOT_GRANT_REPOSITORY,
        ENROLLMENT_REPOSITORY,
        MISSION_CATALOG,
        LOOT_GRANTS,
        CLOCK,
        LOGGER,
      ],
    },
    // --- HU-73: evidencia del Master y entrega de su epica ---
    {
      provide: MASTER_ENCOUNTER_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        reports: ReportRepositoryPort,
      ): MasterEncounterRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresMasterEncounterRepository(db)
          : new InMemoryMasterEncounterRepository(
              reports instanceof InMemoryReportRepository ? reports : undefined,
            ),
      inject: [APP_CONFIG, DATABASE, REPORT_REPOSITORY],
    },
    {
      provide: EPIC_GRANTS,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): EpicGrantPort => {
        if (config.epicGrantsDriver === IntegrationDriver.Memory) {
          logger.warn('epic_grants_in_memory', {
            detail:
              'EPIC_GRANTS_DRIVER=memory: las épicas del Máster no llegan al inventario de Player/Inventory.',
          })

          return new InMemoryEpicGrants()
        }

        if (config.playerInventoryBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('epic_grants_not_configured', {
            detail:
              'Falta PLAYER_INVENTORY_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: las épicas quedarán pendientes.',
          })

          return unconfiguredEpicGrants
        }

        return new PlayerInventoryEpicGrantClient({
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
      provide: GRANT_MASTER_EPICS,
      useFactory: (
        masters: MasterEncounterRepositoryPort,
        enrollments: EnrollmentRepositoryPort,
        catalog: MissionCatalogPort,
        grants: EpicGrantPort,
        clock: ClockPort,
        logger: Logger,
      ): GrantMasterEpics =>
        new GrantMasterEpics(masters, enrollments, catalog, grants, clock, {
          batchSize: 50,
          onError: (enrollmentId, error) => {
            logger.warn('epic_grant_error', { enrollmentId, detail: describeError(error) })
          },
        }),
      inject: [
        MASTER_ENCOUNTER_REPOSITORY,
        ENROLLMENT_REPOSITORY,
        MISSION_CATALOG,
        EPIC_GRANTS,
        CLOCK,
        LOGGER,
      ],
    },
    // --- HU-09 (Task HU-09.4): recompensa de experiencia por derrota ---
    {
      provide: EXPERIENCE_REWARD_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        reports: ReportRepositoryPort,
      ): ExperienceRewardRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresExperienceRewardRepository(db)
          : // En memoria, el avance de una recompensa mueve ademas su linea del
            // reporte (Task HU-09.5), asi que los dos dobles comparten estado.
            new InMemoryExperienceRewardRepository(
              reports instanceof InMemoryReportRepository ? reports : undefined,
            ),
      inject: [APP_CONFIG, DATABASE, REPORT_REPOSITORY],
    },
    {
      provide: EXPERIENCE_ROLLS,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): ExperienceRollPort => {
        if (config.experienceRewardsDriver === IntegrationDriver.Memory) {
          logger.warn('experience_rolls_in_memory', {
            detail:
              'EXPERIENCE_REWARDS_DRIVER=memory: las tiradas no las hace Combat; se reparten caras fijas.',
          })

          return new InMemoryExperienceRolls()
        }

        if (config.combatBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('experience_rolls_not_configured', {
            detail: 'Falta COMBAT_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: no se pediran tiradas.',
          })

          return unconfiguredRolls
        }

        return new CombatExperienceRollClient({
          baseUrl: config.combatBaseUrl,
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
      provide: EXPERIENCE_CREDITS,
      useFactory: (config: AppConfig, clock: ClockPort, logger: Logger): ExperienceCreditPort => {
        if (config.experienceRewardsDriver === IntegrationDriver.Memory) {
          logger.warn('experience_credits_in_memory', {
            detail:
              'EXPERIENCE_REWARDS_DRIVER=memory: la experiencia no llega al heroe de Player/Inventory.',
          })

          return new InMemoryExperienceCredits()
        }

        if (config.playerInventoryBaseUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('experience_credits_not_configured', {
            detail:
              'Falta PLAYER_INVENTORY_BASE_URL o INTERNAL_SERVICE_AUTH_SECRET: no se acreditara.',
          })

          return unconfiguredCredits
        }

        return new PlayerInventoryExperienceClient({
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
      provide: COORDINATE_EXPERIENCE_REWARD,
      useFactory: (
        rewards: ExperienceRewardRepositoryPort,
        enrollments: EnrollmentRepositoryPort,
        rolls: ExperienceRollPort,
        credits: ExperienceCreditPort,
        clock: ClockPort,
        logger: Logger,
      ): CoordinateExperienceReward =>
        new CoordinateExperienceReward(rewards, enrollments, rolls, credits, clock, {
          batchSize: 50,
          onError: (enrollmentId, error) => {
            logger.warn('experience_reward_error', { enrollmentId, detail: describeError(error) })
          },
        }),
      inject: [
        EXPERIENCE_REWARD_REPOSITORY,
        ENROLLMENT_REPOSITORY,
        EXPERIENCE_ROLLS,
        EXPERIENCE_CREDITS,
        CLOCK,
        LOGGER,
      ],
    },
    {
      provide: EXPERIENCE_REWARD_SCHEDULER,
      useFactory: (
        config: AppConfig,
        rewards: CoordinateExperienceReward,
        logger: Logger,
      ): ExperienceRewardScheduler =>
        new ExperienceRewardScheduler(
          rewards,
          logger,
          config.experienceRewardIntervalMs,
          config.experienceRewardEnabled,
        ),
      inject: [APP_CONFIG, COORDINATE_EXPERIENCE_REWARD, LOGGER],
    },
    // --- HU-74: reporte e historial ---
    {
      provide: REPORT_REPOSITORY,
      useFactory: (config: AppConfig, db: Kysely<Database> | null): ReportRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresReportRepository(db)
          : new InMemoryReportRepository(),
      inject: [APP_CONFIG, DATABASE],
    },
    {
      provide: GET_MISSION_REPORT,
      useFactory: (
        reports: ReportRepositoryPort,
        enrollments: EnrollmentRepositoryPort,
      ): GetMissionReport => new GetMissionReport(reports, enrollments),
      inject: [REPORT_REPOSITORY, ENROLLMENT_REPOSITORY],
    },
    {
      provide: LIST_MISSION_HISTORY,
      useFactory: (
        enrollments: EnrollmentRepositoryPort,
        reports: ReportRepositoryPort,
        catalog: MissionCatalogPort,
      ): ListMissionHistory => new ListMissionHistory(enrollments, reports, catalog),
      inject: [ENROLLMENT_REPOSITORY, REPORT_REPOSITORY, MISSION_CATALOG],
    },
    {
      provide: GET_MISSION_HISTORY_SUMMARY,
      useFactory: (
        reports: ReportRepositoryPort,
        catalog: MissionCatalogPort,
      ): GetMissionHistorySummary => new GetMissionHistorySummary(reports, catalog),
      inject: [REPORT_REPOSITORY, MISSION_CATALOG],
    },
    // --- HU-76: logros y reconocimientos ---
    {
      // El ejemplo del contrato solo con MISSIONS_EXAMPLE_CATALOG; si no, el
      // aprobado, vacio hasta la decision 1. Un catalogo roto impide arrancar.
      provide: ACHIEVEMENT_CATALOG,
      useFactory: (config: AppConfig): AchievementCatalogPort =>
        new StaticAchievementCatalog(
          config.exampleCatalog ? EXAMPLE_ACHIEVEMENTS : APPROVED_ACHIEVEMENTS,
        ),
      inject: [APP_CONFIG],
    },
    {
      provide: ACHIEVEMENT_EVIDENCE,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        enrollments: EnrollmentRepositoryPort,
        reports: ReportRepositoryPort,
        masters: MasterEncounterRepositoryPort,
      ): AchievementEvidencePort =>
        usesPostgres(config, db)
          ? new PostgresAchievementEvidence(db)
          : new InMemoryAchievementEvidence(enrollments, reports, masters),
      inject: [
        APP_CONFIG,
        DATABASE,
        ENROLLMENT_REPOSITORY,
        REPORT_REPOSITORY,
        MASTER_ENCOUNTER_REPOSITORY,
      ],
    },
    {
      provide: ACHIEVEMENT_REPOSITORY,
      useFactory: (
        config: AppConfig,
        db: Kysely<Database> | null,
        enrollments: EnrollmentRepositoryPort,
        masters: MasterEncounterRepositoryPort,
      ): AchievementRepositoryPort =>
        usesPostgres(config, db)
          ? new PostgresAchievementRepository(db)
          : // En memoria cuenta los hechos del doble de matriculas; si una prueba
            // lo sustituyo, no ve ninguno.
            new InMemoryAchievementRepository(
              enrollments instanceof InMemoryEnrollmentRepository
                ? enrollments
                : new InMemoryEnrollmentRepository(),
              masters,
            ),
      inject: [APP_CONFIG, DATABASE, ENROLLMENT_REPOSITORY, MASTER_ENCOUNTER_REPOSITORY],
    },
    // El cosmetico sale por el mismo cliente y el mismo contrato de HU-59 que la
    // epica: EPIC_GRANTS_DRIVER gobierna las dos entregas.
    { provide: RECOGNITION_GRANTS, useExisting: EPIC_GRANTS },
    {
      provide: EVALUATE_MISSION_ACHIEVEMENTS,
      useFactory: (
        catalog: AchievementCatalogPort,
        achievements: AchievementRepositoryPort,
        evidence: AchievementEvidencePort,
        clears: DifficultyClearRepositoryPort,
        missions: MissionCatalogPort,
        clock: ClockPort,
        logger: Logger,
      ): EvaluateMissionAchievements =>
        new EvaluateMissionAchievements(catalog, achievements, evidence, clears, missions, clock, {
          batchSize: 50,
          onError: (error) => {
            logger.warn('achievement_evaluation_error', { detail: describeError(error) })
          },
        }),
      inject: [
        ACHIEVEMENT_CATALOG,
        ACHIEVEMENT_REPOSITORY,
        ACHIEVEMENT_EVIDENCE,
        DIFFICULTY_CLEAR_REPOSITORY,
        MISSION_CATALOG,
        CLOCK,
        LOGGER,
      ],
    },
    {
      provide: GRANT_ACHIEVEMENT_RECOGNITIONS,
      useFactory: (
        achievements: AchievementRepositoryPort,
        catalog: AchievementCatalogPort,
        grants: RecognitionGrantPort,
        clock: ClockPort,
        logger: Logger,
      ): GrantAchievementRecognitions =>
        new GrantAchievementRecognitions(achievements, catalog, grants, clock, {
          batchSize: 50,
          onError: (error) => {
            logger.warn('achievement_recognition_error', { detail: describeError(error) })
          },
        }),
      inject: [ACHIEVEMENT_REPOSITORY, ACHIEVEMENT_CATALOG, RECOGNITION_GRANTS, CLOCK, LOGGER],
    },
    {
      provide: GET_MISSION_ACHIEVEMENTS,
      useFactory: (
        catalog: AchievementCatalogPort,
        achievements: AchievementRepositoryPort,
        evidence: AchievementEvidencePort,
        clears: DifficultyClearRepositoryPort,
        missions: MissionCatalogPort,
      ): GetMissionAchievements =>
        new GetMissionAchievements(catalog, achievements, evidence, clears, missions),
      inject: [
        ACHIEVEMENT_CATALOG,
        ACHIEVEMENT_REPOSITORY,
        ACHIEVEMENT_EVIDENCE,
        DIFFICULTY_CLEAR_REPOSITORY,
        MISSION_CATALOG,
      ],
    },
  ],
})
export class AppModule {}
