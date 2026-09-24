import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common'

export interface ValidationViolation {
  readonly field: string
  readonly reasons: readonly string[]
}

const violationsOf = (errors: readonly ValidationError[], parent = ''): ValidationViolation[] =>
  errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`
    const own =
      error.constraints === undefined ? [] : [{ field, reasons: Object.values(error.constraints) }]

    return [...own, ...violationsOf(error.children ?? [], field)]
  })

/**
 * Pipe de validacion de todas las rutas. Lo usan `main.ts` y las pruebas, para
 * que estas ejerciten exactamente lo mismo que produccion.
 *
 * Se descartan las propiedades no declaradas y se rechaza la peticion si llegan
 * campos desconocidos: evita que un cliente fije datos que el contrato no
 * contempla, como un importe o un propietario.
 *
 * El error sigue la forma comun de los contratos, `{ code, message }`, con
 * `code: VALIDATION_ERROR`. `violations` es detalle tecnico para quien integra;
 * Web muestra `message`.
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'La solicitud tiene datos que faltan o no son válidos.',
        violations: violationsOf(errors),
      }),
  })
