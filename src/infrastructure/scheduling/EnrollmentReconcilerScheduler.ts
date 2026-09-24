import type { ReconcilePendingEnrollments } from '../../application/use-cases/ReconcilePendingEnrollments'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Ejecuta el reconciliador de matriculas PENDING cada cierto intervalo (diseno
 * de HU-70, «Secuencia», paso 4).
 *
 * Mismo patron que los demas temporizadores de ADR-019: intervalo dentro del
 * proceso y APAGADO por defecto (`ENROLLMENT_RECONCILER_ENABLED`). El estado vive
 * en la base: un reinicio retrasa la reconciliacion, no la pierde.
 *
 * Nunca solapa dos ciclos, y un ciclo que falla no detiene los siguientes.
 */
export class EnrollmentReconcilerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly reconcile: ReconcilePendingEnrollments,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly enabled: boolean,
  ) {}

  onModuleInit(): void {
    if (this.enabled) {
      this.start()
    }
  }

  onModuleDestroy(): void {
    this.stop()
  }

  start(): void {
    if (this.timer !== null) {
      return
    }

    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    // No mantiene vivo el proceso por si solo.
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Un ciclo. Publico para las pruebas, que no esperan al reloj real. */
  async tick(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true

    try {
      const summary = await this.reconcile.execute()

      if (summary.confirmed + summary.rejected + summary.expired + summary.failed > 0) {
        this.logger.info('enrollment_reconciler_cycle', { ...summary })
      }
    } catch (error: unknown) {
      this.logger.warn('enrollment_reconciler_failed', { detail: describeError(error) })
    } finally {
      this.running = false
    }
  }
}
