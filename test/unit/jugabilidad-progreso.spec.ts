import {
  heroOfRequest,
  progressNamesOf,
  progressPercentOf,
  remainingSecondsOf,
  revealedProgressOf,
  type ProgressNames,
} from '../../src/domain/policies/ProgressPolicy'

const START = new Date('2026-10-01T15:00:00.000Z')
const END = new Date('2026-10-01T16:00:00.000Z')
const at = (minutes: number): Date => new Date(START.getTime() + minutes * 60_000)

const NAMES: ProgressNames = {
  enemies: new Map([
    ['sombra', 'Sombra Corrompida'],
    ['guardian', 'El Guardián Eterno'],
  ]),
  masters: new Map([['olvido', 'Sombra del Olvido']]),
  bossRef: 'guardian',
  abilities: new Map([['golpe', 'Golpe con escudo']]),
}

/** Cuatro turnos del heroe: dos contra una sombra, uno contra el Master y uno contra el jefe. */
const LOG = [
  { seq: 1, type: 'encounterStarted', encounter: 1, kind: 'REGULAR' },
  { seq: 2, type: 'enemyStarted', enemyRef: 'sombra', maxHealth: 5 },
  {
    seq: 3,
    type: 'heroAction',
    enemyRef: 'sombra',
    action: 'ABILITY',
    abilityId: 'golpe',
    hit: true,
    damage: 3,
    critical: false,
    enemyHealth: 2,
    effects: [{ kind: 'BUFF' }],
  },
  {
    seq: 4,
    type: 'enemyAction',
    enemyRef: 'sombra',
    hit: true,
    damage: 1,
    heroHealth: 39,
    enraged: false,
  },
  {
    seq: 5,
    type: 'heroAction',
    enemyRef: 'sombra',
    action: 'BASIC_ATTACK',
    abilityId: null,
    hit: true,
    damage: 2,
    critical: true,
    enemyHealth: 0,
  },
  { seq: 6, type: 'combatantDefeated', encounter: 1, turn: 2, combatant: 'sombra#1' },
  {
    seq: 7,
    type: 'heroAction',
    enemyRef: 'olvido',
    action: 'BASIC_ATTACK',
    attacked: false,
    hit: false,
    damage: 0,
    critical: false,
    enemyHealth: 9,
  },
  { seq: 8, type: 'heroHealed', amount: 2, heroHealth: 40 },
  { seq: 9, type: 'combatantDefeated', encounter: 1, turn: 3, combatant: 'olvido#1' },
  {
    seq: 10,
    type: 'heroAction',
    enemyRef: 'guardian',
    action: 'BASIC_ATTACK',
    abilityId: null,
    hit: true,
    damage: 20,
    critical: false,
    enemyHealth: 0,
  },
  { seq: 11, type: 'combatantDefeated', encounter: 2, turn: 4, combatant: 'guardian#1' },
  { seq: 12, type: 'simulationFinished', combatOutcome: 'HERO_VICTORIOUS', bossDefeated: true },
  'basura',
  { seq: 13, type: 'tipoDesconocido' },
]

const reveal = (now: Date, options: { finished?: boolean; after?: number } = {}) =>
  revealedProgressOf({
    log: LOG,
    startedAt: START,
    endsAt: END,
    now,
    finished: options.finished ?? false,
    after: options.after ?? 0,
    names: NAMES,
  })

