import {
  creditOperationIdOf,
  experienceRewardKey,
  pendingReward,
  rewardCredited,
  rewardDeferred,
  rewardRejected,
  rewardRolled,
  InvalidRewardTransitionError,
  isTerminalReward,
  type ExperienceReward,
} from '../../src/domain/entities/ExperienceReward'
import { DomainError } from '../../src/domain/errors/DomainError'
import { experienceRewardsOf, readCombatLog } from '../../src/domain/policies/CombatLogPolicy'

/**
 * HU-09 (Task HU-09.4): el estado de la recompensa y la lectura de la bitacora.
 *
 * La bitacora es lo unico que identifica QUE derrotas devengan, y llega de otro
 * servicio: aqui se comprueba que se lee entera, en orden, sin inventar lo que no
 * cumple el contrato y sin perder dos derrotas del mismo arquetipo.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')

const event = (encounter: unknown, combatant: unknown): unknown => ({
  seq: 1,
  type: 'combatantDefeated',
  encounter,
  turn: 1,
  combatant,
})

const rewardOf = (enemyInstanceId = 'sombra-corrompida#1'): ExperienceReward =>
  pendingReward({
    enrollmentId: 'enr-01',
    playerId: 'sub-1',
    heroId: 'hero-01',
    simulationId: 'sim-01',
    defeat: {
      encounterId: '1',
      enemyInstanceId,
      rivalRef: enemyInstanceId.split('#')[0] ?? 'rival',
    },
    now: NOW,
  })

describe('HU-09 — lectura de la bitacora de la simulacion', () => {
  it('lee cada baja con su encuentro y su instancia, en el orden de la bitacora', () => {
    const reading = readCombatLog([
      { seq: 1, type: 'encounterStarted', encounter: 1 },
      event(1, 'sombra-corrompida#1'),
      event(1, 'sombra-corrompida#2'),
      event(5, 'guardian-eterno#1'),
      { seq: 5, type: 'encounterFinished', encounter: 1 },
    ])

    expect(reading.invalid).toEqual([])
    expect(reading.defeats).toEqual([
      { encounterId: '1', enemyInstanceId: 'sombra-corrompida#1', rivalRef: 'sombra-corrompida' },
      { encounterId: '1', enemyInstanceId: 'sombra-corrompida#2', rivalRef: 'sombra-corrompida' },
      { encounterId: '5', enemyInstanceId: 'guardian-eterno#1', rivalRef: 'guardian-eterno' },
    ])
  })

  it('DOS derrotas del mismo arquetipo son DOS recompensas, no una', () => {
    const reading = readCombatLog([event(1, 'sombra#1'), event(1, 'sombra#2')])

    expect(reading.defeats).toHaveLength(2)
  })

  it('la misma instancia repetida es la MISMA baja: no se cuenta dos veces', () => {
    const reading = readCombatLog([event(1, 'sombra#1'), event(1, 'sombra#1')])

    expect(reading.defeats).toHaveLength(1)
  })

  it('la misma instancia en OTRO encuentro es otra baja', () => {
    const reading = readCombatLog([event(1, 'sombra#1'), event(2, 'sombra#1')])

    expect(reading.defeats).toHaveLength(2)
  })

  it.each([
    ['sin encuentro', event(undefined, 'sombra#1')],
    ['con encuentro cero', event(0, 'sombra#1')],
    ['con encuentro negativo', event(-1, 'sombra#1')],
    ['con encuentro fraccionario', event(1.5, 'sombra#1')],
    ['con encuentro de texto', event('1', 'sombra#1')],
    ['sin enemigo', event(1, undefined)],
    ['con enemigo vacio', event(1, '   ')],
    ['sin instancia', event(1, 'sombra-corrompida')],
    ['con instancia cero', event(1, 'sombra#0')],
    ['con instancia no numerica', event(1, 'sombra#x')],
    ['con arquetipo vacio', event(1, '#1')],
  ])('descarta una baja %s y lo dice', (_label, broken) => {
    const reading = readCombatLog([broken])

    expect(reading.defeats).toEqual([])
    expect(reading.invalid).toHaveLength(1)
  })

  it('un evento que no es una baja, o que no es un objeto, se ignora en silencio', () => {
    const reading = readCombatLog([
      { seq: 1, type: 'turnAdvanced' },
      'texto',
      null,
      42,
      { seq: 2, type: 'combatantDefeated' },
    ])

    // El ultimo si es una baja declarada, pero sin cuerpo: se descarta y se dice.
    expect(reading.defeats).toEqual([])
    expect(reading.invalid).toHaveLength(1)
  })

  it('una baja ilegible NO impide leer las demas', () => {
    const reading = readCombatLog([
      event(1, 'sombra#1'),
      event(undefined, 'sombra#2'),
      event(2, 'mago#1'),
    ])

    expect(reading.defeats.map((defeat) => defeat.enemyInstanceId)).toEqual(['sombra#1', 'mago#1'])
    expect(reading.invalid).toHaveLength(1)
  })

  it('sin victoria no hay derrotas: una bitacora sin bajas devuelve vacio (CA-08)', () => {
    const reading = readCombatLog([
      { seq: 1, type: 'encounterStarted', encounter: 1 },
      { seq: 2, type: 'simulationFinished', combatOutcome: 'HERO_DEFEATED' },
    ])

    expect(reading.defeats).toEqual([])
    expect(reading.invalid).toEqual([])
  })
})

describe('HU-09 — recompensas PENDING de una mision cerrada', () => {
  it('crea una recompensa PENDING por derrota, sin tirada y sin importe', () => {
    const rewards = experienceRewardsOf({
      enrollmentId: 'enr-01',
      playerId: 'sub-1',
      heroId: 'hero-01',
      simulationId: 'sim-01',
      defeats: readCombatLog([event(1, 'sombra#1'), event(5, 'guardian#1')]).defeats,
      now: NOW,
    })

    expect(rewards).toHaveLength(2)
    expect(rewards[0]).toMatchObject({
      enrollmentId: 'enr-01',
      playerId: 'sub-1',
      heroId: 'hero-01',
      simulationId: 'sim-01',
      status: 'PENDING',
      roll: null,
      amount: null,
      attempts: 0,
      lastError: null,
      creditedAt: null,
    })
    // Nace lista para su primer intento: el barrido selecciona por intento vencido.
    expect(rewards[0]?.nextAttemptAt).toEqual(NOW)
  })

  it('sin derrotas devuelve una lista vacia, que no es un error', () => {
    expect(
      experienceRewardsOf({
        enrollmentId: 'enr-01',
        playerId: 'sub-1',
        heroId: 'hero-01',
        simulationId: 'sim-01',
        defeats: [],
        now: NOW,
      }),
    ).toEqual([])
  })
})

describe('HU-09 — maquina de estados de la recompensa', () => {
  it('la clave es la INSTANCIA de la derrota dentro de la mision', () => {
    expect(experienceRewardKey(rewardOf())).toBe('enr-01::1::sombra-corrompida#1')
  })

  it('la clave de acreditacion es la del contrato', () => {
    expect(creditOperationIdOf(rewardOf())).toBe(
      'mission:enr-01:encounter:1:enemy:sombra-corrompida#1:hero:hero-01:xp',
    )
  })

  it('PENDING -> ROLLED guarda la cara, el importe y la fecha del proximo intento', () => {
    const rolled = rewardRolled(rewardOf(), 5, 25, NOW)

    expect(rolled).toMatchObject({ status: 'ROLLED', roll: 5, amount: 25, nextAttemptAt: NOW })
  })

  it.each([
    ['una cara 0', 0, 12],
    ['una cara 9', 9, 12],
    ['una cara fraccionaria', 2.5, 12],
    ['un importe fraccionario', 5, 12.5],
    ['un importe negativo', 5, -1],
  ])('rechaza %s al guardar la tirada', (_label, roll, amount) => {
    expect(() => rewardRolled(rewardOf(), roll, amount, NOW)).toThrow(DomainError)
  })

  it('ROLLED -> CREDITED es terminal y deja la fecha', () => {
    const credited = rewardCredited(rewardRolled(rewardOf(), 1, 12, NOW), NOW)

    expect(credited).toMatchObject({ status: 'CREDITED', creditedAt: NOW, nextAttemptAt: null })
    expect(isTerminalReward(credited.status)).toBe(true)
  })

  it('una recompensa SIN tirar no se puede acreditar', () => {
    expect(() => rewardCredited(rewardOf(), NOW)).toThrow(InvalidRewardTransitionError)
  })

  it('el rechazo definitivo es terminal y guarda el motivo', () => {
    const rejected = rewardRejected(rewardOf(), 'EXPERIENCE_GRANT_REJECTED')

    expect(rejected).toMatchObject({ status: 'FAILED', lastError: 'EXPERIENCE_GRANT_REJECTED' })
    expect(isTerminalReward(rejected.status)).toBe(true)
  })

  it('el aplazamiento NO cambia el estado y espera un escalonado', () => {
    const deferred = rewardDeferred(rewardOf(), 'HTTP_503', NOW)

    expect(deferred.status).toBe('PENDING')
    expect(deferred.attempts).toBe(1)
    expect(deferred.lastError).toBe('HTTP_503')
    expect(deferred.nextAttemptAt?.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('una recompensa terminal no admite mas transiciones', () => {
    const credited = rewardCredited(rewardRolled(rewardOf(), 1, 12, NOW), NOW)

    expect(() => rewardDeferred(credited, 'HTTP_503', NOW)).toThrow(InvalidRewardTransitionError)
    expect(() => rewardRejected(credited, 'X')).toThrow(InvalidRewardTransitionError)
  })

  it('no muta la recompensa de entrada', () => {
    const pending = rewardOf()
    rewardRolled(pending, 3, 17, NOW)

    expect(pending).toMatchObject({ status: 'PENDING', roll: null, amount: null })
  })

  it.each(['', '   '])('rechaza un identificador en blanco al crear la recompensa: %s', (blank) => {
    expect(() =>
      pendingReward({
        enrollmentId: blank,
        playerId: 'sub-1',
        heroId: 'hero-01',
        simulationId: 'sim-01',
        defeat: { encounterId: '1', enemyInstanceId: 'a#1', rivalRef: 'a' },
        now: NOW,
      }),
    ).toThrow(DomainError)
  })
})
