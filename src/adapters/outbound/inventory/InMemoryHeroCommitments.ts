import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  HeroCommitmentPort,
} from '../../../application/ports/HeroCommitmentPort'

interface Commitment {
  readonly commitmentId: string
  readonly heroId: string
  readonly playerId: string
  readonly request: string
}

/**
 * Doble de DESARROLLO del compromiso `MISSION` (`HERO_COMMITMENTS_DRIVER=memory`,
 * prohibido con NODE_ENV=production). Player/Inventory todavia no expone la ruta
 * propuesta en hu-70-mission-enrollment-v1; este doble reproduce su contrato
 * para poder recorrer la matricula en local:
 *
 * - concede si el heroe no tiene otro compromiso vigente;
 * - repetir el mismo `operationId` con el mismo cuerpo devuelve el mismo
 *   compromiso, y con otro cuerpo es un resultado desconocido (`409`);
 * - liberar es idempotente.
 *
 * No comprueba propiedad, readiness ni mazo completo: eso es de Player/Inventory.
 */
export class InMemoryHeroCommitments implements HeroCommitmentPort {
  private readonly byOperation = new Map<string, Commitment>()

  // eslint-disable-next-line @typescript-eslint/require-await
  async commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    const fingerprint = JSON.stringify([request.playerId, request.heroId, request.reference])
    const existing = this.byOperation.get(request.operationId)

    if (existing !== undefined) {
      return existing.request === fingerprint
        ? { kind: 'GRANTED', commitmentId: existing.commitmentId }
        : { kind: 'UNKNOWN', reason: 'OPERATION_ID_REUSED' }
    }

    for (const commitment of this.byOperation.values()) {
      if (commitment.heroId === request.heroId) {
        return { kind: 'REJECTED', rejection: { code: 'HERO_COMMITTED', busyWith: 'MISSION' } }
      }
    }

    const commitment: Commitment = {
      commitmentId: `cmt_${request.operationId}`,
      heroId: request.heroId,
      playerId: request.playerId,
      request: fingerprint,
    }
    this.byOperation.set(request.operationId, commitment)

    return { kind: 'GRANTED', commitmentId: commitment.commitmentId }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'> {
    this.byOperation.delete(operationId)

    return 'RELEASED'
  }
}
