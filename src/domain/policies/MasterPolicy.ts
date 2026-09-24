import type {
  MasterEncounterRecord,
  MasterEncounterStatus,
} from '../entities/MasterEncounterRecord'
import type {
  MasterCandidate,
  MasterEncounter,
  MissionDefinition,
} from '../entities/MissionDefinition'
import type { SimulationFacts, SimulationMaster } from '../entities/MissionExecution'
import type { ReportRewardLine } from '../entities/MissionReport'
import { DomainError } from '../errors/DomainError'
import { uuidV5 } from '../value-objects/deterministic-uuid'
import { isCount, isRecord } from './SettlementPolicy'

/**
 * Reglas del Master de HU-73 que le tocan a Missions (RF-73). Missions no tira
 * dados ni calcula estadisticas: configura, resuelve la probabilidad para el
 * heroe, comprueba la evidencia que manda Combat y pide la epica (ADR-021).
 */

export const MASTER_CONFIG_REASONS = [
  'PROBABILITY_OUT_OF_RANGE',
  'MISSING_REFERENCE',
  // No esta en el contrato: la evidencia se casa por `masterRef`, asi que dos
  // candidatos con el mismo harian ambigua cual es la epica ganada.
  'DUPLICATE_REFERENCE',
  // Tampoco esta en el contrato: la HU pide al Master niveles POR ENCIMA del
  // heroe y el desfase acaba en una columna `integer`, asi que ha de ser un
  // entero no negativo que quepa en ella. La evidencia exige lo mismo.
  'INVALID_LEVEL_OFFSET',
  'EVALUATION_POINT_OUT_OF_RANGE',
  'INVALID_MAX_APPEARANCES',
] as const

export type MasterConfigReason = (typeof MASTER_CONFIG_REASONS)[number]

/** `INVALID_MASTER_CONFIG` del contrato: el contenido no llega a Combat (P-X5). */
export class InvalidMasterConfigError extends DomainError {
  readonly code = 'INVALID_MASTER_CONFIG'

  constructor(
    readonly missionId: string,
    readonly reason: MasterConfigReason,
  ) {
    super(`La configuracion del Master de ${missionId} no es valida: ${reason}.`)
    this.name = 'InvalidMasterConfigError'
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const isProbability = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** El mayor valor de una columna `integer` de PostgreSQL. */
const MAX_INTEGER = 2_147_483_647

/**
 * P-X5, en el orden del contrato. El contenido llega de `jsonb`, asi que cada
 * parte se lee sin fiarse del tipo. Un punto repetido tampoco vale: no es otra
 * oportunidad, y la evidencia se casa punto a punto.
 */
export const masterConfigProblem = (
  config: MasterEncounter,
  encountersTotal: number,
): MasterConfigReason | null => {
  const candidates: readonly unknown[] = Array.isArray(config.candidates) ? config.candidates : []
  const points: readonly unknown[] = Array.isArray(config.evaluationPoints)
    ? config.evaluationPoints
    : []

  if (
    candidates.some(
      (candidate) =>
        isRecord(candidate) &&
        (!isRecord(candidate.probabilityByHeroType) ||
          !Object.values(candidate.probabilityByHeroType).every(isProbability)),
    )
  ) {
    return 'PROBABILITY_OUT_OF_RANGE'
  }

  if (
    candidates.length === 0 ||
    !candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isText(candidate.masterRef) &&
        isText(candidate.subtype) &&
        isRecord(candidate.epic) &&
        isText(candidate.epic.epicRef),
    )
  ) {
    return 'MISSING_REFERENCE'
  }

  const refs = candidates.map((candidate) => (isRecord(candidate) ? candidate.masterRef : null))

  if (new Set(refs).size !== refs.length) {
    return 'DUPLICATE_REFERENCE'
  }

  if (
    !candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isCount(candidate.levelOffset) &&
        candidate.levelOffset <= MAX_INTEGER,
    )
  ) {
    return 'INVALID_LEVEL_OFFSET'
  }

  const after = points.map((point) => (isRecord(point) ? point.afterEncounter : null))

  if (
    after.length === 0 ||
    !after.every((value) => isCount(value) && value >= 1 && value <= encountersTotal) ||
    new Set(after).size !== after.length
  ) {
    return 'EVALUATION_POINT_OUT_OF_RANGE'
  }

  const max: unknown = config.maxAppearances

  if (max !== undefined && (!isCount(max) || max < 1)) {
    return 'INVALID_MAX_APPEARANCES'
  }

