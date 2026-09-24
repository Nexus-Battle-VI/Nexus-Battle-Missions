import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Kysely } from 'kysely'

import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { PostgresMissionCatalog } from '../../src/adapters/outbound/persistence/PostgresMissionCatalog'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import { missionDefinitionOf } from '../../src/domain/policies/MissionContentPolicy'
import {
  MIGRATIONS,
  createDatabase,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { EXAMPLE_MISSIONS_V1 } from '../support/example-missions-v1'

const LINKED = '7c935118-290e-4419-b215-475efe206a4d'
const TOMA_Y_LLEVA = '0783a7ad-bb8a-463d-b24a-c4d88aae2d37'

/** La fila que escribio la migracion 010 con el contenido v1. */
const rowOf = (source: MissionDefinition) => {
  const mission = missionDefinitionOf(source, source.missionId)
  return {
    mission_id: mission.missionId,
    name: mission.name,
    category: mission.category,
    summary: mission.summary,
    narrative: mission.narrative,
    image_ref: mission.imageRef,
    estimated_duration_minutes: mission.estimatedDurationMinutes,
    recommended_power: mission.recommendedPower,
    prerequisites: [...mission.prerequisites],
    content: JSON.stringify({
      objectives: mission.objectives,
      enemies: mission.enemies,
      finalBoss: mission.finalBoss,
      encounters: mission.encounters,
      combatRules: mission.combatRules,
      masterEncounter: mission.masterEncounter,
      rewards: mission.rewards,
      highlightedRewards: mission.highlightedRewards,
    }),
    active: mission.active,
  }
}

/** El Templo v1 tras el runbook de productos: botin enlazado y «Toma y lleva». */
const templeLinked = (): MissionDefinition => {
  const [templo] = EXAMPLE_MISSIONS_V1 as [MissionDefinition]
  const master = templo.masterEncounter
  return {
    ...templo,
    finalBoss: {
      ...templo.finalBoss,
      drops: (templo.finalBoss.drops ?? []).map((drop) => ({ ...drop, productId: LINKED })),
    },
    masterEncounter:
      master === null
        ? null
        : {
            ...master,
            candidates: master.candidates.map((candidate) => ({
              ...candidate,
              epic: {
                epicRef: 'toma-y-lleva',
                name: 'Toma y lleva',
                generalEffect: '+1 al ataque para todos los héroes.',
                epicEffect: 'Solo Pícaro Veneno: disminuye a la mitad el daño del oponente.',
                productId: TOMA_Y_LLEVA,
              },
            })),
          },
  }
}

describe('Contenido v2 en PostgreSQL (migracion 012, P-J9)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  it('una base con el contenido v1 pasa al v2 sin perder lo enlazado ni lo editado', async () => {
    const before012 = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([name]) => name !== '012-content-v2'),
    )
    expect((await migrateToLatest(db, before012)).error).toBeUndefined()

    // La base de antes: solo las dos misiones v1, el Templo enlazado por el runbook y
    // un resumen de la Camara cambiado por un administrador.
    const [, camara] = EXAMPLE_MISSIONS_V1 as [MissionDefinition, MissionDefinition]
    await db.deleteFrom('mission_definitions').execute()
    await db
      .insertInto('mission_definitions')
      .values([rowOf(templeLinked()), rowOf({ ...camara, summary: 'Resumen del administrador.' })])
      .execute()

    const outcome = await migrateToLatest(db)

    expect(outcome.error).toBeUndefined()
    expect(outcome.applied).toEqual(['012-content-v2'])
    const missions = await new PostgresMissionCatalog(db).listAll()
    expect(missions.map((mission) => mission.missionId)).toEqual([
      'msn_camino_templo',
      'msn_templo_olvidado',
      'msn_arena_caidos',
      'msn_camara_sellada',
      'msn_travesia_bosque',
    ])

    const templo = missions.find((mission) => mission.missionId === 'msn_templo_olvidado')
    expect(templo?.imageRef).toBe('mision-templo-olvidado')
    expect(templo?.combatRules?.maxTurnsPerEncounter).toBe(300)
    expect(templo?.finalBoss.drops?.map((drop) => drop.productId)).toEqual([LINKED, LINKED, LINKED])
    expect(
      templo?.masterEncounter?.candidates.map((candidate) => [
        candidate.masterRef,
        candidate.epic.productId,
      ]),
    ).toEqual([['sombra-del-olvido', TOMA_Y_LLEVA]])

    const upgraded = missions.find((mission) => mission.missionId === 'msn_camara_sellada')
    expect(upgraded?.summary).toBe('Resumen del administrador.')
    expect(upgraded?.masterEncounter?.candidates.map((candidate) => candidate.masterRef)).toEqual([
      'hechicera-del-sello',
      'coloso-de-obsidiana',
    ])
    expect(upgraded?.objectives.map((objective) => objective.id)).toEqual([
      'obj_sello',
      'obj_master',
    ])

    // Las misiones nuevas son exactamente las del contenido v2.
    for (const missionId of ['msn_camino_templo', 'msn_arena_caidos', 'msn_travesia_bosque']) {
      const expected = EXAMPLE_MISSIONS.find((mission) => mission.missionId === missionId)
      const stored = missions.find((mission) => mission.missionId === missionId)
      expect(stored).toEqual(
        expected === undefined ? undefined : missionDefinitionOf(expected, missionId),
      )
    }
  })

  it('repetirla no cambia nada: la migracion queda registrada y el contenido igual', async () => {
    const before = await new PostgresMissionCatalog(db).listAll()

    expect((await migrateToLatest(db)).applied).toEqual([])
    expect(await new PostgresMissionCatalog(db).listAll()).toEqual(before)
  })
})
