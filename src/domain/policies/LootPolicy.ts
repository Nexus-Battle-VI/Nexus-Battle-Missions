import type { LootGrantRecord } from '../entities/LootGrantRecord'
import type { ReportRewardLine } from '../entities/MissionReport'
import { uuidV5 } from '../value-objects/deterministic-uuid'
import { isRecord } from './SettlementPolicy'

const LOOT_GRANT_NAMESPACE = '7b1e4c52-9d3a-4f6e-8a21-5c0d9e8f7a36'

/**
 * `operationId` de la entrega de un botin (P-J1): el mismo al repetir el cierre o
 * la llamada, asi que Player/Inventory no lo entrega dos veces. Un botin por
 * etiqueta y matricula: Combat ya agrupa las tiradas de cada botin en una cantidad.
 */
export const lootGrantOperationId = (enrollmentId: string, label: string): string =>
  uuidV5(LOOT_GRANT_NAMESPACE, `${enrollmentId}:loot:${label}`)

export interface LootItem {
  readonly label: string
  readonly quantity: number
  /** El producto que Combat devolvio con el botin (el que enlazaba el contenido). */
  readonly productId: string | null
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * El producto VIGENTE de un botin segun el contenido, buscado por su etiqueta. El
 * contenido llega de `jsonb` y pudo cambiar despues de la matricula: se lee sin
 * fiarse de su forma. `null` si el botin no tiene producto enlazado.
 */
export const dropProductOf = (definition: unknown, label: string): string | null => {
  const boss = isRecord(definition) ? definition.finalBoss : null
  const drops: readonly unknown[] = isRecord(boss) && Array.isArray(boss.drops) ? boss.drops : []

  for (const drop of drops) {
    if (isRecord(drop) && drop.label === label && isText(drop.productId)) {
      return drop.productId
    }
  }

  return null
}

export interface LootRewards {
  readonly records: readonly LootGrantRecord[]
  /** Las lineas `PRODUCT` del reporte, detras de las de HU-73 y HU-09. */
  readonly rewards: readonly ReportRewardLine[]
}

/**
 * Cada botin ganado deja su entrega pendiente y su linea `PRODUCT` (P-J1). El
 * producto sale del que devolvio Combat o, si no venia, del contenido vigente; si
 * todavia no hay ninguno, la entrega espera a que un administrador lo enlace.
 */
export const lootRewardsOf = (input: {
  readonly enrollmentId: string
  readonly loot: readonly LootItem[]
  readonly definition: unknown
  readonly firstLineNo: number
  readonly now: Date
}): LootRewards => {
  const records: LootGrantRecord[] = []
  const rewards: ReportRewardLine[] = []

  for (const item of input.loot) {
    const lineNo = input.firstLineNo + rewards.length

    rewards.push({
      lineNo,
      kind: 'PRODUCT',
      reference: item.label,
      name: item.label,
      rarity: null,
      quantity: item.quantity,
      status: 'PENDING',
      source: 'HU-72',
      progression: null,
      updatedAt: input.now,
    })
    records.push({
      enrollmentId: input.enrollmentId,
      lineNo,
      label: item.label,
      quantity: item.quantity,
      operationId: lootGrantOperationId(input.enrollmentId, item.label),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: input.now,
      lastError: null,
      grantedAt: null,
      productId: item.productId ?? dropProductOf(input.definition, item.label),
    })
  }

  return { records, rewards }
}
