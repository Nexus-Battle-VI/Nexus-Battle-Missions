import { isActiveEnrollment } from '../../domain/entities/MissionEnrollment'
import type {
  CombatStats,
  MissionReport,
  ReportEnemies,
  ReportExperience,
  ReportObjective,
  ReportRecord,
  ReportRewardLine,
  ReportSummary,
} from '../../domain/entities/MissionReport'
import { ReportNotAvailableError, ReportNotFoundError } from '../../domain/errors/report-errors'
import { experienceSummaryOf } from '../../domain/policies/ReportPolicy'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ReportRepositoryPort } from '../ports/ReportRepositoryPort'

export type RewardLineView = Omit<ReportRewardLine, 'lineNo' | 'updatedAt' | 'progression'>

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
  /**
   * HU-09 (Task HU-09.5): la experiencia por derrota, agregada. Se DERIVA de las
   * lineas de arriba al leer, asi que no puede contradecirlas.
   */
  readonly experience: ReportExperience
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
  // El nivel del heroe y el desglose por derrota salen de las lineas `HU-09`: la
  // progresion de CADA una no se publica suelta, que seria repetir el mismo nivel
  // ocho veces, sino agregada aqui.
  experience: experienceSummaryOf(rewards),
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
