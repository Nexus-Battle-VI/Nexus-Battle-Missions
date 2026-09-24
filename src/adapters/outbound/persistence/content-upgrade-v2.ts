import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import { EXAMPLE_MISSIONS } from './example-missions'

/** Lo que la mejora lee de una fila de `mission_definitions`. */
export interface StoredMission {
  readonly missionId: string
  readonly summary: string
  readonly narrative: string
  readonly imageRef: string | null
  readonly content: Readonly<Record<string, unknown>>
}

/** La fila mejorada, con la lista de lo que cambio para el registro. */
export interface MissionUpgrade {
  readonly summary: string
  readonly narrative: string
  readonly imageRef: string | null
  readonly content: Readonly<Record<string, unknown>>
  readonly changes: readonly string[]
}

type Json = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Igualdad de JSON sin depender del orden de las claves (jsonb lo reordena). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  )

const sameJson = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/** Valores que sembro la migracion 010 (contenido v1) y que el v2 reemplaza. */
const V1 = {
  maxTurnsPerEncounter: 90,
  sombraProfile: { maxHealth: 55, attack: 3, defense: 6, damage: 1, ai: 'AGGRESSIVE' },
  camaraSummary: 'Ejemplo de misión con requisito previo.',
  camaraNarrative: 'Misión de ejemplo para ver en el tablón una misión bloqueada por requisitos.',
}

const targetOf = (missionId: string): MissionDefinition | undefined =>
  EXAMPLE_MISSIONS.find((mission) => mission.missionId === missionId)

/** Misiones nuevas del contenido v2: se insertan si no existen. */
export const NEW_IN_V2: readonly string[] = [
  'msn_camino_templo',
  'msn_arena_caidos',
  'msn_travesia_bosque',
]

/** Misiones del contenido v1 que el v2 mejora campo a campo. */
export const UPGRADED_IN_V2: readonly string[] = ['msn_templo_olvidado', 'msn_camara_sellada']

/**
 * El Master del Templo en v2: la Sombra del Olvido con perfil de verdadero rival y
 * su epica oficial. Solo si el Templo conserva la Sombra sembrada en v1. Si su
 * epica ya se enlazo a un producto (el runbook la cambia por «Toma y lleva»), se
 * conserva tal cual.
 */
const upgradedTempleMaster = (current: unknown, target: MissionDefinition): Json | null => {
  if (!isRecord(current) || !Array.isArray(current.candidates) || target.masterEncounter === null) {
    return null
  }
  const [sombra, ...others] = current.candidates as unknown[]
  if (
    others.length > 0 ||
    !isRecord(sombra) ||
    sombra.masterRef !== 'sombra-del-olvido' ||
    !sameJson(sombra.profile, V1.sombraProfile)
  ) {
    return null
  }

  const linked =
    isRecord(sombra.epic) && (sombra.epic.productId ?? null) !== null ? sombra.epic : null

  return {
    ...current,
    candidates: target.masterEncounter.candidates.map((candidate) =>
      candidate.masterRef === 'sombra-del-olvido' && linked !== null
        ? { ...candidate, epic: linked }
        : candidate,
    ),
  }
}

/**
 * Mejora de una mision sembrada en v1 al contenido v2 (diseno «misiones jugables»,
 * P-J9). Cada cambio se aplica SOLO si el campo conserva el valor que sembro la
 * migracion 010: lo que un administrador edito, o los productos que enlazo, no se
 * tocan (el mismo principio de 010). Devuelve `null` si no hay nada que cambiar,
 * asi que aplicarla dos veces no hace nada.
 */
export const upgradeToContentV2 = (stored: StoredMission): MissionUpgrade | null => {
  const target = targetOf(stored.missionId)
  if (target === undefined || !UPGRADED_IN_V2.includes(stored.missionId)) {
    return null
  }

  const changes: string[] = []
  let content: Record<string, unknown> = { ...stored.content }
  let { summary, narrative, imageRef } = stored

  if (imageRef === null && target.imageRef !== null) {
    imageRef = target.imageRef
    changes.push('imageRef')
  }

  const rules = content.combatRules
  if (isRecord(rules) && rules.maxTurnsPerEncounter === V1.maxTurnsPerEncounter) {
    content = {
      ...content,
      combatRules: {
        ...rules,
        maxTurnsPerEncounter: target.combatRules?.maxTurnsPerEncounter,
      },
    }
    changes.push('combatRules.maxTurnsPerEncounter')
  }

  if (stored.missionId === 'msn_templo_olvidado') {
    const master = upgradedTempleMaster(content.masterEncounter, target)
    if (master !== null) {
      content = { ...content, masterEncounter: master }
      changes.push('masterEncounter')
    }
  }

  if (stored.missionId === 'msn_camara_sellada') {
    if (summary === V1.camaraSummary) {
      summary = target.summary
      changes.push('summary')
    }
    if (narrative === V1.camaraNarrative) {
      narrative = target.narrative
      changes.push('narrative')
    }
    const boss = content.finalBoss
    if (isRecord(boss) && boss.description === null) {
      content = { ...content, finalBoss: { ...boss, description: target.finalBoss.description } }
      changes.push('finalBoss.description')
    }
    if (content.masterEncounter === null || content.masterEncounter === undefined) {
      content = { ...content, masterEncounter: target.masterEncounter }
      changes.push('masterEncounter')
      const objectives = Array.isArray(content.objectives) ? (content.objectives as unknown[]) : []
      const hasMasterObjective = objectives.some(
        (objective) =>
          isRecord(objective) &&
          isRecord(objective.rule) &&
          objective.rule.type === 'DEFEAT_MASTER',
      )
      if (!hasMasterObjective) {
        content = {
          ...content,
          objectives: [
            ...objectives,
            ...target.objectives.filter((objective) => objective.rule?.type === 'DEFEAT_MASTER'),
          ],
        }
        changes.push('objectives')
      }
    }
  }

  return changes.length === 0 ? null : { summary, narrative, imageRef, content, changes }
}
