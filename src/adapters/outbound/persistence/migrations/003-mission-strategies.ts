import { sql, type Kysely } from 'kysely'

/**
 * HU-71 (Task HU-71.2). Estrategias guardadas y su copia congelada en la
 * matricula.
 *
 * - `mission_strategies`: una estrategia por jugador, heroe y mision (propuesta
 *   P-R1), con `version` para el bloqueo optimista. El CHECK admite entre 1 y 3
 *   rotaciones (CA-04): ni una base manipulada a mano guarda una cuarta.
 * - `mission_enrollments.rotations`: la copia que la matricula congela y que
 *   recibira la simulacion. Vacia solo si el jugador no tenia estrategia
 *   (propuesta P-R9), y en ese caso sin `strategy_version`.
 *
 * Los CHECK usan `case` porque `jsonb_array_length` falla con algo que no sea un
 * arreglo, y PostgreSQL no garantiza el orden de evaluacion de un `and`.
 *
 * `player_id` y `hero_id` no son claves foraneas: son del proveedor de identidad
 * y de Player/Inventory (ADR-005).
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_strategies')
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('hero_id', 'uuid', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) =>
      column.notNull().references('mission_definitions.mission_id'),
    )
    .addColumn('rotations', 'jsonb', (column) => column.notNull())
    .addColumn('version', 'integer', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('mission_strategies_pk', ['player_id', 'hero_id', 'mission_id'])
    .addCheckConstraint('mission_strategies_version_positiva', sql`version >= 1`)
    .addCheckConstraint(
      'mission_strategies_entre_una_y_tres',
      sql`case when jsonb_typeof(rotations) = 'array'
        then jsonb_array_length(rotations) between 1 and 3
        else false end`,
    )
    .execute()

  await db.schema
    .alterTable('mission_enrollments')
    .addColumn('rotations', 'jsonb', (column) => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute()

  await sql`alter table mission_enrollments
    add constraint mission_enrollments_estrategia_congelada check (
      case when jsonb_typeof(rotations) = 'array'
        then jsonb_array_length(rotations) <= 3
          and (strategy_version is null) = (jsonb_array_length(rotations) = 0)
        else false end
    )`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('mission_enrollments')
    .dropConstraint('mission_enrollments_estrategia_congelada')
    .execute()
  await db.schema.alterTable('mission_enrollments').dropColumn('rotations').execute()
  await db.schema.dropTable('mission_strategies').execute()
}
