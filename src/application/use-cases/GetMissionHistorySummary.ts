import {
  bestTimesOf,
  categoryStatsOf,
  epicAlbumOf,
  epicCollectionOf,
  narrativeChainsOf,
  narrativeProgressOf,
  type BestTime,
  type CategoryStats,
  type EpicAlbumEntry,
  type EpicCollectionEntry,
  type NarrativeProgress,
} from '../../domain/policies/HistoryPolicy'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { ReportRepositoryPort } from '../ports/ReportRepositoryPort'

export interface HistorySummaryView {
  readonly byCategory: readonly CategoryStats[]
  /** Con el nombre de la mision, para no mostrar su identificador (P-J10). */
  readonly bestTimes: readonly (BestTime & { readonly missionName: string })[]
  readonly epicCollection: readonly (Omit<EpicCollectionEntry, 'obtainedAt'> & {
    readonly obtainedAt: string
  })[]
  /** Cada epica que se puede ganar y si ya se tiene: la meta a largo plazo (P-J3). */
  readonly epicAlbum: readonly EpicAlbumEntry[]
  /** Objetos obtenidos al derrotar jefes; se conserva aunque no haya producto de Catalog. */
  readonly lootCollection: readonly {
    readonly label: string
    readonly productId: string | null
    readonly quantity: number
  }[]
  /** `missionNames` va en el mismo orden que `missions` (P-J10). */
  readonly narrativeProgress: readonly (NarrativeProgress & {
    readonly missionNames: readonly string[]
  })[]
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
    // El nombre vigente del catalogo; si la mision se retiro, el que tenia al cerrarse.
    const names = new Map(reports.map((report) => [report.mission.missionId, report.mission.name]))
    for (const definition of definitions) names.set(definition.missionId, definition.name)
    const nameOf = (missionId: string): string => names.get(missionId) ?? missionId
    const collection = epicCollectionOf(records)

    return {
      byCategory: categoryStatsOf(reports),
      bestTimes: bestTimesOf(reports).map((best) => ({
        ...best,
        missionName: nameOf(best.missionId),
      })),
      epicCollection: collection.map((entry) => ({
        ...entry,
        obtainedAt: entry.obtainedAt.toISOString(),
      })),
      epicAlbum: epicAlbumOf(definitions, collection),
      lootCollection: [...loot.values()].sort((a, b) => a.label.localeCompare(b.label, 'es')),
      narrativeProgress: narrativeProgressOf(narrativeChainsOf(definitions), completed).map(
        (progress) => ({ ...progress, missionNames: progress.missions.map(nameOf) }),
      ),
    }
  }
}

export const GET_MISSION_HISTORY_SUMMARY = Symbol('GetMissionHistorySummary')
