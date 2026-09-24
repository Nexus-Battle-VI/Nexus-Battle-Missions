import {
  creditOperationIdOf,
  rewardCredited,
  rewardDeferred,
  rewardRejected,
  rewardRolled,
  type ExperienceReward,
} from '../../domain/entities/ExperienceReward'
import type { ReportLineUpdate } from '../../domain/entities/MissionReport'
import {
  experienceForRoll,
  experienceRollsOperationId,
} from '../../domain/policies/ExperienceRewardPolicy'
import type { ClockPort } from '../ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ExperienceCreditOutcome, ExperienceCreditPort } from '../ports/ExperienceCreditPort'
import type { ExperienceRewardRepositoryPort } from '../ports/ExperienceRewardRepositoryPort'
import type { ExperienceRollPort, ExperienceRollResult } from '../ports/ExperienceRollPort'

export interface ExperienceRewardCycleSummary {
  /** Lotes de tiradas resueltos (uno por mision). */
  readonly rollsResolved: number
  readonly rewardsRolled: number
  readonly rewardsCredited: number
  /** Rechazo definitivo: queda visible y no se reintenta. */
  readonly rewardsRejected: number
  /** Sin respuesta definitiva: se reintenta con la MISMA clave. */
  readonly rewardsRetried: number
  /** El intento lanzo: se aplaza y se informa, sin detener a las demas. */
  readonly rewardsFailed: number
}

type Tally = { -readonly [K in keyof ExperienceRewardCycleSummary]: number }

export interface ExperienceRewardOptions {
  readonly batchSize: number
  /** Un fallo en una mision no detiene a las demas; se informa aqui. */
  readonly onError?: (enrollmentId: string, error: unknown) => void
}

/**
 * Coordinacion de la recompensa de experiencia (HU-09, Task HU-09.4; contrato
 * §5.2, §7 y §9).
 *
 * ES EL ESLABON QUE UNE LAS TRES PIEZAS. El cierre de la mision ya dejo una
 * recompensa `PENDING` por cada NPC derrotado; este ciclo, por cada mision con
 * recompensas no terminales:
 *
 *   1. pide a Combat el lote de tiradas de esa mision (`mission:{enrollmentId}:xp-rolls`),
 *      UNA tirada por derrota y en el orden de la bitacora;
 *   2. calcula el importe con `experienceForRoll` -- la formula vive solo ahi -- y
 *      guarda tirada e importe (`ROLLED`);
 *   3. acredita cada derrota en Player/Inventory con SU clave y su importe
 *      (`CREDITED`), una por una.
 *
 * LA REGLA DE ORDEN NO SE NEGOCIA y ya se cumplio antes de llegar aqui: la
 * recompensa se persiste ANTES de pedir la tirada. Es lo que hace imposible la
 * tirada huerfana que el contrato §9.1 prohibe.
 *
 * UN REINTENTO NO VUELVE A TIRAR. Si el proceso se cae entre la tirada y la
 * acreditacion, la recompensa queda `ROLLED` con su importe guardado: el ciclo
 * siguiente acredita, sin pedir otra tirada. Y si se cae antes de tener la
 * respuesta de Combat, vuelve a pedir el MISMO lote con el MISMO `operationId`,
 * que es idempotente y devuelve las mismas caras.
 *
 * UNA DERROTA QUE FALLA NO ARRASTRA A LAS DEMAS. Cada recompensa tiene su estado
 * y su clave: un rechazo definitivo de una no toca a las otras, y la mision no se
 * revierte (contrato §9).
 *
 * Y DEJA EL RASTRO EN EL REPORTE. Cada avance terminal mueve, EN LA MISMA
 * ESCRITURA, la linea `EXPERIENCE` de esa derrota en el reporte de HU-74 (Task
 * HU-09.5): el jugador ve ahi que su experiencia llego y cuanta, y el nivel en que
 * quedo el heroe. Un desenlace sin respuesta definitiva no toca la linea, porque no
 * es un desenlace.
 */
