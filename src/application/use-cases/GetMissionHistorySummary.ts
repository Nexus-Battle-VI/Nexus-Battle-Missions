import {
  bestTimesOf,
  categoryStatsOf,
  epicCollectionOf,
  narrativeChainsOf,
  narrativeProgressOf,
  type BestTime,
  type CategoryStats,
  type EpicCollectionEntry,
  type NarrativeProgress,
} from '../../domain/policies/HistoryPolicy'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { ReportRepositoryPort } from '../ports/ReportRepositoryPort'

export interface HistorySummaryView {
  readonly byCategory: readonly CategoryStats[]
  readonly bestTimes: readonly BestTime[]
  readonly epicCollection: readonly (Omit<EpicCollectionEntry, 'obtainedAt'> & {
    readonly obtainedAt: string
  })[]
  readonly narrativeProgress: readonly NarrativeProgress[]
}

/**
 * `GET /api/v1/missions/me/history/summary` (Task HU-74.2, CA-05): estadisticas
 * por tipo, mejores tiempos, coleccion de epicas y progreso en las cadenas
 * narrativas, calculados al leer a partir de los reportes del jugador (P-T7).
 */
export class GetMissionHistorySummary {
  constructor(
    private readonly reports: ReportRepositoryPort,
    private readonly catalog: MissionCatalogPort,
  ) {}

  async execute(playerId: string): Promise<HistorySummaryView> {
    const [records, definitions] = await Promise.all([
      this.reports.listByPlayer(playerId),
      this.catalog.listActive(),
    ])
    const reports = records.map(({ report }) => report)
    const completed = new Set(
      reports
        .filter((report) => report.summary.outcome === 'COMPLETED')
        .map((report) => report.mission.missionId),
    )

    return {
      byCategory: categoryStatsOf(reports),
      bestTimes: bestTimesOf(reports),
      epicCollection: epicCollectionOf(records).map((entry) => ({
        ...entry,
        obtainedAt: entry.obtainedAt.toISOString(),
      })),
      narrativeProgress: narrativeProgressOf(narrativeChainsOf(definitions), completed),
    }
  }
}

export const GET_MISSION_HISTORY_SUMMARY = Symbol('GetMissionHistorySummary')
