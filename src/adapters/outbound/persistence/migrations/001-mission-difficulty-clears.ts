import { sql, type Kysely } from 'kysely'

/**
 * HU-75 (Task HU-75.2). Primera tabla de negocio de Missions: el andamiaje no
 * creaba ninguna.
 *
 * Un hecho por jugador, mision y nivel completado. Las dos invariantes del
 * diseno viven en el MOTOR, no solo en el codigo:
 *
 * - la clave primaria compuesta impide registrar dos veces el mismo nivel del
 *   mismo jugador en la misma mision;
 * - el CHECK impide persistir un nivel fuera del vocabulario aunque la
 *   aplicacion tuviera un error.
 *
 * La clave primaria empieza por `player_id, mission_id`, que es exactamente la
 * consulta de desbloqueo: no hace falta un indice adicional.
 *
 * Sin claves foraneas: `player_id` es el `sub` del proveedor de identidad
 * (ADR-005) y el tablon de misiones todavia no existe (HU-70).
 *
 * `up` y `down` reciben `Kysely<unknown>` a proposito: una migracion no debe
 * tipar contra el esquema actual, o dejaria de compilar en cuanto una migracion
 * posterior cambiara la tabla.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_difficulty_clears')
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) => column.notNull())
    .addColumn('difficulty', 'text', (column) => column.notNull())
    .addColumn('completed_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('mission_difficulty_clears_pk', [
      'player_id',
      'mission_id',
      'difficulty',
    ])
    .addCheckConstraint(
      'mission_difficulty_clears_nivel_conocido',
      sql`difficulty in ('NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC')`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_difficulty_clears').execute()
}
