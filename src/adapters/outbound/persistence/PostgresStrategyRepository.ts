import type { Kysely, Selectable } from 'kysely'

import type {
  SaveStrategyResult,
  StrategyRepositoryPort,
} from '../../../application/ports/StrategyRepositoryPort'
import type { MissionStrategy } from '../../../domain/entities/MissionStrategy'
import type { Database, MissionStrategiesTable } from './schema'

const toStrategy = (row: Selectable<MissionStrategiesTable>): MissionStrategy => ({
  playerId: row.player_id,
  heroId: row.hero_id,
  missionId: row.mission_id,
  version: row.version,
  rotations: row.rotations,
  updatedAt: row.updated_at,
})

/**
 * Estrategias en PostgreSQL (HU-71). El bloqueo optimista vive en UNA escritura:
 * `insert ... on conflict do nothing` para la primera version y
 * `update ... where version = esperada` para las siguientes. Cero filas escritas
 * es `VERSION_CONFLICT`; no se lee antes para «comprobar», porque dos guardados
 * simultaneos leerian lo mismo.
 */
export class PostgresStrategyRepository implements StrategyRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async find(playerId: string, heroId: string, missionId: string): Promise<MissionStrategy | null> {
    const row = await this.db
      .selectFrom('mission_strategies')
      .selectAll()
      .where('player_id', '=', playerId)
      .where('hero_id', '=', heroId)
      .where('mission_id', '=', missionId)
      .executeTakeFirst()

    return row === undefined ? null : toStrategy(row)
  }

  async save(
    strategy: MissionStrategy,
    expectedVersion: number | null,
  ): Promise<SaveStrategyResult> {
    // jsonb se escribe como texto JSON: el driver convertiria un arreglo en un
    // arreglo de PostgreSQL.
    const rotations = JSON.stringify(strategy.rotations)
    const written =
      expectedVersion === null
        ? await this.db
            .insertInto('mission_strategies')
            .values({
              player_id: strategy.playerId,
              hero_id: strategy.heroId,
              mission_id: strategy.missionId,
              rotations,
              version: strategy.version,
              updated_at: strategy.updatedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(['player_id', 'hero_id', 'mission_id']).doNothing(),
            )
            .returning('version')
            .executeTakeFirst()
        : await this.db
            .updateTable('mission_strategies')
            .set({ rotations, version: strategy.version, updated_at: strategy.updatedAt })
            .where('player_id', '=', strategy.playerId)
            .where('hero_id', '=', strategy.heroId)
            .where('mission_id', '=', strategy.missionId)
            .where('version', '=', expectedVersion)
            .returning('version')
            .executeTakeFirst()

    if (written !== undefined) {
      return { kind: 'SAVED' }
    }

    const current = await this.find(strategy.playerId, strategy.heroId, strategy.missionId)

    return { kind: 'VERSION_CONFLICT', currentVersion: current?.version ?? null }
  }
}
