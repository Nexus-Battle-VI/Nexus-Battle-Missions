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
    // Reglas de la tabla «Objetivos del ejemplo del curso» del contrato de HU-72.
    objectives: [
      {
        id: 'obj_guardian',
        text: 'Derrotar al Guardián del Templo.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
      {
        id: 'obj_camaras',
        text: 'Explorar las 5 cámaras del templo.',
        primary: true,
        rule: { type: 'CLEAR_ENCOUNTERS', count: 5 },
      },
      {
        id: 'obj_vida',
        text: 'Completar la misión sin que la vida del héroe baje del 50 %.',
        primary: false,
        rule: { type: 'MIN_HEALTH_PERCENT', percent: 50 },
      },
      {
        id: 'obj_master',
        text: 'Derrotar al Máster si aparece.',
        primary: false,
        rule: { type: 'DEFEAT_MASTER' },
      },
      {
        // Botin: no evaluable hasta HU-10.
        id: 'obj_fragmentos',
        text: 'Encontrar los 3 fragmentos del Sello Antiguo.',
        primary: false,
        rule: null,
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
    // Reparto ilustrativo del contrato de HU-72: el curso da las cantidades
    // (10, 5 y 3) y «las 5 cámaras», no el orden.
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: null,
        enemies: [{ enemyRef: 'sombra-corrompida', count: 4 }],
      },
      {
        index: 2,
        kind: 'REGULAR',
        powerStep: null,
        enemies: [{ enemyRef: 'sombra-corrompida', count: 6 }],
      },
      {
        index: 3,
        kind: 'REGULAR',
        powerStep: null,
        enemies: [{ enemyRef: 'guardian-de-piedra', count: 5 }],
      },
      {
        index: 4,
        kind: 'REGULAR',
        powerStep: null,
        enemies: [{ enemyRef: 'espectro-ancestral', count: 3 }],
      },
      {
        index: 5,
        kind: 'BOSS',
        powerStep: null,
        enemies: [{ enemyRef: 'guardian-eterno', count: 1 }],
      },
    ],
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
    // Abrir la cámara es vencer a su custodio, el jefe final.
    objectives: [
      {
        id: 'obj_sello',
        text: 'Abrir la cámara sellada.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
    ],
    enemies: [],
    finalBoss: {
      enemyRef: 'custodio-del-sello',
      name: 'Custodio del Sello',
      heroType: null,
      description: null,
      stats: {},
    },
    encounters: [
      {
        index: 1,
        kind: 'BOSS',
        powerStep: null,
        enemies: [{ enemyRef: 'custodio-del-sello', count: 1 }],
      },
    ],
    masterEncounter: null,
    rewards: { guaranteed: [], potential: [], objectiveBonuses: [], firstTime: [] },
    highlightedRewards: [],
    active: true,
  },
]
