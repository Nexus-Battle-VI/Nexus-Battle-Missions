import type { MissionDefinition } from '../../domain/entities/MissionDefinition'

export const MISSION_CONTENT = Symbol('MissionContentPort')

/** Administrative source of truth for playable mission definitions. */
export interface MissionContentPort {
  listAll(): Promise<readonly MissionDefinition[]>
  save(definition: MissionDefinition): Promise<MissionDefinition>
}
