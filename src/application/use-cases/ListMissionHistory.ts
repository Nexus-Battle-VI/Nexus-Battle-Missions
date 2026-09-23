import type { MissionDefinition } from '../../domain/entities/MissionDefinition'
import type { MissionEnrollment } from '../../domain/entities/MissionEnrollment'
import {
  isHistoryOutcome,
  type HistoryOutcome,
  type MissionReport,
} from '../../domain/entities/MissionReport'
import { InvalidHistoryCursorError } from '../../domain/errors/report-errors'
import type { DifficultyLevel } from '../../domain/value-objects/difficulty-level'
import type { MissionCategory } from '../../domain/value-objects/mission-category'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { ReportRepositoryPort } from '../ports/ReportRepositoryPort'

export const HISTORY_DEFAULT_LIMIT = 20
export const HISTORY_MAX_LIMIT = 50

export interface HistoryItemView {
  readonly enrollmentId: string
  readonly missionId: string
  readonly name: string
  /** `null` solo si la mision ya no esta en el catalogo y no tiene reporte. */
  readonly category: MissionCategory | null
  readonly difficulty: DifficultyLevel
  readonly outcome: HistoryOutcome
  readonly finishedAt: string
  readonly simulatedDuration: string | null
  readonly reportAvailable: boolean
}

export interface HistoryPage {
  readonly items: readonly HistoryItemView[]
  readonly nextCursor: string | null
}

export interface HistoryQuery {
  readonly limit: number
  readonly cursor: string | null
}

interface Entry {
  readonly enrollment: MissionEnrollment
  /** El estado ya comprobado: solo llegan aqui las terminadas. */
  readonly outcome: HistoryOutcome
  readonly report: MissionReport | undefined
  readonly finishedAt: number
}

interface Position {
  readonly finishedAt: number
  readonly enrollmentId: string
}

/** Opaco para el cliente: la ultima posicion entregada, en base64url. */
export const encodeHistoryCursor = (position: Position): string =>
  Buffer.from(
    JSON.stringify([new Date(position.finishedAt).toISOString(), position.enrollmentId]),
    'utf8',
  ).toString('base64url')

/** Solo acepta cursores con la forma que da `encodeHistoryCursor`. */
export const decodeHistoryCursor = (cursor: string): Position => {
  let decoded: unknown = null

  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    // Se informa abajo, igual que cualquier otro cursor que no cumple.
  }

  if (Array.isArray(decoded) && decoded.length === 2) {
    const [finishedAt, enrollmentId] = decoded as unknown[]
    const time = typeof finishedAt === 'string' ? Date.parse(finishedAt) : Number.NaN

    if (
      typeof enrollmentId === 'string' &&
      enrollmentId !== '' &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === finishedAt
    ) {
      return { finishedAt: time, enrollmentId }
    }
  }

  throw new InvalidHistoryCursorError()
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Del mas reciente al mas antiguo; a igual fecha, por matricula, para que el orden sea total. */
const newestFirst = (a: Entry, b: Entry): number =>
  b.finishedAt - a.finishedAt || compareText(b.enrollment.enrollmentId, a.enrollment.enrollmentId)

const isAfter = (entry: Entry, position: Position): boolean =>
  entry.finishedAt < position.finishedAt ||
  (entry.finishedAt === position.finishedAt &&
    entry.enrollment.enrollmentId < position.enrollmentId)

/**
 * `GET /api/v1/missions/me/history` (Task HU-74.2, CU-74.3, CA-05). Solo
 * misiones terminadas, de la mas reciente a la mas antigua; las anuladas
 * aparecen sin reporte (P-T3). Se calcula al leer sobre las matriculas y los
 * reportes del jugador (P-T7), paginado por cursor.
 */
export class ListMissionHistory {
  constructor(
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly reports: ReportRepositoryPort,
    private readonly catalog: MissionCatalogPort,
  ) {}

  async execute(playerId: string, query: HistoryQuery): Promise<HistoryPage> {
    const after = query.cursor === null ? null : decodeHistoryCursor(query.cursor)
    const [enrollments, records] = await Promise.all([
      this.enrollments.listByPlayer(playerId),
      this.reports.listByPlayer(playerId),
    ])
    const reports = new Map(records.map(({ report }) => [report.enrollmentId, report]))
    const finished = enrollments
      .flatMap((enrollment): Entry[] => {
        if (!isHistoryOutcome(enrollment.status) || enrollment.finishedAt === null) {
          return []
        }

        const report = reports.get(enrollment.enrollmentId)
        // Con reporte, la mision termino al vencer su duracion (`endsAt`).
        const finishedAt = (report?.summary.finishedAt ?? enrollment.finishedAt).getTime()

        return [{ enrollment, outcome: enrollment.status, report, finishedAt }]
      })
      .sort(newestFirst)
    const remaining = after === null ? finished : finished.filter((entry) => isAfter(entry, after))
    const page = remaining.slice(0, query.limit)
    const last = page.at(-1)
    const definitions = await this.definitionsOf(page)

    return {
      items: page.map((entry) => itemOf(entry, definitions)),
      nextCursor:
        remaining.length > page.length && last !== undefined
          ? encodeHistoryCursor({
              finishedAt: last.finishedAt,
              enrollmentId: last.enrollment.enrollmentId,
            })
          : null,
    }
  }

  /** El nombre de las misiones sin reporte sale del catalogo, aunque ya no esten activas. */
  private async definitionsOf(
    page: readonly Entry[],
  ): Promise<ReadonlyMap<string, MissionDefinition>> {
    const missing = [
      ...new Set(
        page
          .filter((entry) => entry.report === undefined)
          .map((entry) => entry.enrollment.missionId),
      ),
    ]
    const found = await Promise.all(missing.map((missionId) => this.catalog.findById(missionId)))

    return new Map(
      found.flatMap((definition) =>
        definition === null ? [] : [[definition.missionId, definition] as const],
      ),
    )
  }
}

const itemOf = (
  { enrollment, outcome, report, finishedAt }: Entry,
  definitions: ReadonlyMap<string, MissionDefinition>,
): HistoryItemView => {
  const definition = definitions.get(enrollment.missionId)

  return {
    enrollmentId: enrollment.enrollmentId,
    missionId: enrollment.missionId,
    name: report?.mission.name ?? definition?.name ?? enrollment.missionId,
    category: report?.mission.category ?? definition?.category ?? null,
    difficulty: enrollment.difficulty,
    outcome,
    finishedAt: new Date(finishedAt).toISOString(),
    simulatedDuration: report?.summary.simulatedDuration ?? null,
    reportAvailable: report !== undefined,
  }
}

export const LIST_MISSION_HISTORY = Symbol('ListMissionHistory')
