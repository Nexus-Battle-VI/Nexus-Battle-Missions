import { MongoClient, type Db } from 'mongodb'
import { sql, type Kysely } from 'kysely'

import {
  canonicalBody,
  signInternalRequest,
} from '../../../src/adapters/outbound/identity/internal-signature'
import type { Database } from '../../../src/adapters/outbound/persistence/schema'
import type { MissionDefinition } from '../../../src/domain/entities/MissionDefinition'
import { EXAMPLE_MISSIONS } from '../../../src/adapters/outbound/persistence/example-missions'
import { insertDefinition } from '../../support/fixtures'
import type { MissionsApp } from './missions-app'

/**
 * Datos y utilidades de la cadena HU-09 (Task HU-09.6).
 *
 * NADA DE AQUI REIMPLEMENTA UNA REGLA DEL PRODUCTO. La tabla de importes por cara
 * es la del contrato §6 (dato de prueba, no una politica: la politica vive en
 * `ExperienceRewardPolicy`) y la tabla de niveles es la de HU-08, copiada a
 * proposito para poder CONTRASTAR lo que el servicio devuelve.
 */

/** La mision de ejemplo del curso: 10 + 5 + 3 enemigos y el jefe = 19 derrotas. */
export const TEMPLO: MissionDefinition = EXAMPLE_MISSIONS[0]!
export const DEFEATS_IN_TEMPLO = 19

/** El heroe del escenario: identidad canonica, como en el resto de la suite. */
export const HERO_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

/** Contrato `hu-09-experience-reward-v1` §6, columna «al entero mas proximo». */
export const ROLL_AMOUNTS: Readonly<Record<number, number>> = {
  1: 12,
  2: 14,
  3: 17,
  4: 21,
  5: 25,
  6: 30,
  7: 36,
  8: 43,
}

/** Tabla de umbrales de HU-08, para CONTRASTAR el nivel que devuelve Player/Inventory. */
export const LEVEL_THRESHOLDS: readonly number[] = [100, 200, 400, 800, 1600, 3200, 6400, 12800]

/** El nivel que la tabla vigente asigna a un acumulado. */
export const expectedLevel = (totalXp: number): number => {
  let level = 1

  for (const [index, threshold] of LEVEL_THRESHOLDS.entries()) {
    if (totalXp >= threshold) {
      level = index + 1
    }
  }

  return level
}

export const sumOf = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0)

/** El `operationId` del lote de tiradas de una matricula (contrato §5.2). */
export const rollsOperationId = (enrollmentId: string): string => `mission:${enrollmentId}:xp-rolls`

/** El `operationId` de la acreditacion de UNA derrota (contrato §7). */
export const creditOperationId = (input: {
  readonly enrollmentId: string
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly heroId: string
}): string =>
  `mission:${input.enrollmentId}:encounter:${input.encounterId}:enemy:${input.enemyInstanceId}:hero:${input.heroId}:xp`

export interface Enrollment {
  readonly enrollmentId: string
  readonly startedAt: string
  readonly endsAt: string
}

/** La matricula por HTTP, como la hace un jugador. */
export const enroll = async (
  missions: MissionsApp,
  options: { readonly missionId?: string; readonly difficulty?: string; readonly key: string },
): Promise<Enrollment> => {
  const response = await missions
    .post(`/api/v1/missions/${options.missionId ?? TEMPLO.missionId}/enrollments`, {
      heroId: HERO_ID,
      difficulty: options.difficulty ?? 'NORMAL',
      strategyVersion: null,
    })
    .set('Idempotency-Key', options.key)

  if (response.status !== 201) {
    throw new Error(
      `La matricula fallo con ${String(response.status)}: ${JSON.stringify(response.body)}`,
    )
  }

  return response.body as Enrollment
}

