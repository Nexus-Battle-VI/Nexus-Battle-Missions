import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Reporte de ejecucion de la cadena HU-09 (Task HU-09.6).
 *
 * La Task pide «reporte de ejecucion con commit, ambiente, suites, casos y
 * cobertura». Se escribe en un JSON que el PR de Infrastructure copia a
 * `docs/evidence/hu-09-ejecucion-e2e.json` y resume en la evidencia; tambien se
 * imprime por `stdout` para que quede en el registro del trabajo de CI.
 */

export interface ReportCase {
  readonly id: string
  readonly name: string
  readonly result: 'PASS' | 'FAIL'
  readonly observed: Readonly<Record<string, unknown>>
}

export interface ReportRepository {
  readonly repository: string
  readonly commit: string
  readonly dirty: boolean
}

export interface RunReport {
  readonly schemaVersion: 1
  readonly kind: 'hu-09-chain-e2e'
  readonly startedAt: string
  readonly finishedAt: string
  readonly repositories: readonly ReportRepository[]
  readonly environment: Readonly<Record<string, unknown>>
  readonly cases: readonly ReportCase[]
  readonly failed: number
  readonly passed: number
  readonly limitations: readonly string[]
}

const CASES: ReportCase[] = []

export const recordCase = (entry: ReportCase): void => {
  CASES.push(entry)
}

export const OUTPUT_FILE = path.resolve(__dirname, '..', 'out', 'hu-09-ejecucion-e2e.json')

/** Las sustituciones y los limites del escenario: van al reporte, no a un pie de pagina. */
export const LIMITATIONS: readonly string[] = [
  'El resultado de la simulacion de Combat se sustituye por el doble de desarrollo: Combat todavia no produce bitacoras de simulacion (su ingreso responde 503).',
  'El perfil y el compromiso del heroe se sustituyen por los dobles de desarrollo: la ruta interna de perfil (HU-71.2) todavia no esta en develop.',
  'El testimonio del jugador se sustituye: no hay Cognito en la cadena.',
  'En el escenario de los ocho valores de 1d8 se sustituye el puerto de tirada por caras 1..8; la acreditacion sigue siendo la real de Player/Inventory.',
  'Combat corre con sus planificadores reales encendidos: no hacen nada porque su base de batallas esta vacia.',
  'La ventana de la matricula se desplaza al pasado para cerrar la mision sin esperar su duracion real: mide UNA HORA EXACTA y termina un segundo antes del cierre, porque la duracion viaja a Combat en minutos enteros y el reloj no se puede mover (los sellos internos caducan a los 30 s).',
  'Las guardas de no-duplicacion se ejecutan en un proceso hijo por repositorio, con `--testPathPatterns`: aqui se comprueba que estan en verde y que su control negativo corre, no se repite su matriz.',
]

export const writeRunReport = (input: {
  readonly startedAt: Date
  readonly repositories: readonly ReportRepository[]
  readonly environment: Readonly<Record<string, unknown>>
  /** Los casos que la suite DEBIA registrar: lo que falte es un fallo, no un olvido. */
  readonly expectedCaseIds: readonly string[]
}): RunReport => {
  const recorded = new Map(CASES.map((entry) => [entry.id, entry]))
  const cases: ReportCase[] = input.expectedCaseIds.map(
    (id) =>
      recorded.get(id) ?? {
        id,
        name: id,
        result: 'FAIL' as const,
        observed: { reason: 'La prueba no llego a registrarlo: fallo antes de terminar.' },
      },
  )
  const failed = cases.filter((entry) => entry.result === 'FAIL').length
  const report: RunReport = {
    schemaVersion: 1,
    kind: 'hu-09-chain-e2e',
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    repositories: input.repositories,
    environment: input.environment,
    cases,
    failed,
    passed: cases.length - failed,
    limitations: LIMITATIONS,
  }

  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true })
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  return report
}
