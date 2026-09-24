import type { ExperienceReward } from '../../domain/entities/ExperienceReward'

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
   */
  save(next: ExperienceReward, expectedAttempts: number): Promise<boolean>
}

export const EXPERIENCE_REWARD_REPOSITORY = Symbol('ExperienceRewardRepositoryPort')
