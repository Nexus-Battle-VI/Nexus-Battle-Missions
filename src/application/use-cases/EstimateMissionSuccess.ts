import {
  EstimateUnavailableError,
  HeroNotOwnedError,
  MissionNotFoundError,
} from '../../domain/errors/mission-errors'
import {
  ESTIMATE_RUNS,
  estimateOperationId,
  percentOf,
  riskLabelOf,
  riskOf,
  type EstimateRisk,
} from '../../domain/policies/EstimatePolicy'
import {
  parseDifficultyLevel,
  type DifficultyLevel,
} from '../../domain/value-objects/difficulty-level'
import type { HeroProfilePort } from '../ports/HeroAbilitiesPort'
import type { EstimatedAbility, MissionEstimatePort } from '../ports/MissionEstimatePort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { StrategyRepositoryPort } from '../ports/StrategyRepositoryPort'
import { buildSimulationRequest } from './RunMissionExecutions'

export interface EstimateQuery {
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: string
}

/** Todo en porcentajes enteros y con etiqueta: Web lo muestra tal cual. */
export interface MissionEstimateView {
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: DifficultyLevel
  /** La estrategia con la que se estimo; `null` es solo ataque basico. */
  readonly strategyVersion: number | null
  readonly runs: number
  readonly successPercent: number
  readonly defeatPercent: number
  readonly timeoutPercent: number
  readonly risk: EstimateRisk
  readonly riskLabel: string
  readonly averageTurns: number
  /** La vida mas baja a la que llega el heroe, de media, en porcentaje. */
  readonly averageMinHealthPercent: number
  readonly masterAppearancePercent: number
  readonly abilities: readonly EstimatedAbility[]
}

/**
 * `GET /api/v1/missions/{missionId}/estimate?heroId=&difficulty=` (diseno
 * «misiones jugables», P-J7): la probabilidad de exito ANTES de enviar al heroe.
 *
 * Combat corre la misma simulacion que la mision real, con el perfil actual del
 * heroe, la estrategia guardada y la composicion del nivel (P-J8), pero con
 * semillas propias de la estimacion: no adelanta el resultado de la mision. No se
 * guarda nada. Tambien dice que habilidades no sirven en misiones y por que (P-J4).
 */
export class EstimateMissionSuccess {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly heroes: HeroProfilePort,
    private readonly strategies: StrategyRepositoryPort,
    private readonly estimates: MissionEstimatePort,
  ) {}

  async execute(query: EstimateQuery): Promise<MissionEstimateView> {
    const difficulty = parseDifficultyLevel(query.difficulty)
    const definition = await this.catalog.findActive(query.missionId)
    if (definition === null) {
      throw new MissionNotFoundError(query.missionId)
    }

    const [hero, strategy] = await Promise.all([
      this.heroes.profileOf(query.playerId, query.heroId),
      this.strategies.find(query.playerId, query.heroId, query.missionId),
    ])
    if (hero.kind === 'NOT_OWNED') {
      throw new HeroNotOwnedError(query.heroId)
    }
    if (hero.kind === 'UNKNOWN') {
      throw new EstimateUnavailableError(hero.reason)
    }

    const strategyVersion = strategy?.version ?? null
    const operationId = estimateOperationId({
      playerId: query.playerId,
      missionId: query.missionId,
      heroId: query.heroId,
      difficulty,
      strategyVersion,
    })
    const outcome = await this.estimates.estimate(
      buildSimulationRequest({
        operationId,
        enrollmentId: `estimate:${operationId}`,
        missionId: query.missionId,
        difficulty,
        durationMinutes: definition.estimatedDurationMinutes,
        heroId: query.heroId,
        heroProfile: hero.profile,
        strategyVersion,
        rotations: strategy?.rotations ?? [],
        definition,
      }),
      ESTIMATE_RUNS,
    )
    if (outcome.kind === 'UNAVAILABLE') {
      throw new EstimateUnavailableError(outcome.reason)
    }

    // Los tres porcentajes salen de los conteos, con el mismo redondeo.
    const { estimate } = outcome
    const successPercent = percentOf(estimate.victories / estimate.runs)
    const risk = riskOf(successPercent)

    return {
      missionId: query.missionId,
      heroId: query.heroId,
      difficulty,
      strategyVersion,
      runs: estimate.runs,
      successPercent,
      defeatPercent: percentOf(estimate.defeats / estimate.runs),
      timeoutPercent: percentOf(estimate.timeouts / estimate.runs),
      risk,
      riskLabel: riskLabelOf(risk),
      averageTurns: Math.round(estimate.averageTurns),
      averageMinHealthPercent: Math.round(estimate.averageMinHealthPercent),
      masterAppearancePercent: percentOf(estimate.masterAppearanceRate),
      abilities: estimate.abilities,
    }
  }
}

export const ESTIMATE_MISSION_SUCCESS = Symbol('EstimateMissionSuccess')
