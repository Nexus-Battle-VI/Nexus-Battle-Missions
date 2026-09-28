import type { Config } from 'jest'

/**
 * Cadena de extremo a extremo de HU-09 (Task HU-09.6).
 *
 * ESTA CONFIGURACION NO ES LA DE CI POR DEFECTO, A PROPOSITO. El escenario
 * levanta las TRES piezas reales: la app de Missions en este proceso (con
 * PostgreSQL en contenedor) y Combat y Player/Inventory como PROCESOS HIJOS
 * (`node dist/main.js`) con su propio MongoDB. Eso exige los tres repos clonados
 * en la misma maquina, cosa que la puerta de calidad de este repositorio no
 * puede suponer: el workflow `cadena-hu-09.yml` los clona a proposito y este es
 * el unico sitio donde se ejecuta.
 *
 * Se separa de `jest.db.config.ts` por lo mismo que aquella se separo de
 * `jest.config.ts`: quien trabaja en el dominio no deberia necesitar ni Docker,
 * ni dos repos hermanos compilados para correr `npm test`.
 *
 * `maxWorkers: 1` porque la suite se apropia de puertos, contenedores y procesos
 * hijos: dos workers se pisarian.
 */
const config: Config = {
  rootDir: '.',
  displayName: 'e2e',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
  maxWorkers: 1,
  // Compilar y arrancar los dos servicios hermanos, migrar tres motores y
  // recorrer la matriz completa no cabe en el limite por defecto.
  testTimeout: 300_000,

  // La cadena mide lo mismo que las otras dos suites juntas, pero su cobertura
  // es INFORMATIVA: los umbrales siguen donde se pueden exigir sin contenedores
  // (`jest.config.ts` y `jest.db.config.ts`). Aqui se publica en el reporte de
  // ejecucion, que es lo que la Task pide.
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageDirectory: 'coverage-e2e',
  coverageReporters: ['text-summary', 'json-summary'],
}

export default config
