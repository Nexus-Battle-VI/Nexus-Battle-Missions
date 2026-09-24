import { sql, type Kysely } from 'kysely'

/**
 * HU-73 (Task HU-73.2). Evidencia del Master y entrega de su epica.
 *
 * `mission_master_encounters`: una fila por punto de evaluacion de cada
 * matricula (propuesta P-X7), escrita en la transaccion del cierre de HU-72. Si
 * el heroe derroto al Master, la fila lleva la entrega de la epica (P-X6): un
 * `operationId` determinista, su estado y el reintento. Los CHECK imponen en el
 * motor que solo un Master derrotado lleva entrega y que una aparicion siempre
 * nombra a su Master.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_master_encounters')
    .addColumn('enrollment_id', 'text', (column) =>
      column.notNull().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('sequence', 'integer', (column) => column.notNull())
    .addColumn('after_encounter', 'integer')
    .addColumn('master_ref', 'text')
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('epic_ref', 'text')
    .addColumn('level_offset', 'integer')
    .addColumn('turns', 'integer')
    .addColumn('grant_operation_id', 'uuid', (column) => column.unique())
    .addColumn('grant_status', 'text')
    .addColumn('grant_attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('grant_next_attempt_at', 'timestamptz')
    .addColumn('grant_last_error', 'text')
    .addColumn('granted_at', 'timestamptz')
    .addColumn('reward_line_no', 'integer')
    // El producto con que se pidio la entrega: congelado, cada reintento lleva el mismo cuerpo.
    .addColumn('grant_product_id', 'text')
    .addPrimaryKeyConstraint('mission_master_encounters_pk', ['enrollment_id', 'sequence'])
    .addCheckConstraint('mission_master_encounters_punto_positivo', sql`sequence >= 1`)
    .addCheckConstraint(
      'mission_master_encounters_estado_conocido',
      sql`status in ('NOT_APPLICABLE', 'NOT_APPEARED', 'APPEARED_DEFEATED',
        'APPEARED_HERO_DEFEATED', 'APPEARED_ESCAPED', 'SKIPPED_MAX_REACHED')`,
    )
    // Solo NOT_APPLICABLE no tiene punto: no hubo nada que evaluar.
    .addCheckConstraint(
      'mission_master_encounters_punto_salvo_no_aplica',
      sql`(after_encounter is null) = (status = 'NOT_APPLICABLE')`,
    )
    .addCheckConstraint(
      'mission_master_encounters_encuentro_positivo',
      sql`after_encounter is null or after_encounter >= 1`,
    )
    // Una aparicion nombra a su Master; sin aparicion, no hay Master.
    .addCheckConstraint(
      'mission_master_encounters_master_si_aparece',
      sql`(master_ref is not null) = (status in ('APPEARED_DEFEATED', 'APPEARED_HERO_DEFEATED',
        'APPEARED_ESCAPED'))`,
    )
    // Solo un Master derrotado da epica, y siempre con su entrega (CA-01 y CA-03).
    .addCheckConstraint(
      'mission_master_encounters_epica_si_derrotado',
      sql`(epic_ref is not null) = (status = 'APPEARED_DEFEATED')`,
    )
    .addCheckConstraint(
      'mission_master_encounters_entrega_si_derrotado',
      sql`(grant_operation_id is not null) = (status = 'APPEARED_DEFEATED')`,
    )
    .addCheckConstraint(
      'mission_master_encounters_entrega_con_estado',
      sql`(grant_status is not null) = (grant_operation_id is not null)`,
    )
    .addCheckConstraint(
      'mission_master_encounters_estado_de_entrega',
      sql`grant_status is null or grant_status in ('PENDING', 'GRANTED', 'REJECTED')`,
    )
    .addCheckConstraint(
      'mission_master_encounters_entregada_con_fecha',
      sql`(granted_at is not null) = (grant_status is not distinct from 'GRANTED')`,
    )
    // Solo una entrega lleva producto, y una entregada siempre lo lleva.
    .addCheckConstraint(
      'mission_master_encounters_producto_de_entrega',
      sql`grant_product_id is null or grant_operation_id is not null`,
    )
    .addCheckConstraint(
      'mission_master_encounters_entregada_con_producto',
      sql`grant_status is distinct from 'GRANTED' or grant_product_id is not null`,
    )
    .addCheckConstraint('mission_master_encounters_intentos', sql`grant_attempts >= 0`)
    .addCheckConstraint('mission_master_encounters_turnos', sql`turns is null or turns >= 0`)
    .addCheckConstraint(
      'mission_master_encounters_linea_positiva',
      sql`reward_line_no is null or reward_line_no >= 1`,
    )
    .execute()

  // Las entregas por hacer, de la mas atrasada a la mas reciente.
  await sql`create index mission_master_encounters_por_entregar
    on mission_master_encounters (grant_next_attempt_at)
    where grant_status = 'PENDING'`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_master_encounters').execute()
}
