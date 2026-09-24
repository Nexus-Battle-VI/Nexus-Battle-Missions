import type { BusyWith, MissingSlot, ReadinessBlocker } from '../../domain/errors/mission-errors'

export const HERO_COMMITMENTS = Symbol('HeroCommitmentPort')

/**
 * Reserva del heroe en Player/Inventory (compromiso `MISSION`, propuesta del
 * contrato hu-70-mission-enrollment-v1 para Team Alfa; HOY NO EXISTE en
 * Player/Inventory).
 *
 * La solicitud debe ser IDENTICA en cada reintento: Player/Inventory responde lo
 * mismo ante el mismo `operationId` y `409` si llega con otro cuerpo.
 */
export interface CommitHeroRequest {
  readonly operationId: string
  readonly playerId: string
  readonly heroId: string
  readonly reference: string
  readonly expiresAt: Date
  readonly requireCompleteLoadout: boolean
}

export type CommitHeroOutcome =
  | { readonly kind: 'GRANTED'; readonly commitmentId: string }
  | { readonly kind: 'REJECTED'; readonly rejection: CommitmentRejection }
  /**
   * `409`, `503`, ruta inexistente, tiempo agotado o error de red. ADR-019: el
   * resultado es DESCONOCIDO; no autoriza a suponer que no ocurrio.
   */
  | { readonly kind: 'UNKNOWN'; readonly reason: string }

export type CommitmentRejection =
  | { readonly code: 'HERO_NOT_OWNED' }
  | { readonly code: 'HERO_NOT_READY'; readonly blockers: readonly ReadinessBlocker[] }
  | { readonly code: 'LOADOUT_INCOMPLETE'; readonly missingSlots: readonly MissingSlot[] }
  | { readonly code: 'HERO_COMMITTED'; readonly busyWith: BusyWith | null }

export interface HeroCommitmentPort {
  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome>

  /**
   * Libera por `operationId`. Idempotente: `RELEASED` tanto si habia compromiso
   * vigente como si no. `UNKNOWN` si no hubo confirmacion.
   */
  release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'>
}
