import type { EpicGrantOutcome, EpicGrantPort, EpicGrantRequest } from './EpicGrantPort'

/**
 * Entrega de un cosmetico de logro en Player/Inventory (HU-76). Es el mismo
 * contrato de entregas de HU-59 que usa la epica de HU-73 (un producto, cantidad
 * 1), con un `operationId` de otro espacio: por eso se cablea con el mismo
 * cliente (`useExisting: EPIC_GRANTS`) y sin variable de entorno nueva.
 *
 * Player/Inventory **todavia no acepta a `missions`** (Team Alfa, ADR-019):
 * hasta entonces, cada entrega queda pendiente y se reintenta.
 */
export type RecognitionGrantRequest = EpicGrantRequest

export type RecognitionGrantOutcome = EpicGrantOutcome

export type RecognitionGrantPort = EpicGrantPort

export const RECOGNITION_GRANTS = Symbol('RecognitionGrantPort')
