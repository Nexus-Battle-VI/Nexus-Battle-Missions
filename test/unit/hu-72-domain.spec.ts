import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  closeEnrollment,
  confirmEnrollment,
  InvalidEnrollmentTransitionError,
  newPendingEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import {
  InvalidExecutionTransitionError,
  markHeroReleased,
  queueExecution,
  recordSimulation,
  requestSimulation,
  retryDelayMs,
  retryLater,
  settleExecution,
  voidExecution,
  type MissionExecution,
  type SimulationRequest,
  type SimulationResult,
} from '../../src/domain/entities/MissionExecution'
import {
  evaluateObjectives,
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../src/domain/policies/SettlementPolicy'

const [TEMPLO] = EXAMPLE_MISSIONS as [MissionDefinition]
const STARTED = new Date('2026-10-01T15:00:00.000Z')
const ENDS = new Date('2026-10-02T03:00:00.000Z')

/** Resumen del fixture P-01 del contrato de HU-72. */
const P01_SUMMARY = {
  encountersCompleted: 5,
  encountersTotal: 5,
  totalTurns: 142,
  damageDealt: 1830,
  damageTaken: 640,
  minHealthPercent: 41.5,
  criticalEffects: 9,
  bossDefeated: true,
  master: { appeared: false, masterRef: null, defeated: false },
  simulatedDuration: 'PT9H40M',
}

const facts = (summary: unknown) => {
  const parsed = simulationFactsOf(summary)

  if (parsed === null) {
    throw new Error('El resumen de la prueba no es valido.')
  }

  return parsed
}

const request = { operationId: 'op_sim_1' } as unknown as SimulationRequest
const result: SimulationResult = {
  simulationId: 'sim_1',
  seedRef: 'seed_1',
  combatOutcome: 'HERO_VICTORIOUS',
  summary: P01_SUMMARY,
  combatLog: [{ seq: 1, type: 'simulationFinished' }],
}

const queued = (): MissionExecution =>
  queueExecution({ enrollmentId: 'enr_1', operationId: 'op_sim_1', endsAt: ENDS, now: STARTED })

describe('MissionExecution: transiciones (HU-72)', () => {
  it('nace QUEUED, lista para intentarse ya y con plazo endsAt + 30 min (P-S8)', () => {
    expect(queued()).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      nextAttemptAt: STARTED,
      deadlineAt: new Date('2026-10-02T03:30:00.000Z'),
      version: 0,
    })
  })

  it('el escalonado es 5 s, 30 s, 2 min y 10 min, y despues cada 10 min', () => {
    expect([0, 1, 2, 3, 4, 7].map(retryDelayMs)).toEqual([
      5_000, 5_000, 30_000, 120_000, 600_000, 600_000,
    ])
  })

  it('congela la primera solicitud: los reintentos mandan la misma (P-S3)', () => {
    const first = requestSimulation(queued(), request, STARTED)
    const other = { operationId: 'otro' } as unknown as SimulationRequest
    const second = requestSimulation(first, other, STARTED)

    expect(first).toMatchObject({
      status: 'REQUESTED',
      attempts: 1,
      nextAttemptAt: new Date(STARTED.getTime() + 5_000),
    })
    expect(second.request).toBe(request)
    expect(second.attempts).toBe(2)
  })

  it('T-01: sin respuesta, cada reintento espera mas', () => {
    const once = retryLater(requestSimulation(queued(), request, STARTED), 'HTTP_503', STARTED)
    const twice = retryLater(requestSimulation(once, request, STARTED), 'TIMEOUT', STARTED)

    expect(once.nextAttemptAt).toEqual(new Date(STARTED.getTime() + 5_000))
    expect(twice).toMatchObject({
      lastError: 'TIMEOUT',
      nextAttemptAt: new Date(STARTED.getTime() + 30_000),
    })
  })

  it('guarda el resultado sellado y cierra una sola vez', () => {
    const simulated = recordSimulation(
      requestSimulation(queued(), request, STARTED),
      result,
      STARTED,
    )
    const settlement = { outcome: 'COMPLETED' as const, reason: null, objectives: [] }
    const settled = settleExecution(simulated, settlement, ENDS)

    expect(simulated).toMatchObject({ status: 'SIMULATED', result, nextAttemptAt: null })
    expect(settled).toMatchObject({ status: 'SETTLED', settlement, settledAt: ENDS })
    expect(() => settleExecution(settled, settlement, ENDS)).toThrow(
      InvalidExecutionTransitionError,
    )
  })

  it('se anula antes del cierre, y un resultado guardado se conserva (P-S7)', () => {
    expect(voidExecution(queued(), 'SIMULATION_TIMEOUT', ENDS)).toMatchObject({
      status: 'VOIDED',
      settlement: { outcome: 'VOIDED', reason: 'SIMULATION_TIMEOUT', objectives: [] },
    })
    const simulated = recordSimulation(
      requestSimulation(queued(), request, STARTED),
      result,
      STARTED,
    )
    expect(voidExecution(simulated, 'MISSION_NOT_FOUND', ENDS)).toMatchObject({
      status: 'VOIDED',
      result,
      settlement: { reason: 'MISSION_NOT_FOUND' },
    })
  })

  it('una mision cerrada ya no se anula', () => {
    const settled = settleExecution(
      recordSimulation(requestSimulation(queued(), request, STARTED), result, STARTED),
      { outcome: 'COMPLETED', reason: null, objectives: [] },
      ENDS,
    )

    expect(() => voidExecution(settled, 'X', ENDS)).toThrow(InvalidExecutionTransitionError)
    expect(() => voidExecution(voidExecution(queued(), 'X', ENDS), 'X', ENDS)).toThrow(
      InvalidExecutionTransitionError,
    )
  })

  it('la liberacion del heroe se anota una sola vez y solo tras el cierre (P-S10)', () => {
    const voided = voidExecution(queued(), 'X', ENDS)
    const released = markHeroReleased(voided, ENDS)

    expect(released.heroReleasedAt).toEqual(ENDS)
    expect(() => markHeroReleased(released, ENDS)).toThrow(InvalidExecutionTransitionError)
    expect(() => markHeroReleased(queued(), ENDS)).toThrow(InvalidExecutionTransitionError)
  })

  it('solo una ejecucion pedida guarda un resultado', () => {
    expect(() => recordSimulation(queued(), result, STARTED)).toThrow(
      InvalidExecutionTransitionError,
    )
  })
})

