import type { MissionDefinition } from '../entities/MissionDefinition'
import { assertMasterConfig } from './MasterPolicy'
import { isRecord } from './SettlementPolicy'

export class InvalidMissionContentError extends Error {
  constructor(readonly field: string) {
    super(`El contenido de la mision no es valido: ${field}.`)
    this.name = 'InvalidMissionContentError'
  }
}

const requireValue = (condition: boolean, field: string): void => {
  if (!condition) throw new InvalidMissionContentError(field)
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const count = (value: unknown, min = 0, max = 1_000_000): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const drops = (value: unknown, field: string): void => {
  requireValue(Array.isArray(value) && value.length <= 50, field)
  if (!Array.isArray(value)) return
  for (const [index, item] of (value as unknown[]).entries()) {
    requireValue(
      isRecord(item) &&
        text(item.label) &&
        probability(item.probability) &&
        count(item.rolls, 1, 100) &&
        (item.productId === undefined ||
          item.productId === null ||
          (typeof item.productId === 'string' && uuid.test(item.productId))),
      `${field}[${String(index)}]`,
    )
  }
}

const fighter = (value: unknown, field: string): void => {
  requireValue(isRecord(value), field)
  if (!isRecord(value)) return
  requireValue(count(value.maxHealth, 1), `${field}.maxHealth`)
  requireValue(count(value.attack), `${field}.attack`)
  requireValue(count(value.defense), `${field}.defense`)
  requireValue(
    count(value.damage) ||
      (isRecord(value.damage) &&
        ((value.damage.mode === 'FIXED' && count(value.damage.amount)) ||
          (value.damage.mode === 'DICE' &&
            count(value.damage.count, 1, 100) &&
            count(value.damage.sides, 2, 8000)))),
    `${field}.damage`,
  )
  const ai: unknown = value.ai ?? 'AGGRESSIVE'
  requireValue(
    typeof ai === 'string' && ['AGGRESSIVE', 'GUARDED', 'BOSS'].includes(ai),
    `${field}.ai`,
  )
  if (value.ai === 'BOSS') {
    requireValue(count(value.enrageBelowPercent ?? 50, 1, 100), `${field}.enrageBelowPercent`)
    requireValue(count(value.enrageAttackBonus ?? 0), `${field}.enrageAttackBonus`)
  }
}

/** Validate editable JSON before it can reach enrollment or Combat. */
export const missionDefinitionOf = (input: unknown, missionId: string): MissionDefinition => {
  requireValue(isRecord(input), 'body')
  if (!isRecord(input)) throw new InvalidMissionContentError('body')
  requireValue(/^[a-z0-9_-]{3,100}$/u.test(missionId), 'missionId')
  requireValue(input.missionId === missionId, 'missionId')
  requireValue(text(input.name), 'name')
  requireValue(['STORY', 'CHALLENGE', 'EXPLORATION'].includes(String(input.category)), 'category')
  requireValue(text(input.summary), 'summary')
  requireValue(text(input.narrative), 'narrative')
  requireValue(input.imageRef === null || text(input.imageRef), 'imageRef')
  requireValue(count(input.estimatedDurationMinutes, 1, 7 * 24 * 60), 'estimatedDurationMinutes')
  requireValue(input.recommendedPower === null || count(input.recommendedPower), 'recommendedPower')
  requireValue(
    Array.isArray(input.prerequisites) && input.prerequisites.every(text),
    'prerequisites',
  )
  requireValue(typeof input.active === 'boolean', 'active')
  requireValue(Array.isArray(input.objectives) && input.objectives.length > 0, 'objectives')
  for (const [index, objective] of (input.objectives as unknown[]).entries()) {
    requireValue(
      isRecord(objective) &&
        text(objective.id) &&
        text(objective.text) &&
        typeof objective.primary === 'boolean',
      `objectives[${String(index)}]`,
    )
    if (isRecord(objective) && objective.rule !== null) {
      requireValue(
        isRecord(objective.rule) &&
          [
            'DEFEAT_BOSS',
            'CLEAR_ENCOUNTERS',
            'MIN_HEALTH_PERCENT',
            'DEFEAT_MASTER',
            'COLLECT_LOOT',
          ].includes(String(objective.rule.type)),
        `objectives[${String(index)}].rule`,
      )
      if (isRecord(objective.rule) && objective.rule.type === 'CLEAR_ENCOUNTERS') {
        requireValue(count(objective.rule.count, 1, 50), `objectives[${String(index)}].rule.count`)
      }
      if (isRecord(objective.rule) && objective.rule.type === 'MIN_HEALTH_PERCENT') {
        requireValue(
          count(objective.rule.percent, 0, 100),
          `objectives[${String(index)}].rule.percent`,
        )
      }
      if (isRecord(objective.rule) && objective.rule.type === 'COLLECT_LOOT') {
        requireValue(
          text(objective.rule.label) && count(objective.rule.count, 1, 100),
          `objectives[${String(index)}].rule`,
        )
      }
    }
  }
  requireValue(Array.isArray(input.enemies), 'enemies')
  const refs = new Set<string>()
  const declaredCounts = new Map<string, number>()
  for (const [index, enemy] of (input.enemies as unknown[]).entries()) {
    requireValue(
      isRecord(enemy) && text(enemy.enemyRef) && text(enemy.name) && count(enemy.count, 1),
      `enemies[${String(index)}]`,
    )
    if (!isRecord(enemy)) continue
    refs.add(enemy.enemyRef as string)
    declaredCounts.set(enemy.enemyRef as string, enemy.count as number)
    fighter(enemy.profile, `enemies[${String(index)}].profile`)
  }
  requireValue(refs.size === (input.enemies as unknown[]).length, 'enemies.enemyRef')
  requireValue(
    isRecord(input.finalBoss) && text(input.finalBoss.enemyRef) && text(input.finalBoss.name),
    'finalBoss',
  )
  if (!isRecord(input.finalBoss)) throw new InvalidMissionContentError('finalBoss')
  fighter(input.finalBoss.profile, 'finalBoss.profile')
  drops(input.finalBoss.drops ?? [], 'finalBoss.drops')
  requireValue(!refs.has(input.finalBoss.enemyRef as string), 'finalBoss.enemyRef')
  refs.add(input.finalBoss.enemyRef as string)
  requireValue(
    Array.isArray(input.encounters) && input.encounters.length > 0 && input.encounters.length <= 50,
    'encounters',
  )
  const encounters = input.encounters as unknown[]
  const encounterCounts = new Map<string, number>()
  for (const [index, encounter] of encounters.entries()) {
    requireValue(
      isRecord(encounter) &&
        encounter.index === index + 1 &&
        encounter.kind === (index === encounters.length - 1 ? 'BOSS' : 'REGULAR') &&
        (encounter.powerStep === null ||
          (typeof encounter.powerStep === 'number' &&
            encounter.powerStep >= 0 &&
            encounter.powerStep <= 2)) &&
        Array.isArray(encounter.enemies) &&
        encounter.enemies.length > 0,
      `encounters[${String(index)}]`,
    )
    if (!isRecord(encounter) || !Array.isArray(encounter.enemies)) continue
    for (const entry of encounter.enemies as unknown[]) {
      requireValue(
        isRecord(entry) && refs.has(String(entry.enemyRef)) && count(entry.count, 1),
        `encounters[${String(index)}].enemies`,
      )
      if (isRecord(entry)) {
        const ref = entry.enemyRef as string
        requireValue(
          (encounter.kind === 'BOSS') === (ref === input.finalBoss.enemyRef),
          `encounters[${String(index)}].kind`,
        )
        encounterCounts.set(ref, (encounterCounts.get(ref) ?? 0) + (entry.count as number))
      }
    }
  }
  requireValue(
    encounterCounts.get(input.finalBoss.enemyRef as string) === 1,
    'finalBoss.encounters',
  )
  for (const [ref, declared] of declaredCounts) {
    requireValue(encounterCounts.get(ref) === declared, `enemies.${ref}.count`)
  }
  const rules = input.combatRules
  requireValue(isRecord(rules), 'combatRules')
  if (isRecord(rules)) {
    requireValue(count(rules.turnDurationSeconds, 1, 3600), 'combatRules.turnDurationSeconds')
    requireValue(count(rules.maxTurnsPerEncounter, 1, 1000), 'combatRules.maxTurnsPerEncounter')
    requireValue(count(rules.recoveryPercent, 0, 100), 'combatRules.recoveryPercent')
    requireValue(probability(rules.criticalChance), 'combatRules.criticalChance')
    requireValue(
      typeof rules.criticalMultiplier === 'number' &&
        rules.criticalMultiplier >= 1 &&
        rules.criticalMultiplier <= 1.8,
      'combatRules.criticalMultiplier',
    )
    if (rules.difficultyMultipliers !== undefined) {
      requireValue(isRecord(rules.difficultyMultipliers), 'combatRules.difficultyMultipliers')
      if (isRecord(rules.difficultyMultipliers)) {
        for (const level of ['NORMAL', 'HEROIC', 'LEGENDARY', 'MYTHIC']) {
          const multiplier = rules.difficultyMultipliers[level]
          requireValue(
            typeof multiplier === 'number' &&
              Number.isFinite(multiplier) &&
              multiplier > 0 &&
              multiplier <= 10,
            `combatRules.difficultyMultipliers.${level}`,
          )
        }
      }
    }
    for (const field of ['supportAttack', 'supportDamage', 'supportRegen'] as const) {
      requireValue(
        rules[field] === undefined || count(rules[field], 0, 100),
        `combatRules.${field}`,
      )
    }
  }
  if (input.masterEncounter !== null) {
    requireValue(isRecord(input.masterEncounter), 'masterEncounter')
    if (isRecord(input.masterEncounter) && Array.isArray(input.masterEncounter.candidates)) {
      for (const [index, candidate] of (input.masterEncounter.candidates as unknown[]).entries()) {
        requireValue(isRecord(candidate), `masterEncounter.candidates[${String(index)}]`)
        if (isRecord(candidate))
          fighter(candidate.profile, `masterEncounter.candidates[${String(index)}].profile`)
      }
    }
  }
  requireValue(
    isRecord(input.rewards) &&
      Array.isArray(input.rewards.guaranteed) &&
      Array.isArray(input.rewards.potential) &&
      Array.isArray(input.rewards.objectiveBonuses) &&
      Array.isArray(input.rewards.firstTime),
    'rewards',
  )
  if (isRecord(input.rewards)) drops(input.rewards.potential, 'rewards.potential')
  if (isRecord(input.rewards)) {
    for (const field of ['guaranteed', 'objectiveBonuses', 'firstTime'] as const) {
      requireValue(
        Array.isArray(input.rewards[field]) &&
          (input.rewards[field] as unknown[]).every(
            (entry) => isRecord(entry) && text(entry.label),
          ),
        `rewards.${field}`,
      )
    }
  }
  requireValue(Array.isArray(input.highlightedRewards), 'highlightedRewards')
  requireValue(
    (input.highlightedRewards as unknown[]).every((entry) => isRecord(entry) && text(entry.label)),
    'highlightedRewards',
  )
  const definition = input as unknown as MissionDefinition
  assertMasterConfig(definition)
  return definition
}
