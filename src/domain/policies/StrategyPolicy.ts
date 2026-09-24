import { StrategyVersionMismatchError } from '../errors/mission-errors'
import {
  InvalidRotationError,
  TooManyRotationsError,
  UnknownAbilityError,
  type RotationViolation,
  type RotationViolationReason,
} from '../errors/strategy-errors'
import {
  abilitiesUsedBy,
  MAX_ROTATIONS,
  MAX_STEPS_PER_ROTATION,
  ROTATION_PRIORITIES,
  type Rotation,
  type RotationPriority,
} from '../value-objects/rotation'
import { listNames } from './EnrollmentPolicy'

/**
 * Reglas de la estrategia de HU-71 (RF-71). Funciones puras: las habilidades del
 * heroe se las pasa quien las consulto en Player/Inventory. La decision por turno
 * (que rotacion es viable) NO vive aqui: la ejecuta Combat en la simulacion.
 */

const PRIORITY_REASONS: ReadonlySet<RotationViolationReason> = new Set([
  'PRIORITY_REPEATED',
  'PRIORITY_GAP',
  'PRIORITY_ORDER',
])

/** Por que la rotacion de la posicion `index` no lleva la prioridad que le toca. */
const priorityProblem = (
  priority: RotationPriority,
  index: number,
  seen: ReadonlySet<RotationPriority>,
): RotationViolationReason => {
  if (seen.has(priority)) {
    return 'PRIORITY_REPEATED'
  }

  return ROTATION_PRIORITIES.indexOf(priority) > index ? 'PRIORITY_GAP' : 'PRIORITY_ORDER'
}

/**
 * Reglas 2 y 3 del contrato. Las prioridades van en orden y sin huecos: `HIGH`;
 * `HIGH` y `MEDIUM`; o las tres (P-R2). Cada rotacion tiene entre 1 y 3 acciones
 * (P-R3).
 */
export const rotationViolations = (
  rotations: readonly Rotation[],
): readonly RotationViolation[] => {
  if (rotations.length === 0) {
    return [{ field: 'rotations', reason: 'NO_ROTATIONS' }]
  }

  const violations: RotationViolation[] = []
  const seen = new Set<RotationPriority>()

  rotations.forEach((rotation, index) => {
    if (rotation.priority !== ROTATION_PRIORITIES[index]) {
      violations.push({
        field: `rotations[${String(index)}].priority`,
        reason: priorityProblem(rotation.priority, index, seen),
      })
    }

    seen.add(rotation.priority)
  })

  rotations.forEach((rotation, index) => {
    if (rotation.steps.length === 0) {
      violations.push({ field: `rotations[${String(index)}].steps`, reason: 'EMPTY_ROTATION' })
    } else if (rotation.steps.length > MAX_STEPS_PER_ROTATION) {
      violations.push({ field: `rotations[${String(index)}].steps`, reason: 'TOO_MANY_STEPS' })
    }
  })

  return violations
}

const invalidRotationMessage = (violations: readonly RotationViolation[]): string => {
  if (violations.some((violation) => violation.reason === 'NO_ROTATIONS')) {
    return 'Configura al menos una rotación.'
  }

  if (violations.some((violation) => PRIORITY_REASONS.has(violation.reason))) {
    return 'Las prioridades deben ser Alta, Media y Baja, en ese orden y sin saltos.'
  }

  return 'Cada rotación debe tener entre una y tres acciones.'
}

/** Reglas 1 a 3 del contrato, en su orden: la cuarta rotacion va primero (CA-04). */
export const assertRotationShape = (rotations: readonly Rotation[]): void => {
  if (rotations.length > MAX_ROTATIONS) {
    throw new TooManyRotationsError(MAX_ROTATIONS, rotations.length)
  }

  const violations = rotationViolations(rotations)

  if (violations.length > 0) {
    throw new InvalidRotationError(violations, invalidRotationMessage(violations))
  }
}

/** Regla 4: cada `ABILITY` usa una habilidad que el heroe tiene (P-R4). */
export const assertAbilitiesKnown = (
  rotations: readonly Rotation[],
  heroAbilities: ReadonlySet<string>,
): void => {
  const unknown = abilitiesUsedBy(rotations).filter((abilityId) => !heroAbilities.has(abilityId))

  if (unknown.length === 0) {
    return
  }

  const quoted = listNames(unknown.map((abilityId) => `«${abilityId}»`))

  throw new UnknownAbilityError(
    unknown,
    unknown.length === 1
      ? `Tu héroe no tiene la habilidad ${quoted}.`
      : `Tu héroe no tiene las habilidades ${quoted}.`,
  )
}

/**
 * Extension de HU-71 a la matricula (P-R8): la version que el jugador tiene
 * delante debe ser la guardada. Sin estrategia guardada es `null` y la mision
 * sigue adelante solo con el ataque basico (P-R9).
 */
export const assertStrategyVersionMatches = (
  requested: number | null,
  current: number | null,
): void => {
  if (requested !== current) {
    throw new StrategyVersionMismatchError(requested, current)
  }
}
