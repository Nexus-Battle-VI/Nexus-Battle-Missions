import type {
  CompletionEntry,
  CompletionGrantOutcome,
  MissionDefinition,
} from '../entities/MissionDefinition'
import type { SimulationRequest } from '../entities/MissionExecution'
import { scalingOf, type RewardTier } from '../value-objects/difficulty-scaling'
import { DIFFICULTY_LEVELS, type DifficultyLevel } from '../value-objects/difficulty-level'

/**
 * Derechos de recompensa de FINALIZACION de una mision (HU-10, Task HU-10.4;
 * `hu-10-mission-completion-reward-v1` §4, §5 y §6).
 *
 * ES UNA POLITICA PURA: no lee la base, no llama a Wallet ni a Player/Inventory,
 * no usa aleatoriedad, no consulta el catalogo vivo y no escribe nada. Transforma
 * el CONTENIDO CONGELADO de la ejecucion, la dificultad realmente ejecutada, el
 * desenlace y los objetivos en una lista de derechos, tambien congelables. La
 * entrega de esos derechos es de HU-10.5.
 *
 * DE DONDE SALEN LOS MONTOS. SOLO de `rewards.completion` del contenido congelado.
 * No hay tabla global («Normal = X»), no se deriva nada de `rewardTier`, y una
 * dificultad que no figura en un mapa NO tiene derecho (ni se usa otra, ni se
 * interpola, ni se multiplica).
 *
 * DESENLACES. Lista CERRADA: solo `COMPLETED` y `FAILED` liquidan. `IN_PROGRESS`,
 * `VOIDED`, `ABANDONED` (regla pendiente, P-HU10-1) y cualquier valor desconocido
 * NO producen derechos.
 *
 *   - La XP de finalizacion aplica en `COMPLETED` y `FAILED` [PO #19].
 *   - Creditos, productos y bonificaciones aplican SOLO si la entrada declara el
 *     desenlace en `grantOn`. No se infiere que `FAILED` reciba lo de `COMPLETED`
 *     (P-HU10-3).
 *   - `FIRST_TIME` NO es liquidable hasta que el PO defina «primera vez»
 *     (P-HU10-4): la forma existe y se valida, pero no genera derecho.
 */

/** Un derecho ya calculado y congelado. No lleva ningun efecto: es un dato. */
export type CompletionEntitlement =
  | {
      readonly rewardKey: string
      readonly kind: 'EXPERIENCE'
      readonly group: 'COMPLETION'
      readonly amount: number
    }
  | {
      readonly rewardKey: string
      readonly kind: 'CREDITS'
      readonly group: CompletionEntry['group']
      readonly entryKey: string
      readonly amount: number
    }
  | {
      readonly rewardKey: string
      readonly kind: 'PRODUCT'
      readonly group: CompletionEntry['group']
      readonly entryKey: string
      readonly productId: string
      readonly quantity: number
    }

export type NoEntitlementReason =
  'OUTCOME_NOT_LIQUIDABLE' | 'SNAPSHOT_MISSING' | 'NO_COMPLETION_CONFIG' | 'UNKNOWN_DIFFICULTY'

export interface CompletionRewardEvaluation {
  /** Dificultad realmente ejecutada (la de la matricula). `null` si no es del vocabulario. */
  readonly difficulty: DifficultyLevel | null
  /** Evidencia congelada: NO se usa para derivar montos. */
  readonly rewardTier: RewardTier | null
  readonly entitlements: readonly CompletionEntitlement[]
  /** Por que no hay derechos, cuando no los hay. `null` si hay al menos uno. */
  readonly reason: NoEntitlementReason | null
  /** Entradas que existen pero no son liquidables todavia (p. ej. `FIRST_TIME`). */
  readonly skipped: readonly { readonly key: string; readonly reason: string }[]
}

export interface ObjectiveOutcome {
  readonly id: string
  /** `null`: no aplico o no es evaluable. Solo `true` da derecho a una bonificacion. */
  readonly met: boolean | null
}

const LIQUIDABLE_OUTCOMES: readonly string[] = ['COMPLETED', 'FAILED']