describe('Progreso revelado de una mision (P-J6)', () => {
  it('al empezar solo se ve lo anterior al primer golpe', () => {
    const { entries, nextRevealAt } = reveal(START)

    expect(entries.map((entry) => entry.kind)).toEqual(['ENCOUNTER_STARTED', 'ENEMY_APPEARED'])
    expect(nextRevealAt).toEqual(at(15))
  })

  it('cada turno se revela en su fraccion de la duracion real', () => {
    expect(reveal(at(15)).entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
    expect(reveal(at(30)).entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(reveal(at(59)).entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('el desenlace no se ve antes del final, aunque ya se vean todos los golpes', () => {
    const almost = reveal(new Date(END.getTime() - 1))
    expect(almost.entries.some((entry) => entry.kind === 'MISSION_FINISHED')).toBe(false)

    const done = reveal(END, { finished: true })
    expect(done.entries.at(-1)).toMatchObject({ kind: 'MISSION_FINISHED', victory: true })
    expect(done.nextRevealAt).toBeNull()
    expect(done.total).toBe(13)
  })

  it('`after` devuelve solo lo nuevo', () => {
    expect(reveal(at(30), { after: 4 }).entries.map((entry) => entry.seq)).toEqual([5, 6])
  })

  it('traduce referencias a nombres y marca quien es jefe o Master', () => {
    const entries = reveal(END, { finished: true }).entries
    const bySeq = (seq: number) => entries.find((entry) => entry.seq === seq)

    expect(bySeq(3)).toMatchObject({
      kind: 'HERO_ACTION',
      enemy: 'Sombra Corrompida',
      role: 'ENEMY',
      ability: 'Golpe con escudo',
      attacked: true,
      effects: [{ kind: 'BUFF' }],
      turn: 1,
    })
    expect(bySeq(5)).toMatchObject({ ability: null, critical: true, effects: [] })
    expect(bySeq(7)).toMatchObject({ enemy: 'Sombra del Olvido', role: 'MASTER', attacked: false })
    expect(bySeq(8)).toMatchObject({ kind: 'HERO_HEALED', amount: 2, heroHealth: 40 })
    expect(bySeq(9)).toMatchObject({ kind: 'DEFEATED', enemy: 'Sombra del Olvido', role: 'MASTER' })
    expect(bySeq(11)).toMatchObject({ kind: 'DEFEATED', enemy: 'El Guardián Eterno', role: 'BOSS' })
    expect(bySeq(4)).toMatchObject({
      kind: 'ENEMY_ACTION',
      heroHealth: 39,
      prevented: 0,
      reflected: 0,
    })
  })

  it('porcentaje y tiempo restante los calcula el servidor', () => {
    expect(progressPercentOf(START, END, at(-5))).toBe(0)
    expect(progressPercentOf(START, END, at(30))).toBe(50)
    expect(progressPercentOf(START, END, at(90))).toBe(100)
    expect(progressPercentOf(START, START, START)).toBe(100)
    expect(remainingSecondsOf(END, at(59))).toBe(60)
    expect(remainingSecondsOf(END, at(61))).toBe(0)
  })

  it('lee los nombres de la solicitud y del contenido sin fiarse de su forma', () => {
    const names = progressNamesOf(
      {
        encounters: [{ enemies: [{ enemyRef: 'sombra', name: 'Sombra' }, null] }, 'roto'],
        hero: { profile: { name: 'Kaelen', abilities: [{ abilityId: 'golpe', name: 'Golpe' }] } },
      },
      {
        enemies: [{ enemyRef: 'espectro', name: 'Espectro' }],
        finalBoss: { enemyRef: 'guardian', name: 'Guardián' },
        masterEncounter: { candidates: [{ masterRef: 'olvido', name: 'Olvido' }, 7] },
      },
    )

    expect([...names.enemies]).toEqual([
      ['espectro', 'Espectro'],
      ['sombra', 'Sombra'],
      ['guardian', 'Guardián'],
    ])
    expect(names.masters.get('olvido')).toBe('Olvido')
    expect(names.bossRef).toBe('guardian')
    expect(names.abilities.get('golpe')).toBe('Golpe')
    expect(progressNamesOf(null, null)).toMatchObject({ bossRef: null })
    expect(
      heroOfRequest({ hero: { profile: { name: 'Kaelen', effectiveStats: { health: 40 } } } }),
    ).toEqual({
      name: 'Kaelen',
      maxHealth: 40,
    })
    expect(heroOfRequest(null)).toEqual({ name: null, maxHealth: null })
  })
})
