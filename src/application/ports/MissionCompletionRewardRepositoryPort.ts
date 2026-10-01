import type { MissionCompletionRewardDelivery } from '../../domain/entities/MissionCompletionRewardDelivery'
import type { ReportLineUpdate } from '../../domain/entities/MissionReport'

/**
 * Estado de las entregas de finalizacion de mision (HU-10, Task HU-10.5).
 *
 * DOS ESCRITURAS, CADA UNA EN SU MOMENTO, igual que HU-09 y el botin de HU-72:
 *
 *  - el CIERRE de la mision (`ExecutionRepositoryPort.close`) las crea `PENDING`,
 *    con su derecho ya congelado por `CompletionRewardPolicy`, dentro de su MISMA
 *    transaccion;
 *  - el CICLO de coordinacion las avanza: `CREDITED` cuando el contexto dueno
 *    confirma, `FAILED` ante un rechazo terminal. Cada avance es una escritura
 *    condicionada por los intentos leidos.
 *
 * UNA FILA POR DERECHO (`rewardKey`), no por mision: una entrega que falla no
 * arrastra a las demas de la misma liquidacion (contrato §16).
 */
export interface MissionCompletionRewardRepositoryPort {
  /**
   * Las entregas `PENDING` con el intento vencido, las mas atrasadas primero.
   */
  dueDeliveries(now: Date, limit: number): Promise<readonly MissionCompletionRewardDelivery[]>

  /** Las de una matricula, para inspeccion y para pruebas. */
  listByEnrollment(enrollmentId: string): Promise<readonly MissionCompletionRewardDelivery[]>

  /**
   * Guarda el avance si la entrega seguia con los intentos leidos. `false`: otro
   * proceso se adelanto y no se escribe nada.
   *
   * `line` es el reflejo del desenlace en la linea `HU-10` del reporte de HU-74, y
   * se escribe EN LA MISMA TRANSACCION que el estado de la entrega: son el mismo
   * hecho contado dos veces. `null` en un desenlace no terminal (la linea sigue
   * `PENDING`).
   */
  save(
    next: MissionCompletionRewardDelivery,
    expectedAttempts: number,
    line?: ReportLineUpdate | null,
  ): Promise<boolean>
}

export const MISSION_COMPLETION_REWARD_REPOSITORY = Symbol('MissionCompletionRewardRepositoryPort')
