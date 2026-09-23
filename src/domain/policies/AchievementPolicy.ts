import {
  ACHIEVEMENT_CRITERIA,
  EPIC_STATES,
  RECOGNITION_KINDS,
  type AchievementCriterion,
  type AchievementDefinition,
  type AchievementProof,
  type AchievementRule,
  type AchievementStatus,
  type AchievementUnlock,
  type EpicState,
  type RecognitionKind,
  type RecognitionStatus,
} from '../entities/Achievement'
import type { EpicGrantStatus } from '../entities/MasterEncounterRecord'
import type {
  MasterCandidate,
  MasterEncounter,
  MissionDefinition,
} from '../entities/MissionDefinition'
import { REPORT_SCHEMA_VERSION } from '../entities/MissionReport'
import {
  InvalidAchievementCatalogError,
  type AchievementCatalogReason,
} from '../errors/achievement-errors'
import { uuidV5 } from '../value-objects/deterministic-uuid'
import { isDifficultyLevel, type DifficultyLevel } from '../value-objects/difficulty-level'
import { isoDurationSeconds } from '../value-objects/iso-duration'
import {
  isMissionCategory,
  MISSION_CATEGORIES,
  type MissionCategory,
} from '../value-objects/mission-category'
import { masterConfigProblem } from './MasterPolicy'
import { isCount, isRecord } from './SettlementPolicy'

/**
 * Reglas de los logros de HU-76 (RF-76). Son funciones puras y las usan igual el
 * evaluador y la consulta, asi que nunca discrepan. Missions no guarda progreso:
 * lo deriva de lo que ya guardan otras historias del servicio (P-L3 revisada):
 *
 * - misiones completadas: los clears de HU-75 (P-M10), en cualquier dificultad;
 * - dano, duracion y encuentros: los reportes `COMPLETED` de HU-74;
 * - Master derrotados y la entrega de su epica: la evidencia de HU-73;
 * - objetivos: las definiciones activas de HU-70 (P-L6).
 */

/**
 * Version de las reglas de evaluacion. Se sube cuando cambia como se evalua un
 * criterio: cambia la huella y se reevalua a todos los jugadores, tambien a los
 * que ya no juegan.
 */
export const ACHIEVEMENT_POLICY_VERSION = 1

/** Espacio UUID v5 de las entregas de cosmeticos; distinto del de las epicas de HU-73. */
const ACHIEVEMENT_GRANT_NAMESPACE = 'c1c392d8-2b08-40eb-aeff-de394c31093c'

/** Espacio UUID v5 de la huella del catalogo y del contenido. */
const ACHIEVEMENT_FINGERPRINT_NAMESPACE = 'e0a44b37-6588-4b75-9997-56736f4bcd0b'

/** El mayor valor de una columna `integer` de PostgreSQL. */
const MAX_INTEGER = 2_147_483_647

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Texto con algo mas que espacios y que PostgreSQL puede guardar: una columna
 * `text` no admite el caracter U+0000, y un logro que no se puede guardar no
 * debe pasar la validacion del catalogo.
 */
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && !value.includes('\u0000')

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

// --- Evidencia: el «hecho normalizado» del contrato, visto por jugador ---

/**
 * Un reporte `COMPLETED` tal como sale de `mission_reports`: sus columnas y los
 * cuatro datos de la foto que usan los logros, todavia sin validar.
 */
export interface CompletedReportRow {
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  readonly finishedAt: Date
  readonly schemaVersion: number
  readonly damageTaken: unknown
  readonly simulatedDuration: unknown
  readonly encountersCompleted: unknown
  readonly encountersTotal: unknown
}

/** Un reporte `COMPLETED` del jugador. Lo que no se puede comprobar queda en `null`. */
export interface CompletedReportEvidence {
  readonly enrollmentId: string
  readonly missionId: string
  readonly difficulty: DifficultyLevel
  /** El fin de la mision para el jugador (su `endsAt`). */
  readonly finishedAt: Date
  readonly damageTaken: number | null
  readonly simulatedDuration: string | null
  readonly encountersCompleted: number | null
  readonly encountersTotal: number | null
}

