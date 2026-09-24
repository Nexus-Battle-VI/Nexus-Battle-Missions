import { isRecord } from './SettlementPolicy'

/**
 * Progreso de una mision en curso (diseno «misiones jugables», P-J6; curso 7.8.9,
 * «Panel de misiones activas»). Combat simula la mision entera en segundos al
 * empezar; la bitacora se REVELA al jugador poco a poco, en proporcion al turno de
 * cada evento sobre la duracion real. El servidor decide que se ve: el cliente no
 * calcula tiempo ni progreso, y el desenlace no se muestra antes del final.
 */
export const PROGRESS_KINDS = [
  'ENCOUNTER_STARTED',
  'ENEMY_APPEARED',
  'HERO_ACTION',
  'ENEMY_GUARDED',
  'ENEMY_ACTION',
  'HERO_HEALED',
  'DEFEATED',
  'ENCOUNTER_FINISHED',
  'HERO_RECOVERED',
  'MISSION_FINISHED',
] as const

export type ProgressKind = (typeof PROGRESS_KINDS)[number]

export type ProgressRole = 'ENEMY' | 'BOSS' | 'MASTER'

/** Una entrada de la bitacora, con nombres y sin referencias internas de Combat. */
export interface ProgressEntry {
  readonly seq: number
  /** Turnos del heroe transcurridos al ocurrir; 0 antes del primer golpe. */
  readonly turn: number
  readonly kind: ProgressKind
  readonly encounter?: number
  readonly boss?: boolean
  readonly enemy?: string
  readonly role?: ProgressRole
  readonly maxHealth?: number
  readonly ability?: string | null
  readonly attacked?: boolean
  readonly hit?: boolean
  readonly damage?: number
  readonly critical?: boolean
  readonly enemyHealth?: number
  readonly heroHealth?: number
  readonly enraged?: boolean
  readonly prevented?: number
  readonly reflected?: number
  readonly amount?: number
  readonly victory?: boolean
  /** Lo que hizo la habilidad, tal como lo informa Combat (P-J4). */
  readonly effects?: readonly Readonly<Record<string, unknown>>[]
}

/** Nombres con que se traducen las referencias de la bitacora. */
export interface ProgressNames {
  readonly enemies: ReadonlyMap<string, string>
  readonly masters: ReadonlyMap<string, string>
  readonly bossRef: string | null
  readonly abilities: ReadonlyMap<string, string>
}

export interface RevealedProgress {
  readonly entries: readonly ProgressEntry[]
  /** Eventos que la bitacora tiene en total; los que faltan se revelan despues. */
  readonly total: number
  /** Cuando se revela el proximo evento; `null` si ya se ve todo. */
  readonly nextRevealAt: Date | null
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const pairsOf = (list: unknown, key: string): readonly (readonly [string, string])[] =>
  Array.isArray(list)
    ? (list as unknown[]).flatMap((item) =>
        isRecord(item) && typeof item[key] === 'string' && typeof item.name === 'string'
          ? [[item[key], item.name] as const]
          : [],
      )
    : []

/**
 * Los nombres para la bitacora, de la solicitud congelada que se envio a Combat y
 * del contenido. Todo se lee con tolerancia: llega de `jsonb` y un dato roto solo
 * deja la referencia en lugar del nombre.
 */
export const progressNamesOf = (request: unknown, definition: unknown): ProgressNames => {
  const encounters: readonly unknown[] =
    isRecord(request) && Array.isArray(request.encounters) ? request.encounters : []
  const content = isRecord(definition) ? definition : {}
  const boss = isRecord(content.finalBoss) ? content.finalBoss : {}
  const master = isRecord(content.masterEncounter) ? content.masterEncounter : {}
  const hero = isRecord(request) && isRecord(request.hero) ? request.hero : {}
  const profile = isRecord(hero.profile) ? hero.profile : {}

  return {
    enemies: new Map([
      ...pairsOf(content.enemies, 'enemyRef'),
      ...encounters.flatMap((encounter) =>
        isRecord(encounter) ? pairsOf(encounter.enemies, 'enemyRef') : [],
      ),
      ...pairsOf([boss], 'enemyRef'),
    ]),
    masters: new Map(pairsOf(master.candidates, 'masterRef')),
    bossRef: typeof boss.enemyRef === 'string' ? boss.enemyRef : null,
    abilities: new Map(pairsOf(profile.abilities, 'abilityId')),
  }
}

/** Nombre y vida maxima del heroe tal como se enviaron a Combat. */
export const heroOfRequest = (
  request: unknown,
): { readonly name: string | null; readonly maxHealth: number | null } => {
  const hero = isRecord(request) && isRecord(request.hero) ? request.hero : {}
  const profile = isRecord(hero.profile) ? hero.profile : {}
  const stats = isRecord(profile.effectiveStats) ? profile.effectiveStats : {}
  return {
    name: typeof profile.name === 'string' && profile.name !== '' ? profile.name : null,
    maxHealth: typeof stats.health === 'number' ? stats.health : null,
  }
}

/** Del 0 al 100: el tiempo transcurrido sobre la duracion real. */
export const progressPercentOf = (startedAt: Date, endsAt: Date, now: Date): number => {
  const span = endsAt.getTime() - startedAt.getTime()
  if (span <= 0) return 100
  const ratio = (now.getTime() - startedAt.getTime()) / span
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)))
}

