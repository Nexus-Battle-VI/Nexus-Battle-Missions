import type { MissionDifficultyClear } from '../../domain/entities/MissionDifficultyClear'
import type { MissionEnrollment, MissionFact } from '../../domain/entities/MissionEnrollment'
import type { MissionExecution } from '../../domain/entities/MissionExecution'
import type { ReportRecord } from '../../domain/entities/MissionReport'

/** Un hecho `MissionEnrollmentStarted` que todavia no tiene ejecucion. */
export interface StartedMission {
  readonly factId: string
  readonly enrollmentId: string
}

/**
 * Cierre de una mision en UNA transaccion (CU-72.2 y CU-72.3): cambian la
 * matricula y la ejecucion, se registra el clear de HU-75 si hubo exito, el
 * hecho `MissionSettled` y el reporte de HU-74. Las dos transiciones exigen la
 * version leida.
 */
export interface MissionClosure {
  readonly enrollment: MissionEnrollment
  readonly enrollmentVersion: number
  readonly execution: MissionExecution
  readonly executionVersion: number
  readonly clear: MissionDifficultyClear | null
  readonly fact: MissionFact
  /** HU-74 (P-T1): la foto nace con el cierre. Una anulacion no tiene reporte (P-T3). */
  readonly report: ReportRecord | null
}

export interface ExecutionRepositoryPort {
  pendingStarts(limit: number): Promise<readonly StartedMission[]>
  /** Crea la ejecucion y marca el hecho como procesado, a la vez. Repetirlo no duplica nada. */
  queue(execution: MissionExecution, factId: string): Promise<void>
  findById(enrollmentId: string): Promise<MissionExecution | null>
  /** `QUEUED` o `REQUESTED` con el intento vencido, las mas atrasadas primero. */
  due(now: Date, limit: number): Promise<readonly MissionExecution[]>
  /** `SIMULATED` cuya matricula ya llego a `endsAt`. */
  closable(now: Date, limit: number): Promise<readonly MissionExecution[]>
  /** `SETTLED` o `VOIDED` con el heroe todavia sin liberar. */
  awaitingRelease(limit: number): Promise<readonly MissionExecution[]>
  saveTransition(next: MissionExecution, expectedVersion: number): Promise<boolean>
  /** `false` si otro proceso cambio antes la matricula o la ejecucion: no se escribe nada. */
  close(closure: MissionClosure): Promise<boolean>
}

export const EXECUTION_REPOSITORY = Symbol('ExecutionRepositoryPort')
