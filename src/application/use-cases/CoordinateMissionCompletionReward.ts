import {
  completionOperationIdOf,
  deliveryCredited,
  deliveryDeferred,
  deliveryRejected,
  type MissionCompletionRewardDelivery,
} from '../../domain/entities/MissionCompletionRewardDelivery'
import type { ReportLineUpdate } from '../../domain/entities/MissionReport'
import type { ClockPort } from '../ports/ClockPort'
import type {
  CompletionExperienceCreditOutcome,
  CompletionExperienceCreditPort,
} from '../ports/CompletionExperienceCreditPort'
import type {
  CompletionProductGrantOutcome,
  CompletionProductGrantPort,
} from '../ports/CompletionProductGrantPort'
import type { MissionCompletionRewardRepositoryPort } from '../ports/MissionCompletionRewardRepositoryPort'
import type { WalletCreditOutcome, WalletCreditPort } from '../ports/WalletCreditPort'

export interface MissionCompletionRewardCycleSummary {
  readonly xpCredited: number
  readonly creditsCredited: number
  readonly productsCredited: number
  /** Rechazo definitivo: queda visible y no se reintenta. */
  readonly rejected: number
  /** Sin respuesta definitiva: se reintenta con la MISMA clave. */
  readonly retried: number
  /** El intento lanzo: se aplaza y se informa, sin detener a las demas. */
  readonly failed: number
}

type Tally = { -readonly [K in keyof MissionCompletionRewardCycleSummary]: number }

export interface MissionCompletionRewardOptions {
  readonly batchSize: number
  /** Una entrega que falla no detiene a las demas; se informa aqui. */
  readonly onError?: (enrollmentId: string, rewardKey: string, error: unknown) => void
}

/**
 * Coordinacion de la liquidacion de finalizacion de mision (HU-10, Task HU-10.5;
 * `hu-10-mission-completion-reward-v1` §13, §14 y §16).
 *
 * EL CIERRE (`RunMissionExecutions.close`) YA DEJO cada derecho como una entrega
 * `PENDING`, con su `amount`/`quantity` congelado por `CompletionRewardPolicy` y
 * su linea `HU-10` en el reporte. Este ciclo solo AVANZA lo que quede pendiente,
 * una entrega a la vez:
 *
 *   - `EXPERIENCE` -> Player/Inventory (`source.kind = MISSION_COMPLETION`);
 *   - `CREDITS`    -> Wallet (`POST .../credits/mission-reward`);
 *   - `PRODUCT`    -> Player/Inventory (`POST .../inventory/grants`, mismo
 *     contrato que la epica de HU-73 y el botin de HU-72).
 *
 * SIN TRANSACCION DISTRIBUIDA (ADR-019, contrato §16): cada llamada externa
 * ocurre AQUI, fuera de cualquier transaccion de base; el resultado se persiste
 * DESPUES, en una escritura local propia. Nunca se abre una transaccion de
 * PostgreSQL para despues esperar una respuesta HTTP.
 *
 * UNA ENTREGA QUE FALLA NO ARRASTRA A LAS DEMAS: cada una tiene su propia clave y
 * su propio estado (contrato §16). Y NINGUN FALLO REVIERTE LA MISION: la
 * recompensa es un efecto posterior del cierre, no una condicion suya.
 */
