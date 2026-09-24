import type { DifficultyLevel } from '../value-objects/difficulty-level'
import type { HeroProgressionSnapshot } from '../value-objects/hero-progression'
import type { MissionCategory } from '../value-objects/mission-category'

/**
 * Reporte de una mision terminada (HU-74, agregado `MissionReport`, propuestas
 * P-T1 y P-T2): una foto INMUTABLE que se crea en la misma transaccion que
 * cierra la mision (HU-72). No recalcula dano ni vuelve a entregar recompensas.
 *
 * Lo unico que cambia despues es el estado de cada linea de recompensa, que
 * vive aparte de la foto (`ReportRewardLine`).
 */
export const REPORT_SCHEMA_VERSION = 1

/** Una mision anulada (`VOIDED`) no tiene reporte (P-T3). */
export const REPORT_OUTCOMES = ['COMPLETED', 'FAILED', 'ABANDONED'] as const

export type ReportOutcome = (typeof REPORT_OUTCOMES)[number]

/** El historial tambien muestra las anuladas, sin reporte (P-T3). */
export const HISTORY_OUTCOMES = [...REPORT_OUTCOMES, 'VOIDED'] as const

export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number]

export const isHistoryOutcome = (value: string): value is HistoryOutcome =>
  (HISTORY_OUTCOMES as readonly string[]).includes(value)

export interface ReportHero {
  readonly heroId: string
  /** Del perfil congelado de Player/Inventory; `null` si no lo trae. */
  readonly name: string | null
  readonly subtype: string | null
}

export interface ReportSummary {
  readonly outcome: ReportOutcome
  readonly outcomeReason: string | null
  readonly hero: ReportHero
  readonly startedAt: Date
  /** Cuando termino la mision para el jugador: su `endsAt`. */
  readonly finishedAt: Date
  /** Duracion simulada que informa Combat (ISO-8601); `null` si no la trae o no es valida. */
  readonly simulatedDuration: string | null
}

export interface SkillUse {
  readonly abilityId: string
  readonly count: number
}

/** Del resumen de Combat. Un dato que falta o no cumple queda en `null`. */
export interface CombatStats {
  readonly encountersCompleted: number | null
  readonly encountersTotal: number | null
  readonly totalTurns: number | null
  readonly damageDealt: number | null
  readonly damageTaken: number | null
  readonly criticalEffects: number | null
  readonly skillsUsed: readonly SkillUse[]
}

export interface DefeatedEnemy {
  readonly enemyRef: string
  readonly name: string
  readonly count: number
}

export interface ReportBoss {
  readonly enemyRef: string
  readonly name: string
  readonly defeated: boolean
}

/** Evidencia del Master (HU-73). `status` sigue el vocabulario de su contrato. */
export interface ReportMaster {
  readonly masterRef: string
  readonly name: string
  readonly status: string
}

export interface ReportEnemies {
  /** Los regulares; el jefe va aparte, en `boss`. */
  readonly defeated: readonly DefeatedEnemy[]
  readonly boss: ReportBoss
  /** Los Master que aparecieron, segun la evidencia de HU-73; vacia si no aparecio ninguno. */
  readonly masters: readonly ReportMaster[]
}

export interface ReportObjective {
  readonly id: string
  readonly text: string
  readonly primary: boolean
  /** `null`: no aplico (el Master no aparecio) o no es evaluable en esta version. */
  readonly met: boolean | null
  /** Bonificacion por objetivo cumplido: la define HU-10; hasta entonces, `null`. */
  readonly bonus: null
}

export interface MissionReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly enrollmentId: string
  /** Dueno del reporte: solo el lo lee (P-T8). No se publica en la respuesta. */
  readonly playerId: string
  readonly mission: {
    readonly missionId: string
    readonly name: string
    readonly category: MissionCategory
    readonly difficulty: DifficultyLevel
  }
  readonly summary: ReportSummary
  readonly combatStats: CombatStats
  readonly enemies: ReportEnemies
  readonly objectives: readonly ReportObjective[]
  /** Cuando se genero: el momento del cierre. */
  readonly generatedAt: Date
}

