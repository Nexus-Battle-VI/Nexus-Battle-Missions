import type { CoordinateExperienceReward } from '../../application/use-cases/CoordinateExperienceReward'
import { describeError } from '../observability/describe-error'
import type { Logger } from '../observability/logger'

/**
 * Barrido de la recompensa de experiencia (HU-09, Task HU-09.4; contrato §9).
 *
 * Cada ciclo avanza lo que quedo a medias: pide a Combat las tiradas que falten y
 * acredita en Player/Inventory lo que ya tenga importe, reintentando con la MISMA
 * clave. Es lo que sostiene la garantia del contrato §9.1: una tirada persistida
 * sin acreditar es aceptable mientras exista una recompensa no terminal que la
 * reclame y este barrido pueda terminarla.
 *
 * MISMO PATRON que los demas temporizadores del servicio (ADR-019): intervalo
 * dentro del proceso, APAGADO por defecto (`EXPERIENCE_REWARD_ENABLED`) y el
 * estado en la base -- un reinicio retrasa el reintento, no lo pierde.
 *
 * Nunca solapa dos ciclos, y un ciclo que falla no detiene los siguientes.
 */
export class ExperienceRewardScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly rewards: CoordinateExperienceReward,
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
        this.logger.info('experience_reward_cycle', { ...summary })
      }
    } catch (error: unknown) {
      this.logger.warn('experience_reward_failed', { detail: describeError(error) })
    } finally {
      this.running = false
    }
  }
}
