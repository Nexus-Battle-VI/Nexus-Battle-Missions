import { sql, type Kysely } from 'kysely'

import { missionDefinitionOf } from '../../../../domain/policies/MissionContentPolicy'
import { NEW_IN_V2, UPGRADED_IN_V2, upgradeToContentV2 } from '../content-upgrade-v2'
import { EXAMPLE_MISSIONS } from '../example-missions'

interface StoredRow {
  readonly summary: string
  readonly narrative: string
  readonly image_ref: string | null
  readonly content: Readonly<Record<string, unknown>>
}

/**
 * Contenido v2 (diseno «misiones jugables», P-J3 y P-J9): una primera mision de
 * 10 minutos, un desafio de una hora, una exploracion de un dia y un Master por
 * cada epica oficial de la Tabla 20.
 *
 * - Las tres misiones nuevas se insertan solo si no existen.
 * - El Templo y la Camara se mejoran campo a campo, y solo donde conservan lo que
 *   sembro la migracion 010: lo que un administrador edito o enlazo no se toca.
 *
 * En una base nueva, 010 ya siembra el contenido v2 y esta migracion no cambia nada.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  for (const source of EXAMPLE_MISSIONS.filter((item) => NEW_IN_V2.includes(item.missionId))) {
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
      on conflict (mission_id) do nothing
    `.execute(db)
  }

  for (const missionId of UPGRADED_IN_V2) {
    const { rows } = await sql<StoredRow>`
      select summary, narrative, image_ref, content
      from mission_definitions
      where mission_id = ${missionId}
      for update
    `.execute(db)
    const row = rows[0]
    if (row === undefined) {
      continue
    }
    const upgrade = upgradeToContentV2({
      missionId,
      summary: row.summary,
      narrative: row.narrative,
      imageRef: row.image_ref,
      content: row.content,
    })
    if (upgrade === null) {
      continue
    }
    await sql`
      update mission_definitions
      set summary = ${upgrade.summary},
          narrative = ${upgrade.narrative},
          image_ref = ${upgrade.imageRef},
          content = ${JSON.stringify(upgrade.content)}::jsonb
      where mission_id = ${missionId}
    `.execute(db)
  }
}