export const REWARD_KINDS = ['CREDITS', 'PRODUCT', 'EPIC', 'EXPERIENCE'] as const

export type RewardKind = (typeof REWARD_KINDS)[number]

export const REWARD_STATUSES = ['PENDING', 'CREDITED', 'FAILED'] as const

export type RewardStatus = (typeof REWARD_STATUSES)[number]

/**
 * Quien calcula la linea: HU-10 (creditos y productos), HU-73 (la epica) o HU-09
 * (la experiencia de cada NPC derrotado, Task HU-09.5).
 *
 * EL ORIGEN ES PARTE DE LA CLAVE DE LA LINEA, no una etiqueta: dice quien la
 * escribio y con que reglas se puede tocar. Una linea `HU-09` solo la mueve el
 * ciclo de experiencia, y por eso el resumen de experiencia del reporte se
 * calcula filtrando por este campo y no por `kind`.
 */
export const REWARD_SOURCES = ['HU-10', 'HU-73', 'HU-09'] as const

export type RewardSource = (typeof REWARD_SOURCES)[number]

export interface ReportRewardLine {
  readonly lineNo: number
  readonly kind: RewardKind
  readonly reference: string | null
  readonly name: string
  readonly rarity: string | null
  readonly quantity: number
  readonly status: RewardStatus
  readonly source: RewardSource
  /**
   * HU-09 (Task HU-09.5): el estado del heroe al acreditar esta linea. `null` en
   * cualquier linea que no sea de experiencia y en una de experiencia que todavia
   * no se acredito -- la progresion solo se conoce cuando Player/Inventory
   * confirma, y no se inventa antes.
   */
  readonly progression: HeroProgressionSnapshot | null
  readonly updatedAt: Date
}

/**
 * Lo que un desenlace cambia en su linea, y NUNCA en la foto (CU-74.4). Es lo que
 * el avance de una entrega escribe junto a su propio estado, en la MISMA
 * transaccion: la recompensa de experiencia de HU-09 y su linea del reporte son el
 * mismo hecho contado dos veces, y no pueden quedar desacordes.
 */
export interface ReportLineUpdate {
  readonly status: Extract<RewardStatus, 'CREDITED' | 'FAILED'>
  /**
   * Unidades entregadas: para la experiencia, la experiencia ACREDITADA. `0`
   * mientras no se haya entregado nada -- el importe lo decide la tirada, que
   * ocurre despues del cierre.
   */
  readonly quantity: number
  /** Solo en una linea `EXPERIENCE`; `null` si Player/Inventory no la devolvio. */
  readonly progression: HeroProgressionSnapshot | null
  readonly at: Date
}

/**
 * La experiencia de la mision, tal como la ve el jugador (HU-09, Task HU-09.5).
 *
 * ES UN BLOQUE DERIVADO, no parte de la foto: se calcula al leer el reporte a
 * partir de sus lineas `HU-09`, que son las unicas que cambian despues del cierre.
 * No se guarda porque un dato guardado aparte se puede quedar atras.
 */
export interface ReportExperience {
  /** Derrotas registradas: una linea `EXPERIENCE` por cada NPC derrotado. */
  readonly defeats: number
  /** Experiencia ACREDITADA, sumada. Una derrota pendiente todavia no cuenta. */
  readonly totalXp: number
  readonly credited: number
  readonly pending: number
  readonly failed: number
  /** Nivel del heroe tras la ultima acreditacion; `null` si todavia no hay ninguna. */
  readonly level: number | null
  /** Experiencia ACUMULADA del heroe en ese momento; `null` si no hay acreditaciones. */
  readonly currentXp: number | null
  /** Tope de nivel que informo Player/Inventory; `null` si no hay acreditaciones. */
  readonly maxLevel: number | null
  /** Niveles cruzados con la experiencia de ESTA mision. */
  readonly levelsGained: number
  readonly leveledUp: boolean
}

/** La foto y sus lineas de recompensa: se guardan juntas en el cierre y se leen juntas. */
export interface ReportRecord {
  readonly report: MissionReport
  readonly rewards: readonly ReportRewardLine[]
}
