import type { MasterEncounterRepositoryPort } from '../../../application/ports/MasterEncounterRepositoryPort'
import type { MasterEncounterRecord } from '../../../domain/entities/MasterEncounterRecord'
import { InMemoryReportRepository } from './InMemoryReportRepository'

const keyOf = (enrollmentId: string, sequence: number): string =>
  `${enrollmentId}#${String(sequence)}`

const byTime = (date: Date | null | undefined): number => date?.getTime() ?? Number.MAX_SAFE_INTEGER

/**
 * Doble de desarrollo y pruebas de `mission_master_encounters` (HU-73). El
 * cierre del doble de ejecuciones escribe aqui con `recordNow`; la entrega de
 * la epica cambia a la vez la linea del doble de reportes, que es el
 * equivalente en memoria de hacerlo en una transaccion.
 */
export class InMemoryMasterEncounterRepository implements MasterEncounterRepositoryPort {
  private readonly encounters = new Map<string, MasterEncounterRecord>()

  constructor(
    private readonly reports: InMemoryReportRepository = new InMemoryReportRepository(),
  ) {}

  /** Sincrona, para el cierre de HU-72. Repetirla no cambia lo guardado. */
  recordNow(records: readonly MasterEncounterRecord[]): void {
    for (const encounter of records) {
      const key = keyOf(encounter.enrollmentId, encounter.sequence)

      if (!this.encounters.has(key)) {
        this.encounters.set(key, encounter)
      }
    }
  }

  pendingGrants(now: Date, limit: number): Promise<readonly MasterEncounterRecord[]> {
    return Promise.resolve(
      [...this.encounters.values()]
        .filter(
          (encounter) =>
            encounter.grant?.status === 'PENDING' &&
            byTime(encounter.grant.nextAttemptAt) <= now.getTime(),
        )
        .sort((a, b) => byTime(a.grant?.nextAttemptAt) - byTime(b.grant?.nextAttemptAt))
        .slice(0, limit),
    )
  }

  listByEnrollment(enrollmentId: string): Promise<readonly MasterEncounterRecord[]> {
    return Promise.resolve(
      [...this.encounters.values()]
        .filter((encounter) => encounter.enrollmentId === enrollmentId)
        .sort((a, b) => a.sequence - b.sequence),
    )
  }

  saveGrant(next: MasterEncounterRecord, expectedAttempts: number, at: Date): Promise<boolean> {
    const key = keyOf(next.enrollmentId, next.sequence)
    const current = this.encounters.get(key)?.grant

    if (current?.status !== 'PENDING' || current.attempts !== expectedAttempts) {
      return Promise.resolve(false)
    }

    const grant =
      next.grant === null
        ? null
        : { ...next.grant, productId: current.productId ?? next.grant.productId }

    // Un producto congelado no se borra ni se cambia, como en PostgreSQL.
    this.encounters.set(key, { ...next, grant })

    if (grant !== null && grant.status !== 'PENDING' && grant.rewardLineNo !== null) {
      this.reports.updateRewardStatusNow(
        next.enrollmentId,
        grant.rewardLineNo,
        grant.status === 'GRANTED' ? 'CREDITED' : 'FAILED',
        at,
      )
    }

    return Promise.resolve(true)
  }

  freezeProduct(next: MasterEncounterRecord, expectedAttempts: number): Promise<boolean> {
    const key = keyOf(next.enrollmentId, next.sequence)
    const stored = this.encounters.get(key)
    const current = stored?.grant
    const productId = next.grant?.productId ?? null

    if (
      stored === undefined ||
      current?.status !== 'PENDING' ||
      current.attempts !== expectedAttempts ||
      current.productId !== null ||
      productId === null
    ) {
      return Promise.resolve(false)
    }

    this.encounters.set(key, { ...stored, grant: { ...current, productId } })

    return Promise.resolve(true)
  }
}