describe('Hechos del resumen (HU-72, P-S5)', () => {
  it('lee los hechos del fixture P-01', () => {
    expect(facts(P01_SUMMARY)).toEqual({
      encountersCompleted: 5,
      encountersTotal: 5,
      bossDefeated: true,
      minHealthPercent: 41.5,
      master: { appeared: false, defeated: false },
    })
  })

  it('sin master en el resumen, el Master no aparecio', () => {
    expect(facts({ ...P01_SUMMARY, master: undefined }).master).toEqual({
      appeared: false,
      defeated: false,
    })
  })

  it.each([
    ['no es un objeto', null],
    ['sin bossDefeated', { ...P01_SUMMARY, bossDefeated: undefined }],
    ['con mas encuentros completados que totales', { ...P01_SUMMARY, encountersCompleted: 6 }],
    ['con una vida fuera de 0 a 100', { ...P01_SUMMARY, minHealthPercent: 120 }],
    ['con un conteo no entero', { ...P01_SUMMARY, encountersTotal: 4.5 }],
    ['con un master mal formado', { ...P01_SUMMARY, master: { appeared: 'no' } }],
  ])('rechaza un resumen %s', (_caso, summary) => {
    expect(simulationFactsOf(summary)).toBeNull()
  })
})

describe('Resultado de la mision (tabla del diseno de HU-72)', () => {
  it('P-01: objetivos del curso evaluados con el resumen', () => {
    expect(evaluateObjectives(TEMPLO.objectives, facts(P01_SUMMARY))).toEqual([
      { id: 'obj_guardian', type: 'DEFEAT_BOSS', primary: true, met: true },
      { id: 'obj_camaras', type: 'CLEAR_ENCOUNTERS', primary: true, met: true },
      { id: 'obj_vida', type: 'MIN_HEALTH_PERCENT', primary: false, met: false },
      { id: 'obj_master', type: 'DEFEAT_MASTER', primary: false, met: null },
      { id: 'obj_fragmentos', type: 'COLLECT_LOOT', primary: false, met: null },
    ])
  })

  it('P-01: con los principales cumplidos la mision se completa (CA-06)', () => {
    expect(settlementOf('HERO_VICTORIOUS', TEMPLO.objectives, facts(P01_SUMMARY))).toMatchObject({
      outcome: 'COMPLETED',
      reason: null,
    })
  })

  it('P-04: si el heroe cae, falla aunque haya cumplido objetivos (CA-04)', () => {
    expect(settlementOf('HERO_DEFEATED', TEMPLO.objectives, facts(P01_SUMMARY))).toMatchObject({
      outcome: 'FAILED',
      reason: 'HERO_DEFEATED',
    })
  })

  it('T-05: agotado el tiempo sin los principales, falla con TIME_LIMIT (decision 2)', () => {
    const summary = {
      encountersCompleted: 4,
      encountersTotal: 5,
      bossDefeated: false,
      minHealthPercent: 22,
    }

    expect(settlementOf('TIME_BUDGET_EXHAUSTED', TEMPLO.objectives, facts(summary))).toMatchObject({
      outcome: 'FAILED',
      reason: 'TIME_LIMIT',
    })
  })

  it('agotado el tiempo con los principales cumplidos, se completa', () => {
    expect(
      settlementOf('TIME_BUDGET_EXHAUSTED', TEMPLO.objectives, facts(P01_SUMMARY)).outcome,
    ).toBe('COMPLETED')
  })

  it('gana los combates pero falta un principal: FAILED con OBJECTIVES_NOT_MET', () => {
    const summary = { ...P01_SUMMARY, encountersCompleted: 4 }

    expect(settlementOf('HERO_VICTORIOUS', TEMPLO.objectives, facts(summary))).toMatchObject({
      outcome: 'FAILED',
      reason: 'OBJECTIVES_NOT_MET',
    })
  })

  it('el objetivo del Master se evalua solo si aparecio', () => {
    const appeared = { ...P01_SUMMARY, master: { appeared: true, masterRef: 'm', defeated: true } }
    const escaped = { ...P01_SUMMARY, master: { appeared: true, masterRef: 'm', defeated: false } }
    const masterOf = (summary: unknown) =>
      evaluateObjectives(TEMPLO.objectives, facts(summary)).find((o) => o.id === 'obj_master')

    expect(masterOf(appeared)?.met).toBe(true)
    expect(masterOf(escaped)?.met).toBe(false)
  })

  it('un objetivo principal sin regla no bloquea el resultado', () => {
    const loot = [{ id: 'obj_botin', text: 'Encontrar el sello.', primary: true, rule: null }]

    expect(settlementOf('HERO_VICTORIOUS', loot, facts(P01_SUMMARY))).toMatchObject({
      outcome: 'COMPLETED',
      objectives: [{ id: 'obj_botin', type: null, met: null }],
    })
  })

  it('la Camara Sellada se abre venciendo a su custodio', () => {
    const [, CAMARA] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
    const survived = { ...P01_SUMMARY, bossDefeated: false }

    expect(settlementOf('HERO_VICTORIOUS', CAMARA.objectives, facts(P01_SUMMARY)).outcome).toBe(
      'COMPLETED',
    )
    expect(settlementOf('HERO_VICTORIOUS', CAMARA.objectives, facts(survived))).toMatchObject({
      outcome: 'FAILED',
      reason: 'OBJECTIVES_NOT_MET',
    })
  })
})

