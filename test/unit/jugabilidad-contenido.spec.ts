import {
  NEW_IN_V2,
  upgradeToContentV2,
  type StoredMission,
} from '../../src/adapters/outbound/persistence/content-upgrade-v2'
import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import type {
  MasterCandidate,
  MasterEncounter,
  MissionDefinition,
} from '../../src/domain/entities/MissionDefinition'
import { masterAppearanceChanceOf } from '../../src/domain/policies/MasterPolicy'
import { missionDefinitionOf } from '../../src/domain/policies/MissionContentPolicy'
import { EXAMPLE_MISSIONS_V1 } from '../support/example-missions-v1'

const byId = (missions: readonly MissionDefinition[], missionId: string): MissionDefinition => {
  const found = missions.find((mission) => mission.missionId === missionId)
  if (found === undefined) throw new Error(`Falta ${missionId}`)
  return found
}

/** La fila como la escribe la migracion 010, pasada por JSON como jsonb. */
const storedOf = (source: MissionDefinition): StoredMission => {
  const mission = missionDefinitionOf(source, source.missionId)
  return JSON.parse(
    JSON.stringify({
      missionId: mission.missionId,
      summary: mission.summary,
      narrative: mission.narrative,
      imageRef: mission.imageRef,
      content: {
        objectives: mission.objectives,
        enemies: mission.enemies,
        finalBoss: mission.finalBoss,
        encounters: mission.encounters,
        combatRules: mission.combatRules,
        masterEncounter: mission.masterEncounter,
        rewards: mission.rewards,
        highlightedRewards: mission.highlightedRewards,
      },
    }),
  ) as StoredMission
}

const TEMPLO_V1 = storedOf(byId(EXAMPLE_MISSIONS_V1, 'msn_templo_olvidado'))
const TEMPLO_V2 = storedOf(byId(EXAMPLE_MISSIONS, 'msn_templo_olvidado'))
const CAMARA_V1 = storedOf(byId(EXAMPLE_MISSIONS_V1, 'msn_camara_sellada'))
const CAMARA_V2 = storedOf(byId(EXAMPLE_MISSIONS, 'msn_camara_sellada'))

type Json = Record<string, unknown>
const clone = (value: StoredMission): StoredMission =>
  JSON.parse(JSON.stringify(value)) as StoredMission
const record = (value: unknown): Json => value as Json
const list = (value: unknown): Json[] => value as Json[]

const PRODUCT = '0783a7ad-bb8a-463d-b24a-c4d88aae2d37'

/** El Templo v1 despues del runbook: botin enlazado y la Sombra con «Toma y lleva». */
const templeLinked = (): StoredMission => {
  const linked = clone(TEMPLO_V1)
  const content = record(linked.content)
  for (const drop of list(record(content.finalBoss).drops)) {
    drop.productId = '7c935118-290e-4419-b215-475efe206a4d'
  }
  const [sombra] = list(record(content.masterEncounter).candidates)
  record(sombra).epic = {
    name: 'Toma y lleva',
    epicRef: 'toma-y-lleva',
    productId: PRODUCT,
    generalEffect: '+1 al ataque para todos los héroes.',
    epicEffect: 'Solo Pícaro Veneno: disminuye a la mitad el daño causado por el oponente.',
  }
  return linked
}

