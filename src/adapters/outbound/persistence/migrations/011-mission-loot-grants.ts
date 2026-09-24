import { sql, type Kysely } from 'kysely'

/**
 * Entrega del botin del jefe (diseno «misiones jugables», P-J1). Hasta aqui el
 * reporte mostraba el botin y nada lo entregaba. Cada botin ganado tiene su linea
 * `PRODUCT` en el reporte, con origen `HU-72`, y su entrega en esta tabla: la
 * escribe el cierre y despues solo cambia la entrega, como la epica de HU-73.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_origen_conocido`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_origen_conocido
    check (source in ('HU-10', 'HU-73', 'HU-09', 'HU-72'))`.execute(db)

  await db.schema
    .createTable('mission_loot_grants')
    .addColumn('enrollment_id', 'text', (column) => column.notNull())
    .addColumn('line_no', 'integer', (column) => column.notNull())
    .addColumn('label', 'text', (column) => column.notNull())
    .addColumn('quantity', 'integer', (column) => column.notNull())
    .addColumn('operation_id', 'uuid', (column) => column.notNull().unique())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('granted_at', 'timestamptz')
    .addColumn('product_id', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('mission_loot_grants_pk', ['enrollment_id', 'line_no'])
    // La entrega refleja una linea del reporte: sin reporte no hay entrega.
    .addForeignKeyConstraint(
      'mission_loot_grants_linea_del_reporte',
      ['enrollment_id', 'line_no'],
      'mission_report_rewards',
      ['enrollment_id', 'line_no'],
    )
    .addCheckConstraint(
      'mission_loot_grants_estado_conocido',
      sql`status in ('PENDING', 'GRANTED', 'REJECTED')`,
    )
    .addCheckConstraint('mission_loot_grants_cantidad_positiva', sql`quantity >= 1`)
    .addCheckConstraint('mission_loot_grants_intentos_no_negativos', sql`attempts >= 0`)
    .addCheckConstraint(
      'mission_loot_grants_fecha_al_entregar',
      sql`(status = 'GRANTED') = (granted_at is not null)`,
    )
    .addCheckConstraint(
      'mission_loot_grants_producto_al_entregar',
      sql`status <> 'GRANTED' or product_id is not null`,
    )
    .execute()

  await sql`create index mission_loot_grants_por_entregar
    on mission_loot_grants (next_attempt_at) where status = 'PENDING'`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_loot_grants').execute()
  await sql`delete from mission_report_rewards where source = 'HU-72'`.execute(db)
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_origen_conocido`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_origen_conocido
    check (source in ('HU-10', 'HU-73', 'HU-09'))`.execute(db)
}
