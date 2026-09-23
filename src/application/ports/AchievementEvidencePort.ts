import type {
  CompletedReportEvidence,
  DefeatedMasterEvidence,
} from '../../domain/policies/AchievementPolicy'

/**
 * Evidencia de los logros (HU-76): solo LECTURA sobre tablas del mismo servicio
 * que escriben otras historias. Los clears de HU-75 se leen con su propio
 * puerto (`DifficultyClearRepositoryPort.completedMissions`, P-M10).
 *
 * No amplia `ReportRepositoryPort` ni `MasterEncounterRepositoryPort`: la lectura
 * es por jugador y tolerante con la foto del reporte.
 */
export interface AchievementEvidencePort {
  /**
   * Los reportes `COMPLETED` del jugador (HU-74), leidos con tolerancia: nunca
   * lanza por la forma o la version de la foto; lo que no se puede comprobar
   * queda en `null`.
   */
  completedReportsOf(playerId: string): Promise<readonly CompletedReportEvidence[]>

  /**
   * Los Master que el heroe derroto (`APPEARED_DEFEATED`, HU-73) en las
   * matriculas `COMPLETED` o `FAILED` del jugador, con el estado de la entrega
   * de su epica.
   */
  defeatedMastersOf(playerId: string): Promise<readonly DefeatedMasterEvidence[]>
}

export const ACHIEVEMENT_EVIDENCE = Symbol('AchievementEvidencePort')