/**
 * Lee la foto con tolerancia y nunca lanza: un reporte de otra version, o con
 * datos raros, deja la evidencia en `null` y no bloquea al jugador ni la
 * consulta. Un `null` NO es 0: sin el dato no hay evidencia de «sin dano»
 * (CA-02), al contrario que en las estadisticas del historial.
 */
export const completedReportEvidenceOf = (row: CompletedReportRow): CompletedReportEvidence => {
  const known = row.schemaVersion === REPORT_SCHEMA_VERSION
  const { damageTaken, simulatedDuration, encountersCompleted, encountersTotal } = row

  return {
    enrollmentId: row.enrollmentId,
    missionId: row.missionId,
    difficulty: row.difficulty,
    finishedAt: row.finishedAt,
    damageTaken:
      known && typeof damageTaken === 'number' && Number.isFinite(damageTaken) && damageTaken >= 0
        ? damageTaken
        : null,
    simulatedDuration:
      known &&
      typeof simulatedDuration === 'string' &&
      isoDurationSeconds(simulatedDuration) !== null
        ? simulatedDuration
        : null,
    encountersCompleted: known && isCount(encountersCompleted) ? encountersCompleted : null,
    encountersTotal: known && isCount(encountersTotal) ? encountersTotal : null,
  }
}

/** Un Master que el heroe derroto (`APPEARED_DEFEATED`) en una mision terminada del jugador. */
export interface DefeatedMasterEvidence {
  readonly enrollmentId: string
  readonly sequence: number
  readonly masterRef: string
  readonly epicRef: string | null
  /** El estado de la entrega de su epica (HU-73). */
  readonly grantStatus: EpicGrantStatus | null
}

/**
 * La evidencia de un jugador en el momento de evaluar. `null`: no se leyo,
 * porque ningun logro pendiente la necesita.
 */
export interface PlayerAchievementEvidence {
  /** Misiones completadas al menos una vez, en cualquier dificultad (P-M10). */
  readonly completedMissionIds: ReadonlySet<string> | null
  readonly completedReports: readonly CompletedReportEvidence[] | null
  readonly defeatedMasters: readonly DefeatedMasterEvidence[] | null
}

export interface EvidenceNeeds {
  readonly clears: boolean
  readonly reports: boolean
  readonly masters: boolean
}

type RecordTimeRule = Extract<AchievementRule, { readonly criterion: 'RECORD_TIME' }>

/** Segundos del umbral de tiempo record, o `null` si todavia no hay uno valido (decision 3). */
const thresholdOf = (rule: RecordTimeRule): number | null => {
  const seconds =
    rule.maxSimulatedDuration === null ? null : isoDurationSeconds(rule.maxSimulatedDuration)

  return seconds !== null && seconds > 0 ? seconds : null
}

/** Solo se lee la evidencia que necesitan los logros que el jugador aun no tiene. */
export const evidenceNeedsOf = (pending: readonly AchievementDefinition[]): EvidenceNeeds => ({
  clears: pending.some(({ rule }) => rule.criterion === 'ALL_CATEGORY_MISSIONS'),
  reports: pending.some(
    ({ rule }) =>
      rule.criterion === 'FLAWLESS_MISSION' ||
      (rule.criterion === 'RECORD_TIME' && thresholdOf(rule) !== null),
  ),
  masters: pending.some(
    ({ rule }) =>
      rule.criterion === 'ALL_MASTERS_DEFEATED' || rule.criterion === 'ALL_MASTER_EPICS',
  ),
})

// --- Objetivos (P-L6) ---

/**
 * El contenido que fija los objetivos de los logros de «todas»: las misiones
 * ACTIVAS de cada categoria, los Master disponibles y sus epicas. Cambia con el
 * catalogo de misiones, asi que se calcula al evaluar y al leer.
 */
