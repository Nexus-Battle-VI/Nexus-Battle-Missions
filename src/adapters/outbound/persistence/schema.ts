import type { ColumnType, Generated } from 'kysely'

import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import type {
  EnrollmentRejection,
  EnrollmentStatus,
} from '../../../domain/entities/MissionEnrollment'
import type { DifficultyLevel } from '../../../domain/value-objects/difficulty-level'
import type { MissionCategory } from '../../../domain/value-objects/mission-category'
import type { Rotation } from '../../../domain/value-objects/rotation'
import type {
  CombatOutcome,
  ExecutionStatus,
  MissionOutcome,
  ObjectiveResult,
  SimulationRequest,
} from '../../../domain/entities/MissionExecution'
import type {
  ReportOutcome,
  RewardKind,
  RewardSource,
  RewardStatus,
} from '../../../domain/entities/MissionReport'

/**
 * Esquema de la base de datos del servicio, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Cada migracion que cree o cambie una tabla debe reflejarse
 * aqui en el mismo Pull Request.
 *
 * Nombres de columna en `snake_case`, que es la convencion de PostgreSQL. La
 * traduccion a la instantanea del agregado ocurre en un `mapping.ts` explicito.
 */
export interface Database {
  readonly mission_difficulty_clears: MissionDifficultyClearsTable
  readonly mission_definitions: MissionDefinitionsTable
  readonly mission_enrollments: MissionEnrollmentsTable
  readonly mission_facts: MissionFactsTable
  readonly mission_strategies: MissionStrategiesTable
  readonly mission_executions: MissionExecutionsTable
  readonly mission_reports: MissionReportsTable
  readonly mission_report_rewards: MissionReportRewardsTable
}

/**
 * Niveles completados por jugador y mision (HU-75, migracion
 * `001-mission-difficulty-clears`). Un hecho no se actualiza: es lo que
 * desbloquea el nivel siguiente.
 */
export interface MissionDifficultyClearsTable {
  readonly player_id: string
  readonly mission_id: string
  readonly difficulty: DifficultyLevel
  readonly completed_at: ColumnType<Date, Date | string, never>
  readonly created_at: ColumnType<Date, Date | string | undefined, never>
}

/** Contenido de una definicion que se lee entero (`content`, jsonb). */
export interface MissionDefinitionContent {
  readonly objectives: MissionDefinition['objectives']
  readonly enemies: MissionDefinition['enemies']
  readonly finalBoss: MissionDefinition['finalBoss']
  readonly encounters: MissionDefinition['encounters']
  readonly masterEncounter: MissionDefinition['masterEncounter']
  readonly rewards: MissionDefinition['rewards']
  readonly highlightedRewards: MissionDefinition['highlightedRewards']
}

/**
 * Definiciones del tablon (HU-70, migracion `002-mission-enrollments`). Los
 * `jsonb` se escriben como texto JSON: el driver convertiria un arreglo de
 * JavaScript en un arreglo de PostgreSQL, no en JSON.
 */
export interface MissionDefinitionsTable {
  readonly mission_id: string
  readonly name: string
  readonly category: MissionCategory
  readonly summary: string
  readonly narrative: string
  readonly image_ref: string | null
  readonly estimated_duration_minutes: number
  readonly recommended_power: number | null
  readonly prerequisites: ColumnType<string[], string[] | undefined, string[]>
  readonly content: ColumnType<MissionDefinitionContent, string, string>
  readonly active: ColumnType<boolean, boolean | undefined, boolean>
  readonly created_at: ColumnType<Date, Date | string | undefined, never>
}

