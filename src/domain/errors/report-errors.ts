import { DomainError } from './DomainError'

/**
 * Errores del reporte y del historial (HU-74, contrato hu-74-mission-report-v1).
 * Cada uno corresponde a un `code` estable del contrato; la traduccion a HTTP
 * vive en `missions-error.mapper.ts`. Los mensajes son los que ve el jugador.
 */

/** `404 REPORT_NOT_AVAILABLE` (CA-04): la mision del jugador sigue en curso. */
export class ReportNotAvailableError extends DomainError {
  constructor(
    readonly enrollmentId: string,
    readonly endsAt: Date | null,
  ) {
    super('La misión sigue en curso. El reporte estará listo cuando termine.')
    this.name = 'ReportNotAvailableError'
  }
}

/**
 * `404 REPORT_NOT_FOUND`: no existe, es de otro jugador o la mision se anulo. Un
 * reporte ajeno responde igual que uno inexistente (propuesta P-T8).
 */
export class ReportNotFoundError extends DomainError {
  constructor(readonly enrollmentId: string) {
    super('No encontramos ese reporte.')
    this.name = 'ReportNotFoundError'
  }
}

/** `400 VALIDATION_ERROR`: el cursor del historial no es uno que haya dado el servicio. */
export class InvalidHistoryCursorError extends DomainError {
  constructor() {
    super('El cursor del historial no es válido. Vuelve a pedir la primera página.')
    this.name = 'InvalidHistoryCursorError'
  }
}
