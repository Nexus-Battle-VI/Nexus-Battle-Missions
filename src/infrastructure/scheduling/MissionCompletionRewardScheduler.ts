import type { CoordinateMissionCompletionReward } from '../../application/use-cases/CoordinateMissionCompletionReward'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Barrido de la liquidacion de finalizacion de mision (HU-10, Task HU-10.5;
 * contrato §14).
 *
 * El cierre ya dejo cada derecho como una entrega `PENDING`, con su importe
 * congelado. Cada ciclo solo avanza lo que quedo a medias: XP y creditos hacia
 * Player/Inventory y Wallet, producto hacia el mismo `inventory/grants` de las
 * epicas y el botin, reintentando con la MISMA clave.
 *
 * MISMO PATRON que `ExperienceRewardScheduler` (ADR-019): intervalo dentro del
 * proceso, APAGADO por defecto (`MISSION_COMPLETION_REWARD_ENABLED`) y el estado
 * en la base -- un reinicio retrasa el reintento, no lo pierde.
 *
 * Nunca solapa dos ciclos, y un ciclo que falla no detiene los siguientes.
 */
export class MissionCompletionRewardScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly rewards: CoordinateMissionCompletionReward,
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
      const summary = await this.rewards.run()

      if (Object.values(summary).some((count) => count > 0)) {
        this.logger.info('mission_completion_reward_cycle', { ...summary })
      }
    } catch (error: unknown) {
      this.logger.warn('mission_completion_reward_failed', { detail: describeError(error) })
    } finally {
      this.running = false
    }
  }
}
