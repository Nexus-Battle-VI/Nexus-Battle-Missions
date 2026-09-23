import type { ReportRecord, RewardStatus } from '../../domain/entities/MissionReport'

/**
 * Reportes de mision (HU-74). Se escriben en el cierre de HU-72, dentro de su
 * transaccion (`ExecutionRepositoryPort.close`, propuesta P-T1). Aqui solo se
 * leen, salvo el estado de las lineas de recompensa: lo unico que cambia despues
 * de la foto (P-T2).
 */
export interface ReportRepositoryPort {
  findByEnrollment(enrollmentId: string): Promise<ReportRecord | null>
  /** Los del jugador, del mas reciente al mas antiguo (`summary.finishedAt`). */
  listByPlayer(playerId: string): Promise<readonly ReportRecord[]>
  /**
   * CU-74.4: una entrega se confirmo o fallo. Cambia la linea, nunca la foto.
   * `false` si la linea no existe. La usaran HU-10 y HU-73.2.
   */
  updateRewardStatus(
    enrollmentId: string,
    lineNo: number,
    status: RewardStatus,
    at: Date,
  ): Promise<boolean>
}

export const REPORT_REPOSITORY = Symbol('ReportRepositoryPort')
