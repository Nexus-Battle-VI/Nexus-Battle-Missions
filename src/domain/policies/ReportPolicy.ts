import { isAppearance, type MasterEncounterRecord } from '../entities/MasterEncounterRecord'
import type { MissionDefinition } from '../entities/MissionDefinition'
import type { MissionEnrollment } from '../entities/MissionEnrollment'
import type { Settlement, SimulationResult } from '../entities/MissionExecution'
import {
  REPORT_SCHEMA_VERSION,
  type CombatStats,
  type DefeatedEnemy,
  type MissionReport,
  type ReportExperience,
  type ReportMaster,
  type ReportOutcome,
  type ReportRewardLine,
  type SkillUse,
} from '../entities/MissionReport'
import { isoDurationSeconds } from '../value-objects/iso-duration'
import { isCount, isRecord, simulationFactsOf } from './SettlementPolicy'

/**
 * Arma el reporte de HU-74 (CU-74.1) con lo que el cierre de HU-72 ya tiene: el
 * resumen de Combat, los objetivos evaluados y el contenido de la mision. Es una
 * funcion pura: no llama a Combat ni recalcula nada (P-T1 y P-T2).
 *
 * HU-72 valida solo los hechos que deciden el resultado. El resto del resumen se
 * lee con tolerancia: un dato que falta o no cumple queda en `null` (o fuera de
 * su lista) en lugar de impedir el cierre de la mision.
 */
export interface ReportInput {
  readonly enrollment: MissionEnrollment
  readonly definition: MissionDefinition
  readonly result: SimulationResult
  readonly settlement: Settlement
  /** Perfil del heroe congelado en la solicitud a Combat (HU-72): da nombre y subtipo. */
  readonly heroProfile: Readonly<Record<string, unknown>> | null
  /** La evidencia del Master de HU-73; sin ella, ningun Master aparecio. */
  readonly masters?: readonly MasterEncounterRecord[]
  /** El momento del cierre. */
  readonly generatedAt: Date
}

const countOrNull = (value: unknown): number | null => (isCount(value) ? value : null)

/** El dano puede no ser entero; basta con que sea un numero finito no negativo. */
const amountOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** Solo los Master que aparecieron (CA-03); la no aparicion queda en la evidencia de HU-73. */
const mastersOf = (
  records: readonly MasterEncounterRecord[],
  definition: MissionDefinition,
): readonly ReportMaster[] => {
  // El contenido vigente llega de `jsonb`: sin la forma esperada, solo se pierde el nombre.
  const config: unknown = definition.masterEncounter
  const candidates: readonly unknown[] =
    isRecord(config) && Array.isArray(config.candidates) ? config.candidates : []
  const names = new Map(
    candidates.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.masterRef === 'string'
        ? [[candidate.masterRef, textOrNull(candidate.name)] as const]
        : [],
    ),
  )

  return records.flatMap(({ masterRef, status }) =>
    masterRef !== null && isAppearance(status)
      ? [{ masterRef, name: names.get(masterRef) ?? masterRef, status }]
      : [],
  )
}

const skillsUsedOf = (value: unknown): readonly SkillUse[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const skills: SkillUse[] = []

  for (const entry of value as unknown[]) {
    const abilityId = isRecord(entry) ? textOrNull(entry.abilityId) : null
    const count = isRecord(entry) ? countOrNull(entry.count) : null

    if (abilityId !== null && count !== null) {
      skills.push({ abilityId, count })
    }
  }

  return skills
}

const combatStatsOf = (summary: Readonly<Record<string, unknown>>): CombatStats => ({
  encountersCompleted: countOrNull(summary.encountersCompleted),
  encountersTotal: countOrNull(summary.encountersTotal),
  totalTurns: countOrNull(summary.totalTurns),
  damageDealt: amountOrNull(summary.damageDealt),
  damageTaken: amountOrNull(summary.damageTaken),
  criticalEffects: countOrNull(summary.criticalEffects),
  skillsUsed: skillsUsedOf(summary.skillsUsed),
})

/** Los enemigos regulares derrotados, con el nombre del contenido. El jefe va aparte. */
const defeatedOf = (value: unknown, definition: MissionDefinition): readonly DefeatedEnemy[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const names = new Map(definition.enemies.map((enemy) => [enemy.enemyRef, enemy.name]))
  const defeated: DefeatedEnemy[] = []

  for (const entry of value as unknown[]) {
    const enemyRef = isRecord(entry) ? textOrNull(entry.enemyRef) : null
    const count = isRecord(entry) ? countOrNull(entry.count) : null

    if (enemyRef !== null && count !== null && enemyRef !== definition.finalBoss.enemyRef) {
      defeated.push({ enemyRef, name: names.get(enemyRef) ?? enemyRef, count })
    }
  }

  return defeated
}