describe('Cierre de la matricula y hecho MissionSettled (HU-72)', () => {
  const inProgress = (): MissionEnrollment =>
    confirmEnrollment(
      newPendingEnrollment({
        enrollmentId: 'enr_1',
        playerId: 'sub-1',
        missionId: TEMPLO.missionId,
        heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
        difficulty: 'NORMAL',
        operationId: 'op-1',
        idempotencyKey: 'key-1',
        requestFingerprint: 'fp',
        strategyVersion: null,
        requestedAt: STARTED,
      }),
      'cmt-1',
      STARTED,
      720,
    )

  it.each(['COMPLETED', 'FAILED', 'VOIDED'] as const)(
    'una matricula en curso termina %s',
    (status) => {
      expect(closeEnrollment(inProgress(), status, ENDS)).toMatchObject({
        status,
        finishedAt: ENDS,
        version: 2,
      })
    },
  )

  it('solo una matricula en curso se cierra', () => {
    const closed = closeEnrollment(inProgress(), 'COMPLETED', ENDS)

    expect(() => closeEnrollment(closed, 'FAILED', ENDS)).toThrow(InvalidEnrollmentTransitionError)
  })

  it('el hecho lleva lo que necesitan HU-74, HU-76 y HU-10', () => {
    const settlement = settlementOf('HERO_VICTORIOUS', TEMPLO.objectives, facts(P01_SUMMARY))

    expect(missionSettledFact(inProgress(), settlement, 'sim_1', ENDS)).toEqual({
      type: 'MissionSettled',
      enrollmentId: 'enr_1',
      createdAt: ENDS,
      payload: {
        enrollmentId: 'enr_1',
        missionId: TEMPLO.missionId,
        playerId: 'sub-1',
        heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
        difficulty: 'NORMAL',
        missionOutcome: 'COMPLETED',
        reason: null,
        objectives: settlement.objectives,
        simulationId: 'sim_1',
        // HU-73: sin evidencia del Master, la lista va vacia.
        masterEncounters: [],
        settledAt: ENDS.toISOString(),
      },
    })
  })
})