/** Segundos que faltan para terminar; 0 si ya termino. */
export const remainingSecondsOf = (endsAt: Date, now: Date): number =>
  Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000))

const refOf = (combatant: unknown): string | null => {
  if (typeof combatant !== 'string' || combatant === '') return null
  const hash = combatant.lastIndexOf('#')
  return hash > 0 ? combatant.slice(0, hash) : combatant
}

const who = (
  ref: unknown,
  names: ProgressNames,
): { readonly enemy: string; readonly role: ProgressRole } => {
  const key = typeof ref === 'string' ? ref : ''
  const master = names.masters.get(key)
  if (master !== undefined) return { enemy: master, role: 'MASTER' }
  return {
    enemy: names.enemies.get(key) ?? key,
    role: key !== '' && key === names.bossRef ? 'BOSS' : 'ENEMY',
  }
}

/** Traduce un evento de Combat; `null` si no es de los que se muestran. */
const entryOf = (
  event: Readonly<Record<string, unknown>>,
  turn: number,
  names: ProgressNames,
): ProgressEntry | null => {
  const seq = numberOr(event.seq, 0)
  const base = { seq, turn }

  switch (event.type) {
    case 'encounterStarted':
      return {
        ...base,
        kind: 'ENCOUNTER_STARTED',
        encounter: numberOr(event.encounter, 0),
        boss: event.kind === 'BOSS',
      }
    case 'enemyStarted':
      return {
        ...base,
        kind: 'ENEMY_APPEARED',
        ...who(event.enemyRef, names),
        maxHealth: numberOr(event.maxHealth, 0),
      }
    case 'heroAction': {
      const abilityId = typeof event.abilityId === 'string' ? event.abilityId : null
      return {
        ...base,
        kind: 'HERO_ACTION',
        ...who(event.enemyRef, names),
        ability: abilityId === null ? null : (names.abilities.get(abilityId) ?? abilityId),
        attacked: event.attacked !== false,
        hit: event.hit === true,
        damage: numberOr(event.damage, 0),
        critical: event.critical === true,
        enemyHealth: numberOr(event.enemyHealth, 0),
        effects: Array.isArray(event.effects) ? (event.effects as unknown[]).filter(isRecord) : [],
      }
    }
    case 'enemyGuarded':
      return { ...base, kind: 'ENEMY_GUARDED', ...who(event.enemyRef, names) }
    case 'enemyAction':
      return {
        ...base,
        kind: 'ENEMY_ACTION',
        ...who(event.enemyRef, names),
        hit: event.hit === true,
        damage: numberOr(event.damage, 0),
        heroHealth: numberOr(event.heroHealth, 0),
        enraged: event.enraged === true,
        prevented: numberOr(event.prevented, 0),
        reflected: numberOr(event.reflected, 0),
      }
    case 'heroHealed':
      return {
        ...base,
        kind: 'HERO_HEALED',
        amount: numberOr(event.amount, 0),
        heroHealth: numberOr(event.heroHealth, 0),
      }
    case 'combatantDefeated':
      return { ...base, kind: 'DEFEATED', ...who(refOf(event.combatant), names) }
    case 'encounterFinished':
      return {
        ...base,
        kind: 'ENCOUNTER_FINISHED',
        encounter: numberOr(event.encounter, 0),
        heroHealth: numberOr(event.heroHealth, 0),
      }
    case 'heroRecovered':
      return { ...base, kind: 'HERO_RECOVERED', heroHealth: numberOr(event.heroHealth, 0) }
    case 'simulationFinished':
      return {
        ...base,
        kind: 'MISSION_FINISHED',
        victory: event.combatOutcome === 'HERO_VICTORIOUS',
      }
    default:
      return null
  }
}

/**
 * Lo que el jugador ya puede ver de la bitacora. Cada evento se revela cuando el
 * tiempo transcurrido alcanza la fraccion de su turno sobre el total: el primer
 * golpe al empezar y el ultimo al final. `MISSION_FINISHED` solo se ve al terminar.
 * `after` devuelve solo lo nuevo, para que el panel pida en incrementos.
 */
export const revealedProgressOf = (input: {
  readonly log: readonly unknown[]
  readonly startedAt: Date
  readonly endsAt: Date
  readonly now: Date
  readonly finished: boolean
  readonly after: number
  readonly names: ProgressNames
}): RevealedProgress => {
  const events = input.log.filter(isRecord)
  const totalTurns = Math.max(1, events.filter((event) => event.type === 'heroAction').length)
  const span = Math.max(0, input.endsAt.getTime() - input.startedAt.getTime())
  const entries: ProgressEntry[] = []
  let turn = 0
  let nextRevealAt: number | null = null

  for (const event of events) {
    if (event.type === 'heroAction') turn += 1
    const revealAt =
      event.type === 'simulationFinished'
        ? input.endsAt.getTime()
        : input.startedAt.getTime() + Math.floor((span * turn) / totalTurns)
    const visible = input.finished || revealAt <= input.now.getTime()

    if (!visible) {
      nextRevealAt = nextRevealAt === null ? revealAt : Math.min(nextRevealAt, revealAt)
      continue
    }

    const entry = entryOf(event, turn, input.names)
    if (entry !== null && entry.seq > input.after) entries.push(entry)
  }

  return {
    entries,
    total: events.length,
    nextRevealAt: nextRevealAt === null ? null : new Date(nextRevealAt),
  }
}
