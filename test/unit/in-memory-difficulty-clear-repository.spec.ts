import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'

const AT = new Date('2026-09-22T15:00:00.000Z')

describe('InMemoryDifficultyClearRepository', () => {
  it('un jugador sin hechos no tiene niveles completados', async () => {
    const repository = new InMemoryDifficultyClearRepository()

    expect([...(await repository.clearedLevels('jugador', 'mision'))]).toEqual([])
  })

  it('registra un hecho nuevo y avisa cuando se repite, sin duplicarlo', async () => {
    const repository = new InMemoryDifficultyClearRepository()
    const clear = {
      playerId: 'jugador',
      missionId: 'mision',
      difficulty: 'NORMAL',
      completedAt: AT,
    } as const

    await expect(repository.record(clear)).resolves.toBe(true)
    await expect(repository.record(clear)).resolves.toBe(false)
    expect([...(await repository.clearedLevels('jugador', 'mision'))]).toEqual(['NORMAL'])
  })

  // Control del comentario del adaptador: con una clave "jugador:mision" estos
  // dos hechos distintos colisionarian y el segundo se perderia.
  it('identificadores con separadores no colisionan entre si', async () => {
    const repository = new InMemoryDifficultyClearRepository()

    await expect(
      repository.record({ playerId: 'a:b', missionId: 'c', difficulty: 'NORMAL', completedAt: AT }),
    ).resolves.toBe(true)
    await expect(
      repository.record({ playerId: 'a', missionId: 'b:c', difficulty: 'NORMAL', completedAt: AT }),
    ).resolves.toBe(true)

    expect([...(await repository.clearedLevels('a:b', 'c'))]).toEqual(['NORMAL'])
    expect([...(await repository.clearedLevels('a', 'b:c'))]).toEqual(['NORMAL'])
    expect([...(await repository.clearedLevels('a', 'b'))]).toEqual([])
  })
})
