import type { ExperienceRewardRepositoryPort } from '../../../application/ports/ExperienceRewardRepositoryPort'
import {
  experienceRewardKey,
  type ExperienceReward,
} from '../../../domain/entities/ExperienceReward'
import type { ReportLineUpdate } from '../../../domain/entities/MissionReport'
import { InMemoryReportRepository } from './InMemoryReportRepository'

/**
 * Estado de las recompensas de experiencia en memoria (HU-09, Task HU-09.4).
 *
 * Doble de desarrollo y de pruebas, con la MISMA semantica que el adaptador de
 * PostgreSQL: el cierre inserta las recompensas `PENDING`, el barrido lee las no
 * terminales con el intento vencido y el avance se guarda condicionado por los
 * intentos leidos -- si otro proceso se adelanto, `save` devuelve `false` y no
 * escribe nada.
 *
 * SI EL AVANCE GANA, ADEMAS MUEVE LA LINEA DEL REPORTE (Task HU-09.5), igual que
 * la transaccion del adaptador real: comparte estado con el doble de reportes, y
 * sin esa linea el reporte diria `PENDING` de una experiencia ya entregada.
 *
 * Guarda instantaneas, no objetos vivos: una mutacion sin guardar no se filtra.
 */
export class InMemoryExperienceRewardRepository implements ExperienceRewardRepositoryPort {
  private readonly byKey = new Map<string, ExperienceReward>()

  constructor(
    private readonly reports: InMemoryReportRepository = new InMemoryReportRepository(),
  ) {}

  /** Lo llama el cierre de la mision, dentro de su transaccion (aqui, sin ella). */
  insert(rewards: readonly ExperienceReward[]): void {
    for (const reward of rewards) {
      const key = experienceRewardKey(reward)

      // Repetir el cierre no cambia lo ya escrito, igual que `on conflict do nothing`.
      if (!this.byKey.has(key)) {
        this.byKey.set(key, reward)
      }
    }
  }

  dueRewards(now: Date, limit: number): Promise<readonly ExperienceReward[]> {
    const due = [...this.byKey.values()]
      .filter(
        (reward) =>
          reward.status !== 'CREDITED' &&
          reward.status !== 'FAILED' &&
          reward.nextAttemptAt !== null &&
          reward.nextAttemptAt.getTime() <= now.getTime(),
      )
      .sort(
        (left, right) =>
          (left.nextAttemptAt?.getTime() ?? 0) - (right.nextAttemptAt?.getTime() ?? 0),
      )
      .slice(0, limit)

    return Promise.resolve(due.map((reward) => ({ ...reward })))
  }

  listByEnrollment(enrollmentId: string): Promise<readonly ExperienceReward[]> {
    const rewards = [...this.byKey.values()]
      .filter((reward) => reward.enrollmentId === enrollmentId)
      .map((reward) => ({ ...reward }))

    return Promise.resolve(rewards)
  }

  save(
    next: ExperienceReward,
    expectedAttempts: number,
    line: ReportLineUpdate | null = null,
  ): Promise<boolean> {
    const key = experienceRewardKey(next)
    const current = this.byKey.get(key)

    if (current?.attempts !== expectedAttempts) {
      return Promise.resolve(false)
    }

    this.byKey.set(key, { ...next })

    // La linea se mueve solo si el avance gano, como en la transaccion real.
    if (line !== null && next.reportLineNo !== null) {
      this.reports.applyCreditNow(next.enrollmentId, next.reportLineNo, line)
    }

    return Promise.resolve(true)
  }
}