describe('Contenido v2 sobre lo sembrado en v1 (P-J9)', () => {
  it('el Templo sembrado en v1 queda igual que el v2', () => {
    const upgrade = upgradeToContentV2(TEMPLO_V1)

    expect(upgrade).toEqual({
      summary: TEMPLO_V2.summary,
      narrative: TEMPLO_V2.narrative,
      imageRef: 'mision-templo-olvidado',
      content: TEMPLO_V2.content,
      changes: ['imageRef', 'combatRules.maxTurnsPerEncounter', 'masterEncounter'],
    })
  })

  it('la Camara sembrada en v1 queda igual que la v2, con su Master y su objetivo', () => {
    const upgrade = upgradeToContentV2(CAMARA_V1)

    expect(upgrade).toEqual({
      summary: CAMARA_V2.summary,
      narrative: CAMARA_V2.narrative,
      imageRef: 'mision-camara-sellada',
      content: CAMARA_V2.content,
      changes: [
        'imageRef',
        'combatRules.maxTurnsPerEncounter',
        'summary',
        'narrative',
        'finalBoss.description',
        'masterEncounter',
        'objectives',
      ],
    })
  })

  it('conserva los productos que el runbook ya enlazo', () => {
    const upgrade = upgradeToContentV2(templeLinked())
    const content = record(upgrade?.content)
    const candidates = list(record(content.masterEncounter).candidates)

    expect(list(record(content.finalBoss).drops).map((drop) => drop.productId)).toEqual([
      '7c935118-290e-4419-b215-475efe206a4d',
      '7c935118-290e-4419-b215-475efe206a4d',
      '7c935118-290e-4419-b215-475efe206a4d',
    ])
    // El Templo solo trae a la Sombra: el Coloso vive en la Camara (15 % por mision).
    expect(candidates.map((candidate) => candidate.masterRef)).toEqual(['sombra-del-olvido'])
    expect(record(candidates[0]?.epic).productId).toBe(PRODUCT)
    expect(record(candidates[0]?.profile).attack).toBe(8)
  })

  it('no toca lo que edito un administrador', () => {
    const edited = clone(TEMPLO_V1)
    const content = record(edited.content)
    record(content.combatRules).maxTurnsPerEncounter = 120
    record(list(record(content.masterEncounter).candidates)[0]?.profile).attack = 5

    const upgrade = upgradeToContentV2({ ...edited, imageRef: 'imagen-propia' })

    expect(upgrade).toBeNull()
  })

  it('una Camara con resumen propio y un Master puesto a mano conserva ambos', () => {
    const edited = clone(CAMARA_V1)
    const content = record(edited.content)
    content.masterEncounter = record(TEMPLO_V2.content).masterEncounter
    const mine = { ...edited, summary: 'Resumen del administrador.' }

    const upgrade = upgradeToContentV2(mine)

    expect(upgrade?.summary).toBe('Resumen del administrador.')
    expect(record(upgrade?.content).masterEncounter).toEqual(content.masterEncounter)
    expect(record(upgrade?.content).objectives).toEqual(content.objectives)
    expect(upgrade?.changes).not.toContain('masterEncounter')
  })

  it('no duplica el objetivo del Master si ya existe', () => {
    const edited = clone(CAMARA_V1)
    const content = record(edited.content)
    content.objectives = [
      ...list(content.objectives),
      { id: 'mio', text: 'Vencer al Master.', primary: false, rule: { type: 'DEFEAT_MASTER' } },
    ]

    const upgrade = upgradeToContentV2(edited)

    expect(
      list(record(upgrade?.content).objectives).filter(
        (objective) => record(objective.rule).type === 'DEFEAT_MASTER',
      ),
    ).toHaveLength(1)
  })

  it('aplicarla dos veces no cambia nada la segunda', () => {
    for (const stored of [TEMPLO_V1, CAMARA_V1, templeLinked()]) {
      const first = upgradeToContentV2(stored)
      expect(first).not.toBeNull()
      const second = upgradeToContentV2({ ...stored, ...first, missionId: stored.missionId })
      expect(second).toBeNull()
    }
  })

  it('el contenido v2 ya sembrado y las misiones nuevas no cambian', () => {
    expect(upgradeToContentV2(TEMPLO_V2)).toBeNull()
    expect(upgradeToContentV2(CAMARA_V2)).toBeNull()
    for (const missionId of NEW_IN_V2) {
      expect(upgradeToContentV2(storedOf(byId(EXAMPLE_MISSIONS, missionId)))).toBeNull()
    }
    expect(upgradeToContentV2({ ...TEMPLO_V1, missionId: 'msn_otra' })).toBeNull()
  })
})

