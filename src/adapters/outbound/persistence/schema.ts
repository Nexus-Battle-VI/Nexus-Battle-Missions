import type { ColumnType, Generated } from 'kysely'

import type {
  AchievementCriterion,
  AchievementProof,
  RecognitionKind,
  RecognitionStatus,
} from '../../../domain/entities/Achievement'
import type {
  EpicGrantStatus,
  MasterEncounterStatus,
} from '../../../domain/entities/MasterEncounterRecord'
import type { ExperienceRewardStatus } from '../../../domain/entities/ExperienceReward'
import type { LootGrantStatus } from '../../../domain/entities/LootGrantRecord'
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
  readonly mission_master_encounters: MissionMasterEncountersTable
  readonly mission_loot_grants: MissionLootGrantsTable
  readonly mission_experience_rewards: MissionExperienceRewardsTable
  readonly mission_achievement_unlocks: MissionAchievementUnlocksTable
  readonly mission_achievement_evaluations: MissionAchievementEvaluationsTable
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
  readonly combatRules?: MissionDefinition['combatRules']
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

/**
 * Lineas de recompensa de cada reporte (HU-74): solo cambian su estado, su
 * importe y su fecha. La progresion del heroe la escribe el avance de la
 * experiencia (HU-09, migracion `008-report-experience`).
 */
export interface MissionReportRewardsTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly line_no: ColumnType<number, number, never>
  readonly kind: ColumnType<RewardKind, RewardKind, never>
  readonly reference: ColumnType<string | null, string | null, never>
  readonly name: ColumnType<string, string, never>
  readonly rarity: ColumnType<string | null, string | null, never>
  /**
   * Unidades entregadas. En una linea de experiencia es el importe ACREDITADO, que
   * solo se conoce cuando la tirada ocurre: nace en cero y el avance de HU-09 lo
   * escribe (Task HU-09.5), de ahi que sea actualizable.
   */
  readonly quantity: ColumnType<number, number, number>
  readonly status: RewardStatus
  readonly source: ColumnType<RewardSource, RewardSource, never>
  /** Nivel del heroe al acreditar; `null` mientras no se acredite o no se leyera. */
  readonly hero_level: number | null
  readonly hero_current_xp: number | null
  readonly hero_max_level: number | null
  readonly levels_gained: number | null
  readonly updated_at: Date
}

/**
 * Evidencia del Master por matricula (HU-73, migracion
 * `006-mission-master-encounters`). Lo escribe el cierre; despues solo cambia la
 * entrega de la epica.
 */
export interface MissionMasterEncountersTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly sequence: ColumnType<number, number, never>
  readonly after_encounter: ColumnType<number | null, number | null, never>
  readonly master_ref: ColumnType<string | null, string | null, never>
  readonly status: ColumnType<MasterEncounterStatus, MasterEncounterStatus, never>
  readonly epic_ref: ColumnType<string | null, string | null, never>
  readonly level_offset: ColumnType<number | null, number | null, never>
  readonly turns: ColumnType<number | null, number | null, never>
  readonly grant_operation_id: ColumnType<string | null, string | null, never>
  readonly grant_status: EpicGrantStatus | null
  readonly grant_attempts: ColumnType<number, number | undefined, number>
  readonly grant_next_attempt_at: Date | null
  readonly grant_last_error: string | null
  readonly granted_at: Date | null
  readonly reward_line_no: ColumnType<number | null, number | null, never>
  readonly grant_product_id: string | null
}

/**
 * Entrega del botin del jefe (diseno «misiones jugables», P-J1, migracion
 * `011-mission-loot-grants`). La escribe el cierre; despues solo cambia la entrega.
 */
export interface MissionLootGrantsTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly line_no: ColumnType<number, number, never>
  readonly label: ColumnType<string, string, never>
  readonly quantity: ColumnType<number, number, never>
  readonly operation_id: ColumnType<string, string, never>
  readonly status: LootGrantStatus
  readonly attempts: ColumnType<number, number | undefined, number>
  readonly next_attempt_at: Date | null
  readonly last_error: string | null
  readonly granted_at: Date | null
  readonly product_id: string | null
  readonly created_at: ColumnType<Date, Date | undefined, never>
}

