import type {
  MasterEpic,
  MissionCombatRules,
  MissionDefinition,
} from '../../../domain/entities/MissionDefinition'

/**
 * Contenido jugable de Missions (diseno «misiones jugables», contenido v2). Lo
 * siembran las migraciones 010 y 012 y lo usa `MISSIONS_EXAMPLE_CATALOG=true`.
 * «El Templo Olvidado» es el ejemplo de la seccion 7.8.14 del documento del curso.
 *
 * Los valores de combate que faltaban en el curso son propuestas editables del
 * equipo, medidas con el motor real de Combat (P-J9): en Normal casi todo heroe
 * gana; el riesgo crece con el nivel de dificultad, con la duracion y con heroes
 * fragiles, y una buena estrategia lo reduce. Los productos (`productId`) se enlazan
 * en cada entorno desde la administracion: aqui van en `null`.
 */

/** Reglas comunes; cada mision fija su ritmo, su tope por encuentro y su descanso. */
const rulesOf = (
  turnDurationSeconds: number,
  maxTurnsPerEncounter: number,
  recoveryPercent: number,
): MissionCombatRules => ({
  turnDurationSeconds,
  maxTurnsPerEncounter,
  recoveryPercent,
  criticalChance: 0.1,
  criticalMultiplier: 1.5,
  difficultyMultipliers: { NORMAL: 1, HEROIC: 1.5, LEGENDARY: 2, MYTHIC: 2.5 },
  supportAttack: 10,
  supportDamage: 3,
  supportRegen: 1,
})

/**
 * Las 8 epicas oficiales de la Tabla 20, una por Master (P-J3). Los textos son los
 * de sus productos en Catalog; el `productId` cambia por entorno y se enlaza luego.
 */
const epicOf = (
  epicRef: string,
  name: string,
  generalEffect: string,
  epicEffect: string,
): MasterEpic => ({ epicRef, name, generalEffect, epicEffect, productId: null })

