import type { LootGrantRepositoryPort } from '../../../application/ports/LootGrantRepositoryPort'
import type { LootGrantRecord } from '../../../domain/entities/LootGrantRecord'
import { InMemoryReportRepository } from './InMemoryReportRepository'

const keyOf = (enrollmentId: string, lineNo: number): string => `${enrollmentId}#${String(lineNo)}`

const byTime = (date: Date | null): number => date?.getTime() ?? Number.MAX_SAFE_INTEGER

/**
 * Doble de desarrollo y pruebas de `mission_loot_grants` (P-J1). El cierre del
 * doble de ejecuciones escribe aqui con `recordNow`; la entrega cambia a la vez la
 * linea del doble de reportes, que es el equivalente en memoria de la transaccion.
 */
export class InMemoryLootGrantRepository implements LootGrantRepositoryPort {
  private readonly grants = new Map<string, LootGrantRecord>()

  constructor(
    private readonly reports: InMemoryReportRepository = new InMemoryReportRepository(),
  ) {}

  /** Sincrona, para el cierre de HU-72. Repetirla no cambia lo guardado. */
  recordNow(records: readonly LootGrantRecord[]): void {
    for (const grant of records) {
      const key = keyOf(grant.enrollmentId, grant.lineNo)

      if (!this.grants.has(key)) {
        this.grants.set(key, grant)
      }
    }
  }

  pendingGrants(now: Date, limit: number): Promise<readonly LootGrantRecord[]> {
    return Promise.resolve(
      [...this.grants.values()]
        .filter(
          (grant) => grant.status === 'PENDING' && byTime(grant.nextAttemptAt) <= now.getTime(),
        )
        .sort((a, b) => byTime(a.nextAttemptAt) - byTime(b.nextAttemptAt))
        .slice(0, limit),
    )
  }

  listByEnrollment(enrollmentId: string): Promise<readonly LootGrantRecord[]> {
    return Promise.resolve(
      [...this.grants.values()]
        .filter((grant) => grant.enrollmentId === enrollmentId)
        .sort((a, b) => a.lineNo - b.lineNo),
    )
  }

  saveGrant(next: LootGrantRecord, expectedAttempts: number, at: Date): Promise<boolean> {
    const key = keyOf(next.enrollmentId, next.lineNo)
    const current = this.grants.get(key)

    if (current?.status !== 'PENDING' || current.attempts !== expectedAttempts) {
      return Promise.resolve(false)
    }

    // Un producto congelado no se borra ni se cambia, como en PostgreSQL.
    this.grants.set(key, { ...next, productId: current.productId ?? next.productId })

    if (next.status !== 'PENDING') {
      this.reports.updateRewardStatusNow(
        next.enrollmentId,
        next.lineNo,
        next.status === 'GRANTED' ? 'CREDITED' : 'FAILED',
        at,
      )
    }

    return Promise.resolve(true)
  }

  freezeProduct(next: LootGrantRecord, expectedAttempts: number): Promise<boolean> {
    const key = keyOf(next.enrollmentId, next.lineNo)
    const current = this.grants.get(key)

    if (
      current?.status !== 'PENDING' ||
      current.attempts !== expectedAttempts ||
      current.productId !== null ||
      next.productId === null
    ) {
      return Promise.resolve(false)
    }

    this.grants.set(key, { ...current, productId: next.productId })

    return Promise.resolve(true)
  }
}
