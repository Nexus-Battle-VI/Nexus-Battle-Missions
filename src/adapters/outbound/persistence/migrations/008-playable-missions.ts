import { sql, type Kysely } from 'kysely'

import { EXAMPLE_MISSIONS } from '../example-missions'
import { missionDefinitionOf } from '../../../../domain/policies/MissionContentPolicy'

/** Initial editable content. Complete administrator edits are never overwritten. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  for (const source of EXAMPLE_MISSIONS) {
    const mission = missionDefinitionOf(source, source.missionId)
    const content = {
      objectives: mission.objectives,
      enemies: mission.enemies,
      finalBoss: mission.finalBoss,
      encounters: mission.encounters,
      combatRules: mission.combatRules,
      masterEncounter: mission.masterEncounter,
      rewards: mission.rewards,
      highlightedRewards: mission.highlightedRewards,
    }
    await sql`
      insert into mission_definitions
        (mission_id, name, category, summary, narrative, image_ref,
         estimated_duration_minutes, recommended_power, prerequisites, content, active)
      values
        (${mission.missionId}, ${mission.name}, ${mission.category}, ${mission.summary},
         ${mission.narrative}, ${mission.imageRef}, ${mission.estimatedDurationMinutes},
         ${mission.recommendedPower}, ${mission.prerequisites}::text[],
         ${JSON.stringify(content)}::jsonb, ${mission.active})
      on conflict (mission_id) do update set content = excluded.content
      where mission_definitions.content->'combatRules' is null
         or mission_definitions.content#>'{finalBoss,profile}' is null
         or mission_definitions.content#>'{finalBoss,profile}' = 'null'::jsonb
    `.execute(db)
  }
}
