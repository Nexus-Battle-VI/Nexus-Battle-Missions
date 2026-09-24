import type { MissionCatalogPort } from '../../../application/ports/MissionCatalogPort'
import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'
import type { MissionContentPort } from '../../../application/ports/MissionContentPort'
import { assertMasterConfig } from '../../../domain/policies/MasterPolicy'

/**
 * Doble de desarrollo y pruebas (`PERSISTENCE_DRIVER=memory`). Recibe las
 * definiciones al construirse; por defecto no tiene ninguna, igual que una base
 * recien migrada: el contenido de las misiones sigue pendiente (decision 7).
 *
 * Construirlo es cargar el contenido: un Master mal configurado falla aqui con
 * `INVALID_MASTER_CONFIG` (HU-73, P-X5) y no llega a Combat.
 */
export class InMemoryMissionCatalog implements MissionCatalogPort, MissionContentPort {
  private definitions: MissionDefinition[]

  constructor(definitions: readonly MissionDefinition[] = []) {
    definitions.forEach(assertMasterConfig)
    this.definitions = [...definitions].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listActive(): Promise<readonly MissionDefinition[]> {
    return this.definitions.filter((definition) => definition.active)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findActive(missionId: string): Promise<MissionDefinition | null> {
    return (
      this.definitions.find(
        (definition) => definition.missionId === missionId && definition.active,
      ) ?? null
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(missionId: string): Promise<MissionDefinition | null> {
    return this.definitions.find((definition) => definition.missionId === missionId) ?? null
  }

  listAll(): Promise<readonly MissionDefinition[]> {
    return Promise.resolve([...this.definitions])
  }

  save(definition: MissionDefinition): Promise<MissionDefinition> {
    this.definitions = [
      ...this.definitions.filter((item) => item.missionId !== definition.missionId),
      definition,
    ].sort((a, b) => a.name.localeCompare(b.name, 'es'))
    return Promise.resolve(definition)
  }
}
