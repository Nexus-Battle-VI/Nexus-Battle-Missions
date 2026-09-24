import { sql, type Kysely } from 'kysely'

/**
 * La experiencia de HU-09 en el reporte de HU-74 (HU-09, Task HU-09.5; migracion
 * `008-report-experience`).
 *
 * QUE CAMBIA Y POR QUE.
 *
 * 1. `source` admite el origen `HU-09`. El reporte ya tenia lineas `EXPERIENCE`
 *    declaradas en su vocabulario, pero hasta ahora nadie las escribia: la
 *    experiencia de cada NPC derrotado se guardaba en `mission_experience_rewards`
 *    y el jugador no la veia. El origen es lo que permite contar lo acreditado sin
 *    confundirlo con la linea de creditos, productos o epica.
 * 2. `quantity` deja de exigir `>= 1`. La linea de una derrota NACE EN CERO: su
 *    importe lo decide la tirada de Combat, que ocurre DESPUES del cierre, asi que
 *    en la foto todavia no existe. Un cero aqui significa "todavia no hay importe",
 *    y el ciclo de coordinacion lo completa al acreditar.
 * 3. La linea guarda la PROGRESION del heroe que devuelve Player/Inventory con la
 *    acreditacion: nivel, experiencia acumulada, tope de nivel y niveles cruzados.
 *    Missions no la calcula -- la tabla de HU-08 es de Player/Inventory (`ADR-019`)
 *    --, solo la guarda para poder contar la subida de nivel sin volver a
 *    preguntar. Las cuatro columnas van juntas o ninguna.
 * 4. `mission_experience_rewards.reward_line_no` ata cada recompensa a SU linea. La
 *    clave foranea compuesta impide que una recompensa apunte a una linea que no
 *    existe: las dos filas nacen en la misma transaccion del cierre y las dos se
 *    mueven en la misma transaccion del avance.
 *
 * NO SE TOCA NINGUNA FILA EXISTENTE. Las lineas ya escritas tienen su origen y su
 * cantidad validos con las reglas nuevas (aflojar un `check` no invalida nada), y
 * las columnas nuevas nacen nulas. Un reporte anterior a esta migracion no tiene
 * lineas de experiencia y su resumen sale con ceros: es la verdad, esa mision no
 * registro derrotas.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  // 1. El origen de HU-09.
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_origen_conocido`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_origen_conocido
    check (source in ('HU-10', 'HU-73', 'HU-09'))`.execute(db)

  // 2. Una linea puede nacer sin importe y seguir siendo valida.
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_cantidad_positiva`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_cantidad_no_negativa
    check (quantity >= 0)`.execute(db)

  // 3. La progresion del heroe, tal como la devolvio Player/Inventory.
  await sql`alter table mission_report_rewards
    add column hero_level integer,
    add column hero_current_xp integer,
    add column hero_max_level integer,
    add column levels_gained integer`.execute(db)

  // Las cuatro columnas son un dato o ninguno: media progresion se contradice.
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_progresion_completa
    check (
      (hero_level is null) = (hero_current_xp is null)
      and (hero_level is null) = (hero_max_level is null)
      and (hero_level is null) = (levels_gained is null)
    )`.execute(db)
  // Un nivel por encima del tope que el propio servicio declara es incoherente.
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_nivel_en_rango
    check (hero_level is null or (hero_level >= 1 and hero_level <= hero_max_level))`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_experiencia_no_negativa
    check (
      (hero_current_xp is null or hero_current_xp >= 0)
      and (levels_gained is null or levels_gained >= 0)
    )`.execute(db)
  // La progresion solo existe en una linea ACREDITADA: es el estado del heroe
  // DESPUES de entregar, y antes de entregar no hay ningun estado que guardar.
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_progresion_al_acreditar
    check (status = 'CREDITED' or hero_level is null)`.execute(db)

  // 4. La recompensa y su linea, atadas por clave foranea.
  await sql`alter table mission_experience_rewards add column reward_line_no integer`.execute(db)
  await sql`alter table mission_experience_rewards
    add constraint mission_experience_rewards_linea_del_reporte
    foreign key (enrollment_id, reward_line_no)
    references mission_report_rewards (enrollment_id, line_no)`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`alter table mission_experience_rewards
    drop constraint mission_experience_rewards_linea_del_reporte`.execute(db)
  await sql`alter table mission_experience_rewards drop column reward_line_no`.execute(db)

  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_progresion_al_acreditar`.execute(db)
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_experiencia_no_negativa`.execute(db)
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_nivel_en_rango`.execute(db)
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_progresion_completa`.execute(db)
  await sql`alter table mission_report_rewards
    drop column hero_level,
    drop column hero_current_xp,
    drop column hero_max_level,
    drop column levels_gained`.execute(db)

  // Primero se van las lineas del origen nuevo: sin ellas, ninguna fila se queda
  // en cero y el `check` viejo vuelve a valer para lo que queda.
  await sql`delete from mission_report_rewards where source = 'HU-09'`.execute(db)
  await sql`update mission_report_rewards set quantity = 1 where quantity < 1`.execute(db)
  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_cantidad_no_negativa`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_cantidad_positiva
    check (quantity >= 1)`.execute(db)

  await sql`alter table mission_report_rewards
    drop constraint mission_report_rewards_origen_conocido`.execute(db)
  await sql`alter table mission_report_rewards
    add constraint mission_report_rewards_origen_conocido
    check (source in ('HU-10', 'HU-73'))`.execute(db)
}
