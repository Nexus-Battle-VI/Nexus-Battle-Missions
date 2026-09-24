import {
  achievementContentOf,
  achievementViewsOf,
  evidenceNeedsOf,
  type AchievementView,
} from '../../domain/policies/AchievementPolicy'
import type { AchievementCatalogPort } from '../ports/AchievementCatalogPort'
import type { AchievementEvidencePort } from '../ports/AchievementEvidencePort'
import type { AchievementRepositoryPort } from '../ports/AchievementRepositoryPort'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import { readAchievementEvidence } from './AchievementEvidence'

export type MissionAchievementItem = Omit<AchievementView, 'unlockedAt'> & {
  readonly unlockedAt: string | null
}

export interface MissionAchievementsView {
  readonly items: readonly MissionAchievementItem[]
}

/**
 * `GET /api/v1/missions/me/achievements` (Task HU-76.2, contrato
 * hu-76-mission-achievements-v1): los logros del jugador con su progreso y su
 * reconocimiento, para el perfil (CA-01).
 *
 * Solo lee: nunca desbloquea. El progreso de lo que falta se calcula con la
 * misma funcion que el evaluador; lo desbloqueado sale congelado (P-L5). Solo se
 * lee la evidencia que necesitan los logros aun no desbloqueados.
 */
export class GetMissionAchievements {
  constructor(
    private readonly catalog: AchievementCatalogPort,
    private readonly achievements: AchievementRepositoryPort,
    private readonly evidence: AchievementEvidencePort,
    private readonly clears: DifficultyClearRepositoryPort,
    private readonly missions: MissionCatalogPort,
  ) {}

  async execute(playerId: string): Promise<MissionAchievementsView> {
    const [definitions, unlocks, active] = await Promise.all([
      this.catalog.list(),
      this.achievements.unlocksOf(playerId),
      this.missions.listActive(),
    ])
    const unlocked = new Set(unlocks.map((unlock) => unlock.achievementId))
    const evidence = await readAchievementEvidence(
      { evidence: this.evidence, clears: this.clears },
      playerId,
      evidenceNeedsOf(definitions.filter((definition) => !unlocked.has(definition.achievementId))),
    )
    const views = achievementViewsOf({
      definitions,
      content: achievementContentOf(active),
      evidence,
      unlocks,
    })

    return {
      items: views.map((view) => ({
        ...view,
        unlockedAt: view.unlockedAt === null ? null : view.unlockedAt.toISOString(),
      })),
    }
  }
}

export const GET_MISSION_ACHIEVEMENTS = Symbol('GetMissionAchievements')
