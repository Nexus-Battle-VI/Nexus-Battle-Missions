import { isActiveEnrollment } from '../../domain/entities/MissionEnrollment'
import type {
  CombatStats,
  MissionReport,
  ReportEnemies,
  ReportObjective,
  ReportRecord,
  ReportRewardLine,
  ReportSummary,
} from '../../domain/entities/MissionReport'
import { ReportNotAvailableError, ReportNotFoundError } from '../../domain/errors/report-errors'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ReportRepositoryPort } from '../ports/ReportRepositoryPort'

export type RewardLineView = Omit<ReportRewardLine, 'lineNo' | 'updatedAt'>

export interface MissionReportView {
  readonly schemaVersion: number
  readonly enrollmentId: string
  readonly mission: MissionReport['mission']
  readonly summary: Omit<ReportSummary, 'startedAt' | 'finishedAt'> & {
    readonly startedAt: string
    readonly finishedAt: string
  }
  readonly combatStats: CombatStats
  readonly enemies: ReportEnemies
  readonly loot?: MissionReport['loot']
  readonly objectives: readonly ReportObjective[]
  /** Lo unico que cambia con el tiempo: el estado de cada entrega (P-T2). */
  readonly rewards: readonly RewardLineView[]
  readonly generatedAt: string
}

/** La forma del contrato hu-74-mission-report-v1: sin el jugador y con fechas ISO-8601. */
export const reportViewOf = ({ report, rewards }: ReportRecord): MissionReportView => ({
  schemaVersion: report.schemaVersion,
  enrollmentId: report.enrollmentId,
  mission: report.mission,
  summary: {
    ...report.summary,
    startedAt: report.summary.startedAt.toISOString(),
    finishedAt: report.summary.finishedAt.toISOString(),
  },
  combatStats: report.combatStats,
  enemies: report.enemies,
  ...(report.loot === undefined ? {} : { loot: report.loot }),
  objectives: report.objectives,
  rewards: rewards.map(({ kind, reference, name, rarity, quantity, status, source }) => ({
    kind,
    reference,
    name,
    rarity,
    quantity,
    status,
    source,
  })),
  generatedAt: report.generatedAt.toISOString(),
})

/**
 * `GET /api/v1/missions/me/reports/{enrollmentId}` (Task HU-74.2, CU-74.2). El
 * jugador sale del testimonio verificado: un reporte ajeno responde igual que
 * uno que no existe, para no revelar que matriculas hay (propuesta P-T8).
 */
export class GetMissionReport {
  constructor(
    private readonly reports: ReportRepositoryPort,
    private readonly enrollments: EnrollmentRepositoryPort,
  ) {}

  async execute(playerId: string, enrollmentId: string): Promise<MissionReportView> {
    const record = await this.reports.findByEnrollment(enrollmentId)

    if (record !== null && record.report.playerId === playerId) {
      return reportViewOf(record)
    }

    const enrollment = await this.enrollments.findById(enrollmentId)

    // CA-04: una mision en curso todavia no tiene reporte.
    if (
      enrollment !== null &&
      enrollment.playerId === playerId &&
      isActiveEnrollment(enrollment.status)
    ) {
      throw new ReportNotAvailableError(enrollmentId, enrollment.endsAt)
    }

    throw new ReportNotFoundError(enrollmentId)
  }
}

export const GET_MISSION_REPORT = Symbol('GetMissionReport')