export interface AchievementContent {
  readonly missionsByCategory: Readonly<Record<MissionCategory, readonly string[]>>
  readonly availableMasters: readonly string[]
  readonly masterEpics: readonly string[]
}

/**
 * Los Master que pueden aparecer en una mision: solo con una configuracion valida
 * (una invalida anula la mision con `INVALID_MASTER_CONFIG`) y con alguna
 * probabilidad mayor que 0. El contenido de PostgreSQL llega de `jsonb` sin
 * validar, asi que se lee a la defensiva.
 */
const availableCandidatesOf = (definition: MissionDefinition): readonly MasterCandidate[] => {
  const config: unknown = definition.masterEncounter
  const encounters: unknown = definition.encounters

  if (
    !isRecord(config) ||
    !Array.isArray(encounters) ||
    masterConfigProblem(config as unknown as MasterEncounter, encounters.length) !== null
  ) {
    return []
  }

  // Con la configuracion valida, cada candidato tiene su forma (P-X5).
  return (config as unknown as MasterEncounter).candidates.filter((candidate) =>
    Object.values(candidate.probabilityByHeroType).some((probability) => probability > 0),
  )
}

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compareText)

/**
 * El mismo Master puede estar en dos misiones y dos Master pueden dar la misma
 * epica: las listas van sin repetidos y ordenadas.
 */
export const achievementContentOf = (
  definitions: readonly MissionDefinition[],
): AchievementContent => {
  const active = definitions.filter((definition) => definition.active)
  const candidates = active.flatMap(availableCandidatesOf)
  const missionsOf = (category: MissionCategory): readonly string[] =>
    uniqueSorted(
      active
        .filter((definition) => definition.category === category)
        .map((definition) => definition.missionId),
    )

  return {
    missionsByCategory: {
      STORY: missionsOf('STORY'),
      CHALLENGE: missionsOf('CHALLENGE'),
      EXPLORATION: missionsOf('EXPLORATION'),
    },
    availableMasters: uniqueSorted(candidates.map((candidate) => candidate.masterRef)),
    masterEpics: uniqueSorted(candidates.map((candidate) => candidate.epic.epicRef)),
  }
}

// --- Progreso: una sola funcion para el evaluador y para la consulta ---

export interface AchievementProgress {
  readonly current: number
  readonly target: number
  /** `false`: sin objetivo (un «todas» sin contenido) o sin umbral. Nunca se otorga. */
  readonly evaluable: boolean
  /** Solo con el progreso completo: nunca con progreso parcial (CA-03). */
  readonly met: boolean
  readonly proof: AchievementProof
}

const NO_PROOF: AchievementProof = { refs: [], enrollmentIds: [] }

const progressWith = (
  current: number,
  target: number,
  proof: AchievementProof,
  evaluable = target >= 1,
): AchievementProgress => ({
  current,
  target,
  evaluable,
  met: evaluable && current >= target,
  proof,
})

/**
 * Para cada referencia, la matricula que la prueba: la menor, para que el
 * resultado no dependa del orden en que se lee la evidencia.
 */
const firstEnrollmentByRef = (
  rows: readonly { readonly ref: string; readonly enrollmentId: string }[],
): ReadonlyMap<string, string | null> => {
  const first = new Map<string, string>()

  for (const { ref, enrollmentId } of rows) {
    const current = first.get(ref)

    if (current === undefined || compareText(enrollmentId, current) < 0) {
      first.set(ref, enrollmentId)
    }
  }

  return first
}

/** «Todas»: cuantas referencias del objetivo tienen evidencia. Un objetivo vacio no es evaluable. */
const allOf = (
  target: readonly string[],
  found: ReadonlyMap<string, string | null>,
): AchievementProgress => {
  const refs = target.filter((ref) => found.has(ref))
  const enrollmentIds = uniqueSorted(
    refs.flatMap((ref) => {
      const enrollmentId = found.get(ref)

      return enrollmentId === undefined || enrollmentId === null ? [] : [enrollmentId]
    }),
  )

  return progressWith(refs.length, target.length, { refs, enrollmentIds })
}

