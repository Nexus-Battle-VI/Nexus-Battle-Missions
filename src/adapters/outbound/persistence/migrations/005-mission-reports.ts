import { sql, type Kysely } from 'kysely'

/**
 * HU-74 (Task HU-74.2). Reporte e historial de misiones.
 *
 * - `mission_reports`: la foto de cada mision terminada (propuestas P-T1 y
 *   P-T2), creada en la transaccion del cierre de HU-72. La foto va entera en
 *   `snapshot` (jsonb, con su `schema_version`); las columnas sueltas son las que
 *   se consultan. Un disparador impide actualizarla: la inmutabilidad vive en el
 *   motor. Borrarla si se puede, porque la retencion sigue pendiente (decision 6).
 * - `mission_report_rewards`: las lineas de recompensa y su estado, lo unico que
 *   cambia despues del cierre (CU-74.4). Las escribiran HU-10 y HU-73.2.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_reports')
    .addColumn('enrollment_id', 'text', (column) =>
      column.primaryKey().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) => column.notNull())
    .addColumn('category', 'text', (column) => column.notNull())
    .addColumn('difficulty', 'text', (column) => column.notNull())
    .addColumn('outcome', 'text', (column) => column.notNull())
    .addColumn('finished_at', 'timestamptz', (column) => column.notNull())
    .addColumn('schema_version', 'integer', (column) => column.notNull())
    .addColumn('snapshot', 'jsonb', (column) => column.notNull())
    .addColumn('generated_at', 'timestamptz', (column) => column.notNull())
    .addCheckConstraint(
      'mission_reports_desenlace_conocido',
      sql`outcome in ('COMPLETED', 'FAILED', 'ABANDONED')`,
    )
    .addCheckConstraint(
      'mission_reports_categoria_conocida',
      sql`category in ('STORY', 'CHALLENGE', 'EXPLORATION')`,
    )
    .addCheckConstraint(
      'mission_reports_nivel_conocido',
      sql`difficulty in ('NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC')`,
    )
    .addCheckConstraint('mission_reports_version_positiva', sql`schema_version >= 1`)
    .addCheckConstraint('mission_reports_foto_es_objeto', sql`jsonb_typeof(snapshot) = 'object'`)
    .execute()

  // El historial y su resumen leen los reportes de un jugador, del mas reciente al mas antiguo.
  await sql`create index mission_reports_por_jugador
    on mission_reports (player_id, finished_at desc, enrollment_id desc)`.execute(db)

  await sql`create function mission_reports_inmutable() returns trigger language plpgsql as $$
    begin
      raise exception 'mission_reports_inmutable: un reporte de mision no se modifica (HU-74, P-T2)';
    end
  $$`.execute(db)
  await sql`create trigger mission_reports_sin_cambios before update on mission_reports
    for each row execute function mission_reports_inmutable()`.execute(db)

  await db.schema
    .createTable('mission_report_rewards')
    .addColumn('enrollment_id', 'text', (column) =>
      column.notNull().references('mission_reports.enrollment_id'),
    )
    .addColumn('line_no', 'integer', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('reference', 'text')
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('rarity', 'text')
    .addColumn('quantity', 'integer', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('source', 'text', (column) => column.notNull())
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull())
    .addPrimaryKeyConstraint('mission_report_rewards_pk', ['enrollment_id', 'line_no'])
    .addCheckConstraint('mission_report_rewards_linea_positiva', sql`line_no >= 1`)
    .addCheckConstraint(
      'mission_report_rewards_tipo_conocido',
      sql`kind in ('CREDITS', 'PRODUCT', 'EPIC', 'EXPERIENCE')`,
    )
    .addCheckConstraint('mission_report_rewards_cantidad_positiva', sql`quantity >= 1`)
    .addCheckConstraint(
      'mission_report_rewards_estado_conocido',
      sql`status in ('PENDING', 'CREDITED', 'FAILED')`,
    )
    .addCheckConstraint('mission_report_rewards_origen_conocido', sql`source in ('HU-10', 'HU-73')`)
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_report_rewards').execute()
  // Borrar la tabla borra tambien su disparador.
  await db.schema.dropTable('mission_reports').execute()
  await sql`drop function mission_reports_inmutable()`.execute(db)
}
