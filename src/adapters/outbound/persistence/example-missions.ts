import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'

/**
 * Misiones DE EJEMPLO para desarrollo (`MISSIONS_EXAMPLE_CATALOG=true`, solo con
 * persistencia en memoria). No son contenido aprobado: «El Templo Olvidado» es
 * el ejemplo de la seccion 7.8.14 del documento del curso, y «La Camara Sellada»
 * existe solo para ver un requisito previo en el tablon.
 *
 * Donde el curso no da un valor, queda vacio: no se inventan estadisticas.
 */
export const EXAMPLE_MISSIONS: readonly MissionDefinition[] = [
  {
    missionId: 'msn_templo_olvidado',
    name: 'El Templo Olvidado',
    category: 'STORY',
    summary: 'Un templo custodiado por criaturas corrompidas y un guardián milenario.',
    narrative:
      'En las profundidades del Bosque Sombrío yace un antiguo templo dedicado a los Dioses ' +
      'Olvidados. Según las leyendas, alberga poderosos artefactos y conocimientos ancestrales, ' +
      'custodiados por criaturas corrompidas y un guardián milenario.',
    imageRef: null,
    estimatedDurationMinutes: 12 * 60,
    recommendedPower: 15,
    prerequisites: [],
    objectives: [
      { id: 'obj_guardian', text: 'Derrotar al Guardián del Templo.', primary: true },
      { id: 'obj_camaras', text: 'Explorar las 5 cámaras del templo.', primary: true },
      {
        id: 'obj_vida',
        text: 'Completar la misión sin que la vida del héroe baje del 50 %.',
        primary: false,
      },
      { id: 'obj_master', text: 'Derrotar al Máster si aparece.', primary: false },
      {
        id: 'obj_fragmentos',
        text: 'Encontrar los 3 fragmentos del Sello Antiguo.',
        primary: false,
      },
    ],
    enemies: [
      {
        enemyRef: 'sombra-corrompida',
        name: 'Sombras Corrompidas',
        count: 10,
        description: 'Enemigos básicos con ataque moderado.',
      },
      {
        enemyRef: 'guardian-de-piedra',
        name: 'Guardianes de Piedra',
        count: 5,
        description: 'Enemigos con alta defensa.',
      },
      {
        enemyRef: 'espectro-ancestral',
        name: 'Espectros Ancestrales',
        count: 3,
        description: 'Enemigos con ataques mágicos.',
      },
    ],
    finalBoss: {
      enemyRef: 'guardian-eterno',
      name: 'El Guardián Eterno',
      heroType: 'GUERRERO_TANQUE',
      description: 'Guerrero Tanque con habilidades potenciadas.',
      stats: { health: 100 },
    },
    masterEncounter: {
      probability: 0.15,
      candidates: [
        {
          masterRef: 'sombra-del-olvido',
          name: 'Sombra del Olvido',
          heroType: 'PICARO_VENENO',
          epic: {
            epicRef: 'velo-de-sombras',
            name: 'Velo de Sombras',
            generalEffect: '+2 a la defensa para todos los héroes.',
            epicEffect:
              'Solo Pícaro Veneno: intangible durante 1 turno y envenena al atacante ' +
              '(+3 de daño durante 2 turnos).',
          },
        },
      ],
    },
    rewards: {
      guaranteed: [{ label: '50 créditos' }, { label: '1 Cofre de Bronce' }],
      potential: [
        { label: 'Fragmento del Sello Antiguo', probability: 0.6, rolls: 3 },
        { label: 'Armadura «Piel del Guardián»', probability: 0.2, rolls: 1 },
        { label: 'Arma «Espada del Templo»', probability: 0.15, rolls: 1 },
      ],
      objectiveBonuses: [],
      firstTime: [
        { label: '10 créditos adicionales' },
        { label: 'Título «Explorador del Templo»' },
      ],
    },
    highlightedRewards: [{ label: '50 créditos' }, { label: '1 Cofre de Bronce' }],
    active: true,
  },
  {
    missionId: 'msn_camara_sellada',
    name: 'La Cámara Sellada',
    category: 'STORY',
    summary: 'Ejemplo de misión con requisito previo.',
    narrative: 'Misión de ejemplo para ver en el tablón una misión bloqueada por requisitos.',
    imageRef: null,
    estimatedDurationMinutes: 6 * 60,
    recommendedPower: null,
    prerequisites: ['msn_templo_olvidado'],
    objectives: [{ id: 'obj_sello', text: 'Abrir la cámara sellada.', primary: true }],
    enemies: [],
    finalBoss: {
      enemyRef: 'custodio-del-sello',
      name: 'Custodio del Sello',
      heroType: null,
      description: null,
      stats: {},
    },
    masterEncounter: null,
    rewards: { guaranteed: [], potential: [], objectiveBonuses: [], firstTime: [] },
    highlightedRewards: [],
    active: true,
  },
]