export class CoordinateMissionCompletionReward {
  constructor(
    private readonly deliveries: MissionCompletionRewardRepositoryPort,
    private readonly xp: CompletionExperienceCreditPort,
    private readonly wallet: WalletCreditPort,
    private readonly products: CompletionProductGrantPort,
    private readonly clock: ClockPort,
    private readonly options: MissionCompletionRewardOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<MissionCompletionRewardCycleSummary> {
    const tally: Tally = {
      xpCredited: 0,
      creditsCredited: 0,
      productsCredited: 0,
      rejected: 0,
      retried: 0,
      failed: 0,
    }

    for (const delivery of await this.deliveries.dueDeliveries(
      this.now(),
      this.options.batchSize,
    )) {
      try {
        await this.deliver(delivery, tally)
      } catch (error: unknown) {
        tally.failed += 1
        this.options.onError?.(delivery.enrollmentId, delivery.rewardKey, error)
        await this.deferAfterFailure(delivery)
      }
    }

    return { ...tally }
  }

  private async deliver(delivery: MissionCompletionRewardDelivery, tally: Tally): Promise<void> {
    switch (delivery.kind) {
      case 'EXPERIENCE':
        await this.deliverExperience(delivery, tally)
        return
      case 'CREDITS':
        await this.deliverCredits(delivery, tally)
        return
      case 'PRODUCT':
        await this.deliverProduct(delivery, tally)
    }
  }

  /** XP de finalizacion: la MISMA ruta de HU-09, con `source.kind = MISSION_COMPLETION`. */
  private async deliverExperience(
    delivery: MissionCompletionRewardDelivery & { readonly kind: 'EXPERIENCE' },
    tally: Tally,
  ): Promise<void> {
    const outcome = await this.xp.credit({
      operationId: completionOperationIdOf(delivery),
      playerId: delivery.playerId,
      heroId: delivery.heroId,
      amount: delivery.amount,
      source: {
        kind: 'MISSION_COMPLETION',
        enrollmentId: delivery.enrollmentId,
        missionId: delivery.missionId,
        simulationId: delivery.simulationId,
        difficulty: delivery.difficulty,
        missionOutcome: delivery.missionOutcome,
      },
    })

    await this.advance(delivery, outcome, tally, 'xpCredited')
  }

  /** Creditos de mision: Wallet, con el `rewardKey` y el `occurredAt` congelados. */
  private async deliverCredits(
    delivery: MissionCompletionRewardDelivery & { readonly kind: 'CREDITS' },
    tally: Tally,
  ): Promise<void> {
    const outcome = await this.wallet.credit({
      operationId: completionOperationIdOf(delivery),
      playerId: delivery.playerId,
      enrollmentId: delivery.enrollmentId,
      missionId: delivery.missionId,
      difficulty: delivery.difficulty,
      rewardKey: delivery.rewardKey,
      creditsAmount: delivery.amount,
      occurredAt: delivery.settledAt,
    })

    await this.advance(delivery, outcome, tally, 'creditsCredited')
  }

  /** Producto garantizado, de objetivo o de primera vez: mismo contrato que HU-72/HU-73. */
  private async deliverProduct(
    delivery: MissionCompletionRewardDelivery & { readonly kind: 'PRODUCT' },
    tally: Tally,
  ): Promise<void> {
    const outcome = await this.products.grant({
      operationId: completionOperationIdOf(delivery),
      playerId: delivery.playerId,
      productId: delivery.productId,
      quantity: delivery.quantity,
    })

    // `inventory/grants` no distingue "entregado" de "aplicado esta vez": para
    // Missions las dos son la misma linea `CREDITED`.
    const normalized: CompletionExperienceCreditOutcome | WalletCreditOutcome =
      outcome.kind === 'GRANTED' ? { kind: 'CREDITED', progression: null } : outcome

    await this.advance(delivery, normalized, tally, 'productsCredited')
  }

  /**
   * Aplica el desenlace de UNA llamada externa a la entrega y a su linea del
   * reporte, en una unica escritura local. `creditedCounter` distingue en el
   * resumen que dependencia se acredito, sin tres metodos casi iguales.
   */
  private async advance(
    delivery: MissionCompletionRewardDelivery,
    // El producto llega YA normalizado (`deliverProduct`): `GRANTED` no es una
    // forma que este metodo necesite conocer.
    outcome: CompletionExperienceCreditOutcome | WalletCreditOutcome,
    tally: Tally,
    creditedCounter: 'xpCredited' | 'creditsCredited' | 'productsCredited',
  ): Promise<void> {
    const now = this.now()
    const next =
      outcome.kind === 'CREDITED'
        ? deliveryCredited(delivery, now)
        : outcome.kind === 'REJECTED'
          ? deliveryRejected(delivery, outcome.reason)
          : deliveryDeferred(delivery, outcome.reason, now)

    const line = lineUpdateOf(outcome, delivery, now)

    if (await this.deliveries.save(next, delivery.attempts, line)) {
      if (outcome.kind === 'CREDITED') {
        tally[creditedCounter] += 1
      } else if (outcome.kind === 'REJECTED') {
        tally.rejected += 1
      } else {
        tally.retried += 1
      }
    }
  }

  /** Un intento que lanzo (p. ej. un error de programacion) se aplaza, sin perder el derecho. */
  private async deferAfterFailure(delivery: MissionCompletionRewardDelivery): Promise<void> {
    const now = this.now()

    try {
      await this.deliveries.save(
        deliveryDeferred(delivery, 'INTERNAL_ERROR', now),
        delivery.attempts,
      )
    } catch {
      // Sin base no hay como aplazarla: el ciclo siguiente lo vuelve a intentar.
    }
  }

  private now(): Date {
    return this.clock.now()
  }
}

export const COORDINATE_MISSION_COMPLETION_REWARD = Symbol('CoordinateMissionCompletionReward')

/**
 * El reflejo de un desenlace en la linea `HU-10`, o `null` si no fue definitivo
 * (la linea sigue `PENDING`). `quantity` YA esta en la linea desde que nacio (a
 * diferencia de HU-09): aqui solo cambia su estado y, en la de experiencia, la
 * progresion.
 */
const lineUpdateOf = (
  outcome: CompletionExperienceCreditOutcome | WalletCreditOutcome | CompletionProductGrantOutcome,
  delivery: MissionCompletionRewardDelivery,
  at: Date,
): ReportLineUpdate | null => {
  if (outcome.kind === 'UNKNOWN') {
    return null
  }

  const quantity = delivery.kind === 'PRODUCT' ? delivery.quantity : delivery.amount

  if (outcome.kind === 'REJECTED') {
    return { status: 'FAILED', quantity, progression: null, at }
  }

  return {
    status: 'CREDITED',
    quantity,
    // Solo la entrega de experiencia trae progresion; Missions nunca la calcula.
    progression:
      delivery.kind === 'EXPERIENCE' && 'progression' in outcome ? outcome.progression : null,
    at,
  }
}
