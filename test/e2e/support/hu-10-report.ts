import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Evidencia mecanica de HU-10.7; se escribe exclusivamente desde la ejecucion E2E. */
export interface Hu10Repository {
  readonly repo: string
  readonly sha: string
  readonly dirty: boolean
}

export interface Hu10Service {
  readonly name: string
  readonly mode: 'REAL' | 'SUBSTITUTED'
  readonly persistence: string
}

export interface Hu10Scenario {
  readonly id: string
  readonly title: string
  readonly status: 'PASS' | 'FAIL' | 'SKIPPED'
  readonly assertions: readonly string[]
  readonly notes: readonly string[]
}

export interface Hu10RunReport {
  readonly schemaVersion: 1
  readonly kind: 'hu-10-settlement-e2e'
  readonly startedAt: string
  readonly finishedAt: string
  readonly repositories: readonly Hu10Repository[]
  readonly services: readonly Hu10Service[]
  readonly scenarios: readonly Hu10Scenario[]
  readonly summary: { readonly passed: number; readonly failed: number; readonly skipped: number }
  readonly limitations: readonly string[]
}

const scenarios: Hu10Scenario[] = []

export const recordHu10Scenario = (scenario: Hu10Scenario): void => {
  scenarios.push(scenario)
}

/** Esta ruta es un producto de la corrida, nunca un fixture versionado a mano. */
export const HU10_OUTPUT_FILE = path.resolve(process.cwd(), 'artifacts', 'hu-10-ejecucion-e2e.json')

export const writeHu10RunReport = (input: {
  readonly startedAt: Date
  readonly expectedScenarioIds: readonly string[]
  readonly repositories: readonly Hu10Repository[]
  readonly services: readonly Hu10Service[]
  readonly limitations: readonly string[]
}): Hu10RunReport => {
  const recorded = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const completed = input.expectedScenarioIds.map(
    (id): Hu10Scenario =>
      recorded.get(id) ?? {
        id,
        title: id,
        status: 'FAIL',
        assertions: [],
        notes: ['La prueba no alcanzó a registrar el escenario.'],
      },
  )
  const summary = {
    passed: completed.filter((scenario) => scenario.status === 'PASS').length,
    failed: completed.filter((scenario) => scenario.status === 'FAIL').length,
    skipped: completed.filter((scenario) => scenario.status === 'SKIPPED').length,
  }
  const report: Hu10RunReport = {
    schemaVersion: 1,
    kind: 'hu-10-settlement-e2e',
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    repositories: input.repositories,
    services: input.services,
    scenarios: completed,
    summary,
    limitations: input.limitations,
  }

  mkdirSync(path.dirname(HU10_OUTPUT_FILE), { recursive: true })
  writeFileSync(HU10_OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  return report
}
