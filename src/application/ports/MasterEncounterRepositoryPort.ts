import type { MasterEncounterRecord } from '../../domain/entities/MasterEncounterRecord'

/**
 * Evidencia del Master por matricula (HU-73, `mission_master_encounters`). La
 * escribe el cierre de HU-72 en su transaccion (`MissionClosure.masters`); aqui
 * solo se leen las entregas pendientes y se guarda su avance.
 */
export interface MasterEncounterRepositoryPort {
  /** Las entregas `PENDING` con el intento vencido, las mas atrasadas primero. */
  pendingGrants(now: Date, limit: number): Promise<readonly MasterEncounterRecord[]>
  listByEnrollment(enrollmentId: string): Promise<readonly MasterEncounterRecord[]>
  /**
   * Guarda el nuevo estado de la entrega si seguia `PENDING` con los intentos
   * leidos. Si queda `GRANTED` o `REJECTED`, la linea `EPIC` del reporte de HU-74
   * pasa a `CREDITED` o `FAILED` en la misma escritura. `false`: otro proceso se
   * adelanto y no se escribe nada. `at` es el momento de la linea del reporte.
   */
  saveGrant(next: MasterEncounterRecord, expectedAttempts: number, at: Date): Promise<boolean>
  /**
   * Congela el producto ANTES del primer envio: lo escribe solo si la entrega
   * sigue `PENDING`, con los intentos leidos y sin producto. Asi, aunque falle el
   * guardado posterior o se caiga el proceso, cada reintento lleva el mismo
   * cuerpo. `false`: otro proceso se adelanto y no hay que enviar. Una vez
   * congelado, ninguna escritura lo cambia.
   */
  freezeProduct(next: MasterEncounterRecord, expectedAttempts: number): Promise<boolean>
}

export const MASTER_ENCOUNTER_REPOSITORY = Symbol('MasterEncounterRepositoryPort')
