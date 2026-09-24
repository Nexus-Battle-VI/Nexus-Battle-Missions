import type { Kysely, Selectable } from 'kysely'

import type { MissionCatalogPort } from '../../../application/ports/MissionCatalogPort'
import type { MissionContentPort } from '../../../application/ports/MissionContentPort'
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
  encounters: row.content.encounters,
  ...(row.content.combatRules === undefined ? {} : { combatRules: row.content.combatRules }),
  // Un contenido que omite la clave es una mision sin Master, igual que `null`.
  masterEncounter: row.content.masterEncounter ?? null,
  rewards: row.content.rewards,
  highlightedRewards: row.content.highlightedRewards,
  active: row.active,
})

/** Definiciones del tablon en PostgreSQL (HU-70). Solo lectura. */
export class PostgresMissionCatalog implements MissionCatalogPort, MissionContentPort {
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

  async listAll(): Promise<readonly MissionDefinition[]> {
    const rows = await this.db
      .selectFrom('mission_definitions')
      .selectAll()
      .orderBy('name')
      .execute()
    return rows.map(toDefinition)
  }

  async save(definition: MissionDefinition): Promise<MissionDefinition> {
    const content = {
      objectives: definition.objectives,
      enemies: definition.enemies,
      finalBoss: definition.finalBoss,
      encounters: definition.encounters,
      combatRules: definition.combatRules,
      masterEncounter: definition.masterEncounter,
      rewards: definition.rewards,
      highlightedRewards: definition.highlightedRewards,
    }
    const values = {
      mission_id: definition.missionId,
      name: definition.name,
      category: definition.category,
      summary: definition.summary,
      narrative: definition.narrative,
      image_ref: definition.imageRef,
      estimated_duration_minutes: definition.estimatedDurationMinutes,
      recommended_power: definition.recommendedPower,
      prerequisites: [...definition.prerequisites],
      content: JSON.stringify(content),
      active: definition.active,
    }
    await this.db
      .insertInto('mission_definitions')
      .values(values)
      .onConflict((conflict) =>
        conflict.column('mission_id').doUpdateSet({
          name: values.name,
          category: values.category,
          summary: values.summary,
          narrative: values.narrative,
          image_ref: values.image_ref,
          estimated_duration_minutes: values.estimated_duration_minutes,
          recommended_power: values.recommended_power,
          prerequisites: values.prerequisites,
          content: values.content,
          active: values.active,
        }),
      )
      .execute()
    return definition
  }
}