export class CoordinateExperienceReward {
  constructor(
    private readonly rewards: ExperienceRewardRepositoryPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly rolls: ExperienceRollPort,
    private readonly credits: ExperienceCreditPort,
    private readonly clock: ClockPort,
    private readonly options: ExperienceRewardOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<ExperienceRewardCycleSummary> {
    const tally: Tally = {
      rollsResolved: 0,
      rewardsRolled: 0,
      rewardsCredited: 0,
      rewardsRejected: 0,
      rewardsRetried: 0,
      rewardsFailed: 0,
    }

    const due = await this.rewards.dueRewards(this.clock.now(), this.options.batchSize)

    for (const [enrollmentId, rewards] of batchesOf(due)) {
      try {
        await this.advance(enrollmentId, rewards, tally)
      } catch (error: unknown) {
        tally.rewardsFailed += rewards.length
        this.options.onError?.(enrollmentId, error)
        await this.deferAfterFailure(rewards)
      }
    }

    return { ...tally }
  }

  /**
   * Una mision: primero las tiradas que falten, despues las acreditaciones.
   *
   * Se procesan en ese orden dentro del MISMO ciclo para que una recompensa
   * recien tirada se acredite sin esperar al siguiente; y se vuelve a leer el
   * estado de cada recompensa antes de acreditarla, porque la tirada acaba de
   * cambiarlo.
   */
  private async advance(
    enrollmentId: string,
    rewards: readonly ExperienceReward[],
    tally: Tally,
  ): Promise<void> {
    const enrollment = await this.enrollments.findById(enrollmentId)

    if (enrollment === null) {
      throw new Error(`La matricula ${enrollmentId} no existe.`)
    }

    // El cierre no deja recompensas en una anulacion; esto solo cubre un dato que
    // no deberia existir (mismo criterio que la entrega de la epica, P-X6).
    if (enrollment.status === 'VOIDED') {
      for (const reward of rewards) {
        if (
          await this.rewards.save(
            rewardRejected(reward, 'MISSION_VOIDED'),
            reward.attempts,
            rejectedLine(this.now()),
          )
        ) {
          tally.rewardsRejected += 1
        }
      }
      return
    }

    const rolled = await this.rollPending(rewards, tally)

    for (const reward of [...rewards.filter(isRolled), ...rolled]) {
      await this.credit(reward, tally)
    }
  }

  /** Pide a Combat las tiradas que falten y guarda tirada e importe. */
  private async rollPending(
    rewards: readonly ExperienceReward[],
    tally: Tally,
  ): Promise<readonly ExperienceReward[]> {
    const pending = rewards.filter((reward) => reward.status === 'PENDING')
    const first = pending.at(0)

    if (first === undefined) {
      return []
    }

    const outcome = await this.rolls.rollDefeats({
      operationId: experienceRollsOperationId(first.enrollmentId),
      enrollmentId: first.enrollmentId,
      simulationId: first.simulationId,
      heroId: first.heroId,
      defeats: pending.map((reward) => ({
        encounterId: reward.defeat.encounterId,
        enemyInstanceId: reward.defeat.enemyInstanceId,
        rivalRef: reward.defeat.rivalRef,
      })),
    })

    if (outcome.kind === 'REJECTED') {
      for (const reward of pending) {
        if (
          await this.rewards.save(
            rewardRejected(reward, outcome.reason),
            reward.attempts,
            rejectedLine(this.now()),
          )
        ) {
          tally.rewardsRejected += 1
        }
      }
      return []
    }

    if (outcome.kind === 'UNKNOWN') {
      for (const reward of pending) {
        if (
          await this.rewards.save(
            rewardDeferred(reward, outcome.reason, this.now()),
            reward.attempts,
          )
        ) {
          tally.rewardsRetried += 1
        }
      }
      return []
    }

    const byDefeat = indexOfRolls(outcome.rolls, pending)

    // Una respuesta sin la tirada de alguna derrota NO se completa a ojo: se
    // aplaza entera y se reintenta con la misma clave.
    if (byDefeat === null) {
      for (const reward of pending) {
        if (
          await this.rewards.save(
            rewardDeferred(reward, 'INCOMPLETE_ROLLS', this.now()),
            reward.attempts,
          )
        ) {
          tally.rewardsRetried += 1
        }
      }
      return []
    }

    tally.rollsResolved += 1

    const rolled: ExperienceReward[] = []

    for (const reward of pending) {
      const roll = byDefeat.get(defeatKeyOf(reward))

      // `indexOfRolls` ya garantizo que estan todas; si aun asi faltara, se
      // aplaza en vez de inventar una cara.
      if (roll === undefined) {
        if (
          await this.rewards.save(
            rewardDeferred(reward, 'INCOMPLETE_ROLLS', this.now()),
            reward.attempts,
          )
        ) {
          tally.rewardsRetried += 1
        }
        continue
      }

      const next = rewardRolled(reward, roll, experienceForRoll(roll), this.now())

      if (await this.rewards.save(next, reward.attempts)) {
        tally.rewardsRolled += 1
        rolled.push(next)
      }
    }

    return rolled
  }

  /** Acredita una derrota en Player/Inventory con su clave y su importe. */
  private async credit(reward: ExperienceReward, tally: Tally): Promise<void> {
    if (reward.status !== 'ROLLED' || reward.roll === null || reward.amount === null) {
      return
    }

    const outcome = await this.credits.credit({
      operationId: creditOperationIdOf(reward),
      playerId: reward.playerId,
      heroId: reward.heroId,
      amount: reward.amount,
      source: {
        kind: 'MISSION_RIVAL_DEFEAT',
        enrollmentId: reward.enrollmentId,
        simulationId: reward.simulationId,
        encounterId: reward.defeat.encounterId,
        enemyInstanceId: reward.defeat.enemyInstanceId,
        rivalRef: reward.defeat.rivalRef,
        roll: reward.roll,
      },
    })

    const next =
      outcome.kind === 'CREDITED'
        ? rewardCredited(reward, this.now())
        : outcome.kind === 'REJECTED'
          ? rewardRejected(reward, outcome.reason)
          : rewardDeferred(reward, outcome.reason, this.now())

    // HU-09 (Task HU-09.5): la linea del reporte se mueve CON la recompensa, en su
    // misma escritura. Un desenlace sin respuesta definitiva no la toca: la
    // recompensa sigue viva y su linea sigue `PENDING`.
    if (
      await this.rewards.save(next, reward.attempts, creditedLineOf(outcome, reward, this.now()))
    ) {
      if (outcome.kind === 'CREDITED') {
        tally.rewardsCredited += 1
      } else if (outcome.kind === 'REJECTED') {
        tally.rewardsRejected += 1
      } else {
        tally.rewardsRetried += 1
      }
    }
  }

  /**
   * Intento que lanzo: se aplaza con el mismo escalonado. Si no, conservaria la
   * fecha mas antigua y volveria al frente de la cola en cada ciclo.
   */
  private async deferAfterFailure(rewards: readonly ExperienceReward[]): Promise<void> {
    const now = this.now()

    try {
      for (const reward of rewards) {
        await this.rewards.save(rewardDeferred(reward, 'INTERNAL_ERROR', now), reward.attempts)
      }
    } catch {
      // Sin base no hay como aplazarlas: el ciclo siguiente lo vuelve a intentar.
    }
  }

  private now(): Date {
    return this.clock.now()
  }
}

export const COORDINATE_EXPERIENCE_REWARD = Symbol('CoordinateExperienceReward')

/** Las recompensas agrupadas por matricula, en el orden en que llegaron. */
const batchesOf = (
  rewards: readonly ExperienceReward[],
): ReadonlyMap<string, readonly ExperienceReward[]> => {
  const batches = new Map<string, ExperienceReward[]>()

  for (const reward of rewards) {
    const batch = batches.get(reward.enrollmentId)

    if (batch === undefined) {
      batches.set(reward.enrollmentId, [reward])
    } else {
      batch.push(reward)
    }
  }

  return batches
}

const isRolled = (reward: ExperienceReward): boolean =>
  reward.status === 'ROLLED' && reward.roll !== null && reward.amount !== null

const defeatKeyOf = (reward: ExperienceReward): string =>
  `${reward.defeat.encounterId}#${reward.defeat.enemyInstanceId}`

/**
 * Indexa las caras recibidas por derrota, o `null` si falta alguna.
 *
 * Combat devuelve una tirada por derrota del lote; si devuelve menos, o alguna no
 * es una cara valida, la respuesta no sirve: no se completa a ojo ni se inventa
 * un valor medio.
 */
const indexOfRolls = (
  rolls: readonly ExperienceRollResult[],
  pending: readonly ExperienceReward[],
): ReadonlyMap<string, number> | null => {
  const byDefeat = new Map<string, number>()

  for (const roll of rolls) {
    byDefeat.set(`${roll.encounterId}#${roll.enemyInstanceId}`, roll.roll)
  }

  for (const reward of pending) {
    if (!byDefeat.has(defeatKeyOf(reward))) {
      return null
    }
  }

  return byDefeat
}

/**
 * La linea del reporte en un rechazo definitivo: queda `FAILED` y SIN IMPORTE,
 * porque no se entrego nada. Se marca para que el jugador vea QUE derrota fallo;
 * el motivo viaja al registro, no al reporte.
 */
const rejectedLine = (at: Date): ReportLineUpdate => ({
  status: 'FAILED',
  quantity: 0,
  progression: null,
  at,
})

/**
 * El reflejo de una acreditacion en su linea, o `null` si el desenlace no fue
 * definitivo.
 *
 * `quantity` ES LA EXPERIENCIA ACREDITADA: en una linea de experiencia la cantidad
 * es el propio importe. Por eso la linea nace en cero -- cuando nace, la tirada
 * todavia no ha ocurrido -- y se completa aqui, con el importe que ya calculo la
 * politica.
 *
 * `progression` viaja tal cual venga de Player/Inventory: `null` si no la devolvio,
 * y entonces la linea queda acreditada, con su importe y sin nivel, en lugar de
 * darla por fallida.
 */
const creditedLineOf = (
  outcome: ExperienceCreditOutcome,
  reward: ExperienceReward,
  at: Date,
): ReportLineUpdate | null => {
  if (outcome.kind === 'UNKNOWN') {
    return null
  }

  if (outcome.kind === 'REJECTED') {
    return rejectedLine(at)
  }

  return {
    status: 'CREDITED',
    quantity: reward.amount ?? 0,
    progression: outcome.progression,
    at,
  }
}