const byFinish = (a: CompletedReportEvidence, b: CompletedReportEvidence): number =>
  a.finishedAt.getTime() - b.finishedAt.getTime() || compareText(a.enrollmentId, b.enrollmentId)

/**
 * Sin dano (P-L8, endurecida): completada, con el dano informado e igual a 0 y
 * con el recorrido entero. Asi no se premia una ejecucion vacia.
 */
const isFlawless = (report: CompletedReportEvidence): boolean =>
  report.damageTaken === 0 &&
  report.encountersTotal !== null &&
  report.encountersTotal >= 1 &&
  report.encountersCompleted === report.encountersTotal

/** `CREDITED`: solo la epica entregada. `WON`: tambien la pendiente, pero no la rechazada. */
const epicCounts = (status: EpicGrantStatus | null, state: EpicState): boolean =>
  state === 'CREDITED' ? status === 'GRANTED' : status !== 'REJECTED'

const flawlessProgress = (
  count: number,
  reports: readonly CompletedReportEvidence[],
): AchievementProgress => {
  // Misiones distintas, de la primera terminada en adelante.
  const chosen = new Map<string, string>()

  for (const report of reports.filter(isFlawless).sort(byFinish)) {
    if (chosen.size < count && !chosen.has(report.missionId)) {
      chosen.set(report.missionId, report.enrollmentId)
    }
  }

  return progressWith(chosen.size, count, {
    refs: [...chosen.keys()],
    enrollmentIds: [...chosen.values()],
  })
}

/**
 * Tiempo record (P-L7): alguna finalizacion de la mision (y de su dificultad, si
 * la regla la fija) con la duracion simulada dentro del umbral. La prueba es la
 * mejor marca: menos segundos y, a igualdad, la mas antigua, como `bestTimesOf`.
 */
const recordProgress = (
  rule: RecordTimeRule,
  reports: readonly CompletedReportEvidence[],
): AchievementProgress => {
  const threshold = thresholdOf(rule)

  if (threshold === null) {
    return progressWith(0, 1, NO_PROOF, false)
  }

  let best: { readonly report: CompletedReportEvidence; readonly seconds: number } | null = null

  for (const report of reports) {
    const seconds =
      report.simulatedDuration === null ? null : isoDurationSeconds(report.simulatedDuration)

    if (
      report.missionId === rule.missionId &&
      (rule.difficulty === null || report.difficulty === rule.difficulty) &&
      seconds !== null &&
      seconds <= threshold &&
      (best === null ||
        seconds < best.seconds ||
        (seconds === best.seconds && byFinish(report, best.report) < 0))
    ) {
      best = { report, seconds }
    }
  }

  return best === null
    ? progressWith(0, 1, NO_PROOF)
    : progressWith(1, 1, { refs: [rule.missionId], enrollmentIds: [best.report.enrollmentId] })
}

/**
 * El progreso de un logro con el contenido y la evidencia de ahora. La
 * pertenencia se calcula contra el contenido VIGENTE: una mision cuenta en su
 * categoria de hoy (P-04), y en cualquier dificultad.
 */
export const progressOf = (
  definition: AchievementDefinition,
  content: AchievementContent,
  evidence: PlayerAchievementEvidence,
): AchievementProgress => {
  const rule = definition.rule
  const masters = evidence.defeatedMasters ?? []
  const reports = evidence.completedReports ?? []

  switch (rule.criterion) {
    case 'ALL_CATEGORY_MISSIONS':
      return allOf(
        content.missionsByCategory[rule.category],
        new Map([...(evidence.completedMissionIds ?? [])].map((missionId) => [missionId, null])),
      )
    case 'ALL_MASTERS_DEFEATED':
      // Cuenta aunque la mision terminara FAILED: el heroe si lo derroto (L-6).
      return allOf(
        content.availableMasters,
        firstEnrollmentByRef(
          masters.map((master) => ({ ref: master.masterRef, enrollmentId: master.enrollmentId })),
        ),
      )
    case 'ALL_MASTER_EPICS':
      return allOf(
        content.masterEpics,
        firstEnrollmentByRef(
          masters.flatMap((master) =>
            master.epicRef !== null && epicCounts(master.grantStatus, rule.epicState)
              ? [{ ref: master.epicRef, enrollmentId: master.enrollmentId }]
              : [],
          ),
        ),
      )
    case 'FLAWLESS_MISSION':
      return flawlessProgress(rule.count, reports)
    case 'RECORD_TIME':
      return recordProgress(rule, reports)
  }
}

