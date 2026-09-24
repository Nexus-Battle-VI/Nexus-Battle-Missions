import type { Kysely } from 'kysely'

import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import type { Rotation } from '../../src/domain/value-objects/rotation'

/**
 * Datos compartidos por las pruebas. No es una suite: Jest solo toma
 * `test/<proyecto>/**\/*.spec.ts`.
 */

/** Habilidades del Guerrero Armas del ejemplo del curso (seccion 7.8.5). */
export const COURSE_ABILITIES: readonly string[] = [
  'golpe-de-tormenta',
  'embate-sangriento',
  'lanza-de-los-dioses',
]

/** La estrategia del curso (seccion 7.8.5), igual que en los fixtures del contrato de HU-71. */
export const COURSE_STRATEGY: readonly Rotation[] = [
  {
    priority: 'HIGH',
    steps: [
      { kind: 'ABILITY', abilityId: 'golpe-de-tormenta' },
      { kind: 'ABILITY', abilityId: 'embate-sangriento' },
      { kind: 'BASIC_ATTACK' },
    ],
  },
  {
    priority: 'MEDIUM',
    steps: [
      { kind: 'ABILITY', abilityId: 'lanza-de-los-dioses' },
      { kind: 'BASIC_ATTACK' },
      { kind: 'BASIC_ATTACK' },
    ],
  },
  {
    priority: 'LOW',
    steps: [
      { kind: 'ABILITY', abilityId: 'embate-sangriento' },
      { kind: 'BASIC_ATTACK' },
      { kind: 'BASIC_ATTACK' },
    ],
  },
]

/** Fixture de pruebas: puede sustituir el contenido jugable sembrado por la migracion. */
export const insertDefinition = async (
  db: Kysely<Database>,
  definition: MissionDefinition,
): Promise<void> => {
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
    content: JSON.stringify({
      objectives: definition.objectives,
      enemies: definition.enemies,
      finalBoss: definition.finalBoss,
      encounters: definition.encounters,
      combatRules: definition.combatRules,
      masterEncounter: definition.masterEncounter,
      rewards: definition.rewards,
      highlightedRewards: definition.highlightedRewards,
    }),
    active: definition.active,
  }
  await db
    .insertInto('mission_definitions')
    .values(values)
    .onConflict((conflict) => conflict.column('mission_id').doUpdateSet(values))
    .execute()
}
