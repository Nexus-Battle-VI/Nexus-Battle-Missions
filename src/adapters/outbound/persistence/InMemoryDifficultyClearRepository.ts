import type { DifficultyClearRepositoryPort } from '../../../application/ports/DifficultyClearRepositoryPort'
import type { MissionDifficultyClear } from '../../../domain/entities/MissionDifficultyClear'
import type { DifficultyLevel } from '../../../domain/value-objects/difficulty-level'

/**
 * Doble de desarrollo y pruebas (`PERSISTENCE_DRIVER=memory`). Reproduce la
 * semantica de `PostgresDifficultyClearRepository`: un hecho por jugador, mision
 * y nivel, y el primero se conserva. No se usa en produccion: el servicio no
 * arranca con persistencia en memoria (ADR-019).
 */
export class InMemoryDifficultyClearRepository implements DifficultyClearRepositoryPort {
  private readonly clears = new Map<string, MissionDifficultyClear>()

  // `async` a proposito, como en los demas dobles: un fallo debe llegar como
  // promesa rechazada y no como excepcion sincrona.
  // eslint-disable-next-line @typescript-eslint/require-await
  async clearedLevels(playerId: string, missionId: string): Promise<ReadonlySet<DifficultyLevel>> {
    const levels = new Set<DifficultyLevel>()

    for (const clear of this.clears.values()) {
      if (clear.playerId === playerId && clear.missionId === missionId) {
        levels.add(clear.difficulty)
      }
    }

    return levels
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async completedMissions(playerId: string): Promise<ReadonlySet<string>> {
    const missions = new Set<string>()

    for (const clear of this.clears.values()) {
      if (clear.playerId === playerId) {
        missions.add(clear.missionId)
      }
    }

    return missions
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async record(clear: MissionDifficultyClear): Promise<boolean> {
    return this.recordNow(clear)
  }

  /** Como `record`, sincrona: la usa el cierre del doble de ejecuciones de HU-72. */
  recordNow(clear: MissionDifficultyClear): boolean {
    // Clave compuesta serializada como lista: unir con un separador fijo haria
    // colisionar al jugador `a:b` en la mision `c` con el jugador `a` en `b:c`.
    const key = JSON.stringify([clear.playerId, clear.missionId, clear.difficulty])

    if (this.clears.has(key)) {
      return false
    }

    this.clears.set(key, { ...clear })

    return true
  }
}