/**
 * Recompensa de experiencia de UNA derrota (HU-09, migracion
 * `007-experience-rewards`). La crea el cierre en su transaccion, `PENDING` y
 * antes de pedir ninguna tirada; despues solo avanza su estado.
 */
export interface MissionExperienceRewardsTable {
  readonly enrollment_id: ColumnType<string, string, never>
  readonly encounter_id: ColumnType<string, string, never>
  readonly enemy_instance_id: ColumnType<string, string, never>
  readonly player_id: ColumnType<string, string, never>
  readonly hero_id: ColumnType<string, string, never>
  readonly simulation_id: ColumnType<string, string, never>
  readonly rival_ref: ColumnType<string, string, never>
  readonly status: ExperienceRewardStatus
  /** Cara del dado de Combat; `null` mientras no se haya pedido la tirada. */
  readonly roll: number | null
  /** Experiencia ya calculada y entera; `null` mientras no haya tirada. */
  readonly amount: number | null
  readonly attempts: ColumnType<number, number | undefined, number>
  readonly next_attempt_at: Date | null
  readonly last_error: string | null
  readonly credited_at: Date | null
  /** La linea del reporte que refleja esta derrota (HU-09.5); `null` sin reporte. */
  readonly reward_line_no: number | null
  readonly created_at: ColumnType<Date, Date | undefined, never>
}

/**
 * Logros desbloqueados (HU-76, migracion `009-mission-achievements`), uno por
 * jugador y logro. Lo desbloqueado queda congelado; despues solo cambia la
 * entrega de un cosmetico.
 */
export interface MissionAchievementUnlocksTable {
  readonly player_id: ColumnType<string, string, never>
  readonly achievement_id: ColumnType<string, string, never>
  readonly achievement_version: ColumnType<number, number, never>
  readonly criterion: ColumnType<AchievementCriterion, AchievementCriterion, never>
  readonly name: ColumnType<string, string, never>
  readonly progress_current: ColumnType<number, number, never>
  readonly progress_target: ColumnType<number, number, never>
  readonly proof: ColumnType<AchievementProof, string, never>
  readonly unlocked_at: ColumnType<Date, Date, never>
  readonly recognition_kind: ColumnType<RecognitionKind, RecognitionKind, never>
  readonly recognition_name: ColumnType<string, string, never>
  readonly recognition_status: RecognitionStatus
  readonly grant_operation_id: ColumnType<string | null, string | null, never>
  readonly grant_attempts: ColumnType<number, number | undefined, number>
  readonly grant_next_attempt_at: Date | null
  readonly grant_last_error: string | null
  readonly grant_product_id: string | null
  readonly credited_at: Date | null
}

/** Punto de control de la evaluacion de logros de cada jugador (HU-76, migracion 009). */
export interface MissionAchievementEvaluationsTable {
  readonly player_id: ColumnType<string, string, never>
  readonly settled_seen: number
  readonly epics_granted_seen: number
  readonly catalog_fingerprint: string | null
  readonly evaluated_at: Date | null
  readonly attempts: ColumnType<number, number | undefined, number>
  readonly next_attempt_at: Date | null
  readonly last_error: string | null
}

/**
 * Hechos internos de Missions: `MissionEnrollmentStarted` (HU-70), que consume
 * HU-72, y `MissionSettled` (HU-72). `processed_at` es SOLO de HU-72: cada otro
 * consumidor lleva su propio registro (HU-76, `mission_achievement_evaluations`)
 * y no lo marca, para no ocultar el hecho a los demas.
 */
export interface MissionFactsTable {
  readonly fact_id: Generated<string>
  readonly type: string
  readonly enrollment_id: string
  readonly payload: ColumnType<Record<string, unknown>, string, never>
  readonly created_at: ColumnType<Date, Date, never>
  readonly processed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
}
