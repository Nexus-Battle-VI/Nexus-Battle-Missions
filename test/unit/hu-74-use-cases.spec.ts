import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryExecutionRepository } from '../../src/adapters/outbound/persistence/InMemoryExecutionRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type {
  CombatSimulationPort,
  SimulationCallOutcome,
} from '../../src/application/ports/CombatSimulationPort'
import type {
  HeroProfileOutcome,
  HeroProfilePort,
} from '../../src/application/ports/HeroAbilitiesPort'
import type {
  CommitHeroOutcome,
  CommitHeroRequest,
  HeroCommitmentPort,
} from '../../src/application/ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import {
  EnrollInMission,
  type EnrollCommand,
} from '../../src/application/use-cases/EnrollInMission'
import { GetMissionHistorySummary } from '../../src/application/use-cases/GetMissionHistorySummary'
import { GetMissionReport } from '../../src/application/use-cases/GetMissionReport'
import { ListMissionHistory } from '../../src/application/use-cases/ListMissionHistory'
import { RunMissionExecutions } from '../../src/application/use-cases/RunMissionExecutions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import type { SimulationResult } from '../../src/domain/entities/MissionExecution'
import * as ReportPolicy from '../../src/domain/policies/ReportPolicy'
import { EnrollmentPendingError } from '../../src/domain/errors/mission-errors'
import {
  InvalidHistoryCursorError,
  ReportNotAvailableError,
  ReportNotFoundError,
} from '../../src/domain/errors/report-errors'

const AT = new Date('2026-10-01T15:00:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const CAMARA = 'msn_camara_sellada'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HOUR_MS = 3_600_000
const NO_MASTER = { appeared: false, masterRef: null, defeated: false }

/** Resultado del fixture P-01 de HU-72, con la duracion simulada que se pida. */
const victory = (simulatedDuration: string): SimulationResult => ({
  simulationId: `sim_${simulatedDuration}`,
  seedRef: null,
  combatOutcome: 'HERO_VICTORIOUS',
  summary: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    damageDealt: 1830,
    damageTaken: 640,
    minHealthPercent: 41.5,
    criticalEffects: 9,
    bossDefeated: true,
    master: NO_MASTER,
    simulatedDuration,
  },
  combatLog: [],
})

/** Resultado del fixture P-04 de HU-72: el heroe cae. */
const defeat = (simulatedDuration: string): SimulationResult => ({
  simulationId: `sim_derrota_${simulatedDuration}`,
  seedRef: null,
  combatOutcome: 'HERO_DEFEATED',
  summary: {
    encountersCompleted: 1,
    encountersTotal: 1,
    totalTurns: 30,
    damageDealt: 1280,
    damageTaken: 1100,
    minHealthPercent: 0,
    criticalEffects: 1,
    bossDefeated: false,
    master: NO_MASTER,
    simulatedDuration,
  },
  combatLog: [],
})

class MovableClock implements ClockPort {
  current = AT
  now(): Date {
    return this.current
  }
}

class SequenceIds implements IdGeneratorPort {
  private enrollments = 0
  private operations = 0
  newEnrollmentId(): string {
    this.enrollments += 1
    return `enr_${String(this.enrollments)}`
  }
  newOperationId(): string {
    this.operations += 1
    return `op-${String(this.operations)}`
  }
}

