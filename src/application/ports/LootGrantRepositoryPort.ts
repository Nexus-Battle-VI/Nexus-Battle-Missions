import type { LootGrantRecord } from '../../domain/entities/LootGrantRecord'

/**
 * Entregas del botin del jefe (diseno «misiones jugables», P-J1). Las escribe el
 * cierre de HU-72 dentro de su transaccion; despues solo cambia la entrega, y con
 * ella la linea `PRODUCT` del reporte de HU-74, en la misma transaccion.
 */
export interface LootGrantRepositoryPort {
  /** Las entregas PENDING cuyo proximo intento ya toca, las mas antiguas primero. */
  pendingGrants(now: Date, limit: number): Promise<readonly LootGrantRecord[]>
  listByEnrollment(enrollmentId: string): Promise<readonly LootGrantRecord[]>
  /**
   * Guarda la transicion si nadie la cambio (mismos intentos). Al dejar de estar
   * pendiente, mueve la linea del reporte a `CREDITED` o `FAILED`. `false` si otro
   * proceso se adelanto.
   */
  saveGrant(next: LootGrantRecord, expectedAttempts: number, at: Date): Promise<boolean>
  /** Congela el producto antes de pedir la entrega; `false` si ya estaba congelado. */
  freezeProduct(next: LootGrantRecord, expectedAttempts: number): Promise<boolean>
}

export const LOOT_GRANT_REPOSITORY = Symbol('LootGrantRepositoryPort')
