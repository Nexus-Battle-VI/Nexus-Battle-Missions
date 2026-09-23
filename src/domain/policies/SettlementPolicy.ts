import type { MissionObjective, ObjectiveRule } from '../entities/MissionDefinition'
import type { MissionEnrollment, MissionFact } from '../entities/MissionEnrollment'
import {
  COMBAT_OUTCOMES,
  type CombatOutcome,
  type ObjectiveResult,
  type Settlement,
  type SimulationFacts,
} from '../entities/MissionExecution'

/**
 * Reglas del cierre de HU-72 (RF-72). Funciones puras: Missions decide el
 * resultado de la mision con los hechos del resumen de Combat (P-S5). No calcula
 * dano ni genera aleatoriedad: eso es de Combat (ADR-021).
 */

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

export const isCombatOutcome = (value: unknown): value is CombatOutcome =>
  (COMBAT_OUTCOMES as readonly unknown[]).includes(value)

/**
 * Los hechos del resumen que deciden el resultado, o `null` si falta alguno o
 * no tiene sentido: sin ellos no se decide nada. Sin `master` en el resumen, el
 * Master no aparecio (HU-72 todavia no pide sortearlo).
 */
export const simulationFactsOf = (summary: unknown): SimulationFacts | null => {
  if (!isRecord(summary)) {
    return null
  }

  const { encountersCompleted, encountersTotal, bossDefeated, minHealthPercent } = summary
  const master = summary.master ?? { appeared: false, defeated: false }

  if (
    !isCount(encountersCompleted) ||
    !isCount(encountersTotal) ||
    encountersCompleted > encountersTotal ||
    typeof bossDefeated !== 'boolean' ||
    typeof minHealthPercent !== 'number' ||
    !(minHealthPercent >= 0 && minHealthPercent <= 100) ||
    !isRecord(master) ||
    typeof master.appeared !== 'boolean' ||
    typeof master.defeated !== 'boolean'
  ) {
    return null
  }

  return {
    encountersCompleted,
    encountersTotal,
    bossDefeated,
    minHealthPercent,
    master: { appeared: master.appeared, defeated: master.defeated },
  }
}

const isMet = (rule: ObjectiveRule, facts: SimulationFacts): boolean | null => {
  switch (rule.type) {
    case 'DEFEAT_BOSS':
      return facts.bossDefeated
    case 'CLEAR_ENCOUNTERS':
      return facts.encountersCompleted >= rule.count
    case 'MIN_HEALTH_PERCENT':
      return facts.minHealthPercent >= rule.percent
    case 'DEFEAT_MASTER':
      // Si el Master no aparecio, el objetivo no aplica.
      return facts.master.appeared ? facts.master.defeated : null
  }
}

/** Cada objetivo con su regla (P-S6). Sin regla, no es evaluable en esta version. */
export const evaluateObjectives = (
  objectives: readonly MissionObjective[],
  facts: SimulationFacts,
): readonly ObjectiveResult[] =>
  objectives.map((objective) => ({
    id: objective.id,
    type: objective.rule?.type ?? null,
    primary: objective.primary,
    met: objective.rule === null ? null : isMet(objective.rule, facts),
  }))

/**
 * Resultado de la mision (tabla «Resultado y objetivos» del diseno):
 *
 * - el heroe cae: `FAILED` (CA-04);
 * - gana o se agota el tiempo con los objetivos principales cumplidos: `COMPLETED` (CA-06);
 * - gana con uno principal sin cumplir: `FAILED` (decision 2);
 * - se agota el tiempo sin cumplirlos: `FAILED` con `TIME_LIMIT` (decision 2).
 *
 * Los secundarios no cambian el resultado, y un principal que no aplica tampoco.
 */
export const settlementOf = (
  combatOutcome: CombatOutcome,
  objectives: readonly MissionObjective[],
  facts: SimulationFacts,
): Settlement => {
  const results = evaluateObjectives(objectives, facts)

  if (combatOutcome === 'HERO_DEFEATED') {
    return { outcome: 'FAILED', reason: 'HERO_DEFEATED', objectives: results }
  }

  if (!results.some((result) => result.primary && result.met === false)) {
    return { outcome: 'COMPLETED', reason: null, objectives: results }
  }

  return {
    outcome: 'FAILED',
    reason: combatOutcome === 'TIME_BUDGET_EXHAUSTED' ? 'TIME_LIMIT' : 'OBJECTIVES_NOT_MET',
    objectives: results,
  }
}

/**
 * Hecho interno del cierre (contrato de HU-72, «Hecho interno al cerrar»). Lo
 * consumen HU-74 (reporte), HU-76 (logros), HU-10 (recompensas) y el aviso de
 * fin de mision. Se registra una sola vez por matricula.
 */
export const missionSettledFact = (
  enrollment: MissionEnrollment,
  settlement: Settlement,
  simulationId: string | null,
  settledAt: Date,
): MissionFact => ({
  type: 'MissionSettled',
  enrollmentId: enrollment.enrollmentId,
  payload: {
    enrollmentId: enrollment.enrollmentId,
    missionId: enrollment.missionId,
    playerId: enrollment.playerId,
    heroId: enrollment.heroId,
    difficulty: enrollment.difficulty,
    missionOutcome: settlement.outcome,
    reason: settlement.reason,
    objectives: settlement.objectives,
    simulationId,
    settledAt: settledAt.toISOString(),
  },
  createdAt: settledAt,
})
