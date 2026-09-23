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
export interface MissionObjective {
  readonly id: string
  readonly text: string
  readonly primary: boolean
}

export interface MissionEnemy {
  readonly enemyRef: string
  readonly name: string
  readonly count: number
  readonly description: string | null
}

export interface MissionBoss {
  readonly enemyRef: string
  readonly name: string
  readonly heroType: string | null
  readonly description: string | null
  readonly stats: Readonly<Record<string, number>>
}

export interface MasterEpic {
  readonly epicRef: string
  readonly name: string
  readonly generalEffect: string | null
  readonly epicEffect: string | null
}

export interface MasterCandidate {
  readonly masterRef: string
  readonly name: string
  readonly heroType: string
  readonly epic: MasterEpic
}

export interface MasterEncounter {
  /** Fraccion entre 0 y 1. La fuente y la unidad siguen pendientes (HU-73). */
  readonly probability: number
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
  readonly masterEncounter: MasterEncounter | null
  readonly rewards: MissionRewards
  readonly highlightedRewards: readonly RewardLabel[]
  readonly active: boolean
}
