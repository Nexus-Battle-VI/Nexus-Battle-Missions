import type { AchievementDefinition } from '../../../domain/entities/Achievement'

/**
 * Logros DE EJEMPLO para desarrollo (`MISSIONS_EXAMPLE_CATALOG=true`, solo con
 * persistencia en memoria). Son los siete del contrato
 * hu-76-mission-achievements-v1, en su orden: NO son contenido aprobado. El
 * catalogo definitivo, sus nombres y sus reconocimientos los decide el PO
 * (decision 1 del diseno).
 *
 * Con las misiones de ejemplo y el doble de Combat, «Sin un rasguño» se
 * desbloquea en la primera mision porque el doble nunca recibe dano: esa
 * evidencia no acredita CA-02 ni CA-03.
 */
export const EXAMPLE_ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    achievementId: 'ach_historia_completa',
    version: 1,
    name: 'Cronista del Nexus',
    rule: { criterion: 'ALL_CATEGORY_MISSIONS', category: 'STORY' },
    recognition: { kind: 'TITLE', name: 'Cronista del Nexus' },
  },
  {
    achievementId: 'ach_desafio_completo',
    version: 1,
    name: 'Insignia del Desafío',
    rule: { criterion: 'ALL_CATEGORY_MISSIONS', category: 'CHALLENGE' },
    recognition: { kind: 'BADGE', name: 'Insignia del Desafío' },
  },
  {
    achievementId: 'ach_exploracion_completa',
    version: 1,
    name: 'Insignia del Explorador',
    rule: { criterion: 'ALL_CATEGORY_MISSIONS', category: 'EXPLORATION' },
    recognition: { kind: 'BADGE', name: 'Insignia del Explorador' },
  },
  {
    achievementId: 'ach_cazador_de_master',
    version: 1,
    name: 'Cazador de Máster',
    rule: { criterion: 'ALL_MASTERS_DEFEATED' },
    recognition: { kind: 'TITLE', name: 'Cazador de Máster' },
  },
  {
    achievementId: 'ach_sin_rasgunos',
    version: 1,
    name: 'Sin un rasguño',
    rule: { criterion: 'FLAWLESS_MISSION', count: 1 },
    recognition: { kind: 'BADGE', name: 'Sin un rasguño' },
  },
  {
    achievementId: 'ach_templo_veloz',
    version: 1,
    name: 'Paso veloz',
    // Sin umbral hasta la decision 3: este logro no se evalua.
    rule: {
      criterion: 'RECORD_TIME',
      missionId: 'msn_templo_olvidado',
      maxSimulatedDuration: null,
      difficulty: null,
    },
    recognition: { kind: 'BADGE', name: 'Paso veloz' },
  },
  {
    achievementId: 'ach_coleccionista',
    version: 1,
    name: 'Estandarte del Coleccionista',
    rule: { criterion: 'ALL_MASTER_EPICS', epicState: 'CREDITED' },
    // El cosmetico todavia no existe en Catalog: la entrega esperara sin llamar.
    recognition: {
      kind: 'COSMETIC_PRODUCT',
      name: 'Estandarte del Coleccionista',
      productId: null,
    },
  },
]