// --- Desbloqueo ---

export interface UnlocksDueInput {
  readonly playerId: string
  /** Las definiciones que el jugador aun no tiene desbloqueadas. */
  readonly pending: readonly AchievementDefinition[]
  readonly content: AchievementContent
  readonly evidence: PlayerAchievementEvidence
  readonly now: Date
}

/**
 * El `operationId` de la entrega de un cosmetico: el mismo jugador y el mismo
 * logro dan siempre el mismo, asi que nunca hay dos entregas. No lleva la
 * version, para que un cambio de regla no abra otra. El `achievementId` no admite
 * `:`, asi que el nombre no es ambiguo.
 */
export const achievementGrantOperationId = (playerId: string, achievementId: string): string =>
  uuidV5(ACHIEVEMENT_GRANT_NAMESPACE, `${playerId}:${achievementId}`)

/**
 * Los logros que se desbloquean ahora (CA-01): uno por cada definicion pendiente
 * con el progreso completo. Un titulo o una insignia quedan registrados en el
 * acto; un cosmetico queda pendiente de entregar, sin producto hasta el primer
 * envio.
 */
export const unlocksDue = ({
  playerId,
  pending,
  content,
  evidence,
  now,
}: UnlocksDueInput): readonly AchievementUnlock[] =>
  pending.flatMap((definition): AchievementUnlock[] => {
    const { met, current, target, proof } = progressOf(definition, content, evidence)

    if (!met) {
      return []
    }

    const { recognition } = definition
    const cosmetic = recognition.kind === 'COSMETIC_PRODUCT'

    return [
      {
        playerId,
        achievementId: definition.achievementId,
        achievementVersion: definition.version,
        criterion: definition.rule.criterion,
        name: definition.name,
        progress: { current, target },
        proof,
        unlockedAt: now,
        recognition: {
          kind: recognition.kind,
          name: recognition.name,
          status: cosmetic ? 'PENDING' : 'RECORDED',
        },
        grant: cosmetic
          ? {
              operationId: achievementGrantOperationId(playerId, definition.achievementId),
              attempts: 0,
              nextAttemptAt: now,
              lastError: null,
              productId: null,
              creditedAt: null,
            }
          : null,
      },
    ]
  })

// --- Vista de la consulta ---

export interface AchievementView {
  readonly achievementId: string
  readonly name: string
  readonly criterion: AchievementCriterion
  readonly status: AchievementStatus
  readonly progress: { readonly current: number; readonly target: number }
  readonly unlockedAt: Date | null
  readonly recognition: {
    readonly kind: RecognitionKind
    readonly name: string
    /** `null` mientras el logro no este desbloqueado. */
    readonly status: RecognitionStatus | null
  }
}

export interface AchievementViewsInput {
  readonly definitions: readonly AchievementDefinition[]
  readonly content: AchievementContent
  readonly evidence: PlayerAchievementEvidence
  readonly unlocks: readonly AchievementUnlock[]
}

/**
 * Un logro por definicion del catalogo, mas los desbloqueados que ya no estan en
 * el. Solo es `UNLOCKED` lo que esta guardado, con sus datos CONGELADOS (P-L5);
 * lo demas se calcula ahora con `progressOf`. Un criterio ya cumplido que el
 * evaluador aun no guardo se ve `IN_PROGRESS`, con el progreso completo, como
 * mucho durante un ciclo.
 *
 * Orden: primero los desbloqueados, del mas reciente al mas antiguo; despues el
 * resto, en el orden del catalogo.
 */
