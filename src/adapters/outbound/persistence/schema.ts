import type { ColumnType } from 'kysely'

import type { DifficultyLevel } from '../../../domain/value-objects/difficulty-level'

/**
 * Esquema de la base de datos del servicio, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Cada migracion que cree o cambie una tabla debe reflejarse
 * aqui en el mismo Pull Request.
 *
 * Nombres de columna en `snake_case`, que es la convencion de PostgreSQL. La
 * traduccion a la instantanea del agregado ocurre en un `mapping.ts` explicito.
 */
export interface Database {
  readonly mission_difficulty_clears: MissionDifficultyClearsTable
}

/**
 * Niveles completados por jugador y mision (HU-75, migracion
 * `001-mission-difficulty-clears`). Un hecho no se actualiza: es lo que
 * desbloquea el nivel siguiente.
 */
export interface MissionDifficultyClearsTable {
  readonly player_id: string
  readonly mission_id: string
  readonly difficulty: DifficultyLevel
  readonly completed_at: ColumnType<Date, Date | string, never>
  readonly created_at: ColumnType<Date, Date | string | undefined, never>
}
