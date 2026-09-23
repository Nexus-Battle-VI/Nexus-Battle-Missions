import type { ReportRepositoryPort } from '../../../application/ports/ReportRepositoryPort'
import type { ReportRecord, RewardStatus } from '../../../domain/entities/MissionReport'

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Doble de desarrollo y pruebas de `mission_reports` y `mission_report_rewards`
 * (HU-74). El cierre del doble de ejecuciones escribe aqui con `recordNow`, sin
 * esperas, que es el equivalente en memoria de hacerlo en su transaccion.
 */
export class InMemoryReportRepository implements ReportRepositoryPort {
  private readonly records = new Map<string, ReportRecord>()

  /** Sincrona, para el cierre de HU-72. La foto no se reemplaza: es inmutable (P-T2). */
  recordNow(record: ReportRecord): boolean {
    const enrollmentId = record.report.enrollmentId

    if (this.records.has(enrollmentId)) {
      return false
    }

    this.records.set(enrollmentId, { report: record.report, rewards: [...record.rewards] })

    return true
  }

  findByEnrollment(enrollmentId: string): Promise<ReportRecord | null> {
    return Promise.resolve(this.records.get(enrollmentId) ?? null)
  }

  listByPlayer(playerId: string): Promise<readonly ReportRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter(({ report }) => report.playerId === playerId)
        .sort(
          (a, b) =>
            b.report.summary.finishedAt.getTime() - a.report.summary.finishedAt.getTime() ||
            compareText(b.report.enrollmentId, a.report.enrollmentId),
        ),
    )
  }

  updateRewardStatus(
    enrollmentId: string,
    lineNo: number,
    status: RewardStatus,
    at: Date,
  ): Promise<boolean> {
    return Promise.resolve(this.updateRewardStatusNow(enrollmentId, lineNo, status, at))
  }

  /** Sincrona, para la entrega de la epica de HU-73, que cambia la linea a la vez. */
  updateRewardStatusNow(
    enrollmentId: string,
    lineNo: number,
    status: RewardStatus,
    at: Date,
  ): boolean {
    const record = this.records.get(enrollmentId)

    if (!record?.rewards.some((line) => line.lineNo === lineNo)) {
      return false
    }

    this.records.set(enrollmentId, {
      report: record.report,
      rewards: record.rewards.map((line) =>
        line.lineNo === lineNo ? { ...line, status, updatedAt: at } : line,
      ),
    })

    return true
  }
}
