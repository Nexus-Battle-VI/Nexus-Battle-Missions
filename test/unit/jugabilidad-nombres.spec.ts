import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { GetMissionDetail } from '../../src/application/use-cases/GetMissionDetail'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import { epicAlbumOf, type EpicCollectionEntry } from '../../src/domain/policies/HistoryPolicy'

const byId = (missionId: string): MissionDefinition => {
  const found = EXAMPLE_MISSIONS.find((mission) => mission.missionId === missionId)
  if (found === undefined) throw new Error(`Falta ${missionId}`)
  return found
}

/** Enlaza a un producto las epicas indicadas, como hace el runbook de productos. */
const linked = (definition: MissionDefinition, epicRefs: readonly string[]): MissionDefinition => ({
  ...definition,
  masterEncounter:
    definition.masterEncounter === null
      ? null
      : {
          ...definition.masterEncounter,
          candidates: definition.masterEncounter.candidates.map((candidate) =>
            epicRefs.includes(candidate.epic.epicRef)
              ? {
                  ...candidate,
                  epic: { ...candidate.epic, productId: '11111111-1111-4111-8111-111111111111' },
                }
              : candidate,
          ),
        },
})

const obtained = (epicRef: string, status: EpicCollectionEntry['status']): EpicCollectionEntry => ({
  epicRef,
  name: epicRef,
  masterRef: null,
  masterName: null,
  obtainedAt: new Date('2026-10-02T03:00:00Z'),
  status,
})

describe('Album de epicas (P-J3)', () => {
  const templo = linked(byId('msn_templo_olvidado'), ['toma-y-lleva'])
  // La Hechicera queda sin producto: su epica no se promete.
  const camara = linked(byId('msn_camara_sellada'), ['golpe-de-defensa'])

  it('lista cada epica entregable con su Master y su mision, y marca las que ya se tienen', () => {
    const album = epicAlbumOf(
      [templo, camara],
      [obtained('toma-y-lleva', 'CREDITED'), obtained('golpe-de-defensa', 'FAILED')],
    )

    expect(album).toEqual([
      {
        epicRef: 'toma-y-lleva',
        name: 'Toma y lleva',
        generalEffect: '+1 al ataque para todos los héroes.',
        epicEffect:
          'Solo Pícaro Veneno: disminuye a la mitad el daño causado por el oponente y se lo retorna.',
        heroType: 'PICARO_VENENO',
        masterName: 'Sombra del Olvido',
        missionId: 'msn_templo_olvidado',
        missionName: 'El Templo Olvidado',
        obtained: true,
      },
      expect.objectContaining({
        epicRef: 'golpe-de-defensa',
        masterName: 'Coloso de Obsidiana',
        missionId: 'msn_camara_sellada',
        // Una entrega fallida no cuenta como obtenida.
        obtained: false,
      }),
    ])
  })

  it('una epica en camino ya cuenta, y la misma epica en dos misiones sale una vez', () => {
    const otra: MissionDefinition = { ...camara, missionId: 'msn_otra', name: 'Otra' }

    const album = epicAlbumOf([templo, camara, otra], [obtained('golpe-de-defensa', 'PENDING')])

    expect(album.map((entry) => [entry.epicRef, entry.missionId, entry.obtained])).toEqual([
      ['toma-y-lleva', 'msn_templo_olvidado', false],
      ['golpe-de-defensa', 'msn_camara_sellada', true],
    ])
  })

  it('sin productos enlazados no promete ninguna epica (P-J2)', () => {
    expect(epicAlbumOf(EXAMPLE_MISSIONS, [])).toEqual([])
  })
})

describe('Nombres en lugar de identificadores (P-J10)', () => {
  it('el detalle nombra las misiones previas', async () => {
    const detail = new GetMissionDetail(
      new InMemoryMissionCatalog(EXAMPLE_MISSIONS),
      new InMemoryEnrollmentRepository(),
      new InMemoryDifficultyClearRepository(),
    )

    const view = await detail.execute('sub-1', 'msn_camara_sellada')

    expect(view.imageRef).toBe('mision-camara-sellada')
    expect(view.prerequisites).toEqual(['msn_templo_olvidado'])
    expect(view.prerequisiteMissions).toEqual([
      { missionId: 'msn_templo_olvidado', name: 'El Templo Olvidado' },
    ])
  })

  it('una mision previa que ya no esta activa se muestra con su identificador', async () => {
    const camara = byId('msn_camara_sellada')
    const detail = new GetMissionDetail(
      new InMemoryMissionCatalog([{ ...camara, prerequisites: ['msn_retirada'] }]),
      new InMemoryEnrollmentRepository(),
      new InMemoryDifficultyClearRepository(),
    )

    const view = await detail.execute('sub-1', 'msn_camara_sellada')

    expect(view.prerequisiteMissions).toEqual([{ missionId: 'msn_retirada', name: 'msn_retirada' }])
  })
})
