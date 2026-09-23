import { createHash } from 'node:crypto'

/**
 * UUID version 5 (RFC 9562, seccion 5.5): el mismo espacio y el mismo nombre
 * dan siempre el mismo identificador. Lo usa la entrega de la epica de HU-73
 * (P-X6), que necesita un `operationId` que no cambie al repetir el cierre.
 */
export const uuidV5 = (namespace: string, name: string): string => {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)

  // Version 5 en el nibble alto del byte 6 y variante RFC en el byte 8.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)

  const hex = bytes.toString('hex')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
