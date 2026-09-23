import {
  grantConfirmed,
  grantDeferred,
  grantRejected,
  type MasterEncounterRecord,
} from '../../domain/entities/MasterEncounterRecord'
import { epicOf } from '../../domain/policies/MasterPolicy'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { EpicGrantPort } from '../ports/EpicGrantPort'
import type { MasterEncounterRepositoryPort } from '../ports/MasterEncounterRepositoryPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface EpicGrantCycleSummary {
  readonly epicsGranted: number
  readonly epicsRetried: number
  /** Sin producto de Catalog todavia (decision 7 de HU-73): se espera. */
  readonly epicsWaiting: number
  readonly epicsRejected: number
  readonly epicsFailed: number
}

type Tally = { -readonly [K in keyof EpicGrantCycleSummary]: number }

export interface EpicGrantOptions {
  readonly batchSize: number
  /** Un fallo en una entrega no detiene a las demas; se informa aqui. */
  readonly onError?: (enrollmentId: string, error: unknown) => void
}

/**
 * Entrega de las epicas ganadas (Task HU-73.2, CU-73.3, pasos 2 y 3; CA-01). El
 * cierre de HU-72 deja cada entrega pendiente; este caso de uso la pide a
 * Player/Inventory con su `operationId` determinista hasta tener respuesta
 * definitiva:
 *
 * - `200`: entregada, y la linea `EPIC` del reporte pasa a `CREDITED`;
 * - rechazo definitivo: queda para revision, y la linea pasa a `FAILED`;
 * - sin respuesta, o sin producto de Catalog todavia: se reintenta despues.
 *
 * Missions solo PIDE la entrega; acreditarla y rechazar otras vias es de HU-32.
 */
export class GrantMasterEpics {
  constructor(
    private readonly masters: MasterEncounterRepositoryPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly catalog: MissionCatalogPort,
    private readonly grants: EpicGrantPort,
    private readonly clock: ClockPort,
    private readonly options: EpicGrantOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<EpicGrantCycleSummary> {
    const tally: Tally = {
      epicsGranted: 0,
      epicsRetried: 0,
      epicsWaiting: 0,
      epicsRejected: 0,
      epicsFailed: 0,
    }

    for (const encounter of await this.masters.pendingGrants(
      this.clock.now(),
      this.options.batchSize,
    )) {
      try {
        await this.deliver(encounter, tally)
      } catch (error: unknown) {
        tally.epicsFailed += 1
        this.options.onError?.(encounter.enrollmentId, error)
        await this.deferAfterFailure(encounter)
      }
    }

    return { ...tally }
  }

  /**
   * Una entrega que falla se aplaza con el mismo escalonado. Si no, conservaria
   * la fecha mas antigua y volveria al frente de la cola en cada ciclo, sin
   * espera y quitandole sitio en el lote a las demas.
   */
  private async deferAfterFailure(encounter: MasterEncounterRecord): Promise<void> {
    const grant = encounter.grant

    if (grant?.status !== 'PENDING') {
      return
    }

    const now = this.clock.now()

    try {
      await this.masters.saveGrant(
        grantDeferred(encounter, 'INTERNAL_ERROR', now),
        grant.attempts,
        now,
      )
    } catch {
      // Sin base no hay como aplazarla: el ciclo siguiente lo vuelve a intentar.
    }
  }

  private async deliver(encounter: MasterEncounterRecord, tally: Tally): Promise<void> {
    const grant = encounter.grant

    if (grant === null) {
      return
    }

    const now = this.clock.now()
    const enrollment = await this.enrollments.findById(encounter.enrollmentId)

    if (enrollment === null) {
      throw new Error(`La matricula ${encounter.enrollmentId} no existe.`)
    }

    // P-X6: nunca en una mision anulada. El cierre no deja evidencia en una
    // anulacion; esto solo cubre un dato que no deberia existir.
    if (enrollment.status === 'VOIDED') {
      if (
        await this.masters.saveGrant(
          grantRejected(encounter, 'MISSION_VOIDED'),
          grant.attempts,
          now,
        )
      ) {
        tally.epicsRejected += 1
      }
      return
    }

    // El producto sale del contenido vigente hasta que se congela, y se congela
    // ANTES de enviar: si despues falla el guardado o se cae el proceso, el
    // reintento lleva el mismo cuerpo y Player/Inventory no responde 409.
    const productId = grant.productId ?? (await this.productOf(enrollment.missionId, encounter))

    if (
      grant.productId === null &&
      productId !== null &&
      !(await this.masters.freezeProduct(
        { ...encounter, grant: { ...grant, productId } },
        grant.attempts,
      ))
    ) {
      // Otro proceso se adelanto con esta entrega.
      return
    }

    if (productId === null) {
      if (
        await this.masters.saveGrant(
          grantDeferred(encounter, 'EPIC_PRODUCT_MISSING', now),
          grant.attempts,
          now,
        )
      ) {
        tally.epicsWaiting += 1
      }
      return
    }

    const sending: MasterEncounterRecord = { ...encounter, grant: { ...grant, productId } }
    const outcome = await this.grants.grant({
      operationId: grant.operationId,
      playerId: enrollment.playerId,
      productId,
    })

    switch (outcome.kind) {
      case 'GRANTED':
        if (await this.masters.saveGrant(grantConfirmed(sending, now), grant.attempts, now)) {
          tally.epicsGranted += 1
        }
        return
      case 'REJECTED':
        if (
          await this.masters.saveGrant(grantRejected(sending, outcome.reason), grant.attempts, now)
        ) {
          tally.epicsRejected += 1
        }
        return
      case 'UNKNOWN':
        if (
          await this.masters.saveGrant(
            grantDeferred(sending, outcome.reason, now),
            grant.attempts,
            now,
          )
        ) {
          tally.epicsRetried += 1
        }
    }
  }

  /** El producto sale del contenido vigente: si Catalog lo crea despues, la entrega sigue. */
  private async productOf(
    missionId: string,
    encounter: MasterEncounterRecord,
  ): Promise<string | null> {
    const definition = await this.catalog.findById(missionId)

    return (
      epicOf(definition?.masterEncounter, encounter.masterRef, encounter.epicRef)?.productId ?? null
    )
  }
}

export const GRANT_MASTER_EPICS = Symbol('GrantMasterEpics')