export const achievementViewsOf = ({
  definitions,
  content,
  evidence,
  unlocks,
}: AchievementViewsInput): readonly AchievementView[] => {
  const position = new Map(
    definitions.map((definition, index) => [definition.achievementId, index]),
  )
  // Los que salieron del catalogo van detras de los que siguen en el.
  const positionOf = (achievementId: string): number =>
    position.get(achievementId) ?? definitions.length
  const unlockedIds = new Set(unlocks.map((unlock) => unlock.achievementId))

  const unlocked = [...unlocks]
    .sort(
      (a, b) =>
        b.unlockedAt.getTime() - a.unlockedAt.getTime() ||
        positionOf(a.achievementId) - positionOf(b.achievementId) ||
        compareText(a.achievementId, b.achievementId),
    )
    .map((unlock): AchievementView => ({
      achievementId: unlock.achievementId,
      name: unlock.name,
      criterion: unlock.criterion,
      status: 'UNLOCKED',
      progress: { current: unlock.progress.current, target: unlock.progress.target },
      unlockedAt: unlock.unlockedAt,
      recognition: {
        kind: unlock.recognition.kind,
        name: unlock.recognition.name,
        status: unlock.recognition.status,
      },
    }))

  const rest = definitions
    .filter((definition) => !unlockedIds.has(definition.achievementId))
    .map((definition): AchievementView => {
      const { current, target } = progressOf(definition, content, evidence)

      return {
        achievementId: definition.achievementId,
        name: definition.name,
        criterion: definition.rule.criterion,
        status: current > 0 ? 'IN_PROGRESS' : 'LOCKED',
        progress: { current, target },
        unlockedAt: null,
        recognition: {
          kind: definition.recognition.kind,
          name: definition.recognition.name,
          status: null,
        },
      }
    })

  return [...unlocked, ...rest]
}

// --- Huella y catalogo ---

const ruleKeyOf = (rule: AchievementRule): readonly unknown[] => {
  switch (rule.criterion) {
    case 'ALL_CATEGORY_MISSIONS':
      return [rule.criterion, rule.category]
    case 'ALL_MASTERS_DEFEATED':
      return [rule.criterion]
    case 'FLAWLESS_MISSION':
      return [rule.criterion, rule.count]
    case 'RECORD_TIME':
      return [rule.criterion, rule.missionId, rule.maxSimulatedDuration, rule.difficulty]
    case 'ALL_MASTER_EPICS':
      return [rule.criterion, rule.epicState]
  }
}

/**
 * Huella de lo que decide quien cumple: las reglas del catalogo, el contenido
 * activo y la version de la politica. Si cambia, se reevalua a todos los
 * jugadores: lo que ya se cumplia se otorga (retroactividad) y nada se revoca
 * (P-L5). No incluye nombres ni reconocimientos, que no cambian quien cumple.
 */
export const catalogFingerprintOf = (
  definitions: readonly AchievementDefinition[],
  content: AchievementContent,
): string =>
  uuidV5(
    ACHIEVEMENT_FINGERPRINT_NAMESPACE,
    JSON.stringify([
      ACHIEVEMENT_POLICY_VERSION,
      [...definitions]
        .sort((a, b) => compareText(a.achievementId, b.achievementId))
        .map((definition) => [
          definition.achievementId,
          definition.version,
          ruleKeyOf(definition.rule),
        ]),
      MISSION_CATEGORIES.map((category) => [
        category,
        uniqueSorted(content.missionsByCategory[category]),
      ]),
      uniqueSorted(content.availableMasters),
      uniqueSorted(content.masterEpics),
    ]),
  )

export interface AchievementCatalogProblem {
  readonly achievementId: string | null
  readonly reason: AchievementCatalogReason
}

const ACHIEVEMENT_ID = /^[a-z0-9_]{1,64}$/

/**
 * En minusculas, como lo devuelve la columna `uuid` de PostgreSQL: asi el cuerpo
 * de cada reintento es identico al del primer envio.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Positivo y dentro de una columna `integer`: la version y el objetivo se guardan asi. */
