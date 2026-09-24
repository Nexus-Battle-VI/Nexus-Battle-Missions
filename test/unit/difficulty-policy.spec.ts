import { DomainError } from '../../src/domain/errors/DomainError'
import {
  ProgressionLockedError,
  assertDifficultyUnlocked,
  evaluateAllDifficulties,
  evaluateDifficulty,
} from '../../src/domain/policies/DifficultyPolicy'
import type { DifficultyLevel } from '../../src/domain/value-objects/difficulty-level'

const clears = (...levels: DifficultyLevel[]): ReadonlySet<DifficultyLevel> => new Set(levels)

/**
 * Tabla de decision del diseno de HU-75 (Infrastructure, "Matriz de transicion
 * y aislamiento"), fila por fila. Cada fila bloqueada es el control de una
 * desbloqueada: si la politica aceptara todo, fallarian.
 */
describe('DifficultyPolicy: matriz de transicion (HU-75, CA-02 y CA-03)', () => {
  it.each<[readonly DifficultyLevel[], DifficultyLevel, boolean, DifficultyLevel | null]>([
    [[], 'NORMAL', true, null],
    [[], 'HEROIC', false, 'NORMAL'],
    [[], 'LEGENDARY', false, 'HEROIC'],
    [[], 'MYTHIC', false, 'LEGENDARY'],
    [['NORMAL'], 'HEROIC', true, null],
    [['NORMAL'], 'LEGENDARY', false, 'HEROIC'],
    [['NORMAL', 'HEROIC'], 'LEGENDARY', true, null],
    [['NORMAL', 'HEROIC'], 'MYTHIC', false, 'LEGENDARY'],
    [['NORMAL', 'HEROIC', 'LEGENDARY'], 'MYTHIC', true, null],
    [['NORMAL'], 'NORMAL', true, null],
  ])(
    'completados %j, solicita %s: desbloqueado=%s, falta=%s',
    (done, requested, unlocked, required) => {
      const result = evaluateDifficulty(requested, clears(...done))

      expect(result.difficulty).toBe(requested)
      expect(result.unlocked).toBe(unlocked)
      expect(result.required).toBe(required)
    },
  )

  it('el motivo nombra el nivel inmediatamente inferior, no toda la escalera', () => {
    expect(evaluateDifficulty('LEGENDARY', clears()).lockReason).toBe(
      'Debes completar esta misión en Heroico al menos una vez.',
    )
  })

  it('un nivel desbloqueado no lleva motivo', () => {
    expect(evaluateDifficulty('HEROIC', clears('NORMAL')).lockReason).toBeNull()
  })

  it('solo cuenta el nivel inmediatamente inferior, que es la regla literal de la HU', () => {
    expect(evaluateDifficulty('LEGENDARY', clears('HEROIC')).unlocked).toBe(true)
  })

  it('sin progreso reproduce el primer fixture del contrato, en orden', () => {
    expect(
      evaluateAllDifficulties(clears()).map(({ difficulty, unlocked, lockReason }) => ({
        difficulty,
        unlocked,
        lockReason,
      })),
    ).toEqual([
      { difficulty: 'NORMAL', unlocked: true, lockReason: null },
      {
        difficulty: 'HEROIC',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Normal al menos una vez.',
      },
      {
        difficulty: 'LEGENDARY',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Heroico al menos una vez.',
      },
      {
        difficulty: 'MYTHIC',
        unlocked: false,
        lockReason: 'Debes completar esta misión en Legendario al menos una vez.',
      },
    ])
  })
})

describe('assertDifficultyUnlocked: la validacion que usara la matricula (HU-70)', () => {
  it('rechaza con los datos del 422 del contrato', () => {
    let captured: unknown

    try {
      assertDifficultyUnlocked('msn-1', 'LEGENDARY', clears('NORMAL'))
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(ProgressionLockedError)
    expect(captured).toBeInstanceOf(DomainError)
    expect(captured).toMatchObject({
      missionId: 'msn-1',
      requested: 'LEGENDARY',
      required: 'HEROIC',
      message: 'No puedes iniciar esta misión en Legendario: primero complétala en Heroico.',
    })
  })

  it('no lanza cuando el nivel esta desbloqueado', () => {
    expect(() => {
      assertDifficultyUnlocked('msn-1', 'HEROIC', clears('NORMAL'))
    }).not.toThrow()
  })
})
