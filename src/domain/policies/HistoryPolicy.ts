import type { MissionDefinition } from '../entities/MissionDefinition'
import type {
  MissionReport,
  ReportRecord,
  ReportRewardLine,
  RewardStatus,
} from '../entities/MissionReport'
import { DIFFICULTY_LEVELS, type DifficultyLevel } from '../value-objects/difficulty-level'
import { isoDurationSeconds } from '../value-objects/iso-duration'
import { MISSION_CATEGORIES, type MissionCategory } from '../value-objects/mission-category'

/**
 * Proyecciones del historial de HU-74 (CU-74.3, CA-05). Se calculan al leer, a
 * partir de los reportes del jugador (propuesta P-T7): no hay tablas de
 * agregados que mantener coherentes. Funciones puras.
 */

export interface CategoryStats {
  readonly category: MissionCategory
  readonly completed: number
  readonly failed: number
  readonly abandoned: number
  readonly damageDealt: number
  readonly damageTaken: number
}

/** Todas las categorias del vocabulario, tambien las que no tienen misiones. */
export const categoryStatsOf = (reports: readonly MissionReport[]): readonly CategoryStats[] =>
  MISSION_CATEGORIES.map((category) => {
    const own = reports.filter((report) => report.mission.category === category)
    const withOutcome = (outcome: string): number =>
      own.filter((report) => report.summary.outcome === outcome).length
    const total = (amount: (report: MissionReport) => number | null): number =>
      own.reduce((sum, report) => sum + (amount(report) ?? 0), 0)

    return {
      category,
      completed: withOutcome('COMPLETED'),
      failed: withOutcome('FAILED'),
      abandoned: withOutcome('ABANDONED'),
      damageDealt: total((report) => report.combatStats.damageDealt),
      damageTaken: total((report) => report.combatStats.damageTaken),
    }
  })

