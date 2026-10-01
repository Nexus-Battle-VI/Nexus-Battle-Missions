import type { MissionCompletionRewardRepositoryPort } from '../../../application/ports/MissionCompletionRewardRepositoryPort'
import {
  completionDeliveryKey,
  type MissionCompletionRewardDelivery,
} from '../../../domain/entities/MissionCompletionRewardDelivery'
import type { ReportLineUpdate } from '../../../domain/entities/MissionReport'
import { InMemoryReportRepository } from './InMemoryReportRepository'

/**
 * Entregas de finalizacion de mision en memoria (HU-10, Task HU-10.5).
 *
 * Doble de desarrollo y de pruebas, con la MISMA semantica que el adaptador de
 * PostgreSQL: el cierre inserta las entregas `PENDING` ya congeladas, el barrido
 * lee las no terminales con el intento vencido, y el avance se guarda condicionado
 * por los intentos leidos -- si otro proceso se adelanto, `save` devuelve `false`.
 *
 * SI EL AVANCE GANA, ADEMAS MUEVE LA LINEA `HU-10` DEL REPORTE, igual que la
 * transaccion del adaptador real: comparte estado con el doble de reportes.
 */
export class InMemoryMissionCompletionRewardRepository implements MissionCompletionRewardRepositoryPort {
  private readonly byKey = new Map<string, MissionCompletionRewardDelivery>()

  constructor(
    private readonly reports: InMemoryReportRepository = new InMemoryReportRepository(),
  ) {}

  /** Lo llama el cierre de la mision, dentro de su transaccion (aqui, sin ella). */
  insert(deliveries: readonly MissionCompletionRewardDelivery[]): void {
    for (const delivery of deliveries) {
      const key = completionDeliveryKey(delivery)

      // Repetir el cierre no cambia lo ya escrito, igual que `on conflict do nothing`.
      if (!this.byKey.has(key)) {
        this.byKey.set(key, delivery)
      }
    }
  }

  dueDeliveries(now: Date, limit: number): Promise<readonly MissionCompletionRewardDelivery[]> {
    const due = [...this.byKey.values()]
      .filter(
        (delivery) =>
          delivery.status === 'PENDING' &&
          delivery.nextAttemptAt !== null &&
          delivery.nextAttemptAt.getTime() <= now.getTime(),
      )
      .sort(
        (left, right) =>
          (left.nextAttemptAt?.getTime() ?? 0) - (right.nextAttemptAt?.getTime() ?? 0),
      )
      .slice(0, limit)

    return Promise.resolve(due.map((delivery) => ({ ...delivery })))
  }

  listByEnrollment(enrollmentId: string): Promise<readonly MissionCompletionRewardDelivery[]> {
    const deliveries = [...this.byKey.values()]
      .filter((delivery) => delivery.enrollmentId === enrollmentId)
      .map((delivery) => ({ ...delivery }))

    return Promise.resolve(deliveries)
  }

  save(
    next: MissionCompletionRewardDelivery,
    expectedAttempts: number,
    line: ReportLineUpdate | null = null,
  ): Promise<boolean> {
    const key = completionDeliveryKey(next)
    const current = this.byKey.get(key)

    if (current?.attempts !== expectedAttempts) {
      return Promise.resolve(false)
    }

    this.byKey.set(key, { ...next })

    if (line !== null && next.reportLineNo !== null) {
      this.reports.applyCreditNow(next.enrollmentId, next.reportLineNo, line)
    }

    return Promise.resolve(true)
  }
}
