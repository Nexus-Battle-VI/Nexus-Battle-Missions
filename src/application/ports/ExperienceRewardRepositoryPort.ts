import type { ExperienceReward } from '../../domain/entities/ExperienceReward'
import type { ReportLineUpdate } from '../../domain/entities/MissionReport'

/**
 * Estado de las recompensas de experiencia (HU-09, Task HU-09.4): la tabla que
 * hace posible la garantia del contrato §9.1.
 *
 * DOS ESCRITURAS, CADA UNA EN SU MOMENTO:
 *
 *  - el CIERRE de la mision de HU-72 las crea `PENDING`, dentro de su MISMA
 *    transaccion (`ExecutionRepositoryPort.close`), antes de pedir ninguna
 *    tirada. Es lo que impide la tirada huerfana;
 *  - el CICLO de coordinacion las avanza: `ROLLED` cuando Combat devuelve la cara
 *    y `CREDITED` cuando Player/Inventory confirma la acreditacion. Cada avance
 *    es una escritura condicionada por los intentos leidos, de modo que dos
 *    procesos no se pisan.
 *
 * UNA FILA POR INSTANCIA DE DERROTA, no por mision: la clave es (matriculacion,
 * encuentro, enemigo concreto), y es lo que permite que una derrota falle sin
 * arrastrar a las demas.
 */
export interface ExperienceRewardRepositoryPort {
  /**
   * Las recompensas NO terminales con el intento vencido, las mas atrasadas
   * primero. El caso de uso las agrupa por mision para pedir un solo lote de
   * tiradas por matricula.
   */
  dueRewards(now: Date, limit: number): Promise<readonly ExperienceReward[]>

  /** Las de una matricula, para inspeccion y para el reporte de HU-10. */
  listByEnrollment(enrollmentId: string): Promise<readonly ExperienceReward[]>

  /**
   * Guarda el avance si la recompensa seguia con los intentos leidos. `false`:
   * otro proceso se adelanto y no se escribe nada.
   *
   * HU-09 (Task HU-09.5): `line` es el reflejo del desenlace en la linea del
   * reporte de HU-74, y se escribe EN LA MISMA TRANSACCION que el estado de la
   * recompensa. Son el mismo hecho contado dos veces -- una derrota acreditada y su
   * linea diciendo `CREDITED` --, y separarlos dejaria al jugador viendo una
   * recompensa entregada que su reporte sigue dando por pendiente. La linea la
   * escribe SOLO quien gana el bloqueo; `null` en un desenlace no terminal, donde
   * la linea sigue `PENDING`, y en una recompensa sin linea (mision anulada).
   */
  save(
    next: ExperienceReward,
    expectedAttempts: number,
    line?: ReportLineUpdate | null,
  ): Promise<boolean>
}

export const EXPERIENCE_REWARD_REPOSITORY = Symbol('ExperienceRewardRepositoryPort')
