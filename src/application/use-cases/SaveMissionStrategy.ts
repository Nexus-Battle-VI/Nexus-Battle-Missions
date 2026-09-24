import { nextStrategyVersion, type MissionStrategy } from '../../domain/entities/MissionStrategy'
import { HeroNotOwnedError, MissionNotFoundError } from '../../domain/errors/mission-errors'
import {
  HeroAbilitiesUnavailableError,
  StrategyVersionConflictError,
} from '../../domain/errors/strategy-errors'
import { assertAbilitiesKnown, assertRotationShape } from '../../domain/policies/StrategyPolicy'
import type { Rotation } from '../../domain/value-objects/rotation'
import type { ClockPort } from '../ports/ClockPort'
import type { HeroAbilitiesPort } from '../ports/HeroAbilitiesPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'
import type { StrategyRepositoryPort } from '../ports/StrategyRepositoryPort'
import { toStrategyView, type StrategyView } from './GetMissionStrategy'

export interface SaveStrategyCommand {
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  /** La version que el jugador leyo; `null` para crear la primera. */
  readonly expectedVersion: number | null
  readonly rotations: readonly Rotation[]
}

export interface SavedStrategy {
  /** `true` al crear la primera version (201); `false` al reemplazar (200). */
  readonly created: boolean
  readonly strategy: StrategyView
}

/**
 * `PUT /api/v1/missions/{missionId}/strategies/{heroId}` (Task HU-71.2, CU-71.1,
 * CA-01 y CA-04). Valida en el orden del contrato y responde con el PRIMER fallo:
 * la mision, la forma (reglas 1 a 3), el heroe y sus habilidades en
 * Player/Inventory (regla 4) y la version (regla 5), que se comprueba en la
 * misma escritura para que dos ediciones simultaneas no se pisen.
 */
export class SaveMissionStrategy {
  constructor(
    private readonly catalog: MissionCatalogPort,
    private readonly strategies: StrategyRepositoryPort,
    private readonly abilities: HeroAbilitiesPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: SaveStrategyCommand): Promise<SavedStrategy> {
    if ((await this.catalog.findActive(command.missionId)) === null) {
      throw new MissionNotFoundError(command.missionId)
    }

    assertRotationShape(command.rotations)

    const hero = await this.abilities.abilitiesOf(command.playerId, command.heroId)

    switch (hero.kind) {
      case 'UNKNOWN':
        throw new HeroAbilitiesUnavailableError()
      case 'NOT_OWNED':
        throw new HeroNotOwnedError(command.heroId)
      case 'FOUND':
        assertAbilitiesKnown(command.rotations, hero.abilityIds)
    }

    const strategy: MissionStrategy = {
      playerId: command.playerId,
      heroId: command.heroId,
      missionId: command.missionId,
      version: nextStrategyVersion(command.expectedVersion),
      rotations: command.rotations,
      updatedAt: this.clock.now(),
    }
    const saved = await this.strategies.save(strategy, command.expectedVersion)

    if (saved.kind === 'VERSION_CONFLICT') {
      throw new StrategyVersionConflictError(command.expectedVersion, saved.currentVersion)
    }

    return { created: command.expectedVersion === null, strategy: toStrategyView(strategy) }
  }
}

export const SAVE_MISSION_STRATEGY = Symbol('SaveMissionStrategy')