  return null
}

/** El tope de apariciones de la mision: 1 si el contenido no lo fija (P-X3). */
export const maxAppearancesOf = (config: MasterEncounter): number => config.maxAppearances ?? 1

/** Falla con `INVALID_MASTER_CONFIG` si la definicion trae un Master que no cumple P-X5. */
export const assertMasterConfig = (definition: MissionDefinition): void => {
  if (definition.masterEncounter === null) {
    return
  }

  const reason = masterConfigProblem(definition.masterEncounter, definition.encounters.length)

  if (reason !== null) {
    throw new InvalidMasterConfigError(definition.missionId, reason)
  }
}

const own = (table: Readonly<Record<string, number>>, key: string): number | null =>
  Object.prototype.hasOwnProperty.call(table, key) ? (table[key] ?? null) : null

/**
 * La probabilidad del candidato para el subtipo del heroe (P-X2): la suya o, si
 * no la tiene, la de `"*"`. `null`: para este heroe el candidato no aplica.
 */
export const probabilityFor = (
  candidate: MasterCandidate,
  heroSubtype: string | null,
): number | null =>
  (heroSubtype === null ? null : own(candidate.probabilityByHeroType, heroSubtype)) ??
  own(candidate.probabilityByHeroType, '*')

/** El subtipo del perfil congelado del heroe; Missions no lee nada mas de el. */
export const heroSubtypeOf = (profile: Readonly<Record<string, unknown>> | null): string | null =>
  isText(profile?.subtype) ? profile.subtype : null

/**
 * El bloque `master` de la solicitud a Combat: solo los candidatos con
 * probabilidad para este heroe. Sin ninguno, no se envia (M-6).
 */
export const simulationMasterOf = (
  config: MasterEncounter,
  heroSubtype: string | null,
): SimulationMaster | null => {
  const candidates = config.candidates.flatMap((candidate) => {
    const probability = probabilityFor(candidate, heroSubtype)

    return probability === null
      ? []
      : [
          {
            masterRef: candidate.masterRef,
            subtype: candidate.subtype,
            probability,
            levelOffset: candidate.levelOffset,
            profile: candidate.profile,
            epicRef: candidate.epic.epicRef,
          },
        ]
  })

  if (candidates.length === 0) {
    return null
  }

  return {
    evaluationPoints: [...config.evaluationPoints]
      .sort((a, b) => a.afterEncounter - b.afterEncounter)
      .map(({ afterEncounter }) => ({ afterEncounter })),
    maxAppearances: maxAppearancesOf(config),
    candidates,
  }
}

export const MASTER_FIGHT_OUTCOMES = ['DEFEATED', 'HERO_DEFEATED', 'ESCAPED'] as const

type MasterFightOutcome = (typeof MASTER_FIGHT_OUTCOMES)[number]

const STATUS_OF: Readonly<Record<MasterFightOutcome, MasterEncounterStatus>> = {
  DEFEATED: 'APPEARED_DEFEATED',
  HERO_DEFEATED: 'APPEARED_HERO_DEFEATED',
  ESCAPED: 'APPEARED_ESCAPED',
}

interface Evaluation {
  readonly afterEncounter: number
  readonly masterRef: string
  readonly appeared: boolean
}

interface Fight {
  readonly afterEncounter: number
  readonly masterRef: string
  readonly levelOffset: number
  readonly outcome: MasterFightOutcome
  readonly turns: number | null
}

