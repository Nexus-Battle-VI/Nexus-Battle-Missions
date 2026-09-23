import type { MissionDefinition } from '../../domain/entities/MissionDefinition'

export const MISSION_CATALOG = Symbol('MissionCatalogPort')

/**
 * Definiciones de mision (HU-70). Missions es su unico dueno (ADR-019). Este
 * puerto solo lee: como se carga el contenido es una decision pendiente.
 */
export interface MissionCatalogPort {
  /** Misiones activas, en orden estable (por nombre). */
  listActive(): Promise<readonly MissionDefinition[]>

  /** Una mision activa, o `null` si no existe o esta inactiva. */
  findActive(missionId: string): Promise<MissionDefinition | null>

  /**
   * Una mision aunque ya no este activa. La usa el reconciliador: una matricula
   * pendiente conserva su duracion aunque la mision se retire despues.
   */
  findById(missionId: string): Promise<MissionDefinition | null>
}
