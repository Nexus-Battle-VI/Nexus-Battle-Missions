import type { EpicGrantOutcome, EpicGrantPort, EpicGrantRequest } from './EpicGrantPort'

/**
 * Productos de finalizacion en Player/Inventory (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §10). Se REUTILIZA `POST
 * /api/internal/v1/inventory/grants` SIN cambiarlo: mismo contrato de HU-59 que
 * ya usan la epica de HU-73 y el botin de HU-72 (`LootGrantPort`), con un
 * `operationId` de su propio espacio (UUID v5, contrato §12). Por eso se cablea
 * con el MISMO cliente (`useExisting: EPIC_GRANTS`), sin variable de entorno
 * nueva: `EPIC_GRANTS_DRIVER` gobierna las tres entregas.
 */
export type CompletionProductGrantRequest = EpicGrantRequest

export type CompletionProductGrantOutcome = EpicGrantOutcome

export type CompletionProductGrantPort = EpicGrantPort

export const COMPLETION_PRODUCT_GRANTS = Symbol('CompletionProductGrantPort')
