import type { DifficultyLevel } from '../value-objects/difficulty-level'
import { uuidV5 } from '../value-objects/deterministic-uuid'

/** Corridas de cada estimacion: la granularidad es de un 3 % aproximado. */
export const ESTIMATE_RUNS = 30

/**
 * Riesgo de enviar al heroe, segun las victorias estimadas (P-J7). Propuesta del
 * equipo, pendiente del PO: el curso no define una escala de riesgo.
 */
export const ESTIMATE_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const

export type EstimateRisk = (typeof ESTIMATE_RISKS)[number]

const RISK_LABEL: Readonly<Record<EstimateRisk, string>> = {
  LOW: 'Favorable',
  MEDIUM: 'Pareja',
  HIGH: 'Arriesgada',
  EXTREME: 'Muy arriesgada',
}

/** De 80 % en adelante es favorable; por debajo de 20 %, muy arriesgada. */
export const riskOf = (successPercent: number): EstimateRisk => {
  if (successPercent >= 80) return 'LOW'
  if (successPercent >= 50) return 'MEDIUM'
  if (successPercent >= 20) return 'HIGH'
  return 'EXTREME'
}

export const riskLabelOf = (risk: EstimateRisk): string => RISK_LABEL[risk]

/** Una tasa entre 0 y 1 como porcentaje entero, que es lo que ve el jugador. */
export const percentOf = (rate: number): number => Math.round(rate * 100)

const ESTIMATE_NAMESPACE = '5d2f8b61-3c7e-4a90-b4d1-8e6f0a2c9b37'

/**
 * La operacion de una estimacion: la misma para el mismo jugador, mision, heroe,
 * nivel y version de estrategia. Asi la misma pregunta da la misma respuesta, y
 * no coincide nunca con la operacion aleatoria de una matricula: estimar no
 * adelanta el resultado de la mision real.
 */
export const estimateOperationId = (input: {
  readonly playerId: string
  readonly missionId: string
  readonly heroId: string
  readonly difficulty: DifficultyLevel
  readonly strategyVersion: number | null
}): string =>
  uuidV5(
    ESTIMATE_NAMESPACE,
    [
      input.playerId,
      input.missionId,
      input.heroId,
      input.difficulty,
      input.strategyVersion === null ? 'sin-estrategia' : String(input.strategyVersion),
    ].join(':'),
  )
