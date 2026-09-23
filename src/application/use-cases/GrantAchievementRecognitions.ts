import {
  recognitionCredited,
  recognitionDeferred,
  recognitionFailed,
  type AchievementDefinition,
  type AchievementUnlock,
  type RecognitionGrant,
} from '../../domain/entities/Achievement'
import type { AchievementCatalogPort } from '../ports/AchievementCatalogPort'
import type { AchievementRepositoryPort } from '../ports/AchievementRepositoryPort'
import type { ClockPort } from '../ports/ClockPort'
import type { RecognitionGrantPort } from '../ports/RecognitionGrantPort'

export interface RecognitionCycleSummary {
  readonly recognitionsCredited: number
  readonly recognitionsRetried: number
  /** Sin producto de Catalog todavia: se espera sin llamar a Player/Inventory. */
  readonly recognitionsWaiting: number
  readonly recognitionsRejected: number
  readonly recognitionsFailed: number
}

type Tally = { -readonly [K in keyof RecognitionCycleSummary]: number }

export interface RecognitionGrantOptions {
  readonly batchSize: number
  /** Un fallo en una entrega no detiene a las demas; se informa aqui. */
  readonly onError?: (error: unknown) => void
}

/** El producto del cosmetico en la definicion vigente; `null` si ya no esta o aun no existe. */
const productOf = (
  definitions: readonly AchievementDefinition[],
  achievementId: string,
): string | null => {
  const recognition = definitions.find(
    (definition) => definition.achievementId === achievementId,
  )?.recognition

  return recognition?.kind === 'COSMETIC_PRODUCT' ? recognition.productId : null
}

/**
 * Entrega de los cosmeticos de logro (Task HU-76.2, CU-76.2; CA-01), con el
 * mismo patron que la epica de HU-73: un `operationId` determinista por jugador
 * y logro, el producto congelado ANTES del primer envio y el reintento
 * escalonado. Nunca hay una transaccion abierta durante la llamada.
 *
 * - `200`: entregado (`CREDITED`);
 * - rechazo definitivo: `FAILED`, visible en la consulta y para revision;
 * - sin respuesta, o sin producto todavia: se reintenta despues.
 *
 * Los titulos y las insignias no pasan por aqui: se registran al desbloquear.
 */
export class GrantAchievementRecognitions {
  constructor(
    private readonly achievements: AchievementRepositoryPort,
    private readonly catalog: AchievementCatalogPort,
    private readonly grants: RecognitionGrantPort,
    private readonly clock: ClockPort,
    private readonly options: RecognitionGrantOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<RecognitionCycleSummary> {
    const tally: Tally = {
      recognitionsCredited: 0,
      recognitionsRetried: 0,
      recognitionsWaiting: 0,
      recognitionsRejected: 0,
      recognitionsFailed: 0,
    }
    const pending = await this.achievements.pendingRecognitionGrants(
      this.clock.now(),
      this.options.batchSize,
    )

    if (pending.length === 0) {
      return { ...tally }
    }

    const definitions = await this.catalog.list()

    for (const unlock of pending) {
      const grant = unlock.grant

      // Solo un cosmetico pendiente tiene entrega; lo demas no se toca.
      if (grant === null || unlock.recognition.status !== 'PENDING') {
        continue
      }

      try {
        await this.deliver(unlock, grant, definitions, tally)
      } catch (error: unknown) {
        tally.recognitionsFailed += 1
        this.options.onError?.(error)
        await this.deferAfterFailure(unlock, grant)
      }
    }

    return { ...tally }
  }

  /** Como en HU-73: una entrega que falla se aplaza para no volver al frente de la cola. */
  private async deferAfterFailure(
    unlock: AchievementUnlock,
    grant: RecognitionGrant,
  ): Promise<void> {
    try {
      await this.achievements.saveRecognitionGrant(
        recognitionDeferred(unlock, 'INTERNAL_ERROR', this.clock.now()),
        grant.attempts,
      )
    } catch {
      // Sin base no hay como aplazarla: el ciclo siguiente lo vuelve a intentar.
    }
  }

  private async deliver(
    unlock: AchievementUnlock,
    grant: RecognitionGrant,
    definitions: readonly AchievementDefinition[],
    tally: Tally,
  ): Promise<void> {
    const now = this.clock.now()
    // El producto sale del catalogo vigente hasta que se congela, y se congela
    // ANTES de enviar: cada reintento lleva el mismo cuerpo y Player/Inventory no
    // responde 409.
    const productId = grant.productId ?? productOf(definitions, unlock.achievementId)

    if (
      grant.productId === null &&
      productId !== null &&
      !(await this.achievements.freezeRecognitionProduct(
        { ...unlock, grant: { ...grant, productId } },
        grant.attempts,
      ))
    ) {
      // Otro proceso se adelanto con esta entrega.
      return
    }

    if (productId === null) {
      if (
        await this.achievements.saveRecognitionGrant(
          recognitionDeferred(unlock, 'RECOGNITION_PRODUCT_MISSING', now),
          grant.attempts,
        )
      ) {
        tally.recognitionsWaiting += 1
      }
      return
    }

    const sending: AchievementUnlock = { ...unlock, grant: { ...grant, productId } }
    const outcome = await this.grants.grant({
      operationId: grant.operationId,
      playerId: unlock.playerId,
      productId,
    })

    switch (outcome.kind) {
      case 'GRANTED':
        if (
          await this.achievements.saveRecognitionGrant(
            recognitionCredited(sending, now),
            grant.attempts,
          )
        ) {
          tally.recognitionsCredited += 1
        }
        return
      case 'REJECTED':
        if (
          await this.achievements.saveRecognitionGrant(
            recognitionFailed(sending, outcome.reason),
            grant.attempts,
          )
        ) {
          tally.recognitionsRejected += 1
        }
        return
      case 'UNKNOWN':
        if (
          await this.achievements.saveRecognitionGrant(
            recognitionDeferred(sending, outcome.reason, now),
            grant.attempts,
          )
        ) {
          tally.recognitionsRetried += 1
        }
    }
  }
}

export const GRANT_ACHIEVEMENT_RECOGNITIONS = Symbol('GrantAchievementRecognitions')