const isPositiveInteger = (value: unknown): value is number =>
  isCount(value) && value >= 1 && value <= MAX_INTEGER

const ruleProblem = (rule: unknown): AchievementCatalogReason | null => {
  const criterion: unknown = isRecord(rule) ? rule.criterion : null

  if (!isRecord(rule) || !includes(ACHIEVEMENT_CRITERIA, criterion)) {
    return 'UNKNOWN_CRITERION'
  }

  switch (criterion) {
    case 'ALL_CATEGORY_MISSIONS':
      return typeof rule.category === 'string' && isMissionCategory(rule.category)
        ? null
        : 'INVALID_CATEGORY'
    case 'ALL_MASTERS_DEFEATED':
      return null
    case 'FLAWLESS_MISSION':
      return isPositiveInteger(rule.count) ? null : 'INVALID_COUNT'
    case 'RECORD_TIME': {
      const max = rule.maxSimulatedDuration
      const seconds = typeof max === 'string' ? isoDurationSeconds(max) : null
      const difficulty = rule.difficulty

      return isText(rule.missionId) &&
        (max === null || (seconds !== null && seconds > 0)) &&
        (difficulty === null || (typeof difficulty === 'string' && isDifficultyLevel(difficulty)))
        ? null
        : 'INVALID_RECORD_PARAMS'
    }
    case 'ALL_MASTER_EPICS':
      return includes(EPIC_STATES, rule.epicState) ? null : 'INVALID_EPIC_STATE'
  }
}

/** Un producto solo lo lleva un cosmetico: un UUID de Catalog o `null` mientras no exista. */
const recognitionIsValid = (recognition: unknown): boolean => {
  if (
    !isRecord(recognition) ||
    !includes(RECOGNITION_KINDS, recognition.kind) ||
    !isText(recognition.name)
  ) {
    return false
  }

  const productId = recognition.productId

  return recognition.kind === 'COSMETIC_PRODUCT'
    ? productId === null || (typeof productId === 'string' && UUID.test(productId))
    : productId === undefined
}

const definitionProblem = (definition: unknown): AchievementCatalogReason | null => {
  if (
    !isRecord(definition) ||
    typeof definition.achievementId !== 'string' ||
    !ACHIEVEMENT_ID.test(definition.achievementId)
  ) {
    return 'INVALID_ID'
  }

  if (!isPositiveInteger(definition.version)) {
    return 'INVALID_VERSION'
  }

  if (!isText(definition.name)) {
    return 'INVALID_NAME'
  }

  return (
    ruleProblem(definition.rule) ??
    (recognitionIsValid(definition.recognition) ? null : 'INVALID_RECOGNITION')
  )
}

/**
 * El primer problema del catalogo, en el orden en que viene, o `null`. Se lee
 * sin fiarse del tipo: hoy el catalogo vive en codigo, pero podria cargarse de
 * una tabla (P-L1).
 */
export const achievementCatalogProblem = (
  definitions: readonly AchievementDefinition[],
): AchievementCatalogProblem | null => {
  const seen = new Set<string>()

  for (const definition of definitions) {
    const value: unknown = definition
    const reason = definitionProblem(value)

    if (reason !== null) {
      return {
        achievementId:
          isRecord(value) && typeof value.achievementId === 'string' ? value.achievementId : null,
        reason,
      }
    }

    if (seen.has(definition.achievementId)) {
      return { achievementId: definition.achievementId, reason: 'DUPLICATE_ID' }
    }

    seen.add(definition.achievementId)
  }

  return null
}

/** Falla con `InvalidAchievementCatalogError` si el catalogo trae un logro invalido. */
export const assertAchievementCatalog = (definitions: readonly AchievementDefinition[]): void => {
  const problem = achievementCatalogProblem(definitions)

  if (problem !== null) {
    throw new InvalidAchievementCatalogError(problem.achievementId, problem.reason)
  }
}
