import type { CompletionEntitlement } from './CompletionRewardPolicy'
import type { DifficultyLevel } from '../value-objects/difficulty-level'
import type { ReportRewardLine } from '../entities/MissionReport'
import type { MissionCompletionRewardDelivery } from '../entities/MissionCompletionRewardDelivery'

/**
 * Convierte los DERECHOS ya decididos por `CompletionRewardPolicy` (HU-10.4) en
 * entregas persistibles y en las lineas `HU-10` del reporte de HU-74 (HU-10, Task
 * HU-10.5; `hu-10-mission-completion-reward-v1` §7).
 *
 * NO VUELVE A DECIDIR NADA. `CompletionRewardPolicy.completionRewardsOf` es la
 * UNICA autoridad sobre que se debe (dificultad, `grantOn`, objetivos, snapshot);
 * este modulo solo empaqueta esos derechos ya calculados en filas `PENDING`, igual
 * que `CombatLogPolicy.experienceRewardsOf` empaqueta las derrotas de HU-09 y
 * `LootPolicy.lootRewardsOf` el botin de HU-72.
 *
 * NACE CON SU VALOR. A diferencia de una recompensa de HU-09 (que nace en `0`
 * porque su importe depende de una tirada posterior), una entrega de HU-10 ya
 * conoce su `amount`/`quantity` cuando se crea: el derecho esta congelado desde
 * `CompletionRewardPolicy`.
 *
 * ES PURO: no llama a Wallet, a Player/Inventory, ni genera aleatoriedad. Solo
 * transforma datos ya decididos.
 */
export interface CompletionRewardDeliveries {
  /** Las entregas `PENDING`, cada una con su linea ya asignada. */
  readonly deliveries: readonly MissionCompletionRewardDelivery[]
  /** Las lineas `HU-10` del reporte, en el mismo orden que las entregas. */
  readonly lines: readonly ReportRewardLine[]
}

/** El nombre legible de una linea, sin identificadores tecnicos (contrato §7). */
const nameOf = (entitlement: CompletionEntitlement): string => {
  switch (entitlement.kind) {
    case 'EXPERIENCE':
      return 'Experiencia de finalización'
    case 'CREDITS':
      return 'Créditos de finalización'
    case 'PRODUCT':
      // El contenido de HU-10 no lleva una etiqueta legible para el producto (a
      // diferencia del botin de HU-72): se usa la clave de la entrada, que si es
      // legible por construccion (regex de HU-10.4).
      return entitlement.entryKey
  }
}

export const completionRewardDeliveriesOf = (input: {
  readonly enrollmentId: string
  readonly playerId: string
  readonly heroId: string
  readonly missionId: string
  readonly simulationId: string
  readonly difficulty: DifficultyLevel
  readonly missionOutcome: 'COMPLETED' | 'FAILED'
  readonly entitlements: readonly CompletionEntitlement[]
  /** El numero de la primera linea libre: las de HU-73, HU-09 y HU-72 van delante. */
  readonly firstLineNo: number
  readonly settledAt: Date
}): CompletionRewardDeliveries => {
  const deliveries: MissionCompletionRewardDelivery[] = []
  const lines: ReportRewardLine[] = []

  for (const [index, entitlement] of input.entitlements.entries()) {
    const lineNo = input.firstLineNo + index
    const base = {
      enrollmentId: input.enrollmentId,
      playerId: input.playerId,
      heroId: input.heroId,
      missionId: input.missionId,
      simulationId: input.simulationId,
      difficulty: input.difficulty,
      missionOutcome: input.missionOutcome,
      rewardKey: entitlement.rewardKey,
      settledAt: input.settledAt,
      status: 'PENDING' as const,
      attempts: 0,
      // Nace lista para su primer intento (mismo criterio que HU-09 y HU-72).
      nextAttemptAt: input.settledAt,
      lastError: null,
      creditedAt: null,
      reportLineNo: lineNo,
    }

    deliveries.push(
      entitlement.kind === 'PRODUCT'
        ? {
            ...base,
            kind: 'PRODUCT',
            productId: entitlement.productId,
            quantity: entitlement.quantity,
          }
        : { ...base, kind: entitlement.kind, amount: entitlement.amount },
    )

    lines.push({
      lineNo,
      kind: entitlement.kind,
      reference: entitlement.rewardKey,
      name: nameOf(entitlement),
      rarity: null,
      quantity: entitlement.kind === 'PRODUCT' ? entitlement.quantity : entitlement.amount,
      status: 'PENDING',
      source: 'HU-10',
      // La progresion solo se conoce cuando Player/Inventory confirma la XP; no se inventa antes.
      progression: null,
      updatedAt: input.settledAt,
    })
  }

  return { deliveries, lines }
}