/** Player/Inventory: concede la reserva salvo que se le pida no responder. */
class Commitments implements HeroCommitmentPort {
  answer: 'GRANTED' | 'UNKNOWN' = 'GRANTED'

  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    return Promise.resolve(
      this.answer === 'GRANTED'
        ? { kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` }
        : { kind: 'UNKNOWN', reason: 'TIMEOUT' },
    )
  }

  release(): Promise<'RELEASED' | 'UNKNOWN'> {
    return Promise.resolve('RELEASED')
  }
}

/** Combat con respuestas guionizadas; por defecto, una victoria de 9 h 40 min. */
class ScriptedCombat implements CombatSimulationPort {
  readonly outcomes: SimulationCallOutcome[] = []

  simulate(): Promise<SimulationCallOutcome> {
    return Promise.resolve(
      this.outcomes.shift() ?? { kind: 'SIMULATED', result: victory('PT9H40M') },
    )
  }
}

class Profiles implements HeroProfilePort {
  profileOf(_playerId: string, heroId: string): Promise<HeroProfileOutcome> {
    return Promise.resolve({
      kind: 'FOUND',
      profile: { heroId, name: 'Kaelen', subtype: 'PICARO_VENENO' },
    })
  }
}

const setup = () => {
  const catalog = new InMemoryMissionCatalog(EXAMPLE_MISSIONS)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const reports = new InMemoryReportRepository()
  const commitments = new Commitments()
  const combat = new ScriptedCombat()
  const ids = new SequenceIds()
  const clock = new MovableClock()
  const errors: { enrollmentId: string; error: unknown }[] = []
  const executor = new RunMissionExecutions(
    new InMemoryExecutionRepository(enrollments, clears, reports),
    enrollments,
    catalog,
    new Profiles(),
    combat,
    commitments,
    ids,
    clock,
    { batchSize: 50, onError: (enrollmentId, error) => errors.push({ enrollmentId, error }) },
  )
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    new InMemoryStrategyRepository(),
    commitments,
    ids,
    clock,
  )
  let keys = 0

  /** Se matricula, simula y, si `close`, avanza el reloj hasta el fin y cierra. */
  const play = async (overrides: Partial<EnrollCommand> = {}, close = true) => {
    keys += 1
    const enrolled = await enroll.execute({
      playerId: 'sub-1',
      missionId: TEMPLO,
      heroId: HERO,
      difficulty: 'NORMAL',
      strategyVersion: null,
      idempotencyKey: `key-${String(keys)}`,
      ...overrides,
    })
    await executor.run()

    if (close && enrolled.status === 'IN_PROGRESS') {
      clock.current = new Date(enrolled.endsAt ?? clock.current)
      await executor.run()
    }

    return enrolled
  }

  return {
    enrollments,
    reports,
    errors,
    commitments,
    combat,
    clock,
    play,
    getReport: new GetMissionReport(reports, enrollments),
    history: new ListMissionHistory(enrollments, reports, catalog),
    summary: new GetMissionHistorySummary(reports, catalog),
  }
}

describe('El reporte nace con el cierre de HU-72 (Task HU-74.2, P-T1)', () => {
  it('R-1: la mision completada tiene su reporte, con los bloques del contrato', async () => {
    const { play, getReport, enrollments } = setup()
    const { enrollmentId, endsAt } = await play()

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({
      status: 'COMPLETED',
    })
    const view = await getReport.execute('sub-1', enrollmentId)

    expect(view).toMatchObject({
      schemaVersion: 1,
      enrollmentId,
      mission: { missionId: TEMPLO, name: 'El Templo Olvidado', difficulty: 'NORMAL' },
      summary: {
        outcome: 'COMPLETED',
        outcomeReason: null,
        hero: { heroId: HERO, name: 'Kaelen', subtype: 'PICARO_VENENO' },
        startedAt: AT.toISOString(),
        finishedAt: endsAt,
        simulatedDuration: 'PT9H40M',
      },
      combatStats: { encountersCompleted: 5, damageDealt: 1830, damageTaken: 640 },
      enemies: { boss: { enemyRef: 'guardian-eterno', defeated: true }, masters: [] },
      rewards: [],
      generatedAt: endsAt,
    })
    expect(view.objectives.map(({ id, met }) => [id, met])).toEqual([
      ['obj_guardian', true],
      ['obj_camaras', true],
      ['obj_vida', false],
      ['obj_master', null],
      ['obj_fragmentos', null],
    ])
    // La foto no lleva al jugador: sale del testimonio, nunca de la respuesta.
    expect(view).not.toHaveProperty('playerId')
  })

  it('R-2: la mision fallida tambien tiene reporte', async () => {
    const { play, getReport, combat } = setup()
    combat.outcomes.push({ kind: 'SIMULATED', result: defeat('PT6H10M') })
    const { enrollmentId } = await play()

    await expect(getReport.execute('sub-1', enrollmentId)).resolves.toMatchObject({
      summary: { outcome: 'FAILED', outcomeReason: 'HERO_DEFEATED' },
      enemies: { boss: { defeated: false } },
    })
  })

  it('si la foto no se puede armar, la mision se cierra igual y el fallo se informa', async () => {
    const { play, getReport, enrollments, errors, history } = setup()
    const broken = jest.spyOn(ReportPolicy, 'missionReportOf').mockImplementation(() => {
      throw new Error('foto rota')
    })

    try {
      const { enrollmentId } = await play()

      await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({
        status: 'COMPLETED',
      })
      expect(errors).toEqual([{ enrollmentId, error: new Error('foto rota') }])
      await expect(getReport.execute('sub-1', enrollmentId)).rejects.toBeInstanceOf(
        ReportNotFoundError,
      )
      await expect(history.execute('sub-1', { limit: 20, cursor: null })).resolves.toMatchObject({
        items: [{ enrollmentId, outcome: 'COMPLETED', reportAvailable: false }],
      })
    } finally {
      broken.mockRestore()
    }
  })

  it('una mision anulada no tiene reporte: REPORT_NOT_FOUND (P-T3)', async () => {
    const { play, getReport, combat, enrollments } = setup()
    combat.outcomes.push({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    const { enrollmentId } = await play({}, false)

    await expect(enrollments.findById(enrollmentId)).resolves.toMatchObject({ status: 'VOIDED' })
    await expect(getReport.execute('sub-1', enrollmentId)).rejects.toBeInstanceOf(
      ReportNotFoundError,
    )
  })
})

describe('GetMissionReport (Task HU-74.2, CU-74.2)', () => {
  it('R-5: una mision en curso responde REPORT_NOT_AVAILABLE con su fin (CA-04)', async () => {
    const { play, getReport } = setup()
    const { enrollmentId, endsAt } = await play({}, false)

    await expect(getReport.execute('sub-1', enrollmentId)).rejects.toBeInstanceOf(
      ReportNotAvailableError,
    )
    await expect(getReport.execute('sub-1', enrollmentId)).rejects.toMatchObject({
      enrollmentId,
      endsAt: new Date(endsAt ?? ''),
    })
  })

  it('una matricula pendiente tampoco tiene reporte, y aun no tiene fin', async () => {
    const { enrollments, commitments, getReport, play } = setup()
    commitments.answer = 'UNKNOWN'

    await expect(play()).rejects.toBeInstanceOf(EnrollmentPendingError)
    const [pending] = await enrollments.listByPlayer('sub-1')
    const enrollmentId = pending?.enrollmentId ?? ''

    await expect(getReport.execute('sub-1', enrollmentId)).rejects.toMatchObject({
      enrollmentId,
      endsAt: null,
    })
  })

  it('R-6: el reporte de otro jugador responde igual que uno que no existe (P-T8)', async () => {
    const { play, getReport } = setup()
    const finished = await play()
    const running = await play(
      { playerId: 'sub-2', heroId: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b' },
      false,
    )

    await expect(getReport.execute('sub-2', finished.enrollmentId)).rejects.toBeInstanceOf(
      ReportNotFoundError,
    )
    // Tampoco revela que la matricula de otro sigue en curso.
    await expect(getReport.execute('sub-1', running.enrollmentId)).rejects.toBeInstanceOf(
      ReportNotFoundError,
    )
    await expect(getReport.execute('sub-1', 'enr_inexistente')).rejects.toBeInstanceOf(
      ReportNotFoundError,
    )
  })
})

describe('Historial y su resumen (Task HU-74.2, CU-74.3, CA-05)', () => {
  /**
   * Cuatro misiones del mismo jugador, una tras otra: el Templo completado dos
   * veces (9 h 40 min y 8 h 55 min simuladas), la Camara fallida y el Templo en
   * Heroico anulado por Combat.
   */
  const fourMissions = async () => {
    const context = setup()
    const { play, combat } = context
    const first = await play()
    combat.outcomes.push({ kind: 'SIMULATED', result: victory('PT8H55M') })
    const second = await play()
    combat.outcomes.push({ kind: 'SIMULATED', result: defeat('PT3H10M') })
    const third = await play({ missionId: CAMARA })
    combat.outcomes.push({ kind: 'REJECTED', code: 'INVALID_STRATEGY' })
    const fourth = await play({ difficulty: 'HEROIC' }, false)

    return { ...context, ids: [first, second, third, fourth].map((e) => e.enrollmentId) }
  }

  it('lista las terminadas, de la mas reciente a la mas antigua; la anulada sin reporte', async () => {
    const { history, ids } = await fourMissions()
    const page = await history.execute('sub-1', { limit: 20, cursor: null })

    expect(page.nextCursor).toBeNull()
    // La anulada y la Camara terminan a la misma hora: desempata la matricula.
    expect(page.items.map((item) => [item.enrollmentId, item.outcome])).toEqual([
      [ids[3], 'VOIDED'],
      [ids[2], 'FAILED'],
      [ids[1], 'COMPLETED'],
      [ids[0], 'COMPLETED'],
    ])
    expect(page.items[0]).toEqual({
      enrollmentId: ids[3],
      missionId: TEMPLO,
      name: 'El Templo Olvidado',
      category: 'STORY',
      difficulty: 'HEROIC',
      outcome: 'VOIDED',
      finishedAt: new Date(AT.getTime() + 30 * HOUR_MS).toISOString(),
      simulatedDuration: null,
      reportAvailable: false,
    })
    expect(page.items[3]).toMatchObject({
      finishedAt: new Date(AT.getTime() + 12 * HOUR_MS).toISOString(),
      simulatedDuration: 'PT9H40M',
      reportAvailable: true,
    })
  })

  it('pagina con un cursor opaco sin repetir ni saltar misiones', async () => {
    const { history, ids } = await fourMissions()
    const first = await history.execute('sub-1', { limit: 3, cursor: null })
    const second = await history.execute('sub-1', { limit: 3, cursor: first.nextCursor })

    expect(first.items.map((item) => item.enrollmentId)).toEqual([ids[3], ids[2], ids[1]])
    expect(first.nextCursor).not.toBeNull()
    expect(second).toMatchObject({ items: [{ enrollmentId: ids[0] }], nextCursor: null })
  })

  it('un cursor que no dio el servicio es un error de validacion', async () => {
    const { history } = setup()

    await expect(
      history.execute('sub-1', { limit: 20, cursor: 'no-es-un-cursor' }),
    ).rejects.toBeInstanceOf(InvalidHistoryCursorError)
  })

  it('las misiones en curso no aparecen y cada jugador ve solo lo suyo', async () => {
    const { play, history } = setup()
    await play({}, false)

    await expect(history.execute('sub-1', { limit: 20, cursor: null })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(history.execute('sub-2', { limit: 20, cursor: null })).resolves.toEqual({
      items: [],
      nextCursor: null,
    })
  })

  it('H-1: el resumen trae estadisticas, mejores tiempos y progreso narrativo', async () => {
    const { summary } = await fourMissions()
    const view = await summary.execute('sub-1')

    expect(view.byCategory).toEqual([
      {
        category: 'STORY',
        completed: 2,
        failed: 1,
        abandoned: 0,
        damageDealt: 1830 + 1830 + 1280,
        damageTaken: 640 + 640 + 1100,
      },
      {
        category: 'CHALLENGE',
        completed: 0,
        failed: 0,
        abandoned: 0,
        damageDealt: 0,
        damageTaken: 0,
      },
      {
        category: 'EXPLORATION',
        completed: 0,
        failed: 0,
        abandoned: 0,
        damageDealt: 0,
        damageTaken: 0,
      },
    ])
    expect(view.bestTimes).toEqual([
      {
        missionId: TEMPLO,
        difficulty: 'NORMAL',
        simulatedDuration: 'PT8H55M',
        enrollmentId: 'enr_2',
      },
    ])
    expect(view.narrativeProgress).toEqual([
      { chainId: TEMPLO, missions: [TEMPLO, CAMARA], completed: 1, total: 2 },
    ])
    // Las epicas llegaran con HU-73.2.
    expect(view.epicCollection).toEqual([])
  })

  it('sin misiones terminadas, el resumen sale en cero', async () => {
    const { summary } = setup()
    const [templo] = EXAMPLE_MISSIONS as [MissionDefinition]

    await expect(summary.execute('sub-1')).resolves.toMatchObject({
      bestTimes: [],
      epicCollection: [],
      narrativeProgress: [{ chainId: templo.missionId, completed: 0, total: 2 }],
    })
  })
})