const simulatedDurationOf = (value: unknown): string | null => {
  const duration = textOrNull(value)

  return duration !== null && isoDurationSeconds(duration) !== null ? duration : null
}

const reportOutcomeOf = (settlement: Settlement): ReportOutcome => {
  if (settlement.outcome === 'VOIDED') {
    throw new RangeError('Una mision anulada no tiene reporte (HU-74, P-T3).')
  }

  return settlement.outcome
}

export const missionReportOf = (input: ReportInput): MissionReport => {
  const { enrollment, definition, result, settlement } = input

  if (enrollment.startedAt === null || enrollment.endsAt === null) {
    throw new RangeError(`La matricula ${enrollment.enrollmentId} no tiene inicio y fin.`)
  }

  const summary = result.summary
  const met = new Map(settlement.objectives.map((objective) => [objective.id, objective.met]))

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    enrollmentId: enrollment.enrollmentId,
    playerId: enrollment.playerId,
    mission: {
      missionId: definition.missionId,
      name: definition.name,
      category: definition.category,
      difficulty: enrollment.difficulty,
    },
    summary: {
      outcome: reportOutcomeOf(settlement),
      outcomeReason: settlement.reason,
      hero: {
        heroId: enrollment.heroId,
        name: textOrNull(input.heroProfile?.name),
        subtype: textOrNull(input.heroProfile?.subtype),
      },
      startedAt: enrollment.startedAt,
      // La mision termina para el jugador al vencer su duracion, aunque el
      // planificador la cierre unos segundos despues.
      finishedAt: enrollment.endsAt,
      simulatedDuration: simulatedDurationOf(summary.simulatedDuration),
    },
    combatStats: combatStatsOf(summary),
    enemies: {
      defeated: defeatedOf(summary.enemiesDefeated, definition),
      boss: {
        enemyRef: definition.finalBoss.enemyRef,
        name: definition.finalBoss.name,
        defeated: simulationFactsOf(summary)?.bossDefeated ?? false,
      },
      masters: mastersOf(input.masters ?? [], definition),
    },
    objectives: definition.objectives.map((objective) => ({
      id: objective.id,
      text: objective.text,
      primary: objective.primary,
      met: met.get(objective.id) ?? null,
      bonus: null,
    })),
    generatedAt: input.generatedAt,
  }
}

/** Una linea de experiencia la escribio HU-09: es la unica fuente de este bloque. */
const isExperienceLine = (line: ReportRewardLine): boolean =>
  line.source === 'HU-09' && line.kind === 'EXPERIENCE'

/**
 * El resumen de experiencia del reporte (HU-09, Task HU-09.5), derivado de sus
 * lineas `HU-09`.
 *
 * SE DERIVA Y NO SE GUARDA: es lo unico del reporte que cambia con el tiempo, y un
 * total guardado aparte acabaria diciendo algo distinto que sus propias lineas.
 *
 * EL NIVEL ES EL MAXIMO DE LAS LINEAS ACREDITADAS, no el de la ultima ni el de la
 * de mayor numero. El nivel y la experiencia acumulada SOLO CRECEN (lo garantiza
 * Player/Inventory), asi que el maximo es el estado final del heroe con
 * independencia del orden en que el barrido acredito las derrotas -- que no es un
 * orden que este codigo controle.
 *
 * SIN ACREDITACIONES TODAVIA, el nivel es `null` y no un cero: un cero seria un
 * nivel que el heroe no tiene.
 *
 * UN REPORTE ANTERIOR A HU-09 no tiene lineas de este origen y sale con ceros y
 * con `level: null`, que es la verdad: esa mision no registro derrotas.
 */
export const experienceSummaryOf = (rewards: readonly ReportRewardLine[]): ReportExperience => {
  const lines = rewards.filter(isExperienceLine)
  const credited = lines.filter((line) => line.status === 'CREDITED')

  let level: number | null = null
  let currentXp: number | null = null
  let maxLevel: number | null = null
  let levelsGained = 0
  let totalXp = 0

  for (const line of credited) {
    const progression = line.progression

    totalXp += line.quantity

    if (progression === null) {
      continue
    }

    level = level === null ? progression.level : Math.max(level, progression.level)
    currentXp =
      currentXp === null ? progression.currentXp : Math.max(currentXp, progression.currentXp)
    maxLevel = maxLevel === null ? progression.maxLevel : Math.max(maxLevel, progression.maxLevel)
    levelsGained += progression.levelsGained
  }

  return {
    defeats: lines.length,
    totalXp,
    credited: credited.length,
    pending: lines.filter((line) => line.status === 'PENDING').length,
    failed: lines.filter((line) => line.status === 'FAILED').length,
    level,
    currentXp,
    maxLevel,
    levelsGained,
    leveledUp: levelsGained > 0,
  }
}