describe('Contenido v2 (P-J3 y P-J9)', () => {
  it('cada epica oficial de la Tabla 20 la entrega exactamente un Master', () => {
    const epics = EXAMPLE_MISSIONS.flatMap(
      (mission) => mission.masterEncounter?.candidates.map((candidate) => candidate.epic) ?? [],
    )

    expect(epics.map((epic) => epic.epicRef).sort()).toEqual([
      'frio-concentrado',
      'golpe-de-defensa',
      'intimidacion-sangrienta',
      'luz-cegadora',
      'reanimador-3000',
      'segundo-impulso',
      'te-changua',
      'toma-y-lleva',
    ])
  })

  it('cada Master es del tipo de heroe de su epica', () => {
    const SUBTYPE_OF_EPIC: Readonly<Record<string, string>> = {
      'golpe-de-defensa': 'GUERRERO_TANQUE',
      'segundo-impulso': 'GUERRERO_ARMAS',
      'luz-cegadora': 'MAGO_FUEGO',
      'frio-concentrado': 'MAGO_HIELO',
      'toma-y-lleva': 'PICARO_VENENO',
      'intimidacion-sangrienta': 'PICARO_MACHETE',
      'te-changua': 'CHAMAN',
      'reanimador-3000': 'MEDICO',
    }

    for (const mission of EXAMPLE_MISSIONS) {
      for (const candidate of mission.masterEncounter?.candidates ?? []) {
        expect(candidate.subtype).toBe(SUBTYPE_OF_EPIC[candidate.epic.epicRef])
      }
    }
  })

  it('decision del PO (2026-09-24): un Master aparece en el 15 % de las misiones', () => {
    expect(
      EXAMPLE_MISSIONS.map((mission) => [
        mission.missionId,
        masterAppearanceChanceOf(mission.masterEncounter),
      ]),
    ).toEqual([
      ['msn_templo_olvidado', 0.15],
      ['msn_camara_sellada', 0.1499],
      ['msn_camino_templo', 0],
      ['msn_arena_caidos', 0.1499],
      ['msn_travesia_bosque', 0.15],
    ])
    // Igual para cualquier heroe, en un solo punto y con una sola aparicion: la
    // probabilidad que ve el jugador en cada Master es la de verdad.
    for (const mission of EXAMPLE_MISSIONS) {
      for (const candidate of mission.masterEncounter?.candidates ?? []) {
        expect(Object.keys(candidate.probabilityByHeroType)).toEqual(['*'])
      }
      expect(mission.masterEncounter?.evaluationPoints.length ?? 1).toBe(1)
      expect(mission.masterEncounter?.maxAppearances ?? 1).toBe(1)
    }
  })

  it('la primera mision dura 10 minutos, no pide nada y siempre entrega su botin', () => {
    const first = byId(EXAMPLE_MISSIONS, 'msn_camino_templo')

    expect(first.estimatedDurationMinutes).toBe(10)
    expect(first.prerequisites).toEqual([])
    expect(first.masterEncounter).toBeNull()
    expect(first.finalBoss.drops?.map((drop) => drop.probability)).toEqual([1])
  })

  it('todo el contenido v2 pasa la validacion de la administracion', () => {
    for (const mission of EXAMPLE_MISSIONS) {
      expect(() => missionDefinitionOf(mission, mission.missionId)).not.toThrow()
    }
    expect(EXAMPLE_MISSIONS.map((mission) => mission.imageRef)).toEqual([
      'mision-templo-olvidado',
      'mision-camara-sellada',
      'mision-camino-templo',
      'mision-arena-caidos',
      'mision-travesia-bosque',
    ])
  })
})

describe('Probabilidad de que aparezca un Master en la mision', () => {
  const sombra = byId(EXAMPLE_MISSIONS, 'msn_templo_olvidado').masterEncounter!.candidates[0]!
  const candidate = (
    masterRef: string,
    probabilityByHeroType: Readonly<Record<string, number>>,
  ): MasterCandidate => ({ ...sombra, masterRef, probabilityByHeroType })
  const encounterOf = (
    candidates: readonly MasterCandidate[],
    points: readonly number[] = [1],
  ): MasterEncounter => ({
    evaluationPoints: points.map((afterEncounter) => ({ afterEncounter })),
    maxAppearances: 1,
    candidates,
  })

  it('con tablas por tipo de heroe da la del tipo mas favorecido', () => {
    const config = encounterOf([
      candidate('uno', { '*': 0.1 }),
      candidate('dos', { '*': 0.05, MAGO_HIELO: 0.3 }),
    ])

    // Mago Hielo: 1 - 0,9 x 0,7. Cualquier otro: 1 - 0,9 x 0,95.
    expect(masterAppearanceChanceOf(config)).toBe(0.37)
  })

  it('cada punto de evaluacion es otra oportunidad', () => {
    expect(masterAppearanceChanceOf(encounterOf([candidate('uno', { '*': 0.1 })], [1, 2]))).toBe(
      0.19,
    )
  })

  it('sin Master, sin puntos o con contenido roto es 0', () => {
    expect(masterAppearanceChanceOf(null)).toBe(0)
    expect(masterAppearanceChanceOf(encounterOf([candidate('uno', { '*': 0.1 })], []))).toBe(0)
    expect(masterAppearanceChanceOf({ ...encounterOf([]), candidates: 'roto' as never })).toBe(0)
    expect(
      masterAppearanceChanceOf(
        encounterOf([
          { ...sombra, probabilityByHeroType: 'roto' as never },
          candidate('fuera-de-rango', { '*': 2 }),
        ]),
      ),
    ).toBe(0)
  })
})
