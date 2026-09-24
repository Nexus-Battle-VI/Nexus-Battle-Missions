import {
  lootConfirmed,
  lootDeferred,
  lootRejected,
  type LootGrantRecord,
} from '../../domain/entities/LootGrantRecord'
import { dropProductOf } from '../../domain/policies/LootPolicy'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { LootGrantPort } from '../ports/LootGrantPort'
import type { LootGrantRepositoryPort } from '../ports/LootGrantRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface LootGrantCycleSummary {
  readonly lootGranted: number
  readonly lootRetried: number
  /** Sin producto de Catalog enlazado todavia: se espera. */
  readonly lootWaiting: number
  readonly lootRejected: number
  readonly lootFailed: number
}

type Tally = { -readonly [K in keyof LootGrantCycleSummary]: number }

export interface LootGrantOptions {
  readonly batchSize: number
  /** Un fallo en una entrega no detiene a las demas; se informa aqui. */
  readonly onError?: (enrollmentId: string, error: unknown) => void
}

/**
 * Entrega del botin del jefe (diseno «misiones jugables», P-J1). El cierre de
 * HU-72 deja cada entrega pendiente; este caso de uso la pide a Player/Inventory
 * con su `operationId` determinista hasta tener respuesta definitiva, igual que
 * la epica de HU-73:
 *
 * - `200`: entregada, y la linea `PRODUCT` del reporte pasa a `CREDITED`;
 * - rechazo definitivo: queda para revision, y la linea pasa a `FAILED`;
 * - sin respuesta, o sin producto enlazado todavia: se reintenta despues.
 */
export class GrantMissionLoot {
  constructor(
    private readonly grants: LootGrantRepositoryPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly catalog: MissionCatalogPort,
    private readonly inventory: LootGrantPort,
    private readonly clock: ClockPort,
    private readonly options: LootGrantOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<LootGrantCycleSummary> {
    const tally: Tally = {
      lootGranted: 0,
      lootRetried: 0,
      lootWaiting: 0,
      lootRejected: 0,
      lootFailed: 0,
    }

    for (const grant of await this.grants.pendingGrants(this.clock.now(), this.options.batchSize)) {
      try {
        await this.deliver(grant, tally)
      } catch (error: unknown) {
        tally.lootFailed += 1
        this.options.onError?.(grant.enrollmentId, error)
        await this.deferAfterFailure(grant)
      }
    }

    return { ...tally }
  }

  /** Una entrega que falla se aplaza con el mismo escalonado, sin volver al frente de la cola. */
  private async deferAfterFailure(grant: LootGrantRecord): Promise<void> {
    if (grant.status !== 'PENDING') {
      return
    }

    const now = this.clock.now()

    try {
      await this.grants.saveGrant(lootDeferred(grant, 'INTERNAL_ERROR', now), grant.attempts, now)
    } catch {
      // Sin base no hay como aplazarla: el ciclo siguiente lo vuelve a intentar.
    }
  }

  private async deliver(grant: LootGrantRecord, tally: Tally): Promise<void> {
    const now = this.clock.now()
    const enrollment = await this.enrollments.findById(grant.enrollmentId)

    if (enrollment === null) {
      throw new Error(`La matricula ${grant.enrollmentId} no existe.`)
    }

    // Nunca en una mision anulada: el cierre no deja botin en una anulacion.
    if (enrollment.status === 'VOIDED') {
      if (await this.grants.saveGrant(lootRejected(grant, 'MISSION_VOIDED'), grant.attempts, now)) {
        tally.lootRejected += 1
      }
      return
    }

    // El producto sale del contenido vigente hasta que se congela, y se congela
    // ANTES de enviar: un reintento lleva el mismo cuerpo y no provoca un 409.
    const productId =
      grant.productId ??
      dropProductOf(await this.catalog.findById(enrollment.missionId), grant.label)

    if (
      grant.productId === null &&
      productId !== null &&
      !(await this.grants.freezeProduct({ ...grant, productId }, grant.attempts))
    ) {
      // Otro proceso se adelanto con esta entrega.
      return
    }

    if (productId === null) {
      if (
        await this.grants.saveGrant(
          lootDeferred(grant, 'LOOT_PRODUCT_MISSING', now),
          grant.attempts,
          now,
        )
      ) {
        tally.lootWaiting += 1
      }
      return
    }

    const sending: LootGrantRecord = { ...grant, productId }
    const outcome = await this.inventory.grant({
      operationId: grant.operationId,
      playerId: enrollment.playerId,
      productId,
      quantity: grant.quantity,
    })

    switch (outcome.kind) {
      case 'GRANTED':
        if (await this.grants.saveGrant(lootConfirmed(sending, now), grant.attempts, now)) {
          tally.lootGranted += 1
        }
        return
      case 'REJECTED':
        if (
          await this.grants.saveGrant(lootRejected(sending, outcome.reason), grant.attempts, now)
        ) {
          tally.lootRejected += 1
        }
        return
      case 'UNKNOWN':
        if (
          await this.grants.saveGrant(
            lootDeferred(sending, outcome.reason, now),
            grant.attempts,
            now,
          )
        ) {
          tally.lootRetried += 1
        }
    }
  }
}

export const GRANT_MISSION_LOOT = Symbol('GrantMissionLoot')
