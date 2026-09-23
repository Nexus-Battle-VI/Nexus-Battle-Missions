import type { Kysely } from 'kysely'

import type { DifficultyClearRepositoryPort } from '../../../application/ports/DifficultyClearRepositoryPort'
import type { MissionDifficultyClear } from '../../../domain/entities/MissionDifficultyClear'
import type { DifficultyLevel } from '../../../domain/value-objects/difficulty-level'
import type { Database } from './schema'

/**
 * PostgreSQL es la unica fuente de verdad del progreso de dificultad (ADR-019).
 *
 * La idempotencia del registro no depende de leer antes de escribir: la clave
 * primaria compuesta y `on conflict do nothing` la resuelven en una sola
 * sentencia, tambien bajo concurrencia. Dos registros simultaneos del mismo
 * hecho dejan una fila y un solo `true`, y conservan la fecha del primero.
 */
export class PostgresDifficultyClearRepository implements DifficultyClearRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async clearedLevels(playerId: string, missionId: string): Promise<ReadonlySet<DifficultyLevel>> {
    const rows = await this.db
      .selectFrom('mission_difficulty_clears')
      .select('difficulty')
      .where('player_id', '=', playerId)
      .where('mission_id', '=', missionId)
      .execute()

    return new Set(rows.map((row) => row.difficulty))
  }

  async completedMissions(playerId: string): Promise<ReadonlySet<string>> {
    // La clave primaria empieza por `player_id`: la consulta usa su indice.
    const rows = await this.db
      .selectFrom('mission_difficulty_clears')
      .select('mission_id')
      .distinct()
      .where('player_id', '=', playerId)
      .execute()

    return new Set(rows.map((row) => row.mission_id))
  }

  async record(clear: MissionDifficultyClear): Promise<boolean> {
    const inserted = await this.db
      .insertInto('mission_difficulty_clears')
      .values({
        player_id: clear.playerId,
        mission_id: clear.missionId,
        difficulty: clear.difficulty,
        completed_at: clear.completedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(['player_id', 'mission_id', 'difficulty']).doNothing(),
      )
      .returning('player_id')
      .executeTakeFirst()

    return inserted !== undefined
  }
}
