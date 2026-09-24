export const ID_GENERATOR = Symbol('IdGeneratorPort')

/**
 * Identificadores nuevos. Aislados para que los casos de uso sean deterministas
 * en las pruebas.
 */
export interface IdGeneratorPort {
  /** `enr_` seguido de un UUID. */
  newEnrollmentId(): string
  /** UUID: es la clave de la reserva en Player/Inventory. */
  newOperationId(): string
}
