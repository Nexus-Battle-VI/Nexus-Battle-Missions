/**
 * Vocabulario de las rotaciones de habilidades (HU-71, contrato
 * hu-71-mission-strategy-v1). Rotacion 1, 2 y 3 son prioridad alta, media y
 * baja: son posiciones, no etiquetas libres (propuesta P-R2).
 */
export const ROTATION_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const

export type RotationPriority = (typeof ROTATION_PRIORITIES)[number]

export const STEP_KINDS = ['ABILITY', 'BASIC_ATTACK'] as const

export type StepKind = (typeof STEP_KINDS)[number]

/**
 * Una accion: una habilidad del heroe o el ataque basico (propuesta P-R4).
 * `abilityId` es el `productId` de Catalog que publica Player/Inventory.
 */
export type RotationStep =
  { readonly kind: 'ABILITY'; readonly abilityId: string } | { readonly kind: 'BASIC_ATTACK' }

export interface Rotation {
  readonly priority: RotationPriority
  readonly steps: readonly RotationStep[]
}

/** CA-04: no se puede configurar una cuarta rotacion. */
export const MAX_ROTATIONS = 3

/** Propuesta P-R3: entre 1 y 3 acciones por rotacion. */
export const MAX_STEPS_PER_ROTATION = 3

/** Habilidades distintas que usa la estrategia, en orden de aparicion. */
export const abilitiesUsedBy = (rotations: readonly Rotation[]): readonly string[] => [
  ...new Set(
    rotations.flatMap((rotation) =>
      rotation.steps.flatMap((step) => (step.kind === 'ABILITY' ? [step.abilityId] : [])),
    ),
  ),
]
