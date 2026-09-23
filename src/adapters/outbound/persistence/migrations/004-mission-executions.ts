import { sql, type Kysely } from 'kysely'

const PREVIOUS_ENROLLMENT_STATUSES = sql`status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED', 'REJECTED', 'EXPIRED')`

/**
 * HU-72 (Task HU-72.2). Ejecucion de la simulacion y cierre de la mision.
 *
 * - `mission_enrollments` admite `VOIDED`: la anulacion tecnica (propuesta P-S7).
 * - `mission_executions`: una por matricula (P-S2), con su `operation_id` hacia
 *   Combat, la solicitud congelada, el resultado sellado y el cierre. Los CHECK
 *   impiden un estado que no cuadra: un resultado sin resumen o sin bitacora, un
 *   cierre sin desenlace, o un heroe liberado de una mision sin cerrar.
 * - `mission_facts_por_procesar`: los hechos que el planificador aun no consumio.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`alter table mission_enrollments drop constraint mission_enrollments_estado_conocido`.execute(
    db,
  )
  await sql`alter table mission_enrollments add constraint mission_enrollments_estado_conocido
    check (status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED', 'REJECTED', 'EXPIRED', 'VOIDED'))`.execute(
    db,
  )

  await db.schema
    .createTable('mission_executions')
    .addColumn('enrollment_id', 'text', (column) =>
      column.primaryKey().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('deadline_at', 'timestamptz', (column) => column.notNull())
    .addColumn('request', 'jsonb')
    .addColumn('last_error', 'text')
    .addColumn('simulation_id', 'text')
    .addColumn('seed_ref', 'text')
    .addColumn('combat_outcome', 'text')
    .addColumn('summary', 'jsonb')
    .addColumn('combat_log', 'jsonb')
    .addColumn('simulated_at', 'timestamptz')
    .addColumn('outcome', 'text')
    .addColumn('outcome_reason', 'text')
    .addColumn('objectives', 'jsonb')
    .addColumn('settled_at', 'timestamptz')
    .addColumn('hero_released_at', 'timestamptz')
    .addColumn('version', 'integer', (column) => column.notNull().defaultTo(0))
    .addCheckConstraint(
      'mission_executions_estado_conocido',
      sql`status in ('QUEUED', 'REQUESTED', 'SIMULATED', 'SETTLED', 'VOIDED')`,
    )
    .addCheckConstraint(
      'mission_executions_resultado_conocido',
      sql`combat_outcome is null or combat_outcome in ('HERO_VICTORIOUS', 'HERO_DEFEATED', 'TIME_BUDGET_EXHAUSTED')`,
    )
    .addCheckConstraint(
      'mission_executions_desenlace_conocido',
      sql`outcome is null or outcome in ('COMPLETED', 'FAILED', 'VOIDED')`,
    )
    .addCheckConstraint(
      'mission_executions_solicitud_enviada',
      sql`status <> 'REQUESTED' or request is not null`,
    )
    .addCheckConstraint(
      'mission_executions_resultado_sellado',
      sql`status not in ('SIMULATED', 'SETTLED') or (simulation_id is not null
        and combat_outcome is not null and summary is not null and combat_log is not null
        and simulated_at is not null)`,
    )
    .addCheckConstraint(
      'mission_executions_cierre_completo',
      sql`status not in ('SETTLED', 'VOIDED') or (outcome is not null and settled_at is not null)`,
    )
    .addCheckConstraint(
      'mission_executions_liberacion_tras_cierre',
      sql`hero_released_at is null or status in ('SETTLED', 'VOIDED')`,
    )
    .execute()

  // El planificador busca las vencidas, las que ya pueden cerrarse y las que
  // aun deben liberar al heroe. Para cerrar tambien usa
  // `mission_enrollments_vencimiento`, de la migracion 002.
  await sql`create index mission_executions_pendientes
    on mission_executions (next_attempt_at) where status in ('QUEUED', 'REQUESTED')`.execute(db)
  await sql`create index mission_executions_por_cerrar
    on mission_executions (enrollment_id) where status = 'SIMULATED'`.execute(db)
  await sql`create index mission_executions_por_liberar
    on mission_executions (settled_at) where status in ('SETTLED', 'VOIDED') and hero_released_at is null`.execute(
    db,
  )
  await sql`create index mission_facts_por_procesar
    on mission_facts (type, fact_id) where processed_at is null`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`drop index mission_facts_por_procesar`.execute(db)
  await db.schema.dropTable('mission_executions').execute()
  await sql`alter table mission_enrollments drop constraint mission_enrollments_estado_conocido`.execute(
    db,
  )
  await sql`alter table mission_enrollments add constraint mission_enrollments_estado_conocido
    check (${PREVIOUS_ENROLLMENT_STATUSES})`.execute(db)
}
