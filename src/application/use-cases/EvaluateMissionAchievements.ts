import type { AchievementDefinition } from '../../domain/entities/Achievement'
import { retryDelayMs } from '../../domain/entities/MissionExecution'
import {
  achievementContentOf,
  catalogFingerprintOf,
  evidenceNeedsOf,
  unlocksDue,
  type AchievementContent,
} from '../../domain/policies/AchievementPolicy'
import type { AchievementCatalogPort } from '../ports/AchievementCatalogPort'
import type { AchievementEvidencePort } from '../ports/AchievementEvidencePort'
import type {
  AchievementRepositoryPort,
  PlayerToEvaluate,
} from '../ports/AchievementRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { DifficultyClearRepositoryPort } from '../ports/DifficultyClearRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import { readAchievementEvidence } from './AchievementEvidence'

export interface AchievementCycleSummary {
  readonly achievementPlayersEvaluated: number
  readonly achievementsUnlocked: number
  readonly achievementEvaluationsFailed: number
}

type Tally = { -readonly [K in keyof AchievementCycleSummary]: number }

export interface AchievementEvaluationOptions {
  readonly batchSize: number
  /** Un fallo con un jugador no detiene a los demas; se informa aqui. */
  readonly onError?: (error: unknown) => void
}

/**
 * Evaluacion de logros (Task HU-76.2, CU-76.1; CA-01 a CA-03). Corre en el
 * planificador de HU-72, despues de la entrega de epicas, y evalua a cada
 * jugador con algo nuevo: otra mision terminada, otra epica entregada o un
 * cambio del catalogo o del contenido.
 *
 * Con la evidencia de ahora, desbloquea cada logro pendiente con el progreso
 * completo y deja al dia el punto de control del jugador, todo en una
 * transaccion. Repetir la evaluacion no duplica nada (P-05): un logro se
 * desbloquea una sola vez por jugador. No marca ningun hecho.
 */
export class EvaluateMissionAchievements {
  constructor(
    private readonly catalog: AchievementCatalogPort,
    private readonly achievements: AchievementRepositoryPort,
    private readonly evidence: AchievementEvidencePort,
    private readonly clears: DifficultyClearRepositoryPort,
    private readonly missions: MissionCatalogPort,
    private readonly clock: ClockPort,
    private readonly options: AchievementEvaluationOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<AchievementCycleSummary> {
    const tally: Tally = {
      achievementPlayersEvaluated: 0,
      achievementsUnlocked: 0,
      achievementEvaluationsFailed: 0,
    }
    const definitions = await this.catalog.list()

    // Sin logros en el catalogo no hay nada que evaluar ni que consultar.
    if (definitions.length === 0) {
      return { ...tally }
    }

    const content = achievementContentOf(await this.missions.listActive())
    const fingerprint = catalogFingerprintOf(definitions, content)

    for (const player of await this.achievements.playersToEvaluate(
      this.clock.now(),
      fingerprint,
      this.options.batchSize,
    )) {
      try {
        tally.achievementsUnlocked += await this.evaluate(player, definitions, content, fingerprint)
        tally.achievementPlayersEvaluated += 1
      } catch (error: unknown) {
        tally.achievementEvaluationsFailed += 1
        this.options.onError?.(error)
        await this.deferAfterFailure(player)
      }
    }

    return { ...tally }
  }

  /** Devuelve cuantos logros se desbloquearon ahora. */
  private async evaluate(
    player: PlayerToEvaluate,
    definitions: readonly AchievementDefinition[],
    content: AchievementContent,
    fingerprint: string,
  ): Promise<number> {
    const { playerId } = player
    const unlocked = new Set(
      (await this.achievements.unlocksOf(playerId)).map((unlock) => unlock.achievementId),
    )
    const pending = definitions.filter((definition) => !unlocked.has(definition.achievementId))
    // Siempre DESPUES de los conteos del punto de control (ver `PlayerToEvaluate`).
    const evidence = await readAchievementEvidence(
      { evidence: this.evidence, clears: this.clears },
      playerId,
      evidenceNeedsOf(pending),
    )
    const now = this.clock.now()
    const inserted = await this.achievements.recordEvaluation(
      playerId,
      unlocksDue({ playerId, pending, content, evidence, now }),
      {
        settledSeen: player.settled,
        epicsGrantedSeen: player.epicsGranted,
        fingerprint,
        evaluatedAt: now,
      },
    )

    return inserted.length
  }

  /**
   * Un jugador que falla se aplaza con el escalonado de HU-72. Si no, volveria
   * a la cabeza del lote en cada ciclo, sin espera y quitandole sitio a los
   * demas.
   */
  private async deferAfterFailure(player: PlayerToEvaluate): Promise<void> {
    const attempts = player.attempts + 1

    try {
      await this.achievements.deferEvaluation(player.playerId, {
        attempts,
        nextAttemptAt: new Date(this.clock.now().getTime() + retryDelayMs(attempts)),
        lastError: 'INTERNAL_ERROR',
      })
    } catch {
      // Sin base no hay como aplazarlo: el ciclo siguiente lo vuelve a intentar.
    }
  }
}

export const EVALUATE_MISSION_ACHIEVEMENTS = Symbol('EvaluateMissionAchievements')
