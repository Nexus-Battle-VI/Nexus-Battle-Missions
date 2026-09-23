import type { ColumnType, Generated } from 'kysely'

import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import type {
  EnrollmentRejection,
  EnrollmentStatus,
} from '../../../domain/entities/MissionEnrollment'
import type { DifficultyLevel } from '../../../domain/value-objects/difficulty-level'
import type { MissionCategory } from '../../../domain/value-objects/mission-category'
import type { Rotation } from '../../../domain/value-objects/rotation'

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

/** Hechos internos de Missions (`MissionEnrollmentStarted`); los consume HU-72. */
export interface MissionFactsTable {
  readonly fact_id: Generated<string>
  readonly type: string
  readonly enrollment_id: string
  readonly payload: ColumnType<Record<string, unknown>, string, never>
  readonly created_at: ColumnType<Date, Date, never>
  readonly processed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
}
