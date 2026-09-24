import { sql, type Kysely } from 'kysely'

/**
 * HU-76 (Task HU-76.2). Logros de misiones y sus reconocimientos.
 *
 * El progreso NO se guarda: se calcula con los clears, los reportes y la
 * evidencia del Master que ya guardan HU-75, HU-74 y HU-73. Aqui solo va lo que
 * no se puede derivar:
 *
 * - `mission_achievement_unlocks`: un desbloqueo por jugador y logro (un logro se
 *   otorga una sola vez), con su progreso congelado, la prueba y el
 *   reconocimiento. Un cosmetico lleva ademas su entrega, como la epica de HU-73.
 *   El CHECK del progreso impone CA-03 en el motor: nunca «0 de 0» ni parcial.
 * - `mission_achievement_evaluations`: el punto de control tecnico de cada
 *   jugador (que se vio al evaluarlo y su reintento). Borrarlo no cambia ningun
 *   resultado: solo hace que se vuelva a evaluar.
 *
 * Sin claves foraneas: `player_id` es el `sub` del proveedor de identidad y la
 * prueba guarda las matriculas en `jsonb`. `mission_facts.processed_at` sigue
 * siendo solo de HU-72.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_achievement_unlocks')
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('achievement_id', 'text', (column) => column.notNull())
    .addColumn('achievement_version', 'integer', (column) => column.notNull())
    .addColumn('criterion', 'text', (column) => column.notNull())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('progress_current', 'integer', (column) => column.notNull())
    .addColumn('progress_target', 'integer', (column) => column.notNull())
    .addColumn('proof', 'jsonb', (column) => column.notNull())
    .addColumn('unlocked_at', 'timestamptz', (column) => column.notNull())
    .addColumn('recognition_kind', 'text', (column) => column.notNull())
    .addColumn('recognition_name', 'text', (column) => column.notNull())
    .addColumn('recognition_status', 'text', (column) => column.notNull())
    .addColumn('grant_operation_id', 'uuid', (column) => column.unique())
    .addColumn('grant_attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('grant_next_attempt_at', 'timestamptz')
    .addColumn('grant_last_error', 'text')
    // El producto con que se pidio la entrega: congelado, cada reintento lleva el mismo cuerpo.
    .addColumn('grant_product_id', 'uuid')
    .addColumn('credited_at', 'timestamptz')
    .addPrimaryKeyConstraint('mission_achievement_unlocks_pk', ['player_id', 'achievement_id'])
    .addCheckConstraint(
      'mission_achievement_unlocks_logro_valido',
      sql`achievement_id ~ '^[a-z0-9_]{1,64}$'`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_criterio_conocido',
      sql`criterion in ('ALL_CATEGORY_MISSIONS', 'ALL_MASTERS_DEFEATED', 'FLAWLESS_MISSION',
        'RECORD_TIME', 'ALL_MASTER_EPICS')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_version_positiva',
      sql`achievement_version >= 1`,
    )
    // CA-03 en el motor: un objetivo de verdad y el progreso completo.
    .addCheckConstraint(
      'mission_achievement_unlocks_progreso_completo',
      sql`progress_target >= 1 and progress_current >= progress_target`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_prueba_es_objeto',
      sql`jsonb_typeof(proof) = 'object'`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_nombres_presentes',
      sql`btrim(name) <> '' and btrim(recognition_name) <> ''`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_reconocimiento_conocido',
      sql`recognition_kind in ('TITLE', 'BADGE', 'COSMETIC_PRODUCT')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_estado_de_reconocimiento',
      sql`recognition_status in ('RECORDED', 'PENDING', 'CREDITED', 'FAILED')`,
    )
    // Un titulo o una insignia quedan registrados; solo un cosmetico se entrega.
    .addCheckConstraint(
      'mission_achievement_unlocks_registrado_si_no_es_producto',
      sql`(recognition_kind = 'COSMETIC_PRODUCT') = (recognition_status <> 'RECORDED')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_entrega_solo_de_producto',
      sql`(grant_operation_id is not null) = (recognition_kind = 'COSMETIC_PRODUCT')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_proximo_intento_si_pendiente',
      sql`(grant_next_attempt_at is not null) = (recognition_status = 'PENDING')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_acreditado_con_fecha',
      sql`(credited_at is not null) = (recognition_status = 'CREDITED')`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_acreditado_con_producto',
      sql`recognition_status <> 'CREDITED' or grant_product_id is not null`,
    )
    .addCheckConstraint(
      'mission_achievement_unlocks_producto_de_entrega',
      sql`grant_product_id is null or grant_operation_id is not null`,
    )
    .addCheckConstraint('mission_achievement_unlocks_intentos', sql`grant_attempts >= 0`)
    .execute()

  // Las entregas por hacer, de la mas atrasada a la mas reciente.
  await sql`create index mission_achievement_unlocks_por_entregar
    on mission_achievement_unlocks (grant_next_attempt_at)
    where recognition_status = 'PENDING'`.execute(db)

  await db.schema
    .createTable('mission_achievement_evaluations')
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('settled_seen', 'integer', (column) => column.notNull())
    .addColumn('epics_granted_seen', 'integer', (column) => column.notNull())
    .addColumn('catalog_fingerprint', 'uuid')
    .addColumn('evaluated_at', 'timestamptz')
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addPrimaryKeyConstraint('mission_achievement_evaluations_pk', ['player_id'])
    .addCheckConstraint(
      'mission_achievement_evaluations_conteos_no_negativos',
      sql`settled_seen >= 0 and epics_granted_seen >= 0`,
    )
    .addCheckConstraint('mission_achievement_evaluations_intentos', sql`attempts >= 0`)
    // Solo un fallo deja un reintento pendiente.
    .addCheckConstraint(
      'mission_achievement_evaluations_reintento_tras_fallo',
      sql`(next_attempt_at is not null) = (attempts > 0)`,
    )
    .addCheckConstraint(
      'mission_achievement_evaluations_evaluada_con_huella',
      sql`(evaluated_at is null) = (catalog_fingerprint is null)`,
    )
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_achievement_evaluations').execute()
  await db.schema.dropTable('mission_achievement_unlocks').execute()
}
