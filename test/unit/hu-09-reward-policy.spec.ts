import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { DomainError } from '../../src/domain/errors/DomainError'
import {
  EXPERIENCE_REWARD_BASE,
  EXPERIENCE_REWARD_GROWTH,
  EXPERIENCE_ROLL_FACES,
  defeatKeyOf,
  experienceCreditOperationId,
  experienceForRoll,
  experienceRollsOperationId,
  isExperienceRoll,
} from '../../src/domain/policies/ExperienceRewardPolicy'

/**
 * HU-09 (Task HU-09.4): la formula `10 x 1,2^(1d8)` de la recompensa de
 * experiencia por derrota de un NPC (`hu-09-experience-reward-v1` §6).
 *
 * Es la UNICA implementacion de la formula en el sistema: Combat devuelve la
 * cara del dado y Player/Inventory recibe el importe calculado, asi que estos
 * ocho valores son el contrato entero de la recompensa.
 */
describe('HU-09 — formula de la experiencia por derrota', () => {
  it('el dado tiene 8 caras y la formula usa la base 10 con razon 1,2', () => {
    expect(EXPERIENCE_ROLL_FACES).toBe(8)
    expect(EXPERIENCE_REWARD_BASE).toBe(10)
    expect(EXPERIENCE_REWARD_GROWTH).toBe(1.2)
  })

  it.each([
    [1, 12],
    [2, 14],
    [3, 17],
    [4, 21],
    [5, 25],
    [6, 30],
    [7, 36],
    [8, 43],
  ])('la cara %i otorga %i de experiencia', (roll, expected) => {
    expect(experienceForRoll(roll)).toBe(expected)
  })

  it('los ocho valores son EXACTAMENTE los del contrato', () => {
    const valores = [1, 2, 3, 4, 5, 6, 7, 8].map((roll) => experienceForRoll(roll))

    expect(valores).toEqual([12, 14, 17, 21, 25, 30, 36, 43])
  })

  it('el importe es SIEMPRE entero: se redondea antes de cruzar la frontera', () => {
    for (const roll of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(Number.isInteger(experienceForRoll(roll))).toBe(true)
    }
  })

  it('es una funcion pura: la misma cara da siempre el mismo importe', () => {
    expect(experienceForRoll(5)).toBe(experienceForRoll(5))
    expect(experienceForRoll(8)).toBe(43)
  })

  it.each([0, 9, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rechaza una cara fuera de 1..8: %s',
    (roll) => {
      expect(() => experienceForRoll(roll)).toThrow(DomainError)
    },
  )

  it.each([undefined, null, '3', {}, []])(
    'rechaza una cara que no es un numero entero: %s',
    (roll) => {
      expect(() => experienceForRoll(roll)).toThrow(DomainError)
    },
  )

  it('`isExperienceRoll` acepta solo las ocho caras', () => {
    for (const roll of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(isExperienceRoll(roll)).toBe(true)
    }

    for (const roll of [0, 9, 1.5, '1', null, undefined]) {
      expect(isExperienceRoll(roll)).toBe(false)
    }
  })

  it('la interpretacion del redondeo esta escrita: al mas proximo, no truncamiento', () => {
    // `P-2` sigue abierto en el contrato. Si algun dia se confirma el
    // truncamiento, esta prueba es la que cambia -- y solo esta.
    expect(experienceForRoll(4)).toBe(21)
    expect(experienceForRoll(8)).toBe(43)
  })
})

describe('HU-09 — claves deterministas', () => {
  it('el lote de tiradas de una mision usa el operationId del contrato', () => {
    expect(experienceRollsOperationId('enr_01JB8Y3K7Q')).toBe('mission:enr_01JB8Y3K7Q:xp-rolls')
  })

  it('la acreditacion de una derrota usa la INSTANCIA, no el arquetipo', () => {
    expect(
      experienceCreditOperationId({
        enrollmentId: 'enr_01JB8Y3K7Q',
        encounterId: '5',
        enemyInstanceId: 'guardian-eterno#1',
        heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
      }),
    ).toBe(
      'mission:enr_01JB8Y3K7Q:encounter:5:enemy:guardian-eterno#1:hero:7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60:xp',
    )
  })

  it('dos instancias del mismo arquetipo tienen claves distintas', () => {
    const base = {
      enrollmentId: 'enr-1',
      encounterId: '1',
      heroId: 'hero-1',
    }

    expect(experienceCreditOperationId({ ...base, enemyInstanceId: 'sombra#1' })).not.toBe(
      experienceCreditOperationId({ ...base, enemyInstanceId: 'sombra#2' }),
    )
  })

  it('la misma derrota acreditada a OTRO heroe es otra acreditacion', () => {
    const base = { enrollmentId: 'enr-1', encounterId: '1', enemyInstanceId: 'sombra#1' }

    expect(experienceCreditOperationId({ ...base, heroId: 'hero-1' })).not.toBe(
      experienceCreditOperationId({ ...base, heroId: 'hero-2' }),
    )
  })

  it.each([
    ['matriculacion', { enrollmentId: '' }],
    ['encuentro', { encounterId: '  ' }],
    ['enemigo', { enemyInstanceId: '' }],
    ['heroe', { heroId: '' }],
  ])('rechaza una clave con %s en blanco', (_label, overrides) => {
    expect(() =>
      experienceCreditOperationId({
        enrollmentId: 'enr-1',
        encounterId: '1',
        enemyInstanceId: 'sombra#1',
        heroId: 'hero-1',
        ...overrides,
      }),
    ).toThrow(DomainError)
  })

  it('rechaza un lote sin matriculacion', () => {
    expect(() => experienceRollsOperationId('')).toThrow(DomainError)
  })

  it('la clave de la derrota es encuentro + instancia', () => {
    expect(defeatKeyOf({ encounterId: '1', enemyInstanceId: 'sombra#1' })).toBe('1:sombra#1')
    expect(defeatKeyOf({ encounterId: '1', enemyInstanceId: 'sombra#1' })).not.toBe(
      defeatKeyOf({ encounterId: '1', enemyInstanceId: 'sombra#2' }),
    )
  })
})

/**
 * Guarda estatica: la formula existe UNA vez.
 *
 * El contrato lo exige de forma explicita -- "el dueno unico de la formula es
 * Missions, y no se reproduce en Combat ni en Player/Inventory" -- y la unica
 * forma de que una copia futura falle es mirar el codigo fuente.
 */
describe('HU-09 — la formula no se duplica', () => {
  const ROOT = join(__dirname, '..', '..', 'src')
  const POLICY = 'domain/policies/ExperienceRewardPolicy.ts'

  const sourceFiles = (directory: string): readonly string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)

      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith('.ts') ? [path] : []
    })

  const relative = (file: string): string => file.slice(ROOT.length + 1).replaceAll('\\', '/')

  const codeOf = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('la base, la razon y el redondeo solo aparecen en la politica', () => {
    const files = sourceFiles(ROOT)
      .filter((file) =>
        /EXPERIENCE_REWARD_BASE|EXPERIENCE_REWARD_GROWTH|1\.2\s*\*\*/.test(codeOf(file)),
      )
      .map(relative)

    expect(files).toEqual([POLICY])
  })

  it('nadie escribe la expresion literal `10 x 1,2^n`, ni siquiera la politica', () => {
    const files = sourceFiles(ROOT)
      .filter((file) => /10\s*\*\s*1\.2|1\.2\s*\*\s*10/.test(codeOf(file)))
      .map(relative)

    // La politica usa las constantes con nombre; el literal no aparece en ningun
    // sitio, y esa es justamente la forma de que no se copie a mano.
    expect(files).toEqual([])
  })

  it('el calculo se pide a `experienceForRoll`, no se copia', () => {
    const consumers = sourceFiles(ROOT)
      .filter((file) => /experienceForRoll/.test(codeOf(file)))
      .map(relative)

    // La politica que lo define y el caso de uso que lo consume.
    expect(consumers.sort()).toEqual(
      ['application/use-cases/CoordinateExperienceReward.ts', POLICY].sort(),
    )
  })
})
