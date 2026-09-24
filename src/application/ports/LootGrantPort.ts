import type { EpicGrantOutcome, EpicGrantPort, EpicGrantRequest } from './EpicGrantPort'

/**
 * Entrega del botin del jefe en Player/Inventory (diseno «misiones jugables»,
 * P-J1). Es el mismo contrato de entregas de HU-59 que usan la epica de HU-73 y
 * el cosmetico de HU-76, con cantidad y un `operationId` de otro espacio: por eso
 * se cablea con el mismo cliente (`useExisting: EPIC_GRANTS`) y sin variable de
 * entorno nueva. `EPIC_GRANTS_DRIVER` gobierna las tres entregas.
 */
export type LootGrantRequest = EpicGrantRequest

export type LootGrantOutcome = EpicGrantOutcome

export type LootGrantPort = EpicGrantPort

export const LOOT_GRANTS = Symbol('LootGrantPort')