/**
 * Desplaza la VENTANA de la matricula al pasado para poder cerrar la mision sin
 * esperar sus 12 horas reales.
 *
 * Es la unica forma de cerrar sin tocar el reloj, y el reloj NO se puede tocar:
 * los clientes internos firman con el reloj de Missions y Combat y
 * Player/Inventory aceptan un sello de ±30 s. La ventana sigue siendo una ventana
 * valida (`started_at < ends_at`, `ends_at + SIMULATION_GRACE_MS` en el futuro) y
 * el presupuesto de tiempo que viaja a Combat sigue teniendo sentido.
 *
 * LAS FECHAS LAS CALCULA ESTE PROCESO, no el motor: el cierre compara `ends_at`
 * con el reloj de la aplicacion, asi que `now()` de PostgreSQL ataria el dato al
 * reloj del contenedor, que en un portatil con WSL2 deriva respecto al del
 * anfitrion. Un segundo en el pasado quita esa dependencia.
 *
 * Y LA VENTANA MIDE MINUTOS ENTEROS, que no es un detalle estetico: el presupuesto
 * de tiempo que viaja a Combat es `ends_at - started_at` en minutos, y
 * `toIsoDuration` rechaza cualquier cosa que no sea un entero positivo. Con las
 * dos fechas tomadas de `now()` por separado, la resta da 59,9 minutos y el cierre
 * falla con «La duracion de una mision debe ser un numero entero positivo de
 * minutos»: la mision no se cierra, no hay informe y no se devenga nada. Por eso
 * las dos salen de UNA sola lectura del reloj, separadas por una hora exacta.
 */
export const shiftEnrollmentWindow = async (
  db: Kysely<Database>,
  enrollmentId: string,
): Promise<void> => {
  const now = Date.now()
  const endsAt = new Date(now - 1_000)
  const startedAt = new Date(endsAt.getTime() - 3_600_000)

  await sql`update mission_enrollments
    set started_at = ${startedAt}, ends_at = ${endsAt}
    where enrollment_id = ${enrollmentId}`.execute(db)
}

/** El cierre y el barrido, en el orden en que los mueve el planificador real. */
export const closeAndSweep = async (missions: MissionsApp): Promise<void> => {
  await missions.run()
  await missions.tick()
}

export interface SignedCall {
  readonly status: number
  readonly body: unknown
}

/**
 * Una peticion interna FIRMADA, hecha a mano.
 *
 * Se usa solo donde hay que comprobar la frontera por si misma (el `409` de cada
 * operacion): el camino normal lo hace Missions con sus propios clientes. La ruta
 * firmada es la completa, con `/api`, y el sello se calcula en el momento.
 */
export const signedPost = async (input: {
  readonly baseUrl: string
  readonly path: string
  readonly body: unknown
  readonly secret: string
  readonly now?: Date
}): Promise<SignedCall> => {
  const timestamp = String((input.now ?? new Date()).getTime())
  const signature = signInternalRequest(input.secret, {
    service: 'missions',
    method: 'POST',
    path: input.path,
    timestamp,
    body: input.body,
  })

  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-service': 'missions',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body: canonicalBody(input.body),
  })

  const raw = await response.text()

  return {
    status: response.status,
    body: raw === '' ? null : (JSON.parse(raw) as unknown),
  }
}

/** Colecciones de los dos servicios, tal como se guardan de verdad. */
export interface ChainDatabases {
  readonly combat: Db
  readonly playerInventory: Db
  readonly close: () => Promise<void>
}

export const connectChainDatabases = async (mongoUri: string): Promise<ChainDatabases> => {
  const client = new MongoClient(`${mongoUri}/?directConnection=true`)

  await client.connect()

  return {
    combat: client.db('combat'),
    playerInventory: client.db('player-inventory'),
    close: async () => {
      await client.close()
    },
  }
}

/** El lote de tiradas tal como quedo en Combat. */
export interface RollBatchDocument {
  readonly _id: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly heroId: string
  readonly defeats: readonly {
    readonly encounterId: string
    readonly enemyInstanceId: string
    readonly rivalRef: string
    readonly roll: number
    readonly persistedAt: Date
  }[]
  readonly createdAt: Date
}

export const readRollBatch = async (
  databases: ChainDatabases,
  enrollmentId: string,
): Promise<RollBatchDocument | null> =>
  databases.combat
    .collection<RollBatchDocument>('experience-rolls')
    .findOne({ _id: rollsOperationId(enrollmentId) })