/** Matriculas (HU-70). `version` es el bloqueo optimista de cada transicion. */
export interface MissionEnrollmentsTable {
  readonly enrollment_id: string
  readonly player_id: string
  readonly mission_id: string
  readonly hero_id: string
  readonly difficulty: DifficultyLevel
  readonly status: EnrollmentStatus
  readonly operation_id: string
  readonly idempotency_key: string
  readonly request_fingerprint: string
  readonly strategy_version: number | null
  /** Copia congelada de la estrategia (HU-71, migracion 003). No cambia tras insertarse. */
  readonly rotations: ColumnType<Rotation[], string | undefined, never>
  readonly commitment_id: string | null
  readonly rejection: ColumnType<EnrollmentRejection | null, string | null, string | null>
  readonly requested_at: ColumnType<Date, Date, never>
  readonly started_at: Date | null
  readonly ends_at: Date | null
  readonly finished_at: Date | null
  readonly version: number
}

/**
 * Estrategias guardadas (HU-71, migracion `003-mission-strategies`), una por
 * jugador, heroe y mision. `version` es el bloqueo optimista de cada guardado.
 */
export interface MissionStrategiesTable {
  readonly player_id: string
  readonly hero_id: string
  readonly mission_id: string
  readonly rotations: ColumnType<Rotation[], string, string>
  readonly version: number
  readonly updated_at: ColumnType<Date, Date, Date>
}

/**
 * Ejecucion de la simulacion de cada matricula (HU-72, migracion
 * `004-mission-executions`). Los `jsonb` se escriben como texto JSON.
 */
export interface MissionExecutionsTable {
  readonly enrollment_id: string
  readonly operation_id: string
  readonly status: ExecutionStatus
  readonly attempts: number
  readonly next_attempt_at: Date | null
  readonly deadline_at: Date
  readonly request: ColumnType<SimulationRequest | null, string | null, string | null>
  readonly last_error: string | null
  readonly simulation_id: string | null
  readonly seed_ref: string | null
  readonly combat_outcome: CombatOutcome | null
  readonly summary: ColumnType<Record<string, unknown> | null, string | null, string | null>
  readonly combat_log: ColumnType<unknown[] | null, string | null, string | null>
  readonly simulated_at: Date | null
  readonly outcome: MissionOutcome | null
  readonly outcome_reason: string | null
  readonly objectives: ColumnType<ObjectiveResult[] | null, string | null, string | null>
  readonly settled_at: Date | null
  readonly hero_released_at: Date | null
  readonly version: number
}

/**
 * Reportes de mision (HU-74, migracion `005-mission-reports`). La foto entera va
 * en `snapshot` y no se actualiza nunca: ninguna columna admite `update`.
 */
export interface MissionReportsTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly player_id: ColumnType<string, string, never>
  readonly mission_id: ColumnType<string, string, never>
  readonly category: ColumnType<MissionCategory, MissionCategory, never>
  readonly difficulty: ColumnType<DifficultyLevel, DifficultyLevel, never>
  readonly outcome: ColumnType<ReportOutcome, ReportOutcome, never>
  readonly finished_at: ColumnType<Date, Date, never>
  readonly schema_version: ColumnType<number, number, never>
  /** La valida quien la escribe (`PostgresReportRepository`); aqui es opaca. */
  readonly snapshot: ColumnType<unknown, string, never>
  readonly generated_at: ColumnType<Date, Date, never>
}

/** Lineas de recompensa de cada reporte (HU-74): solo cambian su estado y su fecha. */
export interface MissionReportRewardsTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly line_no: ColumnType<number, number, never>
  readonly kind: ColumnType<RewardKind, RewardKind, never>
  readonly reference: ColumnType<string | null, string | null, never>
  readonly name: ColumnType<string, string, never>
  readonly rarity: ColumnType<string | null, string | null, never>
  readonly quantity: ColumnType<number, number, never>
  readonly status: RewardStatus
  readonly source: ColumnType<RewardSource, RewardSource, never>
  readonly updated_at: Date
}

/** Hechos internos de Missions (`MissionEnrollmentStarted`); los consume HU-72. */
export interface MissionFactsTable {
  readonly fact_id: Generated<string>
  readonly type: string
  readonly enrollment_id: string
  readonly payload: ColumnType<Record<string, unknown>, string, never>
  readonly created_at: ColumnType<Date, Date, never>
  readonly processed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
}