/** Una lista del resumen con cada elemento leido; `null` si alguno no cumple. */
const listOf = <T>(value: unknown, read: (item: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  const items = value.map(read)

  return items.every((item) => item !== null) ? items : null
}

const record = (
  enrollmentId: string,
  sequence: number,
  fields: Pick<MasterEncounterRecord, 'afterEncounter' | 'status'> &
    Partial<Pick<MasterEncounterRecord, 'masterRef' | 'epicRef' | 'levelOffset' | 'turns'>>,
): MasterEncounterRecord => ({
  enrollmentId,
  sequence,
  masterRef: null,
  epicRef: null,
  levelOffset: null,
  turns: null,
  ...fields,
  grant: null,
})

export interface MasterEvidenceInput {
  readonly enrollmentId: string
  /** La configuracion de la definicion: sin ella, la mision no tiene Master. */
  readonly config: MasterEncounter | null
  /** Lo que se envio a Combat, tal como quedo congelado en la solicitud. */
  readonly sent: SimulationMaster | null
  /** El resumen completo de Combat. */
  readonly summary: unknown
  readonly facts: SimulationFacts
}

/**
 * La evidencia del Master (CU-73.3, paso 1): una fila por punto de evaluacion.
 * `null` si el resumen no cuadra con lo que se envio; el cierre entonces anula
 * la mision, porque una epica no se entrega sobre evidencia dudosa.
 *
 * Se comprueba que cada punto alcanzado este evaluado (CA-02), que aparezca como
 * mucho un Master por punto y nunca por encima del tope (P-X3), que cada
 * aparicion tenga su encuentro y que el resumen corto de HU-72 diga lo mismo.
 * Un punto que la mision no alcanzo no deja fila; uno que llego despues del
 * tope queda `SKIPPED_MAX_REACHED` (M-5).
 */
export const masterEncounterRecordsOf = (
  input: MasterEvidenceInput,
): readonly MasterEncounterRecord[] | null => {
  const { enrollmentId, config, sent, facts } = input

  if (sent === null) {
    // Sin bloque `master`, Combat no puede haber sacado ninguno.
    if (facts.master.appeared) {
      return null
    }

    return config === null
      ? []
      : [record(enrollmentId, 1, { afterEncounter: null, status: 'NOT_APPLICABLE' })]
  }

  const master = isRecord(input.summary) ? input.summary.master : undefined
  const points = new Set(sent.evaluationPoints.map((point) => point.afterEncounter))
  const candidates = new Map(sent.candidates.map((candidate) => [candidate.masterRef, candidate]))
  const known = (item: Readonly<Record<string, unknown>>): boolean =>
    isCount(item.afterEncounter) &&
    points.has(item.afterEncounter) &&
    typeof item.masterRef === 'string' &&
    candidates.has(item.masterRef)

  const evaluations = listOf<Evaluation>(isRecord(master) ? master.evaluations : null, (item) =>
    isRecord(item) && known(item) && typeof item.appeared === 'boolean'
      ? {
          afterEncounter: item.afterEncounter as number,
          masterRef: item.masterRef as string,
          appeared: item.appeared,
        }
      : null,
  )
  // CA-04: Combat crea al Master con el desfase que se le envio, y lo devuelve.
  const sameOffset = (item: Readonly<Record<string, unknown>>): boolean =>
    typeof item.masterRef === 'string' &&
    isCount(item.levelOffset) &&
    item.levelOffset <= MAX_INTEGER &&
    item.levelOffset === candidates.get(item.masterRef)?.levelOffset
  const fights = listOf<Fight>(isRecord(master) ? master.encounters : null, (item) =>
    isRecord(item) &&
    known(item) &&
    sameOffset(item) &&
    (MASTER_FIGHT_OUTCOMES as readonly unknown[]).includes(item.outcome)
      ? {
          afterEncounter: item.afterEncounter as number,
          masterRef: item.masterRef as string,
          levelOffset: item.levelOffset as number,
          outcome: item.outcome as MasterFightOutcome,
          // Informativo: si no cabe en la columna `integer`, se pierde el dato, no el cierre.
          turns: isCount(item.turns) && item.turns <= MAX_INTEGER ? item.turns : null,
        }
      : null,
  )

  if (evaluations === null || fights === null) {
    return null
  }

  const records: MasterEncounterRecord[] = []
  let appearances = 0

  for (const [index, { afterEncounter }] of sent.evaluationPoints.entries()) {
    const here = evaluations.filter((evaluation) => evaluation.afterEncounter === afterEncounter)
    const fought = fights.filter((fight) => fight.afterEncounter === afterEncounter)
    const appeared = here.filter((evaluation) => evaluation.appeared)
    const sequence = index + 1
    const reached = facts.encountersCompleted >= afterEncounter
    const capped = appearances >= sent.maxAppearances

    if (!reached || capped) {
      // Combat no debia evaluar este punto: no se llego o ya estaba el tope.
      if (here.length > 0 || fought.length > 0) {
        return null
      }

      // Un punto no alcanzado no deja fila, aunque el tope ya estuviera cubierto.
      if (reached) {
        records.push(
          record(enrollmentId, sequence, { afterEncounter, status: 'SKIPPED_MAX_REACHED' }),
        )
      }

      continue
    }

    const [shown] = appeared

    if (here.length === 0 || new Set(here.map((item) => item.masterRef)).size !== here.length) {
      return null
    }

    if (shown === undefined) {
      if (fought.length > 0) {
        return null
      }

      records.push(record(enrollmentId, sequence, { afterEncounter, status: 'NOT_APPEARED' }))
      continue
    }

    const [fight] = fought

    if (appeared.length > 1 || fought.length !== 1 || fight?.masterRef !== shown.masterRef) {
      return null
    }

    appearances += 1
    const status = STATUS_OF[fight.outcome]

    records.push(
      record(enrollmentId, sequence, {
        afterEncounter,
        status,
        masterRef: fight.masterRef,
        epicRef:
          status === 'APPEARED_DEFEATED'
            ? (candidates.get(fight.masterRef)?.epicRef ?? null)
            : null,
        levelOffset: fight.levelOffset,
        turns: fight.turns,
      }),
    )
  }

  // El resumen corto de HU-72 (objetivo DEFEAT_MASTER) debe decir lo mismo.
  if (
    facts.master.appeared !== fights.length > 0 ||
    facts.master.defeated !== fights.some((fight) => fight.outcome === 'DEFEATED')
  ) {
    return null
  }

  return records
}

/** Espacio de nombres propio de las entregas de epicas de Missions (P-X6). */
const EPIC_GRANT_NAMESPACE = '3f6c1d2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f'

/**
 * `operationId` de la entrega: matricula, Master y numero de aparicion. El mismo
 * cierre, repetido, da el mismo; Player/Inventory no entrega dos veces (M-7).
 */
export const epicGrantOperationId = (
  enrollmentId: string,
  masterRef: string,
  appearance: number,
): string => uuidV5(EPIC_GRANT_NAMESPACE, `${enrollmentId}:${masterRef}:${String(appearance)}`)

export interface EpicRewards {
  readonly records: readonly MasterEncounterRecord[]
  /** Las lineas `EPIC` del reporte de HU-74, en el orden de las apariciones. */
  readonly rewards: readonly ReportRewardLine[]
}

export interface EpicContent {
  readonly name: string | null
  readonly productId: string | null
}

/**
 * La epica de un Master segun el contenido VIGENTE. Se lee sin fiarse de su
 * forma, porque llega de `jsonb` y pudo cambiar despues de la matricula: un
 * contenido roto no debe impedir el cierre ni la entrega. Se busca por Master y
 * epica, asi que dos Master con la misma epica no se confunden. `null` si el
 * candidato ya no esta.
 */
export const epicOf = (
  config: unknown,
  masterRef: string | null,
  epicRef: string | null,
): EpicContent | null => {
  const candidates: readonly unknown[] =
    isRecord(config) && Array.isArray(config.candidates) ? config.candidates : []

  for (const candidate of candidates) {
    const epic = isRecord(candidate) ? candidate.epic : null

    if (
      isRecord(candidate) &&
      isRecord(epic) &&
      candidate.masterRef === masterRef &&
      epic.epicRef === epicRef
    ) {
      return {
        name: isText(epic.name) ? epic.name : null,
        productId: isText(epic.productId) ? epic.productId : null,
      }
    }
  }

  return null
}

/**
 * Cada Master derrotado deja su entrega pendiente y su linea `EPIC` en el
 * reporte (CA-01). Una aparicion sin derrota no da nada (CA-03). `config` es la
 * configuracion vigente del Master; solo da el nombre de la epica.
 */
export const epicRewardsOf = (
  records: readonly MasterEncounterRecord[],
  config: unknown,
  now: Date,
): EpicRewards => {
  const rewards: ReportRewardLine[] = []
  let appearance = 0

  const withGrants = records.map((encounter): MasterEncounterRecord => {
    if (encounter.masterRef === null) {
      return encounter
    }

    appearance += 1

    if (encounter.status !== 'APPEARED_DEFEATED' || encounter.epicRef === null) {
      return encounter
    }

    const lineNo = rewards.length + 1

    rewards.push({
      lineNo,
      kind: 'EPIC',
      reference: encounter.epicRef,
      name: epicOf(config, encounter.masterRef, encounter.epicRef)?.name ?? encounter.epicRef,
      rarity: null,
      quantity: 1,
      status: 'PENDING',
      source: 'HU-73',
      // La progresion del heroe es de las lineas de experiencia (HU-09).
      progression: null,
      updatedAt: now,
    })

    return {
      ...encounter,
      grant: {
        operationId: epicGrantOperationId(encounter.enrollmentId, encounter.masterRef, appearance),
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        grantedAt: null,
        rewardLineNo: lineNo,
        // Se congela al pedir la entrega por primera vez.
        productId: null,
      },
    }
  })

  return { records: withGrants, rewards }
}
