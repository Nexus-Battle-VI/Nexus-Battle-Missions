import { sql, type Kysely } from 'kysely'

/**
 * Entregas de finalizacion de mision (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §7 y §12; migracion `013`).
 *
 * UNA TABLA PROPIA, NO TRES. `EXPERIENCE`, `CREDITS` y `PRODUCT` comparten el
 * mismo ciclo de vida (`PENDING -> CREDITED | FAILED`) y la misma clave
 * `(enrollment_id, reward_key)`; separarlas en tres tablas casi identicas
 * duplicaria el barrido y el indice sin ganar ninguna invariante. Tampoco es una
 * tabla generica de "recompensas": es SOLO de HU-10, con sus columnas propias, del
 * mismo modo que `mission_experience_rewards` es solo de HU-09 y
 * `mission_loot_grants` solo del botin de HU-72.
 *
 * `(enrollment_id, reward_key)` COMO CLAVE PRIMARIA es lo que hace idempotente al
 * cierre: repetirlo con el MISMO contenido congelado calcula los MISMOS derechos y
 * el `insert` (con `on conflict do nothing`) no duplica ninguna fila.
 *
 * DISCRIMINADA POR `kind`, CON UN `CHECK` CERRADO: una fila `EXPERIENCE` o
 * `CREDITS` lleva `amount` y NUNCA `product_id`/`quantity`; una `PRODUCT` al
 * reves. No puede existir una fila a medias.
 *
 * `report_line_no` es `NOT NULL` y tiene clave foranea a
 * `mission_report_rewards`: la entrega SIEMPRE nace con su linea, en la MISMA
 * transaccion del cierre (si el reporte no se pudo construir, no se crea ninguna
 * entrega, igual que el botin de HU-72).
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_completion_reward_deliveries')
    .addColumn('enrollment_id', 'text', (column) =>
      column.notNull().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('reward_key', 'text', (column) => column.notNull())
    .addColumn('report_line_no', 'integer', (column) => column.notNull())
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('hero_id', 'text', (column) => column.notNull())
    .addColumn('mission_id', 'text', (column) => column.notNull())
    .addColumn('simulation_id', 'text', (column) => column.notNull())
    .addColumn('difficulty', 'text', (column) => column.notNull())
    .addColumn('mission_outcome', 'text', (column) => column.notNull())
    // XP y creditos.
    .addColumn('amount', 'integer')
    // Producto.
    .addColumn('product_id', 'text')
    .addColumn('quantity', 'integer')
    .addColumn('operation_id', 'text', (column) => column.notNull().unique())
    .addColumn('status', 'text', (column) => column.notNull())
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('credited_at', 'timestamptz')
    // El momento del cierre, congelado: es el `occurredAt` que se envia a Wallet
    // en CADA intento, nunca la hora del reintento.
    .addColumn('settled_at', 'timestamptz', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('mission_completion_reward_deliveries_pk', [
      'enrollment_id',
      'reward_key',
    ])
    .addForeignKeyConstraint(
      'mission_completion_reward_deliveries_linea_del_reporte',
      ['enrollment_id', 'report_line_no'],
      'mission_report_rewards',
      ['enrollment_id', 'line_no'],
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_tipo_conocido',
      sql`kind in ('EXPERIENCE', 'CREDITS', 'PRODUCT')`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_dificultad_conocida',
      sql`difficulty in ('NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC')`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_desenlace_conocido',
      sql`mission_outcome in ('COMPLETED', 'FAILED')`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_estado_conocido',
      sql`status in ('PENDING', 'CREDITED', 'FAILED')`,
    )
    // Union discriminada cerrada: XP/creditos llevan `amount` y nada de producto;
    // producto lleva `product_id` y `quantity` y nunca `amount`.
    .addCheckConstraint(
      'mission_completion_reward_deliveries_forma_por_tipo',
      sql`(kind in ('EXPERIENCE', 'CREDITS')
             and amount is not null and product_id is null and quantity is null)
          or (kind = 'PRODUCT'
             and product_id is not null and quantity is not null and amount is null)`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_importe_positivo',
      sql`amount is null or amount >= 1`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_cantidad_en_rango',
      sql`quantity is null or (quantity >= 1 and quantity <= 9999)`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_intentos_no_negativos',
      sql`attempts >= 0`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_acreditada_con_fecha',
      sql`(credited_at is not null) = (status = 'CREDITED')`,
    )
    .addCheckConstraint(
      'mission_completion_reward_deliveries_fallo_con_motivo',
      sql`status <> 'FAILED' or last_error is not null`,
    )
    .execute()

  // Lo que le falta al barrido: pendiente, de lo mas atrasado a lo mas reciente.
  await sql`create index mission_completion_reward_deliveries_por_entregar
    on mission_completion_reward_deliveries (next_attempt_at)
    where status = 'PENDING'`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_completion_reward_deliveries').execute()
}
