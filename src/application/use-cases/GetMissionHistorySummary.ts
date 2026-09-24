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
  /** Objetos obtenidos al derrotar jefes; se conserva aunque no haya producto de Catalog. */
  readonly lootCollection: readonly {
    readonly label: string
    readonly productId: string | null
    readonly quantity: number
  }[]
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
    const loot = new Map<string, { label: string; productId: string | null; quantity: number }>()
    for (const report of reports) {
      for (const drop of report.loot ?? []) {
        const key = `${drop.productId ?? ''}\u0000${drop.label}`
        loot.set(key, { ...drop, quantity: (loot.get(key)?.quantity ?? 0) + drop.quantity })
      }
    }

    return {
      byCategory: categoryStatsOf(reports),
      bestTimes: bestTimesOf(reports),
      epicCollection: epicCollectionOf(records).map((entry) => ({
        ...entry,
        obtainedAt: entry.obtainedAt.toISOString(),
      })),
      lootCollection: [...loot.values()].sort((a, b) => a.label.localeCompare(b.label, 'es')),
      narrativeProgress: narrativeProgressOf(narrativeChainsOf(definitions), completed),
    }
  }
}

export const GET_MISSION_HISTORY_SUMMARY = Symbol('GetMissionHistorySummary')
