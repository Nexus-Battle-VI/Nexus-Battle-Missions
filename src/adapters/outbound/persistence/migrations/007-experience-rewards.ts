import { sql, type Kysely } from 'kysely'

/**
 * Estado de las recompensas de experiencia (HU-09, Task HU-09.4; migracion
 * `007-experience-rewards`).
 *
 * UNA FILA POR INSTANCIA DE DERROTA, no por mision: la clave primaria es
 * (matriculacion, encuentro, enemigo concreto), que es la identidad que fija el
 * contrato §4.1 a partir de la bitacora de HU-72. Una mision con 10 + 5 + 3 + 1
 * enemigos derrotados deja 19 filas, y cada una tiene su propio ciclo: una que
 * falla NO arrastra a las demas (§9).
 *
 * POR QUE ESTA TABLA ES LO QUE HACE POSIBLE LA GARANTIA DEL §9.1. La fila nace
 * `PENDING` en la MISMA transaccion del cierre, ANTES de que Missions pida
 * ninguna tirada. Asi toda tirada que Combat llegue a persistir corresponde a una
 * recompensa que ya existe y que el barrido puede terminar: no puede haber una
 * tirada huerfana, que es lo unico que el contrato prohibe.
 *
 * LOS DOS ESTADOS NO TERMINALES SON DISTINTOS Y SE VEN EN LA TABLA: `PENDING` es
 * "todavia no hay tirada" (`roll` y `amount` nulos) y `ROLLED` es "la tirada y su
 * importe ya estan guardados, falta acreditar". Un `FAILED` puede haber muerto en
 * cualquiera de los dos, asi que la tirada es opcional ahi; lo que no puede es
 * haber importe sin tirada.
 *
 * `next_attempt_at` NACE EN `now()` Y NO EN NULO: el barrido selecciona por
 * intento vencido, y una recompensa recien creada tiene que estar lista para su
 * primer intento en el ciclo siguiente.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('mission_experience_rewards')
    .addColumn('enrollment_id', 'text', (column) =>
      column.notNull().references('mission_enrollments.enrollment_id'),
    )
    .addColumn('encounter_id', 'text', (column) => column.notNull())
    .addColumn('enemy_instance_id', 'text', (column) => column.notNull())
    .addColumn('player_id', 'text', (column) => column.notNull())
    .addColumn('hero_id', 'text', (column) => column.notNull())
    .addColumn('simulation_id', 'text', (column) => column.notNull())
    .addColumn('rival_ref', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) => column.notNull())
    // Cara del dado, tal como la devolvio Combat (1..8).
    .addColumn('roll', 'integer')
    // Experiencia ya calculada y entera: la pone la politica de Missions.
    .addColumn('amount', 'integer')
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('credited_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('mission_experience_rewards_pk', [
      'enrollment_id',
      'encounter_id',
      'enemy_instance_id',
    ])
    .addCheckConstraint(
      'mission_experience_rewards_estado_conocido',
      sql`status in ('PENDING', 'ROLLED', 'CREDITED', 'FAILED')`,
    )
    // La tirada existe exactamente cuando ya se pidio: PENDING no la tiene y
    // ROLLED/CREDITED si. Un FAILED conserva la que tuviera -- murio antes o
    // despues de tirar, y en el segundo caso la tirada es parte del registro.
    .addCheckConstraint(
      'mission_experience_rewards_pendiente_sin_tirada',
      sql`status <> 'PENDING' or roll is null`,
    )
    .addCheckConstraint(
      'mission_experience_rewards_rodada_con_tirada',
      sql`status not in ('ROLLED', 'CREDITED') or roll is not null`,
    )
    .addCheckConstraint(
      'mission_experience_rewards_tirada_en_rango',
      sql`roll is null or (roll >= 1 and roll <= 8)`,
    )
    .addCheckConstraint(
      'mission_experience_rewards_importe_sin_tirada',
      sql`roll is not null or amount is null`,
    )
    .addCheckConstraint(
      'mission_experience_rewards_importe_no_negativo',
      sql`amount is null or amount >= 0`,
    )
    .addCheckConstraint(
      'mission_experience_rewards_acreditada_con_fecha',
      sql`(credited_at is not null) = (status = 'CREDITED')`,
    )
    .addCheckConstraint('mission_experience_rewards_intentos', sql`attempts >= 0`)
    // Un fallo dice por que; sin motivo no hay nada que revisar.
    .addCheckConstraint(
      'mission_experience_rewards_fallo_con_motivo',
      sql`status <> 'FAILED' or last_error is not null`,
    )
    .execute()

  // Lo que le falta al barrido: lo no terminal, de lo mas atrasado a lo mas reciente.
  await sql`create index mission_experience_rewards_por_acreditar
    on mission_experience_rewards (next_attempt_at)
    where status in ('PENDING', 'ROLLED')`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('mission_experience_rewards').execute()
}
