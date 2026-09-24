import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  deliverableDropsOf,
  deliverableEpicOf,
  deliverableHighlightsOf,
  playerRewardsOf,
} from '../../src/domain/policies/DeliverableRewardsPolicy'

const TEMPLO = EXAMPLE_MISSIONS[0]!
const PRODUCT = '11111111-1111-4111-8111-111111111111'

/** El Templo con la epica y los dos botines mas probables enlazados a productos. */
const linked = (): MissionDefinition => {
  const master = TEMPLO.masterEncounter!
  return {
    ...TEMPLO,
    finalBoss: {
      ...TEMPLO.finalBoss,
      drops: (TEMPLO.finalBoss.drops ?? []).map((drop, index) => ({
        ...drop,
        productId: index < 2 ? PRODUCT : null,
      })),
    },
    masterEncounter: {
      ...master,
      candidates: master.candidates.map((candidate) => ({
        ...candidate,
        epic: { ...candidate.epic, productId: PRODUCT },
      })),
    },
  }
}

describe('Recompensas que ve el jugador (P-J2)', () => {
  it('nunca promete creditos, cofres, bonos ni titulos: nadie los entrega todavia (HU-10)', () => {
    const rewards = playerRewardsOf(linked())

    expect(TEMPLO.rewards.guaranteed.length).toBeGreaterThan(0)
    expect(rewards).toMatchObject({
      experience: true,
      guaranteed: [],
      objectiveBonuses: [],
      firstTime: [],
    })
  })

  it('el botin solo aparece con producto enlazado, sin el producto y con su probabilidad', () => {
    expect(deliverableDropsOf(TEMPLO)).toEqual([])
    expect(deliverableDropsOf(linked())).toEqual([
      { label: 'Fragmento del Sello Antiguo', probability: 0.6, rolls: 3 },
      { label: 'Armadura «Piel del Guardián»', probability: 0.2, rolls: 1 },
    ])
  })

  it('la epica solo se promete si ya es un producto', () => {
    const [candidate] = TEMPLO.masterEncounter!.candidates
    const [linkedCandidate] = linked().masterEncounter!.candidates

    expect(deliverableEpicOf(candidate!)).toBeNull()
    expect(deliverableEpicOf(linkedCandidate!)).toMatchObject({ name: 'Velo de Sombras' })
  })

  it('la tarjeta destaca experiencia, epicas posibles y el botin mas probable', () => {
    expect(deliverableHighlightsOf(TEMPLO)).toEqual([
      { label: 'Experiencia por cada enemigo derrotado' },
    ])
    expect(deliverableHighlightsOf(linked())).toEqual([
      { label: 'Experiencia por cada enemigo derrotado' },
      { label: 'Épica posible: Velo de Sombras' },
      { label: 'Fragmento del Sello Antiguo' },
      { label: 'Armadura «Piel del Guardián»' },
    ])
  })
})