const GROUP_PREFIX = {
  GUARANTEED: 'guaranteed',
  OBJECTIVE_BONUS: 'objective-bonus',
  FIRST_TIME: 'first-time',
} as const

/**
 * El contenido con el que se SIMULO la ejecucion: `request.contentSnapshot`, o
 * `null` si no lo trae. **No hay fallback al catalogo vivo**: liquidar contra
 * contenido editado despues de la ejecucion daria valores que no son los de esa
 * ejecucion (CA-06). Sin snapshot no hay derechos.
 */
export const frozenContentOf = (
  request: Pick<SimulationRequest, 'contentSnapshot'> | null | undefined,
): MissionDefinition | null => request?.contentSnapshot ?? null

const none = (
  reason: NoEntitlementReason,
  difficulty: DifficultyLevel | null,
  rewardTier: RewardTier | null,
): CompletionRewardEvaluation => ({
  difficulty,
  rewardTier,
  entitlements: [],
  reason,
  skipped: [],
})

export const completionRewardsOf = (input: {
  /** Contenido congelado de la ejecucion (`frozenContentOf`). */
  readonly content: MissionDefinition | null
  readonly difficulty: string
  readonly outcome: string
  readonly objectives: readonly ObjectiveOutcome[]
}): CompletionRewardEvaluation => {
  const difficulty = (DIFFICULTY_LEVELS as readonly string[]).includes(input.difficulty)
    ? (input.difficulty as DifficultyLevel)
    : null
  const rewardTier = difficulty === null ? null : scalingOf(difficulty).rewardTier

  if (!LIQUIDABLE_OUTCOMES.includes(input.outcome)) {
    return none('OUTCOME_NOT_LIQUIDABLE', difficulty, rewardTier)
  }

  if (difficulty === null) {
    return none('UNKNOWN_DIFFICULTY', null, null)
  }

  if (input.content === null) {
    return none('SNAPSHOT_MISSING', difficulty, rewardTier)
  }

  const completion = input.content.rewards.completion

  if (completion === undefined) {
    return none('NO_COMPLETION_CONFIG', difficulty, rewardTier)
  }

  const outcome = input.outcome as CompletionGrantOutcome
  const entitlements: CompletionEntitlement[] = []
  const skipped: { key: string; reason: string }[] = []
  const xp = completion.experience?.amountByDifficulty[difficulty]

  // La XP de finalizacion: COMPLETED y FAILED, sin `grantOn`.
  if (xp !== undefined) {
    entitlements.push({
      rewardKey: 'completion:xp',
      kind: 'EXPERIENCE',
      group: 'COMPLETION',
      amount: xp,
    })
  }

  const met = new Map(input.objectives.map((objective) => [objective.id, objective.met]))

  for (const entry of completion.entries ?? []) {
    if (entry.group === 'FIRST_TIME') {
      // P-HU10-4: sin definicion de «primera vez» no es liquidable.
      skipped.push({ key: entry.key, reason: 'FIRST_TIME_UNDEFINED' })
      continue
    }

    if (!entry.grantOn.includes(outcome)) continue

    if (entry.group === 'OBJECTIVE_BONUS' && met.get(entry.objectiveId ?? '') !== true) continue

    const rewardKey = `${GROUP_PREFIX[entry.group]}:${entry.key}`

    if (entry.reward.kind === 'CREDITS') {
      const amount = entry.reward.amountByDifficulty[difficulty]

      if (amount !== undefined) {
        entitlements.push({
          rewardKey,
          kind: 'CREDITS',
          group: entry.group,
          entryKey: entry.key,
          amount,
        })
      }
    } else {
      const quantity = entry.reward.quantityByDifficulty[difficulty]

      if (quantity !== undefined) {
        entitlements.push({
          rewardKey,
          kind: 'PRODUCT',
          group: entry.group,
          entryKey: entry.key,
          productId: entry.reward.productId,
          quantity,
        })
      }
    }
  }

  return {
    difficulty,
    rewardTier,
    entitlements,
    reason: entitlements.length === 0 ? 'NO_COMPLETION_CONFIG' : null,
    skipped,
  }
}