const EPICS = {
  GOLPE_DE_DEFENSA: epicOf(
    'golpe-de-defensa',
    'Golpe de defensa',
    '+1 al ataque para todos los héroes.',
    'Solo Guerrero Tanque: +4 al daño y +2 % de crítico.',
  ),
  SEGUNDO_IMPULSO: epicOf(
    'segundo-impulso',
    'Segundo impulso',
    'Todos los héroes recuperan 1d4 de vida.',
    'Solo Guerrero Armas: +3 a la vida y +5 % de crítico.',
  ),
  LUZ_CEGADORA: epicOf(
    'luz-cegadora',
    'Luz cegadora',
    '+1 a la vida para todos los héroes.',
    'Solo Mago Fuego: +2 al daño y +1 % de crítico.',
  ),
  FRIO_CONCENTRADO: epicOf(
    'frio-concentrado',
    'Frío concentrado',
    '−1 de poder al oponente.',
    'Solo Mago Hielo: no recibe ningún daño en el turno siguiente.',
  ),
  TOMA_Y_LLEVA: epicOf(
    'toma-y-lleva',
    'Toma y lleva',
    '+1 al ataque para todos los héroes.',
    'Solo Pícaro Veneno: disminuye a la mitad el daño causado por el oponente y se lo retorna.',
  ),
  INTIMIDACION_SANGRIENTA: epicOf(
    'intimidacion-sangrienta',
    'Intimidación sangrienta',
    '+2 al ataque para todos los héroes.',
    'Solo Pícaro Machete: +2 a la vida y +2 % de crítico.',
  ),
  TE_CHANGUA: epicOf(
    'te-changua',
    'Té changua',
    'Sana a todos los aliados 4d8 de vida.',
    'Solo Chamán: se asocia con un compañero; si este cae, revive con el 20 % de su salud.',
  ),
  REANIMADOR_3000: epicOf(
    'reanimador-3000',
    'Reanimador 3000',
    'Sin efecto general.',
    'Solo Médico: se asocia con un compañero; si este cae, revive con el 20 % de su salud.',
  ),
}

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
    imageRef: 'mision-templo-olvidado',
    estimatedDurationMinutes: 12 * 60,
    recommendedPower: 15,
    // P-J9: 300 turnos por encuentro, para que la pelea con el jefe se decida por
    // la vida de alguno y no por agotar el tiempo.
    combatRules: rulesOf(60, 300, 35),
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
    // Contrato de HU-73: el curso da 0.15 para la Sombra del Olvido y no fija el
    // punto; se evalua tras el tercer encuentro. P-J3: cada Master entrega la epica
    // oficial de su tipo de heroe, y el Coloso aparece mas para un Guerrero Tanque.
    masterEncounter: {
      evaluationPoints: [{ afterEncounter: 3 }],
      maxAppearances: 1,
      candidates: [
        {
          masterRef: 'sombra-del-olvido',
          name: 'Sombra del Olvido',
          subtype: 'PICARO_VENENO',
          levelOffset: 2,
          profile: {
            maxHealth: 40,
            attack: 8,
            defense: 6,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'AGGRESSIVE',
          },
          probabilityByHeroType: { '*': 0.15 },
          epic: EPICS.TOMA_Y_LLEVA,
        },
        {
          masterRef: 'coloso-de-obsidiana',
          name: 'Coloso de Obsidiana',
          subtype: 'GUERRERO_TANQUE',
          levelOffset: 2,
          profile: {
            maxHealth: 50,
            attack: 6,
            defense: 8,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'GUARDED',
          },
          probabilityByHeroType: { '*': 0.05, GUERRERO_TANQUE: 0.15 },
          epic: EPICS.GOLPE_DE_DEFENSA,
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
    summary: 'Bajo el templo espera una cámara que nadie ha abierto en siglos.',
    narrative:
      'Con el Guardián Eterno derrotado, los fragmentos del Sello Antiguo revelan una escalera ' +
      'oculta. Al fondo, una cámara protegida por centinelas arcanos guarda el Núcleo del Sello. ' +
      'Su custodio no dejará pasar a nadie que no haya demostrado su valor en el templo.',
    imageRef: 'mision-camara-sellada',
    estimatedDurationMinutes: 6 * 60,
    recommendedPower: null,
    combatRules: rulesOf(60, 300, 35),
    prerequisites: ['msn_templo_olvidado'],
    // Abrir la cámara es vencer a su custodio, el jefe final.
    objectives: [
      {
        id: 'obj_sello',
        text: 'Abrir la cámara sellada.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
      {
        id: 'obj_master',
        text: 'Derrotar a la Hechicera del Sello si aparece.',
        primary: false,
        rule: { type: 'DEFEAT_MASTER' },
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
      description: 'Un autómata de piedra atado al sello desde hace siglos.',
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
    masterEncounter: {
      evaluationPoints: [{ afterEncounter: 2 }],
      maxAppearances: 1,
      candidates: [
        {
          masterRef: 'hechicera-del-sello',
          name: 'Hechicera del Sello',
          subtype: 'MAGO_HIELO',
          levelOffset: 2,
          profile: {
            maxHealth: 38,
            attack: 9,
            defense: 5,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'AGGRESSIVE',
          },
          probabilityByHeroType: { '*': 0.1, MAGO_HIELO: 0.2 },
          epic: EPICS.FRIO_CONCENTRADO,
        },
      ],
    },
    rewards: {
      guaranteed: [{ label: '30 créditos' }],
      potential: [{ label: 'Núcleo del Sello', probability: 0.5, rolls: 1 }],
      objectiveBonuses: [],
      firstTime: [{ label: 'Título «Custodio de la Cámara»' }],
    },
    highlightedRewards: [{ label: '30 créditos' }, { label: 'Núcleo del Sello' }],
    active: true,
  },
  {
    missionId: 'msn_camino_templo',
    name: 'Camino al Templo',
    category: 'STORY',
    summary: 'Tu primera misión: diez minutos para despejar el camino al templo.',
    narrative:
      'Un mensajero del templo pide escolta: los bandidos de Garra asaltan a todo el que se ' +
      'acerca al Bosque Sombrío y le han robado un fragmento del Sello Antiguo. Recupéralo y ' +
      'abre el camino. Es una misión corta, pensada para conocer a tu héroe y su estrategia.',
    imageRef: 'mision-camino-templo',
    estimatedDurationMinutes: 10,
    recommendedPower: 5,
    // Turnos de 5 s: 120 turnos en 10 minutos, de sobra para dos encuentros.
    combatRules: rulesOf(5, 80, 50),
    prerequisites: [],
    objectives: [
      {
        id: 'obj_garra',
        text: 'Derrotar a Garra, jefe de los bandidos.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
      {
        id: 'obj_camino',
        text: 'Despejar el camino.',
        primary: true,
        rule: { type: 'CLEAR_ENCOUNTERS', count: 2 },
      },
      {
        id: 'obj_vida',
        text: 'Llegar al final con al menos la mitad de la vida.',
        primary: false,
        rule: { type: 'MIN_HEALTH_PERCENT', percent: 50 },
      },
      {
        id: 'obj_fragmento',
        text: 'Recuperar el fragmento robado.',
        primary: false,
        rule: { type: 'COLLECT_LOOT', label: 'Fragmento del Sello Antiguo', count: 1 },
      },
    ],
    enemies: [
      {
        enemyRef: 'bandido-del-camino',
        name: 'Bandidos del Camino',
        count: 3,
        description: 'Asaltantes con cuchillos y poca paciencia.',
        profile: {
          maxHealth: 6,
          attack: 6,
          defense: 3,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          ai: 'AGGRESSIVE',
        },
      },
    ],
    finalBoss: {
      enemyRef: 'garra-jefe-bandido',
      name: 'Garra, jefe de los bandidos',
      heroType: 'PICARO_MACHETE',
      description: 'Pícaro Machete que se vuelve temerario cuando está herido.',
      stats: { health: 22, attack: 6, defense: 4 },
      profile: {
        maxHealth: 22,
        attack: 6,
        defense: 4,
        damage: { mode: 'DICE', count: 1, sides: 6 },
        ai: 'BOSS',
        enrageBelowPercent: 40,
        enrageAttackBonus: 2,
      },
      // Botin seguro: la primera mision ya entrega algo al inventario.
      drops: [{ label: 'Fragmento del Sello Antiguo', probability: 1, rolls: 1, productId: null }],
    },
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'bandido-del-camino', count: 3 }],
      },
      {
        index: 2,
        kind: 'BOSS',
        powerStep: 0,
        enemies: [{ enemyRef: 'garra-jefe-bandido', count: 1 }],
      },
    ],
    // Sin Master: es la mision de bienvenida.
    masterEncounter: null,
    rewards: {
      guaranteed: [],
      potential: [{ label: 'Fragmento del Sello Antiguo', probability: 1, rolls: 1 }],
      objectiveBonuses: [],
      firstTime: [],
    },
    highlightedRewards: [],
    active: true,
  },
  {
    missionId: 'msn_arena_caidos',
    name: 'La Arena de los Caídos',
    category: 'CHALLENGE',
    summary: 'Una hora de combate sin tregua contra los campeones de la arena.',
    narrative:
      'En las ruinas de un antiguo coliseo, los caídos siguen luchando por la gloria. Tres ' +
      'oleadas de gladiadores y bestias preceden a Varkas, el Invicto. Dicen que a veces baja ' +
      'a la arena un campeón legendario a medir fuerzas con los recién llegados.',
    imageRef: 'mision-arena-caidos',
    estimatedDurationMinutes: 60,
    recommendedPower: 12,
    // Turnos de 10 s: 360 turnos en la hora.
    combatRules: rulesOf(10, 150, 40),
    prerequisites: ['msn_camino_templo'],
    objectives: [
      {
        id: 'obj_varkas',
        text: 'Derrotar a Varkas, el Invicto.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
      {
        id: 'obj_oleadas',
        text: 'Superar las tres oleadas.',
        primary: true,
        rule: { type: 'CLEAR_ENCOUNTERS', count: 3 },
      },
      {
        id: 'obj_master',
        text: 'Vencer al campeón legendario si baja a la arena.',
        primary: false,
        rule: { type: 'DEFEAT_MASTER' },
      },
      {
        id: 'obj_emblema',
        text: 'Ganar un Emblema de la Arena.',
        primary: false,
        rule: { type: 'COLLECT_LOOT', label: 'Emblema de la Arena', count: 1 },
      },
    ],
    enemies: [
      {
        enemyRef: 'gladiador-caido',
        name: 'Gladiadores Caídos',
        count: 5,
        description: 'Luchadores veloces que atacan sin descanso.',
        profile: {
          maxHealth: 6,
          attack: 4,
          defense: 4,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          ai: 'AGGRESSIVE',
        },
      },
      {
        enemyRef: 'bestia-de-la-arena',
        name: 'Bestias de la Arena',
        count: 3,
        description: 'Criaturas resistentes que golpean fuerte.',
        profile: {
          maxHealth: 10,
          attack: 4,
          defense: 3,
          damage: { mode: 'DICE', count: 1, sides: 6 },
          ai: 'AGGRESSIVE',
        },
      },
    ],
    finalBoss: {
      enemyRef: 'varkas-el-invicto',
      name: 'Varkas, el Invicto',
      heroType: 'GUERRERO_ARMAS',
      description: 'Campeón de la arena que se enfurece cuando pierde la mitad de su vida.',
      stats: { health: 40, attack: 4, defense: 5 },
      profile: {
        maxHealth: 40,
        attack: 4,
        defense: 5,
        damage: { mode: 'DICE', count: 1, sides: 6 },
        ai: 'BOSS',
        enrageBelowPercent: 50,
        enrageAttackBonus: 2,
      },
      drops: [
        { label: 'Emblema de la Arena', probability: 0.5, rolls: 1, productId: null },
        { label: 'Guanteletes del Campeón', probability: 0.15, rolls: 1, productId: null },
      ],
    },
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'gladiador-caido', count: 3 }],
      },
      {
        index: 2,
        kind: 'REGULAR',
        powerStep: 0.05,
        enemies: [{ enemyRef: 'bestia-de-la-arena', count: 2 }],
      },
      {
        index: 3,
        kind: 'REGULAR',
        powerStep: 0.1,
        enemies: [
          { enemyRef: 'gladiador-caido', count: 2 },
          { enemyRef: 'bestia-de-la-arena', count: 1 },
        ],
      },
      {
        index: 4,
        kind: 'BOSS',
        powerStep: 0.15,
        enemies: [{ enemyRef: 'varkas-el-invicto', count: 1 }],
      },
    ],
    masterEncounter: {
      evaluationPoints: [{ afterEncounter: 2 }, { afterEncounter: 3 }],
      maxAppearances: 1,
      candidates: [
        {
          masterRef: 'campeon-carmesi',
          name: 'Campeón Carmesí',
          subtype: 'GUERRERO_ARMAS',
          levelOffset: 2,
          profile: {
            maxHealth: 40,
            attack: 8,
            defense: 6,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'AGGRESSIVE',
          },
          probabilityByHeroType: { '*': 0.05, GUERRERO_ARMAS: 0.12 },
          epic: EPICS.SEGUNDO_IMPULSO,
        },
        {
          masterRef: 'filo-errante',
          name: 'Filo Errante',
          subtype: 'PICARO_MACHETE',
          levelOffset: 2,
          profile: {
            maxHealth: 32,
            attack: 10,
            defense: 5,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'AGGRESSIVE',
          },
          probabilityByHeroType: { '*': 0.05, PICARO_MACHETE: 0.12 },
          epic: EPICS.INTIMIDACION_SANGRIENTA,
        },
      ],
    },
    rewards: {
      guaranteed: [],
      potential: [
        { label: 'Emblema de la Arena', probability: 0.5, rolls: 1 },
        { label: 'Guanteletes del Campeón', probability: 0.15, rolls: 1 },
      ],
      objectiveBonuses: [],
      firstTime: [],
    },
    highlightedRewards: [],
    active: true,
  },
  {
    missionId: 'msn_travesia_bosque',
    name: 'Travesía por el Bosque Sombrío',
    category: 'EXPLORATION',
    summary: 'Un día entero cruzando el bosque, con encuentros inesperados en cada claro.',
    narrative:
      'El Bosque Sombrío es más grande de lo que cuentan los mapas. Lobos, arañas y espíritus ' +
      'acechan entre la niebla, y en su corazón vive la Bruja del Pantano. Los viajeros hablan ' +
      'de maestros solitarios que ponen a prueba a quien se adentra lo suficiente.',
    imageRef: 'mision-travesia-bosque',
    estimatedDurationMinutes: 24 * 60,
    recommendedPower: 12,
    // Exploracion: mas descanso entre claros (50 %) para aguantar siete encuentros.
    combatRules: rulesOf(60, 200, 50),
    prerequisites: ['msn_camino_templo'],
    objectives: [
      {
        id: 'obj_bruja',
        text: 'Derrotar a la Bruja del Pantano.',
        primary: true,
        rule: { type: 'DEFEAT_BOSS' },
      },
      {
        id: 'obj_claros',
        text: 'Atravesar los siete claros del bosque.',
        primary: true,
        rule: { type: 'CLEAR_ENCOUNTERS', count: 7 },
      },
      {
        id: 'obj_master',
        text: 'Derrotar a un maestro del bosque si aparece.',
        primary: false,
        rule: { type: 'DEFEAT_MASTER' },
      },
      {
        id: 'obj_esencias',
        text: 'Reunir 2 Esencias del Bosque.',
        primary: false,
        rule: { type: 'COLLECT_LOOT', label: 'Esencia del Bosque', count: 2 },
      },
    ],
    enemies: [
      {
        enemyRef: 'lobo-sombrio',
        name: 'Lobos Sombríos',
        count: 8,
        description: 'Cazan en manada y atacan sin avisar.',
        profile: {
          maxHealth: 6,
          attack: 3,
          defense: 3,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          ai: 'AGGRESSIVE',
        },
      },
      {
        enemyRef: 'arana-de-niebla',
        name: 'Arañas de Niebla',
        count: 6,
        description: 'Se esconden tras su tela y esperan el momento justo.',
        profile: {
          maxHealth: 7,
          attack: 3,
          defense: 4,
          damage: { mode: 'DICE', count: 1, sides: 4 },
          ai: 'GUARDED',
        },
      },
      {
        enemyRef: 'espiritu-del-pantano',
        name: 'Espíritus del Pantano',
        count: 4,
        description: 'Ecos de viajeros perdidos, con ataques mágicos.',
        profile: {
          maxHealth: 9,
          attack: 4,
          defense: 4,
          damage: { mode: 'DICE', count: 1, sides: 6 },
          ai: 'AGGRESSIVE',
        },
      },
    ],
    finalBoss: {
      enemyRef: 'bruja-del-pantano',
      name: 'La Bruja del Pantano',
      heroType: 'MAGO_HIELO',
      description: 'Maga Hielo que domina la niebla y se enfurece al verse acorralada.',
      stats: { health: 50, attack: 3, defense: 5 },
      profile: {
        maxHealth: 50,
        attack: 3,
        defense: 5,
        damage: { mode: 'DICE', count: 1, sides: 6 },
        ai: 'BOSS',
        enrageBelowPercent: 50,
        enrageAttackBonus: 3,
      },
      drops: [
        { label: 'Esencia del Bosque', probability: 0.6, rolls: 2, productId: null },
        { label: 'Amuleto de Raíz', probability: 0.2, rolls: 1, productId: null },
      ],
    },
    encounters: [
      {
        index: 1,
        kind: 'REGULAR',
        powerStep: 0,
        enemies: [{ enemyRef: 'lobo-sombrio', count: 4 }],
      },
      {
        index: 2,
        kind: 'REGULAR',
        powerStep: 0.03,
        enemies: [{ enemyRef: 'arana-de-niebla', count: 3 }],
      },
      {
        index: 3,
        kind: 'REGULAR',
        powerStep: 0.06,
        enemies: [{ enemyRef: 'lobo-sombrio', count: 4 }],
      },
      {
        index: 4,
        kind: 'REGULAR',
        powerStep: 0.09,
        enemies: [{ enemyRef: 'arana-de-niebla', count: 3 }],
      },
      {
        index: 5,
        kind: 'REGULAR',
        powerStep: 0.12,
        enemies: [{ enemyRef: 'espiritu-del-pantano', count: 2 }],
      },
      {
        index: 6,
        kind: 'REGULAR',
        powerStep: 0.15,
        enemies: [{ enemyRef: 'espiritu-del-pantano', count: 2 }],
      },
      {
        index: 7,
        kind: 'BOSS',
        powerStep: 0.2,
        enemies: [{ enemyRef: 'bruja-del-pantano', count: 1 }],
      },
    ],
    // 7.8.4: en misiones largas pueden aparecer varios Master.
    masterEncounter: {
      evaluationPoints: [{ afterEncounter: 2 }, { afterEncounter: 4 }, { afterEncounter: 6 }],
      maxAppearances: 2,
      candidates: [
        {
          masterRef: 'llama-salvaje',
          name: 'Llama Salvaje',
          subtype: 'MAGO_FUEGO',
          levelOffset: 2,
          profile: {
            maxHealth: 36,
            attack: 9,
            defense: 5,
            damage: { mode: 'DICE', count: 1, sides: 8 },
            ai: 'AGGRESSIVE',
          },
          probabilityByHeroType: { '*': 0.03, MAGO_FUEGO: 0.12 },
          epic: EPICS.LUZ_CEGADORA,
        },
        {
          masterRef: 'chaman-de-la-niebla',
          name: 'Chamán de la Niebla',
          subtype: 'CHAMAN',
          levelOffset: 2,
          profile: {
            maxHealth: 44,
            attack: 6,
            defense: 6,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'GUARDED',
          },
          probabilityByHeroType: { '*': 0.03, CHAMAN: 0.12 },
          epic: EPICS.TE_CHANGUA,
        },
        {
          masterRef: 'cirujano-silente',
          name: 'Cirujano Silente',
          subtype: 'MEDICO',
          levelOffset: 2,
          profile: {
            maxHealth: 40,
            attack: 7,
            defense: 5,
            damage: { mode: 'DICE', count: 1, sides: 6 },
            ai: 'GUARDED',
          },
          probabilityByHeroType: { '*': 0.03, MEDICO: 0.12 },
          epic: EPICS.REANIMADOR_3000,
        },
      ],
    },
    rewards: {
      guaranteed: [],
      potential: [
        { label: 'Esencia del Bosque', probability: 0.6, rolls: 2 },
        { label: 'Amuleto de Raíz', probability: 0.2, rolls: 1 },
      ],
      objectiveBonuses: [],
      firstTime: [],
    },
    highlightedRewards: [],
    active: true,
  },
]
