import { sql, type Kysely } from 'kysely'

/**
 * Corrige `mission_enrollments_heroe_activo` (migracion 002): el indice
 * original era unico sobre `hero_id` SOLO, y `hero_id` es el `productId`
 * canonico del heroe en Catalog -compartido por TODOS los jugadores que
 * poseen ese tipo de heroe (Player-Inventory modela la posesion como pila
 * fungible, no instancias unicas por cuenta), no un id de instancia propio
 * de cada jugador-. Resultado real en produccion: si el jugador A matriculaba
 * su Picaro Veneno en una mision, el jugador B no podia matricular EL SUYO,
 * porque el indice los trataba como "el mismo heroe".
 *
 * El candado correcto es `{player_id, hero_id}`, el mismo criterio que ya
 * usan el candado de batalla y el de equipamiento en Player-Inventory. No se
 * edita la migracion 002 en el sitio -ya esta aplicada en produccion-: esta
 * migracion reemplaza el indice por uno nuevo, correctamente alcanzado.
 */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`drop index mission_enrollments_heroe_activo`.execute(db)
  await sql`create unique index mission_enrollments_heroe_activo_por_jugador
    on mission_enrollments (player_id, hero_id) where status in ('PENDING', 'IN_PROGRESS')`.execute(
    db,
  )
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`drop index mission_enrollments_heroe_activo_por_jugador`.execute(db)
  await sql`create unique index mission_enrollments_heroe_activo
    on mission_enrollments (hero_id) where status in ('PENDING', 'IN_PROGRESS')`.execute(db)
}
