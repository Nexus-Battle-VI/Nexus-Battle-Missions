import type { GrantMasterEpics } from '../../application/use-cases/GrantMasterEpics'
import type { RunMissionExecutions } from '../../application/use-cases/RunMissionExecutions'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Ejecuta el ciclo de HU-72 cada cierto intervalo (CU-72.1 a CU-72.3): programa,
 * simula, cierra y libera. Despues entrega las epicas pendientes de HU-73
 * (CU-73.3), que el cierre acaba de dejar. Mismo patron que el reconciliador de HU-70 y los
 * demas temporizadores de ADR-019: intervalo dentro del proceso y APAGADO por
 * defecto (`MISSION_EXECUTION_ENABLED`). El estado vive en la base: un reinicio
 * retrasa la simulacion o el cierre, no los pierde.
 *
 * Nunca solapa dos ciclos, y un ciclo que falla no detiene los siguientes.
 */
export class MissionExecutionScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly executions: RunMissionExecutions,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly enabled: boolean,
    private readonly epics: GrantMasterEpics | null = null,
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
      const summary = {
        ...(await this.executions.run()),
        ...(await this.epics?.run()),
      }

      if (Object.values(summary).some((count) => count > 0)) {
        this.logger.info('mission_execution_cycle', { ...summary })
      }
    } catch (error: unknown) {
      this.logger.warn('mission_execution_failed', { detail: describeError(error) })
    } finally {
      this.running = false
    }
  }
}
