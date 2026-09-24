import {
  pendingReward,
  type ExperienceReward,
  type ExperienceRewardDefeat,
} from '../entities/ExperienceReward'
import { DomainError } from '../errors/DomainError'

/**
 * Lectura de las derrotas de una simulacion (HU-09, Task HU-09.4;
 * `hu-09-experience-reward-v1` §4.1).
 *
 * DE DONDE SALE LA IDENTIDAD DE UNA RECOMPENSA. Del `combatLog` que produce la
 * simulacion de HU-72: cada baja se registra como
 *
 *     { "seq": 4, "type": "combatantDefeated", "encounter": 1, "turn": 1,
 *       "combatant": "sombra-corrompida#1" }
 *
 * `encounter` y `combatant` son la INSTANCIA real de la derrota, que es lo que
 * identifica la recompensa. `summary.enemiesDefeated[]` NO sirve para esto: es un
 * agregado por arquetipo (`{ enemyRef, count }`) y perderia las derrotas
 * repetidas -- una mision puede enfrentar dos veces al mismo tipo de enemigo, una
 * con `count: 4` y otra con `count: 6`, y son diez recompensas, no dos.
 *
 * EL ORDEN IMPORTA Y SE CONSERVA. El lote de tiradas se resuelve en el orden de
 * las derrotas que Missions envia, y ese orden es el de la bitacora: mismo
 * `operationId` y mismo cuerpo producen las mismas tiradas, en el mismo orden.
 *
 * ENTRADA NO CONFIABLE. La bitacora llega de otro servicio y se guarda como
 * `unknown[]`: aqui se comprueba campo a campo. Un evento de otro tipo se IGNORA
 * (la bitacora tiene muchos mas: turnos, ataques, inicio y fin de encuentro), y
 * un `combatantDefeated` que no cumple el contrato se DESCARTA y se devuelve como
 * incidencia, en lugar de lanzar.
 *
 * POR QUE NO LANZA. Lanzar dejaria la mision sin cerrar en cada ciclo -- y con
 * ella al heroe reservado para siempre -- por un unico evento mal formado de un
 * productor ajeno. El cierre tiene que terminar; lo que no puede es callarse: las
 * incidencias viajan al registro, de modo que un productor roto se ve. Se pierde
 * como mucho la recompensa de ese evento, nunca la mision entera.
 */

/** Tipo del evento de baja en la bitacora de HU-72. */
export const COMBATANT_DEFEATED_EVENT = 'combatantDefeated'

export interface CombatLogReading {
  /** Las derrotas legibles, en el orden de la bitacora. */
  readonly defeats: readonly ExperienceRewardDefeat[]
  /** Una linea por evento `combatantDefeated` que no cumple el contrato. */
  readonly invalid: readonly string[]
}

/**
 * Lee la bitacora y devuelve las derrotas, mas las incidencias.
 *
 * Deduplica por instancia: dos eventos con el mismo encuentro y el mismo
 * `combatant` son la MISMA baja registrada dos veces -- la clave de la recompensa
 * es unica por instancia --, no dos recompensas.
 */
export const readCombatLog = (combatLog: readonly unknown[]): CombatLogReading => {
  const defeats = new Map<string, ExperienceRewardDefeat>()
  const invalid: string[] = []

  for (const [index, entry] of combatLog.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const event = entry as Record<string, unknown>

    if (event.type !== COMBATANT_DEFEATED_EVENT) {
      continue
    }

    const defeat = defeatOf(event)

    if (defeat === null) {
      invalid.push(
        `La baja ${String(index)} de la bitacora no identifica una instancia (<enemyRef>#<n>) con su encuentro.`,
      )
      continue
    }

    const key = `${defeat.encounterId}#${defeat.enemyInstanceId}`

    if (!defeats.has(key)) {
      defeats.set(key, defeat)
    }
  }

  return { defeats: [...defeats.values()], invalid }
}

/**
 * Una baja de la bitacora, o `null` si no cumple el contrato.
 *
 * `combatant` tiene que ser `<enemyRef>#<n>`: el arquetipo se deriva de ahi para
 * trazabilidad, y una instancia sin numero no identifica nada.
 */
const defeatOf = (event: Record<string, unknown>): ExperienceRewardDefeat | null => {
  const encounter = event.encounter
  const combatant = event.combatant

  if (typeof encounter !== 'number' || !Number.isInteger(encounter) || encounter < 1) {
    return null
  }

  if (typeof combatant !== 'string' || combatant.trim().length === 0) {
    return null
  }

  const [rivalRef, instance] = combatant.split('#')

  if (rivalRef === undefined || rivalRef.trim().length === 0 || !isInstance(instance)) {
    return null
  }

  return {
    // El contrato viaja con el encuentro como cadena hacia Combat y
    // Player/Inventory; la bitacora lo trae como numero.
    encounterId: String(encounter),
    enemyInstanceId: combatant,
    rivalRef,
  }
}

/** El sufijo de una instancia: un entero positivo. */
const isInstance = (raw: string | undefined): boolean => {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return false
  }

  return Number(raw) >= 1
}

/**
 * Las recompensas PENDING de una mision cerrada: una por cada derrota.
 *
 * ES LA PRIMERA MITAD DE LA REGLA DE ORDEN DEL CONTRATO §9.1 y la que hace
 * imposible la tirada huerfana: esto se ejecuta en la MISMA transaccion del
 * cierre, ANTES de que Missions pida ninguna tirada, de modo que toda tirada que
 * Combat llegue a persistir corresponde a una recompensa que ya existe.
 *
 * NO PIDE NADA A NADIE Y NO CALCULA IMPORTES. Devuelve recompensas `PENDING` sin
 * tirada y sin importe: la tirada la traera Combat y el importe lo pondra
 * `experienceForRoll` cuando se conozca la cara.
 *
 * SIN DERROTAS NO HAY RECOMPENSAS (CA-08), y una lista vacia es un resultado
 * legitimo, no un error: significa que esa mision no dejo ninguna baja legible.
 */
export const experienceRewardsOf = (input: {
  readonly enrollmentId: string
  readonly playerId: string
  readonly heroId: string
  readonly simulationId: string
  readonly defeats: readonly ExperienceRewardDefeat[]
  readonly now: Date
}): readonly ExperienceReward[] =>
  input.defeats.map((defeat) =>
    pendingReward({
      enrollmentId: input.enrollmentId,
      playerId: input.playerId,
      heroId: input.heroId,
      simulationId: input.simulationId,
      defeat,
      now: input.now,
    }),
  )

/** Un `DomainError` con el detalle de una incidencia, para el registro del cierre. */
export const invalidDefeatError = (detail: string): DomainError => new DomainError(detail)
