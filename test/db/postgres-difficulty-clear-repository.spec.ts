import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql, type Kysely } from 'kysely'

import { PostgresDifficultyClearRepository } from '../../src/adapters/outbound/persistence/PostgresDifficultyClearRepository'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'

/**
 * PostgreSQL REAL (Task HU-75.2). Lo que se prueba aqui no se puede probar con
 * el doble en memoria: que las dos invariantes del diseno viven en el MOTOR
 * (clave primaria compuesta y CHECK del vocabulario) y que el registro sigue
 * siendo idempotente con escrituras concurrentes.
 */
describe('PostgresDifficultyClearRepository (HU-75)', () => {
  let container: StartedPostgreSqlContainer
  let db: Kysely<Database>
  let repository: PostgresDifficultyClearRepository

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start()
    db = createDatabase({ connectionString: container.getConnectionUri() })
    const outcome = await migrateToLatest(db)
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error('La migracion fallo.')
    }
    repository = new PostgresDifficultyClearRepository(db)
  }, 120_000)

  afterAll(async () => {
    await db.destroy()
    await container.stop()
  })

  const AT = new Date('2026-09-22T15:00:00.000Z')

  const rowsOf = async (playerId: string) => {
    const { rows } = await sql<{ difficulty: string; completed_at: Date }>`
      select difficulty, completed_at from mission_difficulty_clears
      where player_id = ${playerId} order by difficulty
    `.execute(db)

    return rows
  }

  it('un jugador sin hechos no tiene niveles completados', async () => {
    expect([...(await repository.clearedLevels('pg-nuevo', 'msn-1'))]).toEqual([])
  })

  it('devuelve el nivel solo para ese jugador y esa mision', async () => {
    await expect(
      repository.record({
        playerId: 'pg-1',
        missionId: 'msn-1',
        difficulty: 'NORMAL',
        completedAt: AT,
      }),
    ).resolves.toBe(true)

    expect([...(await repository.clearedLevels('pg-1', 'msn-1'))]).toEqual(['NORMAL'])
    expect([...(await repository.clearedLevels('pg-1', 'msn-2'))]).toEqual([])
    expect([...(await repository.clearedLevels('pg-2', 'msn-1'))]).toEqual([])
  })

  it('repetir el mismo hecho no lo duplica y conserva la fecha del primero', async () => {
    const first = {
      playerId: 'pg-3',
      missionId: 'msn-1',
      difficulty: 'HEROIC',
      completedAt: AT,
    } as const

    await expect(repository.record(first)).resolves.toBe(true)
    await expect(
      repository.record({ ...first, completedAt: new Date('2026-09-23T10:00:00.000Z') }),
    ).resolves.toBe(false)

    expect(await rowsOf('pg-3')).toEqual([{ difficulty: 'HEROIC', completed_at: AT }])
  })

  it('tres registros simultaneos del mismo hecho dejan una fila y un solo true', async () => {
    const clear = {
      playerId: 'pg-4',
      missionId: 'msn-1',
      difficulty: 'NORMAL',
      completedAt: AT,
    } as const

    const results = await Promise.all([
      repository.record(clear),
      repository.record(clear),
      repository.record(clear),
    ])

    expect(results.filter((applied) => applied)).toHaveLength(1)
    expect(await rowsOf('pg-4')).toHaveLength(1)
  })

  // Controles de motor: se escribe con SQL crudo, saltandose el repositorio, para
  // demostrar que la base rechaza lo invalido aunque la aplicacion fallara.
  it('el motor rechaza un nivel fuera del vocabulario (CHECK)', async () => {
    await expect(
      sql`
        insert into mission_difficulty_clears (player_id, mission_id, difficulty, completed_at)
        values (${'pg-5'}, ${'msn-1'}, ${'EASY'}, now())
      `.execute(db),
    ).rejects.toThrow(/mission_difficulty_clears_nivel_conocido/)
  })

  it('el motor rechaza el mismo hecho duplicado sin on conflict (clave primaria)', async () => {
    const insert = () => sql`
      insert into mission_difficulty_clears (player_id, mission_id, difficulty, completed_at)
      values (${'pg-6'}, ${'msn-1'}, ${'NORMAL'}, now())
    `

    await insert().execute(db)

    await expect(insert().execute(db)).rejects.toThrow(/mission_difficulty_clears_pk/)
  })
})
