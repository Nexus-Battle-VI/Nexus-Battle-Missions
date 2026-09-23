import { DomainError } from '../../src/domain/errors/DomainError'
import {
  DIFFICULTY_LEVELS,
  UnknownDifficultyError,
  displayNameOf,
  isDifficultyLevel,
  parseDifficultyLevel,
  previousLevelOf,
} from '../../src/domain/value-objects/difficulty-level'

describe('DifficultyLevel (HU-75, RF-75)', () => {
  it('el vocabulario es cerrado y su orden es el orden de desbloqueo', () => {
    expect(DIFFICULTY_LEVELS).toEqual(['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC'])
  })

  it.each([
    ['NORMAL', null],
    ['HEROIC', 'NORMAL'],
    ['LEGENDARY', 'HEROIC'],
    ['MYTHIC', 'LEGENDARY'],
  ] as const)('%s exige haber completado antes %s', (level, previous) => {
    expect(previousLevelOf(level)).toBe(previous)
  })

  it.each([...DIFFICULTY_LEVELS])('acepta %s', (level) => {
    expect(isDifficultyLevel(level)).toBe(true)
    expect(parseDifficultyLevel(level)).toBe(level)
  })

  // Control: la escala del filtro del tablon (7.8.9 del curso) no es la de
  // progresion, y la comparacion distingue mayusculas.
  it.each(['EASY', 'HARD', 'EXTREME', 'FACIL', 'normal', ''])('rechaza %p', (value) => {
    expect(isDifficultyLevel(value)).toBe(false)
    expect(() => parseDifficultyLevel(value)).toThrow(UnknownDifficultyError)
  })

  it('el rechazo es un error de dominio y no devuelve el valor recibido en el mensaje', () => {
    let captured: unknown

    try {
      parseDifficultyLevel('<script>')
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(UnknownDifficultyError)
    expect(captured).toBeInstanceOf(DomainError)
    expect((captured as UnknownDifficultyError).received).toBe('<script>')
    expect((captured as UnknownDifficultyError).message).not.toContain('<script>')
  })

  it('los nombres que ve el jugador estan en espanol', () => {
    expect(DIFFICULTY_LEVELS.map(displayNameOf)).toEqual([
      'Normal',
      'Heroico',
      'Legendario',
      'Mítico',
    ])
  })
})
