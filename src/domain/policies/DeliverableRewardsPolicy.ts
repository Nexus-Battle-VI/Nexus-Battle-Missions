import type {
  MasterCandidate,
  MasterEpic,
  MissionDefinition,
  RewardLabel,
} from '../entities/MissionDefinition'

/** Un botin posible del jefe que el servicio SI entrega: su producto ya esta enlazado. */
export interface DeliverableDrop {
  readonly label: string
  /** Fraccion entre 0 y 1 por tirada; el jugador la ve como porcentaje (HU-70 CA-06). */
  readonly probability: number
  readonly rolls: number
}

/**
 * Las recompensas que ve el jugador (diseno «misiones jugables», P-J2): solo lo
 * que el servicio entrega de verdad. La experiencia de cada derrota (HU-09) y el
 * botin del jefe con producto enlazado (P-J1). Los creditos, el cofre, los bonos
 * por objetivo y el titulo de primera vez son texto del contenido que nadie
 * entrega todavia (HU-10): siguen en la definicion para cuando exista quien los
 * entregue, pero no se prometen.
 */
export interface PlayerRewards {
  /** Siempre: cada enemigo derrotado da experiencia (HU-09). */
  readonly experience: true
  readonly guaranteed: readonly RewardLabel[]
  readonly potential: readonly DeliverableDrop[]
  readonly objectiveBonuses: readonly RewardLabel[]
  readonly firstTime: readonly RewardLabel[]
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

export const deliverableDropsOf = (definition: MissionDefinition): readonly DeliverableDrop[] =>
  (definition.finalBoss.drops ?? [])
    .filter((drop) => isText(drop.productId))
    .map(({ label, probability, rolls }) => ({ label, probability, rolls }))

export const playerRewardsOf = (definition: MissionDefinition): PlayerRewards => ({
  experience: true,
  guaranteed: [],
  potential: deliverableDropsOf(definition),
  objectiveBonuses: [],
  firstTime: [],
})

/** La epica de un Master solo se promete si ya es un producto que se puede entregar. */
export const deliverableEpicOf = (candidate: MasterCandidate): MasterEpic | null =>
  isText(candidate.epic.productId) ? candidate.epic : null

/**
 * Lo que destaca la tarjeta del tablon: la experiencia, las epicas posibles y el
 * botin mas probable, todo entregable. Antes se mostraba el texto del contenido
 * («50 creditos», «Cofre de Bronce»), que nadie entregaba.
 */
export const deliverableHighlightsOf = (definition: MissionDefinition): readonly RewardLabel[] => {
  const epics = (definition.masterEncounter?.candidates ?? []).flatMap((candidate) => {
    const epic = deliverableEpicOf(candidate)
    return epic === null ? [] : [{ label: `Épica posible: ${epic.name}` }]
  })
  const drops = [...deliverableDropsOf(definition)]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 2)
    .map((drop) => ({ label: drop.label }))

  return [{ label: 'Experiencia por cada enemigo derrotado' }, ...epics.slice(0, 2), ...drops]
}
