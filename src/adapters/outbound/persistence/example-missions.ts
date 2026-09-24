import type { MissionDefinition } from '../../../domain/entities/MissionDefinition'

/**
 * Misiones DE EJEMPLO para desarrollo (`MISSIONS_EXAMPLE_CATALOG=true`, solo con
 * persistencia en memoria). No son contenido aprobado: «El Templo Olvidado» es
 * el ejemplo de la seccion 7.8.14 del documento del curso, y «La Camara Sellada»
 * existe solo para ver un requisito previo en el tablon.
 *
 * Los valores de combate que faltaban en el curso son decisiones editables del
 * equipo. Este catalogo sigue siendo solo para desarrollo; produccion usa jsonb.
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
    combatRules: {
      turnDurationSeconds: 60,
      maxTurnsPerEncounter: 90,
      recoveryPercent: 35,
      criticalChance: 0.1,
      criticalMultiplier: 1.5,
      difficultyMultipliers: { NORMAL: 1, HEROIC: 1.5, LEGENDARY: 2, MYTHIC: 2.5 },
      supportAttack: 10,
      supportDamage: 3,
      supportRegen: 1,
    },
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
        id: 'obj_fragmentos',
        text: 'Encontrar los 3 fragmentos del Sello Antiguo.',
        primary: false,
        rule: { type: 'COLLECT_LOOT', label: 'Fragmento del Sello Antiguo', count: 3 },
      },
    ],
    enemies: [
      {
        enemyRef: 'sombra-corrompida',
        name: 'Sombras Corrompidas',
        count: 10,
        description: 'Enemigos básicos con ataque moderado.',
        profile: { maxHealth: 5, attack: 2, defense: 3, damage: 1, ai: 'AGGRESSIVE' },
      },
      {
        enemyRef: 'guardian-de-piedra',
        name: 'Guardianes de Piedra',
        count: 5,
        description: 'Enemigos con alta defensa.',
        profile: { maxHealth: 8, attack: 3, defense: 6, damage: 1, ai: 'GUARDED' },
      },
      {
        enemyRef: 'espectro-ancestral',
        name: 'Espectros Ancestrales',
        count: 3,
        description: 'Enemigos con ataques mágicos.',
        profile: { maxHealth: 7, attack: 4, defense: 4, damage: 2, ai: 'AGGRESSIVE' },
      },
    ],
    finalBoss: {
      enemyRef: 'guardian-eterno',
      name: 'El Guardián Eterno',
      heroType: 'GUERRERO_TANQUE',
      description: 'Guerrero Tanque con habilidades potenciadas.',
      stats: { health: 100, attack: 2, defense: 5, damage: 1 },
      profile: {
        maxHealth: 100,
        attack: 2,
        defense: 5,
        damage: 1,
        ai: 'BOSS',
        enrageBelowPercent: 50,
        enrageAttackBonus: 3,
      },
      drops: [
        { label: 'Fragmento del Sello Antiguo', probability: 0.6, rolls: 3, productId: null },
        { label: 'Armadura «Piel del Guardián»', probability: 0.2, rolls: 1, productId: null },
        { label: 'Arma «Espada del Templo»', probability: 0.15, rolls: 1, productId: null },
      ],
    },
    // Reparto ilustrativo del contrato de HU-72: el curso da las cantidades
    // (10, 5 y 3) y «las 5 cámaras», no el orden.
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'sombra-corrompida', count: 4 }],
      },
      {
        index: 2,
        kind: 'REGULAR',
        powerStep: 0.05,
        enemies: [{ enemyRef: 'sombra-corrompida', count: 6 }],
      },
      {
        index: 3,
        kind: 'REGULAR',
        powerStep: 0.1,
        enemies: [{ enemyRef: 'guardian-de-piedra', count: 5 }],
      },
      {
        index: 4,
        kind: 'REGULAR',
        powerStep: 0.15,
        enemies: [{ enemyRef: 'espectro-ancestral', count: 3 }],
      },
      {
        index: 5,
        kind: 'BOSS',
        powerStep: 0.2,
        enemies: [{ enemyRef: 'guardian-eterno', count: 1 }],
      },
    ],
    // Contrato de HU-73: el curso da una sola probabilidad (0.15) y no fija el
    // punto; se evalua tras el tercer encuentro, como en el ejemplo del contrato.
    masterEncounter: {
      evaluationPoints: [{ afterEncounter: 3 }],
      maxAppearances: 1,
      candidates: [
        {
          masterRef: 'sombra-del-olvido',
          name: 'Sombra del Olvido',
          subtype: 'PICARO_VENENO',
          levelOffset: 2,
          profile: { maxHealth: 55, attack: 3, defense: 6, damage: 1, ai: 'AGGRESSIVE' },
          probabilityByHeroType: { '*': 0.15 },
          epic: {
            epicRef: 'velo-de-sombras',
            name: 'Velo de Sombras',
            generalEffect: '+2 a la defensa para todos los héroes.',
            epicEffect:
              'Solo Pícaro Veneno: intangible durante 1 turno y envenena al atacante ' +
              '(+3 de daño durante 2 turnos).',
            // La epica todavia no existe como producto de Catalog (decision 7).
            productId: null,
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
    combatRules: {
      turnDurationSeconds: 60,
      maxTurnsPerEncounter: 90,
      recoveryPercent: 35,
      criticalChance: 0.1,
      criticalMultiplier: 1.5,
      difficultyMultipliers: { NORMAL: 1, HEROIC: 1.5, LEGENDARY: 2, MYTHIC: 2.5 },
      supportAttack: 10,
      supportDamage: 3,
      supportRegen: 1,
    },
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
    enemies: [
      {
        enemyRef: 'centinela-arcano',
        name: 'Centinela Arcano',
        count: 4,
        description: 'Defiende el acceso a la cámara.',
        profile: { maxHealth: 8, attack: 3, defense: 5, damage: 1, ai: 'GUARDED' },
      },
      {
        enemyRef: 'eco-del-sello',
        name: 'Eco del Sello',
        count: 2,
        description: 'Proyección mágica de la cámara.',
        profile: { maxHealth: 10, attack: 4, defense: 5, damage: 1, ai: 'AGGRESSIVE' },
      },
    ],
    finalBoss: {
      enemyRef: 'custodio-del-sello',
      name: 'Custodio del Sello',
      heroType: null,
      description: null,
      stats: { health: 75, attack: 3, defense: 5, damage: 1 },
      profile: {
        maxHealth: 75,
        attack: 3,
        defense: 5,
        damage: 1,
        ai: 'BOSS',
        enrageBelowPercent: 50,
        enrageAttackBonus: 2,
      },
      drops: [{ label: 'Núcleo del Sello', probability: 0.5, rolls: 1, productId: null }],
    },
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'centinela-arcano', count: 4 }],
      },
      {
        index: 2,
        kind: 'REGULAR',
        powerStep: 0.1,
        enemies: [{ enemyRef: 'eco-del-sello', count: 2 }],
      },
      {
        index: 3,
        kind: 'BOSS',
        powerStep: 0.2,
        enemies: [{ enemyRef: 'custodio-del-sello', count: 1 }],
      },
    ],
    masterEncounter: null,
    rewards: {
      guaranteed: [{ label: '30 créditos' }],
      potential: [{ label: 'Núcleo del Sello', probability: 0.5, rolls: 1 }],
      objectiveBonuses: [],
      firstTime: [{ label: 'Título «Custodio de la Cámara»' }],
    },
    highlightedRewards: [{ label: '30 créditos' }, { label: 'Núcleo del Sello' }],
    active: true,
  },
]
