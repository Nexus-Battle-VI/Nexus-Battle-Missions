import { DomainError } from '../errors/DomainError'
import { experienceCreditOperationId, isExperienceRoll } from '../policies/ExperienceRewardPolicy'
import { retryDelayMs } from './MissionExecution'

/**
 * Estado de la recompensa de experiencia de UNA derrota (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §9).
 *
 * UNA RECOMPENSA POR CADA NPC DERROTADO, nunca una por mision. La clave es la
 * INSTANCIA real de la derrota -- el encuentro y el enemigo concreto que registra
 * la bitacora de HU-72 --, no el arquetipo: una mision puede enfrentar dos veces
 * al mismo tipo de enemigo (`sombra-corrompida` aparece con `count: 4` y con
 * `count: 6` en el ejemplo de HU-72) y quedarse con el arquetipo perderia una de
 * las dos recompensas.
 *
 * POR QUE ESTA TABLA EXISTE. Es el estado que hace posible la GARANTIA del
 * contrato §9.1: una tirada persistida sin acreditar es aceptable mientras exista
 * una recompensa en estado no terminal que la reclame y el barrido pueda
 * terminarla; lo que no puede existir es una tirada huerfana. Para eso la
 * recompensa se persiste ANTES de pedir la tirada, y esa es la regla de orden que
 * este fichero hace cumplir: `PENDING` se escribe primero, `ROLLED` despues,
 * `CREDITED` al final.
 *
 * ES UN AGREGADO CON MAQUINA DE ESTADOS PROPIA, como `MasterEncounterRecord`
 * (HU-73): las transiciones son funciones puras que comprueban el estado de
 * origen y devuelven una recompensa nueva. Ninguna transicion muta su entrada.
 *
 * `PENDING ──► ROLLED ──► CREDITED`
 *    │           │
 *    └───────────┴──► FAILED   (rechazo terminal o cuerpo incoherente)
 *
 * `CREDITED` y `FAILED` son TERMINALES: no hay camino de vuelta, y el barrido
 * solo mira los no terminales.
 */
export const EXPERIENCE_REWARD_STATUSES = ['PENDING', 'ROLLED', 'CREDITED', 'FAILED'] as const

export type ExperienceRewardStatus = (typeof EXPERIENCE_REWARD_STATUSES)[number]

/** Una recompensa terminal no se vuelve a intentar nunca. */
export const isTerminalReward = (status: ExperienceRewardStatus): boolean =>
  status === 'CREDITED' || status === 'FAILED'

/**
 * La derrota concreta de la que sale la recompensa, tal como la registra la
 * bitacora de la simulacion de HU-72.
 */
export interface ExperienceRewardDefeat {
  readonly encounterId: string
  readonly enemyInstanceId: string
  readonly rivalRef: string
}

export interface ExperienceReward {
  readonly enrollmentId: string
  /** Jugador de la matricula: destinatario de la acreditacion. */
  readonly playerId: string
  /** Heroe de la matricula: la experiencia va a EL, no al jugador. */
  readonly heroId: string
  /** Simulacion que produjo la derrota; viaja en las dos peticiones. */
  readonly simulationId: string
  readonly defeat: ExperienceRewardDefeat
  readonly status: ExperienceRewardStatus
  /** Cara del dado, tal como la devolvio Combat. `null` hasta `ROLLED`. */
  readonly roll: number | null
  /** Experiencia ya calculada y ENTERA. `null` hasta `ROLLED`. */
  readonly amount: number | null
  readonly attempts: number
  /** Cuando toca el proximo intento; `null` cuando ya no hay que llamar. */
  readonly nextAttemptAt: Date | null
  readonly lastError: string | null
  readonly creditedAt: Date | null
}

/** Clave de la recompensa: la INSTANCIA de la derrota dentro de la mision. */
export const experienceRewardKey = (reward: {
  readonly enrollmentId: string
  readonly defeat: ExperienceRewardDefeat
}): string =>
  `${reward.enrollmentId}::${reward.defeat.encounterId}::${reward.defeat.enemyInstanceId}`

/** La clave con la que se acredita ESTA derrota a ESTE heroe. Determinista. */
export const creditOperationIdOf = (reward: ExperienceReward): string =>
  experienceCreditOperationId({
    enrollmentId: reward.enrollmentId,
    encounterId: reward.defeat.encounterId,
    enemyInstanceId: reward.defeat.enemyInstanceId,
    heroId: reward.heroId,
  })

export class InvalidRewardTransitionError extends DomainError {
  constructor(reward: ExperienceReward) {
    super(
      `La recompensa de ${experienceRewardKey(reward)} esta en ${reward.status} y no admite esa transicion.`,
    )
    this.name = 'InvalidRewardTransitionError'
  }
}

const requireStatus = (
  reward: ExperienceReward,
  allowed: readonly ExperienceRewardStatus[],
): void => {
  if (!allowed.includes(reward.status)) {
    throw new InvalidRewardTransitionError(reward)
  }
}

