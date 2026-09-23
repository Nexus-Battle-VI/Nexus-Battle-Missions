import type { Kysely, Selectable } from 'kysely'

import type { MissionCatalogPort } from '../../../application/ports/MissionCatalogPort'
import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import type { Database, MissionDefinitionsTable } from './schema'

const toDefinition = (row: Selectable<MissionDefinitionsTable>): MissionDefinition => ({
  missionId: row.mission_id,
  name: row.name,
  category: row.category,
  summary: row.summary,
  narrative: row.narrative,
  imageRef: row.image_ref,
  estimatedDurationMinutes: row.estimated_duration_minutes,
  recommendedPower: row.recommended_power,
  prerequisites: row.prerequisites,
  objectives: row.content.objectives,
  enemies: row.content.enemies,
  finalBoss: row.content.finalBoss,
  masterEncounter: row.content.masterEncounter,
  rewards: row.content.rewards,
  highlightedRewards: row.content.highlightedRewards,
  active: row.active,
})

/** Definiciones del tablon en PostgreSQL (HU-70). Solo lectura. */
export class PostgresMissionCatalog implements MissionCatalogPort {
  constructor(private readonly db: Kysely<Database>) {}

  async listActive(): Promise<readonly MissionDefinition[]> {
    const rows = await this.db
      .selectFrom('mission_definitions')
      .selectAll()
      .where('active', '=', true)
      .orderBy('name')
      .execute()

    return rows.map(toDefinition)
  }

  async findActive(missionId: string): Promise<MissionDefinition | null> {
    const row = await this.db
      .selectFrom('mission_definitions')
      .selectAll()
      .where('mission_id', '=', missionId)
      .where('active', '=', true)
      .executeTakeFirst()

    return row === undefined ? null : toDefinition(row)
  }

  async findById(missionId: string): Promise<MissionDefinition | null> {
    const row = await this.db
      .selectFrom('mission_definitions')
      .selectAll()
      .where('mission_id', '=', missionId)
      .executeTakeFirst()

    return row === undefined ? null : toDefinition(row)
  }
}