export interface BestTime {
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  readonly simulatedDuration: string
  readonly enrollmentId: string
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const levelOf = (difficulty: DifficultyLevel): number => DIFFICULTY_LEVELS.indexOf(difficulty)

/**
 * La menor duracion SIMULADA de las misiones completadas, por mision y
 * dificultad (propuesta P-T5): la duracion real es fija por mision. A igual
 * tiempo gana el primero que lo logro.
 */
export const bestTimesOf = (reports: readonly MissionReport[]): readonly BestTime[] => {
  const best = new Map<
    string,
    { readonly report: MissionReport; readonly duration: string; readonly seconds: number }
  >()

  for (const report of reports) {
    const duration = report.summary.simulatedDuration
    const seconds = duration === null ? null : isoDurationSeconds(duration)

    if (report.summary.outcome === 'COMPLETED' && duration !== null && seconds !== null) {
      const key = JSON.stringify([report.mission.missionId, report.mission.difficulty])
      const current = best.get(key)

      if (
        current === undefined ||
        seconds < current.seconds ||
        (seconds === current.seconds &&
          report.summary.finishedAt.getTime() < current.report.summary.finishedAt.getTime())
      ) {
        best.set(key, { report, duration, seconds })
      }
    }
  }

  return [...best.values()]
    .sort(
      (a, b) =>
        compareText(a.report.mission.missionId, b.report.mission.missionId) ||
        levelOf(a.report.mission.difficulty) - levelOf(b.report.mission.difficulty),
    )
    .map(({ report, duration }) => ({
      missionId: report.mission.missionId,
      difficulty: report.mission.difficulty,
      simulatedDuration: duration,
      enrollmentId: report.enrollmentId,
    }))
}

export interface EpicCollectionEntry {
  readonly epicRef: string
  readonly name: string
  /** El Master que la dio, segun la evidencia de HU-73; `null` si no consta. */
  readonly masterRef: string | null
  readonly obtainedAt: Date
  readonly status: RewardStatus
}

const isEpicLine = (line: ReportRewardLine): line is ReportRewardLine & { reference: string } =>
  line.kind === 'EPIC' && line.reference !== null

/** Las epicas ganadas en misiones, con el estado de su entrega, de la primera a la ultima. */
export const epicCollectionOf = (
  records: readonly ReportRecord[],
): readonly EpicCollectionEntry[] =>
  records
    .flatMap(({ report, rewards }) =>
      rewards.filter(isEpicLine).map((line) => ({
        epicRef: line.reference,
        name: line.name,
        masterRef:
          report.enemies.masters.find((master) => master.status === 'APPEARED_DEFEATED')
            ?.masterRef ?? null,
        obtainedAt: report.generatedAt,
        status: line.status,
      })),
    )
    .sort(
      (a, b) =>
        a.obtainedAt.getTime() - b.obtainedAt.getTime() || compareText(a.epicRef, b.epicRef),
    )

export interface NarrativeChain {
  /** La primera mision de la cadena. */
  readonly chainId: string
  /** En orden: cada mision despues de sus requisitos. */
  readonly missions: readonly string[]
}

/**
 * Cadenas narrativas (propuesta P-T6): misiones `STORY` unidas por requisitos
 * previos. Una mision suelta no es una cadena. Solo cuentan las misiones
 * activas y los requisitos entre misiones `STORY`.
 */
export const narrativeChainsOf = (
  definitions: readonly MissionDefinition[],
): readonly NarrativeChain[] => {
  const story = definitions.filter((definition) => definition.category === 'STORY')
  const byId = new Map(story.map((definition) => [definition.missionId, definition]))
  const position = new Map(story.map((definition, index) => [definition.missionId, index]))
  const neighbours = new Map(story.map((definition) => [definition.missionId, new Set<string>()]))

  for (const definition of story) {
    for (const prerequisite of definition.prerequisites) {
      if (prerequisite !== definition.missionId && byId.has(prerequisite)) {
        neighbours.get(definition.missionId)?.add(prerequisite)
        neighbours.get(prerequisite)?.add(definition.missionId)
      }
    }
  }

  const seen = new Set<string>()
  const chains: NarrativeChain[] = []

  for (const definition of story) {
    if (!seen.has(definition.missionId)) {
      const members = componentOf(definition.missionId, neighbours)
      members.forEach((missionId) => seen.add(missionId))

      if (members.size >= 2) {
        const missions = inChainOrder(members, byId, position)
        chains.push({ chainId: missions[0] ?? definition.missionId, missions })
      }
    }
  }

  return chains
}

const componentOf = (
  start: string,
  neighbours: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> => {
  const members = new Set([start])
  const queue = [start]

  // El iterador de un arreglo tambien recorre lo que se le agrega mientras tanto.
  for (const current of queue) {
    for (const neighbour of neighbours.get(current) ?? []) {
      if (!members.has(neighbour)) {
        members.add(neighbour)
        queue.push(neighbour)
      }
    }
  }

  return members
}

/**
 * Orden topologico por niveles: cada vuelta coloca las misiones cuyos
 * requisitos ya estan colocados, en el orden del catalogo. Si ninguna puede (un
 * ciclo en el contenido), coloca las que quedan.
 */
const inChainOrder = (
  members: ReadonlySet<string>,
  byId: ReadonlyMap<string, MissionDefinition>,
  position: ReadonlyMap<string, number>,
): string[] => {
  const byCatalog = (a: string, b: string): number =>
    (position.get(a) ?? 0) - (position.get(b) ?? 0)
  const placed: string[] = []

  while (placed.length < members.size) {
    const remaining = [...members].filter((id) => !placed.includes(id)).sort(byCatalog)
    const ready = remaining.filter((id) =>
      (byId.get(id)?.prerequisites ?? []).every(
        (prerequisite) =>
          prerequisite === id || !members.has(prerequisite) || placed.includes(prerequisite),
      ),
    )

    placed.push(...(ready.length > 0 ? ready : remaining))
  }

  return placed
}

export interface NarrativeProgress extends NarrativeChain {
  readonly completed: number
  readonly total: number
}

/** Una mision cuenta como completada con un reporte `COMPLETED` en cualquier dificultad. */
export const narrativeProgressOf = (
  chains: readonly NarrativeChain[],
  completedMissionIds: ReadonlySet<string>,
): readonly NarrativeProgress[] =>
  chains.map((chain) => ({
    ...chain,
    completed: chain.missions.filter((missionId) => completedMissionIds.has(missionId)).length,
    total: chain.missions.length,
  }))
