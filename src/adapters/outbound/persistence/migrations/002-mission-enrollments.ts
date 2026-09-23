import { sql, type Kysely } from 'kysely'

/**
 * HU-70 (Task HU-70.2). Tablon, matriculas y hechos internos.
 *
 * Las invariantes del diseno viven en el MOTOR, no solo en el codigo:
 *
 * - `mission_enrollments_heroe_activo`: un heroe no esta en dos matriculas
 *   activas (ADR-019, CA-02). Indice unico PARCIAL: una matricula terminada no
 *   ocupa al heroe.
 * - `mission_enrollments_jugador_mision_activa`: una matricula activa por
 *   jugador y mision (propuesta P-M2).
 * - `mission_enrollments_clave_idempotencia`: una clave por jugador (P-M3).
 * - `operation_id` unico: es la clave de la reserva en Player/Inventory.
 * - Los CHECK impiden persistir un estado, una dificultad o una categoria fuera
 *   del vocabulario, y una matricula EN CURSO sin inicio, fin o compromiso.
 * - `mission_facts_un_hecho_por_tipo`: un hecho por tipo y matricula, aunque la
 *   transicion se reintente.
 *
 * `player_id` es el `sub` del proveedor de identidad y `hero_id` el UUID del
 * heroe en Player/Inventory: ninguno es clave foranea (ADR-005).
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_definitions')
    .addColumn('mission_id', 'text', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('category', 'text', (column) => column.notNull())
    .addColumn('summary', 'text', (column) => column.notNull())
    .addColumn('narrative', 'text', (column) => column.notNull())
    .addColumn('image_ref', 'text')
    .addColumn('estimated_duration_minutes', 'integer', (column) => column.notNull())
    .addColumn('recommended_power', 'integer')
    .addColumn('prerequisites', sql`text[]`, (column) => column.notNull().defaultTo(sql`'{}'`))
    // Objetivos, enemigos, jefe, Master y recompensas: contenido que se lee
    // entero y no se consulta por partes.
    .addColumn('content', 'jsonb', (column) => column.notNull())
    .addColumn('active', 'boolean', (column) => column.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'mission_definitions_categoria_conocida',
      sql`category in ('STORY', 'CHALLENGE', 'EXPLORATION')`,
    )
    .addCheckConstraint(
      'mission_definitions_duracion_positiva',
      sql`estimated_duration_minutes > 0`,
    )
    .execute()

  await db.schema
    .createTable('mission_enrollments')
    .addColumn('enrollment_id', 'text', (column) => column.primaryKey())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) =>
      column.notNull().references('mission_definitions.mission_id'),
    )
    .addColumn('hero_id', 'uuid', (column) => column.notNull())
    .addColumn('difficulty', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('idempotency_key', 'text', (column) => column.notNull())
    .addColumn('request_fingerprint', 'text', (column) => column.notNull())
    .addColumn('strategy_version', 'integer')
    .addColumn('commitment_id', 'text')
    .addColumn('rejection', 'jsonb')
    .addColumn('requested_at', 'timestamptz', (column) => column.notNull())
    .addColumn('started_at', 'timestamptz')
    .addColumn('ends_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('version', 'integer', (column) => column.notNull().defaultTo(0))
    .addUniqueConstraint('mission_enrollments_clave_idempotencia', ['player_id', 'idempotency_key'])
    .addCheckConstraint(
      'mission_enrollments_estado_conocido',
      sql`status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED', 'REJECTED', 'EXPIRED')`,
    )
    .addCheckConstraint(
      'mission_enrollments_nivel_conocido',
      sql`difficulty in ('NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC')`,
    )
    .addCheckConstraint(
      'mission_enrollments_en_curso_completa',
      sql`status <> 'IN_PROGRESS' or (started_at is not null and ends_at > started_at and commitment_id is not null)`,
    )
    .addCheckConstraint(
      'mission_enrollments_rechazo_con_motivo',
      sql`status <> 'REJECTED' or rejection is not null`,
    )
    .execute()

  await sql`create unique index mission_enrollments_heroe_activo
    on mission_enrollments (hero_id) where status in ('PENDING', 'IN_PROGRESS')`.execute(db)
  await sql`create unique index mission_enrollments_jugador_mision_activa
    on mission_enrollments (player_id, mission_id) where status in ('PENDING', 'IN_PROGRESS')`.execute(
    db,
  )
  // El tablon lee todas las matriculas de un jugador; el reconciliador, las
  // pendientes mas viejas; HU-72, las que vencen.
  await sql`create index mission_enrollments_por_jugador on mission_enrollments (player_id)`.execute(
    db,
  )
  await sql`create index mission_enrollments_pendientes
    on mission_enrollments (requested_at) where status = 'PENDING'`.execute(db)
  await sql`create index mission_enrollments_vencimiento
    on mission_enrollments (ends_at) where status = 'IN_PROGRESS'`.execute(db)

  await db.schema
    .createTable('mission_facts')
    .addColumn('fact_id', 'bigserial', (column) => column.primaryKey())
    .addColumn('type', 'text', (column) => column.notNull())
    .addColumn('enrollment_id', 'text', (column) =>
      column.notNull().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull())
    // Lo marcara HU-72 al consumir el hecho.
    .addColumn('processed_at', 'timestamptz')
    .addUniqueConstraint('mission_facts_un_hecho_por_tipo', ['type', 'enrollment_id'])
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_facts').execute()
  await db.schema.dropTable('mission_enrollments').execute()
  await db.schema.dropTable('mission_definitions').execute()
}
