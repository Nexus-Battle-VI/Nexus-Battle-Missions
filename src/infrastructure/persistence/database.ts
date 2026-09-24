import {
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely'
import { Pool } from 'pg'

import * as missionDifficultyClears from '../../adapters/outbound/persistence/migrations/001-mission-difficulty-clears'
import * as missionEnrollments from '../../adapters/outbound/persistence/migrations/002-mission-enrollments'
import * as missionStrategies from '../../adapters/outbound/persistence/migrations/003-mission-strategies'
import * as missionExecutions from '../../adapters/outbound/persistence/migrations/004-mission-executions'
import * as missionReports from '../../adapters/outbound/persistence/migrations/005-mission-reports'
import * as missionMasterEncounters from '../../adapters/outbound/persistence/migrations/006-mission-master-encounters'
import * as missionExperienceRewards from '../../adapters/outbound/persistence/migrations/007-experience-rewards'
import * as reportExperience from '../../adapters/outbound/persistence/migrations/008-report-experience'
import * as missionAchievements from '../../adapters/outbound/persistence/migrations/009-mission-achievements'
import * as playableMissions from '../../adapters/outbound/persistence/migrations/010-playable-missions'
import type { Database } from '../../adapters/outbound/persistence/schema'

export interface DatabaseOptions {
  readonly connectionString: string
  /**
   * Conexiones simultaneas del pool.
   *
   * Deliberadamente bajo. Todos los servicios comparten el mismo motor en el
   * nodo de datos (ADR-011): si cada uno abriera un pool generoso, PostgreSQL
   * agotaria `max_connections` antes de que ningun servicio notara presion.
   */
  readonly maxConnections?: number
  /**
   * Recibe los errores de las conexiones OCIOSAS del pool.
   *
   * Una conexion que espera en el pool sigue unida a un proceso del motor. Si
   * el motor se reinicia o la red se corta, esa conexion emite `error` en el
   * pool, y sin ningun oyente Node trata el evento como no controlado y
   * TERMINA EL PROCESO. El servicio entero caeria por un reinicio de la base,
   * en lugar de responder 503 en la readiness y recuperarse solo.
   *
   * Se descubrio con la prueba de control de la CI: al parar PostgreSQL, el
   * contenedor dejaba de responder en vez de devolver 503.
   */
  readonly onIdleError?: (error: Error) => void
}

export const createDatabase = (options: DatabaseOptions): Kysely<Database> => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
    idleTimeoutMillis: 30_000,
    // Sin este limite, un motor caido deja las peticiones colgadas hasta el
    // tiempo de espera de la peticion HTTP, que es mucho mas largo.
    connectionTimeoutMillis: 5_000,
  })

  // El oyente se registra SIEMPRE, aunque nadie pase `onIdleError`: su mera
  // presencia es lo que impide que el proceso termine. El pool ya descarta la
  // conexion rota y abre otra en la siguiente consulta.
  pool.on('error', (error: Error) => {
    options.onIdleError?.(error)
  })

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * `FileMigrationProvider` leeria el directorio en tiempo de ejecucion, y en la
 * imagen de produccion ese directorio contiene JavaScript compilado con otra
 * ruta. Importarlas explicitamente hace que el compilador las verifique y que
 * el empaquetado no pueda dejarse ninguna fuera en silencio.
 *
 * Cada Historia de Usuario anade aqui su migracion, con prefijo numerico que
 * fija el orden. `001-mission-difficulty-clears` (HU-75, Task #384) crea la
 * primera tabla de negocio del servicio; `002-mission-enrollments` (HU-70, Task
 * #366), el tablon, las matriculas y los hechos internos;
 * `003-mission-strategies` (HU-71, Task #370), las estrategias y su copia
 * congelada en la matricula; `004-mission-executions` (HU-72, Task #374), la
 * ejecucion de la simulacion y el cierre de la mision; `005-mission-reports`
 * (HU-74, Task #380), el reporte inmutable y sus lineas de recompensa;
 * `006-mission-master-encounters` (HU-73, Task #377), la evidencia del Master y
 * la entrega de su epica; `007-experience-rewards` (HU-09, Task #442), el estado
 * de la recompensa de experiencia de cada derrota; `008-report-experience` (HU-09,
 * Task #443), el origen `HU-09`, la progresion del heroe en la linea del reporte y
 * su enlace con la recompensa; `009-mission-achievements` (HU-76, Task #388), los
 * logros desbloqueados, sus reconocimientos y el punto de control de cada
 * jugador; y `010-playable-missions`, la siembra de las dos misiones jugables.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '001-mission-difficulty-clears': missionDifficultyClears,
  '002-mission-enrollments': missionEnrollments,
  '003-mission-strategies': missionStrategies,
  '004-mission-executions': missionExecutions,
  '005-mission-reports': missionReports,
  '006-mission-master-encounters': missionMasterEncounters,
  '007-experience-rewards': missionExperienceRewards,
  '008-report-experience': reportExperience,
  '009-mission-achievements': missionAchievements,
  '010-playable-missions': playableMissions,
}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 *
 * No se ejecuta al arrancar el servicio: migrar desde el arranque significa que
 * varias replicas migran a la vez, y que un despliegue con una migracion rota
 * deja el servicio en bucle de reinicio. Se invoca desde `npm run migrate`,
 * como paso explicito del despliegue.
 *
 * Las migraciones se reciben como parametro para que la prueba contra motor
 * real pueda ejercitar el camino de fallo sin anadir una migracion rota al
 * producto.
 */
export const migrateToLatest = async (
  db: Kysely<Database>,
  migrations: Readonly<Record<string, Migration>> = MIGRATIONS,
): Promise<MigrationOutcome> => {
  const provider: MigrationProvider = {
    getMigrations: () => Promise.resolve({ ...migrations }),
  }
  const migrator = new Migrator({ db, provider })
  const { error, results } = await migrator.migrateToLatest()

  return {
    applied: (results ?? [])
      .filter((result: MigrationResult) => result.status === 'Success')
      .map((result: MigrationResult) => result.migrationName),
    error,
  }
}

/**
 * Comprobacion de readiness contra el motor. Devuelve `false` en lugar de
 * lanzar: quien la consume es la sonda, y para ella un motor inalcanzable es un
 * resultado, no una excepcion.
 */
export const pingDatabase = async (db: Kysely<Database>): Promise<boolean> => {
  try {
    await sql`select 1`.execute(db)

    return true
  } catch {
    return false
  }
}
