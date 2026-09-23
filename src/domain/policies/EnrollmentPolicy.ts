import type { MissionDefinition } from '../entities/MissionDefinition'
import type { EnrollmentStatus, MissionEnrollment } from '../entities/MissionEnrollment'
import {
  HeroBusyError,
  MissionAlreadyInProgressError,
  MissionLockedError,
} from '../errors/mission-errors'
import type { PlayerMissionStatus } from '../value-objects/mission-category'

/**
 * Reglas de la matricula de HU-70 (RF-70). Funciones puras: sin reloj, sin
 * persistencia y sin llamadas externas. Quien las invoca les pasa solo los
 * hechos de ESTE jugador.
 */

/**
 * Requisitos previos pendientes (CA-07). Un requisito se cumple con al menos un
 * clear de esa mision en cualquier dificultad (propuesta P-M10): asi no existe un
 * segundo registro de «mision completada» aparte de los clears de HU-75.
 */
export const missingPrerequisitesOf = (
  definition: MissionDefinition,
  completedMissionIds: ReadonlySet<string>,
): readonly string[] => definition.prerequisites.filter((id) => !completedMissionIds.has(id))

/** «a», «b» y «c»: la enumeracion de los mensajes que ve el jugador. */
export const listNames = (names: readonly string[]): string => {
  if (names.length <= 1) {
    return names.join('')
  }

  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1] ?? ''}`
}

/** Motivo que ve el jugador. Si una mision previa no esta en el catalogo, se nombra por su id. */
export const lockReasonFor = (
  missing: readonly string[],
  missionNames: ReadonlyMap<string, string>,
): string =>
  `Completa primero ${listNames(missing.map((id) => `«${missionNames.get(id) ?? id}»`))}.`

export interface PlayerMissionContext {
  readonly completedMissionIds: ReadonlySet<string>
  readonly missionNames: ReadonlyMap<string, string>
  /** Matricula activa del jugador en ESTA mision, si la hay. */
  readonly activeEnrollmentId: string | null
  /** Resultado de su ultima matricula terminada en esta mision. */
  readonly lastFinishedStatus: EnrollmentStatus | null
}

export interface PlayerMissionView {
  readonly status: PlayerMissionStatus
  readonly canEnroll: boolean
  readonly lockReason: string | null
  readonly missingPrerequisites: readonly string[]
  readonly activeEnrollmentId: string | null
}

/**
 * Estado de la mision para el jugador, en este orden: en curso, bloqueada,
 * resultado de la ultima vez o disponible. Una mision completada se puede
 * repetir (7.8.9, «Repetir mision»).
 */
export const derivePlayerMissionStatus = (
  definition: MissionDefinition,
  context: PlayerMissionContext,
): PlayerMissionView => {
  if (context.activeEnrollmentId !== null) {
    return {
      status: 'IN_PROGRESS',
      canEnroll: false,
      lockReason: null,
      missingPrerequisites: [],
      activeEnrollmentId: context.activeEnrollmentId,
    }
  }

  const missing = missingPrerequisitesOf(definition, context.completedMissionIds)

  if (missing.length > 0) {
    return {
      status: 'LOCKED',
      canEnroll: false,
      lockReason: lockReasonFor(missing, context.missionNames),
      missingPrerequisites: missing,
      activeEnrollmentId: null,
    }
  }

  const last = context.lastFinishedStatus
  const status: PlayerMissionStatus =
    last === 'COMPLETED' || last === 'FAILED' || last === 'ABANDONED' ? last : 'AVAILABLE'

  return {
    status,
    canEnroll: true,
    lockReason: null,
    missingPrerequisites: [],
    activeEnrollmentId: null,
  }
}

/** Paso 5 del orden de validacion del contrato (CA-07). */
export const assertPrerequisitesMet = (
  definition: MissionDefinition,
  completedMissionIds: ReadonlySet<string>,
  missionNames: ReadonlyMap<string, string>,
): void => {
  const missing = missingPrerequisitesOf(definition, completedMissionIds)

  if (missing.length > 0) {
    throw new MissionLockedError(
      definition.missionId,
      missing,
      lockReasonFor(missing, missionNames),
    )
  }
}

/** Paso 8: como mucho una matricula activa por jugador y mision (propuesta P-M2). */
export const assertMissionNotInProgress = (
  missionId: string,
  activeInMission: MissionEnrollment | null,
): void => {
  if (activeInMission !== null) {
    throw new MissionAlreadyInProgressError(missionId, activeInMission.enrollmentId)
  }
}

/** Paso 9 (CA-02): el heroe no puede estar en otra matricula activa de Missions. */
export const assertHeroFree = (heroId: string, heroActive: MissionEnrollment | null): void => {
  if (heroActive !== null) {
    throw new HeroBusyError(heroId, 'MISSION')
  }
}
