import type {
  EvidenceNeeds,
  PlayerAchievementEvidence,
} from '../../domain/policies/AchievementPolicy'
import type { AchievementEvidencePort } from '../ports/AchievementEvidencePort'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'

export interface AchievementEvidenceSources {
  readonly evidence: AchievementEvidencePort
  readonly clears: DifficultyClearRepositoryPort
}

/**
 * La evidencia de logros de un jugador (HU-76): solo lo que piden `needs`, en
 * paralelo; lo demas queda en `null`. La comparten el evaluador y la consulta,
 * asi que los dos ven lo mismo.
 */
export const readAchievementEvidence = async (
  sources: AchievementEvidenceSources,
  playerId: string,
  needs: EvidenceNeeds,
): Promise<PlayerAchievementEvidence> => {
  const [completedMissionIds, completedReports, defeatedMasters] = await Promise.all([
    needs.clears ? sources.clears.completedMissions(playerId) : null,
    needs.reports ? sources.evidence.completedReportsOf(playerId) : null,
    needs.masters ? sources.evidence.defeatedMastersOf(playerId) : null,
  ])

  return { completedMissionIds, completedReports, defeatedMasters }
}