export interface GrantDocument {
  readonly _id: string
  readonly amount: number
  readonly roll: number
  readonly ownerId: string
  readonly heroId: string
  readonly enrollmentId: string
  readonly simulationId: string
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly rivalRef: string
  readonly result: {
    readonly currentXp: number
    readonly level: number
    readonly levelsGained: number
  }
}

export const readGrants = async (
  databases: ChainDatabases,
  enrollmentId: string,
): Promise<readonly GrantDocument[]> =>
  databases.playerInventory
    .collection<GrantDocument>('experience_grants')
    .find({ enrollmentId })
    .sort({ _id: 1 })
    .toArray()

/** Cuantos asientos hay en total: distingue "no se acredito" de "se acredito a otro". */
export const countGrants = async (databases: ChainDatabases): Promise<number> =>
  databases.playerInventory.collection('experience_grants').countDocuments({})

export interface ProgressionDocument {
  readonly _id: string
  readonly ownerId: string
  readonly heroId: string
  readonly level: number
  readonly currentXp: number
  readonly version: number
}

export const readProgression = async (
  databases: ChainDatabases,
  playerId: string,
  heroId: string,
): Promise<ProgressionDocument | null> =>
  databases.playerInventory
    .collection<ProgressionDocument>('hero-progressions')
    .findOne({ _id: `${playerId}::${heroId}` })

/**
 * Siembra la progresion de un heroe con un acumulado conocido.
 *
 * El nivel se calcula con la tabla de HU-08: Player/Inventory RECHAZA (422) una
 * progresion cuyo nivel no corresponda a su experiencia, asi que sembrar un
 * desajuste no probaria nada. No hace falta ningun documento de propiedad: la
 * progresion se crea perezosamente y no se comprueba contra el inventario.
 */
export const seedProgression = async (
  databases: ChainDatabases,
  playerId: string,
  heroId: string,
  currentXp: number,
): Promise<void> => {
  await databases.playerInventory.collection<ProgressionDocument>('hero-progressions').insertOne({
    _id: `${playerId}::${heroId}`,
    ownerId: playerId,
    heroId,
    level: expectedLevel(currentXp),
    currentXp,
    version: 0,
  })
}

/**
 * Vence el escalonado de reintentos de una matricula.
 *
 * El barrido de HU-09 selecciona por «intento vencido» y el primer escalon es de
 * 5 s (el segundo, de 30). Esperarlos de verdad alargaria el escenario, y adelantar
 * el reloj romperia los sellos HMAC de las dos fronteras: se vence el DATO, que es
 * lo mismo que el tiempo habria hecho, sin el tiempo.
 *
 * La fecha la calcula ESTE PROCESO y va un minuto en el pasado: el barrido compara
 * contra el reloj de la aplicacion, no contra el del motor.
 */
export const makeRewardsDue = async (db: Kysely<Database>, enrollmentId: string): Promise<void> => {
  await sql`update mission_experience_rewards
    set next_attempt_at = ${new Date(Date.now() - 60_000)}
    where enrollment_id = ${enrollmentId} and status in ('PENDING', 'ROLLED')`.execute(db)
}

/** Deja la base de Player/Inventory como recien arrancada, entre escenarios. */
export const clearPlayerInventory = async (databases: ChainDatabases): Promise<void> => {
  await databases.playerInventory.collection('experience_grants').deleteMany({})
  await databases.playerInventory.collection('hero-progressions').deleteMany({})
}

/**
 * Marca una mision como superada por el jugador.
 *
 * Solo lo usa el escenario de la camara sellada, cuyo contenido exige el templo
 * como requisito: es un dato de partida (lo que el servicio escribe al completar
 * la mision anterior), no una sustitucion de nada.
 */
export const seedClear = async (
  db: Kysely<Database>,
  playerId: string,
  missionId: string,
): Promise<void> => {
  await sql`insert into mission_difficulty_clears (player_id, mission_id, difficulty, completed_at)
    values (${playerId}, ${missionId}, 'NORMAL', now())
    on conflict do nothing`.execute(db)
}

export { insertDefinition }
