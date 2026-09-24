import { randomUUID } from 'node:crypto'

import type { IdGeneratorPort } from '../../../application/ports/IdGeneratorPort'

/** Identificadores aleatorios (UUID v4). El prefijo `enr_` hace legible la matricula. */
export class RandomIdGenerator implements IdGeneratorPort {
  newEnrollmentId(): string {
    return `enr_${randomUUID()}`
  }

  newOperationId(): string {
    return randomUUID()
  }
}
