import type { Rotation } from '../value-objects/rotation'

/**
 * Estrategia guardada por jugador, heroe y mision (HU-71, propuesta P-R1). La
 * matricula de HU-70 la congela: editarla despues no cambia una mision en curso.
 *
 * `version` empieza en 1 y crece con cada guardado. Es el bloqueo optimista que
 * evita que dos ediciones se pisen (`expectedVersion` en el contrato).
 */
export interface MissionStrategy {
  readonly playerId: string
  readonly heroId: string
  readonly missionId: string
  readonly version: number
  readonly rotations: readonly Rotation[]
  readonly updatedAt: Date
}

/** Version que tendra la estrategia al guardarse sobre `expectedVersion` (`null`: la primera). */
export const nextStrategyVersion = (expectedVersion: number | null): number =>
  (expectedVersion ?? 0) + 1
