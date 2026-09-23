import type { EvaluateMissionAchievements } from '../../application/use-cases/EvaluateMissionAchievements'
import type { GrantAchievementRecognitions } from '../../application/use-cases/GrantAchievementRecognitions'
import type { GrantMasterEpics } from '../../application/use-cases/GrantMasterEpics'
import type { RunMissionExecutions } from '../../application/use-cases/RunMissionExecutions'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/** Los pasos del ciclo, en el orden en que corren; `step` en el registro de un fallo. */
type CycleStep = 'executions' | 'epics' | 'achievements' | 'recognitions'

/**
 * Ejecuta el ciclo de HU-72 cada cierto intervalo (CU-72.1 a CU-72.3): programa,
 * simula, cierra y libera. Despues entrega las epicas pendientes de HU-73
 * (CU-73.3), evalua los logros de HU-76 (CU-76.1) y entrega sus cosmeticos
 * (CU-76.2). En ese orden, una epica entregada en el ciclo ya cuenta para la
 * coleccion, y un cosmetico recien desbloqueado se pide en el mismo ciclo.
 *
 * Mismo patron que el reconciliador de HU-70 y los demas temporizadores de
 * ADR-019: intervalo dentro del proceso y APAGADO por defecto
 * (`MISSION_EXECUTION_ENABLED`). El estado vive en la base: un reinicio retrasa
 * la simulacion, el cierre o la entrega, no los pierde.
 *
 * Nunca solapa dos ciclos. Cada paso corre aunque falle el anterior (HU-76): un
 * cierre que falla no deja sin entregar las epicas ni sin evaluar los logros, y
 * el ciclo registra lo que si hicieron los demas.
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
    private readonly achievements: EvaluateMissionAchievements | null = null,
    private readonly recognitions: GrantAchievementRecognitions | null = null,
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
      // Las claves de los resumenes no se repiten entre pasos, asi que se unen sin pisarse.
      const summary: Record<string, number> = {}

      await this.step('executions', summary, this.executions)
      await this.step('epics', summary, this.epics)
      await this.step('achievements', summary, this.achievements)
      await this.step('recognitions', summary, this.recognitions)

      if (Object.values(summary).some((count) => count > 0)) {
        this.logger.info('mission_execution_cycle', { ...summary })
      }
    } finally {
      this.running = false
    }
  }

  private async step(
    name: CycleStep,
    summary: Record<string, number>,
    useCase: { run(): Promise<object> } | null,
  ): Promise<void> {
    if (useCase === null) {
      return
    }

    try {
      Object.assign(summary, await useCase.run())
    } catch (error: unknown) {
      this.logger.warn('mission_execution_failed', { step: name, detail: describeError(error) })
    }
  }
}
