import type { AchievementEvidencePort } from '../../../application/ports/AchievementEvidencePort'
import type { EnrollmentRepositoryPort } from '../../../application/ports/EnrollmentRepositoryPort'
import type { MasterEncounterRepositoryPort } from '../../../application/ports/MasterEncounterRepositoryPort'
import type { ReportRepositoryPort } from '../../../application/ports/ReportRepositoryPort'
import {
  completedReportEvidenceOf,
  type CompletedReportEvidence,
  type DefeatedMasterEvidence,
} from '../../../domain/policies/AchievementPolicy'

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Doble de desarrollo y pruebas de la evidencia de HU-76. Lee los dobles de
 * HU-70, HU-73 y HU-74 solo con sus metodos publicos, y devuelve lo mismo, en el
 * mismo orden, que `PostgresAchievementEvidence`.
 */
export class InMemoryAchievementEvidence implements AchievementEvidencePort {
  constructor(
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly reports: ReportRepositoryPort,
    private readonly masters: MasterEncounterRepositoryPort,
  ) {}

  async completedReportsOf(playerId: string): Promise<readonly CompletedReportEvidence[]> {
    const records = await this.reports.listByPlayer(playerId)

    return records
      .filter(({ report }) => report.summary.outcome === 'COMPLETED')
      .map(({ report }) =>
        completedReportEvidenceOf({
          enrollmentId: report.enrollmentId,
          missionId: report.mission.missionId,
          difficulty: report.mission.difficulty,
          finishedAt: report.summary.finishedAt,
          schemaVersion: report.schemaVersion,
          damageTaken: report.combatStats.damageTaken,
          simulatedDuration: report.summary.simulatedDuration,
          encountersCompleted: report.combatStats.encountersCompleted,
          encountersTotal: report.combatStats.encountersTotal,
        }),
      )
      .sort(
        (a, b) =>
          a.finishedAt.getTime() - b.finishedAt.getTime() ||
          compareText(a.enrollmentId, b.enrollmentId),
      )
  }

  async defeatedMastersOf(playerId: string): Promise<readonly DefeatedMasterEvidence[]> {
    const finished = (await this.enrollments.listByPlayer(playerId)).filter(
      (enrollment) => enrollment.status === 'COMPLETED' || enrollment.status === 'FAILED',
    )
    const records = await Promise.all(
      finished.map((enrollment) => this.masters.listByEnrollment(enrollment.enrollmentId)),
    )

    return records
      .flat()
      .flatMap((record): DefeatedMasterEvidence[] =>
        record.status === 'APPEARED_DEFEATED' && record.masterRef !== null
          ? [
              {
                enrollmentId: record.enrollmentId,
                sequence: record.sequence,
                masterRef: record.masterRef,
                epicRef: record.epicRef,
                grantStatus: record.grant?.status ?? null,
              },
            ]
          : [],
      )
      .sort((a, b) => compareText(a.enrollmentId, b.enrollmentId) || a.sequence - b.sequence)
  }
}