/**
 * Crea la recompensa PENDING de una derrota.
 *
 * ESTE ES EL PASO QUE HACE IMPOSIBLE LA TIRADA HUERFANA: se escribe ANTES de
 * pedir nada a Combat, de modo que toda tirada que Combat llegue a persistir
 * corresponde a una recompensa que ya existe y que el barrido recogera.
 *
 * `nextAttemptAt` nace en `now` -- no en `null` -- porque el barrido selecciona
 * por "intento vencido": una recompensa recien creada esta lista para su primer
 * intento en el ciclo siguiente, no esperando a que alguien la despierte.
 */
export const pendingReward = (input: {
  readonly enrollmentId: string
  readonly playerId: string
  readonly heroId: string
  readonly simulationId: string
  readonly defeat: ExperienceRewardDefeat
  readonly now: Date
}): ExperienceReward => ({
  enrollmentId: requireText(input.enrollmentId, 'La recompensa necesita una matriculacion.'),
  playerId: requireText(input.playerId, 'La recompensa necesita un jugador.'),
  heroId: requireText(input.heroId, 'La recompensa necesita un heroe.'),
  simulationId: requireText(input.simulationId, 'La recompensa necesita una simulacion.'),
  defeat: {
    encounterId: requireText(input.defeat.encounterId, 'La derrota necesita un encuentro.'),
    enemyInstanceId: requireText(
      input.defeat.enemyInstanceId,
      'La derrota necesita un enemigo concreto.',
    ),
    rivalRef: requireText(input.defeat.rivalRef, 'La derrota necesita un arquetipo.'),
  },
  status: 'PENDING',
  roll: null,
  amount: null,
  attempts: 0,
  nextAttemptAt: input.now,
  lastError: null,
  creditedAt: null,
})

/**
 * Guarda la tirada y el importe ya calculado: `PENDING` -> `ROLLED`.
 *
 * El importe entra YA calculado por `ExperienceRewardPolicy`, que es el unico
 * dueno de la formula; aqui solo se comprueba que sea un entero no negativo, que
 * es lo que Player/Inventory va a aceptar.
 *
 * `nextAttemptAt` pasa a `now`: lo siguiente es acreditar, y si el proceso se cae
 * entre la tirada y la acreditacion, el barrido tiene que recogerlo de inmediato.
 * La tirada ya esta persistida en Combat, asi que no se vuelve a pedir.
 */
export const rewardRolled = (
  reward: ExperienceReward,
  roll: unknown,
  amount: unknown,
  now: Date,
): ExperienceReward => {
  requireStatus(reward, ['PENDING'])

  if (!isExperienceRoll(roll)) {
    throw new DomainError(
      `La tirada de ${experienceRewardKey(reward)} debe ser una cara valida del dado.`,
    )
  }

  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    throw new DomainError(
      `La experiencia de ${experienceRewardKey(reward)} debe ser un entero no negativo.`,
    )
  }

  return {
    ...reward,
    status: 'ROLLED',
    roll,
    amount,
    // Los intentos son el TOKEN del bloqueo optimista del repositorio, no solo un
    // contador informativo: si esta transicion no los moviera, dos procesos que
    // leyeron la misma recompensa podrian guardar los dos y el segundo pisaria al
    // primero. Por eso incrementa como las demas.
    attempts: reward.attempts + 1,
    nextAttemptAt: now,
    lastError: null,
  }
}

/** `200` de Player/Inventory: la experiencia esta acreditada. Terminal. */
export const rewardCredited = (reward: ExperienceReward, now: Date): ExperienceReward => {
  requireStatus(reward, ['ROLLED'])

  return {
    ...reward,
    status: 'CREDITED',
    attempts: reward.attempts + 1,
    nextAttemptAt: null,
    lastError: null,
    creditedAt: now,
  }
}

/**
 * Rechazo definitivo: queda visible y NO se reintenta. Terminal.
 *
 * No arrastra a las demas recompensas: cada derrota tiene su propio ciclo, y una
 * que falla no revierte la mision ni el resto de la experiencia (§9, CA-08).
 */
export const rewardRejected = (reward: ExperienceReward, reason: string): ExperienceReward => {
  requireStatus(reward, ['PENDING', 'ROLLED'])

  return {
    ...reward,
    status: 'FAILED',
    attempts: reward.attempts + 1,
    nextAttemptAt: null,
    lastError: reason,
  }
}

/**
 * Sin respuesta definitiva: se reintenta con el MISMO `operationId` y el
 * escalonado que ya usa HU-72.
 *
 * El estado NO cambia: una recompensa en `ROLLED` que no consigue acreditarse
 * sigue en `ROLLED` -- la tirada ya esta persistida en Combat y no se vuelve a
 * pedir -- y una en `PENDING` sigue en `PENDING`, porque su tirada todavia no
 * existe.
 */
export const rewardDeferred = (
  reward: ExperienceReward,
  reason: string,
  now: Date,
): ExperienceReward => {
  requireStatus(reward, ['PENDING', 'ROLLED'])
  const attempts = reward.attempts + 1

  return {
    ...reward,
    attempts,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
    lastError: reason,
  }
}

/** Rechaza cadenas vacias o en blanco sin recortar el valor por sorpresa. */
const requireText = (raw: unknown, message: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError(message)
  }

  return raw.trim()
}
