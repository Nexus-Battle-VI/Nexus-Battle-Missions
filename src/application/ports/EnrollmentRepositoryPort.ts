import type { MissionEnrollment, MissionFact } from '../../domain/entities/MissionEnrollment'

export const ENROLLMENT_REPOSITORY = Symbol('EnrollmentRepositoryPort')

/**
 * Resultado de insertar una matricula `PENDING`. Los conflictos los decide el
 * MOTOR con sus indices unicos, no una lectura previa: dos confirmaciones
 * simultaneas del mismo heroe dejan una sola fila (T-02 del diseno).
 */
export type InsertPendingResult =
  | { readonly kind: 'INSERTED' }
  | {
      readonly kind: 'CONFLICT'
      readonly reason: 'HERO_ACTIVE' | 'PLAYER_MISSION_ACTIVE' | 'IDEMPOTENCY_KEY'
    }

/** Matriculas de HU-70. Missions es su unico dueno (ADR-019). */
export interface EnrollmentRepositoryPort {
  findById(enrollmentId: string): Promise<MissionEnrollment | null>

  findByIdempotencyKey(playerId: string, idempotencyKey: string): Promise<MissionEnrollment | null>

  /**
   * Matricula activa (`PENDING` o `IN_PROGRESS`) del heroe de ESE jugador, en
   * cualquier mision. `heroId` es el `productId` canonico del heroe en
   * Catalog -compartido por TODOS los jugadores que poseen ese tipo de
   * heroe, no un id de instancia por cuenta (Player-Inventory modela la
   * posesion como pila fungible, no instancias unicas)-, asi que sin
   * `playerId` esta consulta confundiria "mi Picaro Veneno esta en mision"
   * con "el Picaro Veneno de CUALQUIERA esta en mision". Mismo criterio que
   * ya usan el candado de batalla y el de equipamiento en Player-Inventory
   * (`{playerId, heroId}`, nunca `heroId` solo).
   */
  findActiveByHero(playerId: string, heroId: string): Promise<MissionEnrollment | null>

  /** Matricula activa del jugador en esa mision. */
  findActiveByPlayerAndMission(
    playerId: string,
    missionId: string,
  ): Promise<MissionEnrollment | null>

  /** Todas las matriculas del jugador, para derivar el estado del tablon. */
  listByPlayer(playerId: string): Promise<readonly MissionEnrollment[]>

  insertPending(enrollment: MissionEnrollment): Promise<InsertPendingResult>

  /**
   * Guarda una transicion con bloqueo optimista: solo escribe si la version
   * guardada es `expectedVersion`. Si trae un hecho, lo registra en la MISMA
   * transaccion. Devuelve `false` si otro proceso ya movio la matricula.
   */
  saveTransition(
    next: MissionEnrollment,
    expectedVersion: number,
    fact: MissionFact | null,
  ): Promise<boolean>

  /** Matriculas `PENDING` pedidas antes de `cutoff`, las mas viejas primero. */
  listPendingRequestedBefore(cutoff: Date, limit: number): Promise<readonly MissionEnrollment[]>
}
