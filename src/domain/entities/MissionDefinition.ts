import type { MissionCategory } from '../value-objects/mission-category'

/**
 * Definicion de una mision del tablon (HU-70, contrato hu-70-mission-enrollment-v1).
 *
 * Es CONTENIDO: HU-70 la lee, no la crea ni la edita. Como se cargan las
 * definiciones es una decision pendiente del diseno (decision 7): el curso pide
 * dos misiones completas por equipo y todavia no hay issue para ellas.
 *
 * Donde el curso no da un valor, el contenido lo deja en `null`; no se inventan
 * estadisticas.
 */
/**
 * Como se evalua un objetivo con el resumen de Combat (HU-72, propuestas P-S5 y
 * P-S6). Combat no conoce los objetivos: Missions decide con los hechos del
 * resumen.
 */
export type ObjectiveRule =
  | { readonly type: 'DEFEAT_BOSS' }
  | { readonly type: 'CLEAR_ENCOUNTERS'; readonly count: number }
  | { readonly type: 'MIN_HEALTH_PERCENT'; readonly percent: number }
  | { readonly type: 'DEFEAT_MASTER' }

export interface MissionObjective {
  readonly id: string
  readonly text: string
  readonly primary: boolean
  /** `null`: no evaluable en esta version (p. ej., el botin, que depende de HU-10). */
  readonly rule: ObjectiveRule | null
}

/**
 * Un encuentro de la simulacion (HU-72). El reparto de enemigos en encuentros es
 * contenido de la mision: el curso da cantidades y camaras, no el orden.
 */
export interface MissionEncounter {
  readonly index: number
  readonly kind: 'REGULAR' | 'BOSS'
  /** Escalado por encuentro: contenido pendiente (decision 8 del diseno de HU-72). */
  readonly powerStep: number | null
  readonly enemies: readonly { readonly enemyRef: string; readonly count: number }[]
}

export interface MissionEnemy {
  readonly enemyRef: string
  readonly name: string
  readonly count: number
  readonly description: string | null
  /** Perfil de Combat: contenido pendiente; ausente o null en los ejemplos. */
  readonly profile?: Readonly<Record<string, unknown>> | null
}

export interface MissionBoss {
  readonly enemyRef: string
  readonly name: string
  readonly heroType: string | null
  readonly description: string | null
  readonly stats: Readonly<Record<string, number>>
  /** Perfil completo cuando el contenido aprobado lo publique. */
  readonly profile?: Readonly<Record<string, unknown>> | null
}

export interface MasterEpic {
  readonly epicRef: string
  readonly name: string
  readonly generalEffect: string | null
  readonly epicEffect: string | null
  /** El producto de Catalog que se entrega; `null` mientras no exista (decision 7 de HU-73). */
  readonly productId: string | null
}

export interface MasterCandidate {
  readonly masterRef: string
  readonly name: string
  /** Subtipo del Master; el detalle de HU-70 lo muestra como `heroType`. */
  readonly subtype: string
  /** Niveles por encima del heroe: literal de la HU, dos (CA-04). */
  readonly levelOffset: number
  /** Estadisticas base: contenido pendiente; `null` si el curso no las da. */
  readonly profile: Readonly<Record<string, unknown>> | null
  /**
   * Fraccion entre 0 y 1 por subtipo del heroe (CA-02); `"*"` vale para
   * cualquiera. La fuente y la unidad siguen pendientes (decision 1 de HU-73).
   */
  readonly probabilityByHeroType: Readonly<Record<string, number>>
  readonly epic: MasterEpic
}

/**
 * Configuracion del Master de una mision (HU-73, propuesta P-X1). Cada punto de
 * evaluacion es una oportunidad al terminar ese encuentro; el tope limita las
 * apariciones de toda la mision (P-X3).
 */
export interface MasterEncounter {
  readonly evaluationPoints: readonly { readonly afterEncounter: number }[]
  /** 1 si el contenido no lo fija (P-X3). */
  readonly maxAppearances?: number
  readonly candidates: readonly MasterCandidate[]
}

export interface RewardLabel {
  readonly label: string
}

export interface PotentialReward {
  readonly label: string
  readonly probability: number
  readonly rolls: number
}

export interface MissionRewards {
  readonly guaranteed: readonly RewardLabel[]
  readonly potential: readonly PotentialReward[]
  readonly objectiveBonuses: readonly RewardLabel[]
  readonly firstTime: readonly RewardLabel[]
}

export interface MissionDefinition {
  readonly missionId: string
  readonly name: string
  readonly category: MissionCategory
  readonly summary: string
  readonly narrative: string
  readonly imageRef: string | null
  readonly estimatedDurationMinutes: number
  /** Informativo: no bloquea la matricula (propuesta P-M11). */
  readonly recommendedPower: number | null
  /** `missionId` de las misiones que hay que completar antes (CA-07). */
  readonly prerequisites: readonly string[]
  readonly objectives: readonly MissionObjective[]
  readonly enemies: readonly MissionEnemy[]
  readonly finalBoss: MissionBoss
  /** Encuentros que recorre la simulacion; el ultimo es el del jefe. */
  readonly encounters: readonly MissionEncounter[]
  readonly masterEncounter: MasterEncounter | null
  readonly rewards: MissionRewards
  readonly highlightedRewards: readonly RewardLabel[]
  readonly active: boolean
}
