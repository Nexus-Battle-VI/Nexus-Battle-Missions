import { InMemoryExperienceRolls } from '../../src/adapters/outbound/combat/InMemoryExperienceRolls'
import { InMemoryExperienceRewardRepository } from '../../src/adapters/outbound/persistence/InMemoryExperienceRewardRepository'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { EnrollmentRepositoryPort } from '../../src/application/ports/EnrollmentRepositoryPort'
import type {
  ExperienceCreditOutcome,
  ExperienceCreditPort,
  ExperienceCreditRequest,
} from '../../src/application/ports/ExperienceCreditPort'
import type { ExperienceRollPort } from '../../src/application/ports/ExperienceRollPort'
import { CoordinateExperienceReward } from '../../src/application/use-cases/CoordinateExperienceReward'
import { reportViewOf } from '../../src/application/use-cases/GetMissionReport'
import {
  pendingReward,
  withReportLine,
  type ExperienceReward,
} from '../../src/domain/entities/ExperienceReward'
import type { MissionEnrollment } from '../../src/domain/entities/MissionEnrollment'
import {
  REPORT_SCHEMA_VERSION,
  type MissionReport,
  type ReportRecord,
  type ReportRewardLine,
} from '../../src/domain/entities/MissionReport'
import { experienceReportLinesOf } from '../../src/domain/policies/CombatLogPolicy'
import { readHeroProgression } from '../../src/domain/policies/HeroProgressionPolicy'
import { experienceSummaryOf } from '../../src/domain/policies/ReportPolicy'
import type { HeroProgressionSnapshot } from '../../src/domain/value-objects/hero-progression'

/**
 * HU-09 (Task HU-09.5): la experiencia en el reporte de HU-74.
 *
 * Se comprueban las tres piezas nuevas y su encaje:
 *
 * 1. la LINEA `EXPERIENCE` que nace con el cierre, una por derrota y sin importe;
 * 2. el RESUMEN derivado que lee el jugador, con el nivel del heroe;
 * 3. y que el avance de la recompensa mueve SU linea en la misma escritura, de modo
 *    que el reporte no puede decir `PENDING` de una experiencia ya entregada.
 */
const NOW = new Date('2026-10-02T03:00:00.000Z')
const ENROLLMENT = 'enr_01JB8Y3K7Q'
const HERO_ID = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'

const progressionOf = (
  overrides: Partial<HeroProgressionSnapshot> = {},
): HeroProgressionSnapshot => ({
  level: 3,
  currentXp: 640,
  maxLevel: 8,
  levelsGained: 1,
  ...overrides,
})

const lineOf = (overrides: Partial<ReportRewardLine> = {}): ReportRewardLine => ({
  lineNo: 1,
  kind: 'EXPERIENCE',
  reference: 'sombra-corrompida#1',
  name: 'Sombra Corrompida',
  rarity: null,
  quantity: 0,
  status: 'PENDING',
  source: 'HU-09',
  progression: null,
  updatedAt: NOW,
  ...overrides,
})

const rewardOf = (
  enemyInstanceId: string,
  reportLineNo: number | null = null,
): ExperienceReward => {
  const reward = pendingReward({
    enrollmentId: ENROLLMENT,
    playerId: 'sub-1',
    heroId: HERO_ID,
    simulationId: 'sim_01JB8Y4B',
    defeat: {
      encounterId: enemyInstanceId.split('#')[1] ?? '1',
      enemyInstanceId,
      rivalRef: enemyInstanceId.split('#')[0] ?? 'rival',
    },
    now: NOW,
  })

  return reportLineNo === null ? reward : withReportLine(reward, reportLineNo)
}

/** La foto minima que el reporte exige; el resumen de experiencia no la mira. */
const reportOf = (rewards: readonly ReportRewardLine[]): ReportRecord => {
  const report: MissionReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    enrollmentId: ENROLLMENT,
    playerId: 'sub-1',
    mission: { missionId: 'templo', name: 'Templo', category: 'STORY', difficulty: 'NORMAL' },
    summary: {
      outcome: 'COMPLETED',
      outcomeReason: null,
      hero: { heroId: HERO_ID, name: 'Heroe', subtype: 'GUERRERO' },
      startedAt: NOW,
      finishedAt: NOW,
      simulatedDuration: null,
    },
    combatStats: {
      encountersCompleted: null,
      encountersTotal: null,
      totalTurns: null,
      damageDealt: null,
      damageTaken: null,
      criticalEffects: null,
      skillsUsed: [],
    },
    enemies: {
      defeated: [],
      boss: { enemyRef: 'guardian-eterno', name: 'Guardian', defeated: true },
      masters: [],
    },
    objectives: [],
    generatedAt: NOW,
  }

  return { report, rewards }
}

describe('Lineas de experiencia del reporte (HU-09, Task HU-09.5)', () => {
  it('una linea PENDING por derrota, detras de las de HU-73 y atada a su recompensa', () => {
    const rewards = [rewardOf('sombra-corrompida#1'), rewardOf('sombra-corrompida#2')]

    const { rewards: bound, lines } = experienceReportLinesOf({
      rewards,
      // Las de la epica ya ocuparon la 1 y la 2.
      firstLineNo: 3,
      enemyNames: new Map([['sombra-corrompida', 'Sombra Corrompida']]),
      now: NOW,
    })

    expect(lines).toEqual([
      {
        lineNo: 3,
        kind: 'EXPERIENCE',
        reference: 'sombra-corrompida#1',
        name: 'Sombra Corrompida',
        rarity: null,
        // Nace en cero: el importe lo decide la tirada, que ocurre DESPUES del cierre.
        quantity: 0,
        status: 'PENDING',
        source: 'HU-09',
        progression: null,
        updatedAt: NOW,
      },
      expect.objectContaining({ lineNo: 4, reference: 'sombra-corrompida#2' }),
    ])
    // La recompensa sabe QUE linea la refleja: es lo que permite moverlas juntas.
    expect(bound.map((reward) => reward.reportLineNo)).toEqual([3, 4])
  })

  it('sin el nombre en el contenido, la linea usa la referencia del arquetipo', () => {
    const { lines } = experienceReportLinesOf({
      rewards: [rewardOf('espectro-ancestral#1')],
      firstLineNo: 1,
      enemyNames: new Map(),
      now: NOW,
    })

    expect(lines[0]).toMatchObject({
      name: 'espectro-ancestral',
      reference: 'espectro-ancestral#1',
    })
  })

  it('sin derrotas no hay lineas: es un resultado legitimo, no un error (CA-08)', () => {
    const { rewards, lines } = experienceReportLinesOf({
      rewards: [],
      firstLineNo: 1,
      enemyNames: new Map(),
      now: NOW,
    })

    expect(rewards).toEqual([])
    expect(lines).toEqual([])
  })
})

describe('Resumen de experiencia del reporte (HU-09, Task HU-09.5)', () => {
  it('un reporte sin lineas de experiencia sale con ceros y sin nivel', () => {
    expect(experienceSummaryOf([])).toEqual({
      defeats: 0,
      totalXp: 0,
      credited: 0,
      pending: 0,
      failed: 0,
      level: null,
      currentXp: null,
      maxLevel: null,
      levelsGained: 0,
      leveledUp: false,
    })
  })

  it('las lineas de otros origenes no entran en el resumen', () => {
    const summary = experienceSummaryOf([
      lineOf({ kind: 'EPIC', source: 'HU-73', quantity: 1, status: 'CREDITED' }),
      lineOf({ kind: 'CREDITS', source: 'HU-10', quantity: 50 }),
    ])

    expect(summary.defeats).toBe(0)
    expect(summary.totalXp).toBe(0)
  })

  it('una derrota pendiente no suma experiencia ni da nivel', () => {
    const summary = experienceSummaryOf([lineOf(), lineOf({ lineNo: 2 })])

    expect(summary).toMatchObject({
      defeats: 2,
      totalXp: 0,
      credited: 0,
      pending: 2,
      failed: 0,
      level: null,
      levelsGained: 0,
      leveledUp: false,
    })
  })

  it('acredita la experiencia sumada y publica el nivel del heroe', () => {
    const summary = experienceSummaryOf([
      lineOf({
        quantity: 12,
        status: 'CREDITED',
        progression: progressionOf({ level: 2, currentXp: 512, levelsGained: 1 }),
      }),
      lineOf({
        lineNo: 2,
        quantity: 25,
        status: 'CREDITED',
        progression: progressionOf({ level: 3, currentXp: 640, levelsGained: 1 }),
      }),
      lineOf({
        lineNo: 3,
        quantity: 17,
        status: 'CREDITED',
        progression: progressionOf({ level: 3, currentXp: 657, levelsGained: 0 }),
      }),
    ])

    expect(summary).toMatchObject({
      defeats: 3,
      totalXp: 54,
      credited: 3,
      pending: 0,
      level: 3,
      currentXp: 657,
      maxLevel: 8,
      levelsGained: 2,
      leveledUp: true,
    })
  })

  it('el nivel es el MAYOR, no el de la ultima linea: el barrido no fija el orden', () => {
    const summary = experienceSummaryOf([
      lineOf({
        quantity: 43,
        status: 'CREDITED',
        progression: progressionOf({ level: 5, currentXp: 2_400, levelsGained: 1 }),
      }),
      lineOf({
        lineNo: 2,
        quantity: 12,
        status: 'CREDITED',
        progression: progressionOf({ level: 2, currentXp: 512, levelsGained: 0 }),
      }),
    ])

    expect(summary).toMatchObject({ level: 5, currentXp: 2_400, levelsGained: 1 })
  })

  it('cuenta por separado acreditadas, pendientes y fallidas', () => {
    const summary = experienceSummaryOf([
      lineOf({ quantity: 12, status: 'CREDITED', progression: progressionOf() }),
      lineOf({ lineNo: 2, status: 'PENDING' }),
      lineOf({ lineNo: 3, quantity: 0, status: 'FAILED' }),
    ])

    expect(summary).toMatchObject({ defeats: 3, credited: 1, pending: 1, failed: 1, totalXp: 12 })
  })

  it('sin progresion legible la experiencia cuenta igual, pero no hay nivel', () => {
    const summary = experienceSummaryOf([lineOf({ quantity: 30, status: 'CREDITED' })])

    expect(summary).toMatchObject({
      totalXp: 30,
      credited: 1,
      level: null,
      currentXp: null,
      levelsGained: 0,
      leveledUp: false,
    })
  })

  it('el reporte publicado lleva el resumen y NO la progresion de cada linea', () => {
    const view = reportViewOf(
      reportOf([lineOf({ quantity: 12, status: 'CREDITED', progression: progressionOf() })]),
    )

    expect(view.experience).toMatchObject({ defeats: 1, totalXp: 12, credited: 1, level: 3 })
    expect(view.rewards).toEqual([
      {
        kind: 'EXPERIENCE',
        reference: 'sombra-corrompida#1',
        name: 'Sombra Corrompida',
        rarity: null,
        quantity: 12,
        status: 'CREDITED',
        source: 'HU-09',
      },
    ])
  })
})

describe('Lectura de la progresion que devuelve Player/Inventory (HU-09, Task HU-09.5)', () => {
  it('lee el cuerpo del contrato', () => {
    expect(
      readHeroProgression({
        operationId: 'op-1',
        applied: true,
        heroId: HERO_ID,
        level: 3,
        currentXp: 640,
        leveledUp: true,
        levelsGained: 1,
        nextLevel: { status: 'AVAILABLE', forNextLevel: 4, amount: 900 },
        maxLevel: 8,
      }),
    ).toEqual({ level: 3, currentXp: 640, maxLevel: 8, levelsGained: 1 })
  })

  it.each([
    ['sin nivel', { currentXp: 640, maxLevel: 8, levelsGained: 1 }],
    ['sin experiencia acumulada', { level: 3, maxLevel: 8, levelsGained: 1 }],
    ['sin tope de nivel', { level: 3, currentXp: 640, levelsGained: 1 }],
    ['sin niveles cruzados', { level: 3, currentXp: 640, maxLevel: 8 }],
    [
      'con un nivel por encima del tope',
      { level: 9, currentXp: 640, maxLevel: 8, levelsGained: 1 },
    ],
    ['con un decimal', { level: 3.5, currentXp: 640, maxLevel: 8, levelsGained: 1 }],
    ['con un negativo', { level: 3, currentXp: -1, maxLevel: 8, levelsGained: 1 }],
    ['con textos', { level: '3', currentXp: '640', maxLevel: '8', levelsGained: '1' }],
    ['sin ser un objeto', 'LEVEL_3'],
  ])('una progresion %s no vale', (_label, body) => {
    expect(readHeroProgression(body)).toBeNull()
  })

  it('un cuerpo nulo no vale, pero no lanza: la acreditacion sigue siendo valida', () => {
    expect(readHeroProgression(null)).toBeNull()
  })
})

/** Devuelve siempre el mismo desenlace: es lo que se quiere medir aqui. */
class StubCredits implements ExperienceCreditPort {
  readonly requests: ExperienceCreditRequest[] = []

  constructor(private readonly outcome: ExperienceCreditOutcome) {}

  credit(request: ExperienceCreditRequest): Promise<ExperienceCreditOutcome> {
    this.requests.push(request)

    return Promise.resolve(this.outcome)
  }
}

let now = NOW
const clock: ClockPort = { now: () => now }

beforeEach(() => {
  now = NOW
})

const enrollmentOf = (status: MissionEnrollment['status']): MissionEnrollment =>
  ({
    enrollmentId: ENROLLMENT,
    playerId: 'sub-1',
    heroId: HERO_ID,
    missionId: 'templo',
    difficulty: 'NORMAL',
    status,
    version: 1,
  }) as MissionEnrollment

const enrollmentsOf = (
  status: MissionEnrollment['status'] = 'IN_PROGRESS',
): EnrollmentRepositoryPort =>
  ({ findById: () => Promise.resolve(enrollmentOf(status)) }) as unknown as EnrollmentRepositoryPort

const coordinationOf = (options: {
  readonly rewards: readonly ExperienceReward[]
  readonly lines: readonly ReportRewardLine[]
  readonly credits: ExperienceCreditPort
  readonly rolls?: ExperienceRollPort
  readonly status?: MissionEnrollment['status']
}) => {
  const reports = new InMemoryReportRepository()
  const stored = new InMemoryExperienceRewardRepository(reports)

  reports.recordNow(reportOf(options.lines))
  stored.insert(options.rewards)

  const useCase = new CoordinateExperienceReward(
    stored,
    enrollmentsOf(options.status),
    options.rolls ?? new InMemoryExperienceRolls(),
    options.credits,
    clock,
    { batchSize: 50 },
  )

  return { reports, stored, useCase }
}

describe('La linea del reporte se mueve con la recompensa (HU-09, Task HU-09.5)', () => {
  it('acreditar deja la linea CREDITED, con el importe y con la progresion', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1', 1)],
      lines: [lineOf()],
      credits: new StubCredits({ kind: 'CREDITED', progression: progressionOf() }),
    })

    await expect(useCase.run()).resolves.toMatchObject({ rewardsCredited: 1 })

    const stored = await reports.findByEnrollment(ENROLLMENT)

    // La cara 1 vale 12 experiencia (`experienceForRoll`), y la linea lo dice.
    expect(stored?.rewards[0]).toEqual({
      lineNo: 1,
      kind: 'EXPERIENCE',
      reference: 'sombra-corrompida#1',
      name: 'Sombra Corrompida',
      rarity: null,
      quantity: 12,
      status: 'CREDITED',
      source: 'HU-09',
      progression: progressionOf(),
      updatedAt: NOW,
    })
    expect(reportViewOf(stored!).experience).toMatchObject({
      defeats: 1,
      totalXp: 12,
      credited: 1,
      level: 3,
      levelsGained: 1,
      leveledUp: true,
    })
  })

  it('la linea acreditada sale con su importe aunque Player/Inventory no de la progresion', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1', 1)],
      lines: [lineOf()],
      credits: new StubCredits({ kind: 'CREDITED', progression: null }),
    })

    await useCase.run()

    const stored = await reports.findByEnrollment(ENROLLMENT)

    expect(stored?.rewards[0]).toMatchObject({
      status: 'CREDITED',
      quantity: 12,
      progression: null,
    })
    expect(reportViewOf(stored!).experience).toMatchObject({
      totalXp: 12,
      credited: 1,
      level: null,
    })
  })

  it('un rechazo definitivo de la acreditacion deja la linea FAILED y sin importe', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('guardian-eterno#1', 1)],
      lines: [lineOf({ reference: 'guardian-eterno#1' })],
      credits: new StubCredits({ kind: 'REJECTED', reason: 'EXPERIENCE_GRANT_REJECTED' }),
    })

    await expect(useCase.run()).resolves.toMatchObject({ rewardsRejected: 1 })

    const stored = await reports.findByEnrollment(ENROLLMENT)

    expect(stored?.rewards[0]).toMatchObject({ status: 'FAILED', quantity: 0, progression: null })
    expect(reportViewOf(stored!).experience).toMatchObject({
      defeats: 1,
      credited: 0,
      failed: 1,
      totalXp: 0,
      level: null,
    })
  })

  it('una respuesta sin confirmar NO toca la linea: sigue PENDING', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1', 1)],
      lines: [lineOf()],
      credits: new StubCredits({ kind: 'UNKNOWN', reason: 'HTTP_503' }),
    })

    await expect(useCase.run()).resolves.toMatchObject({ rewardsRetried: 1 })

    const stored = await reports.findByEnrollment(ENROLLMENT)

    expect(stored?.rewards[0]).toMatchObject({ status: 'PENDING', quantity: 0 })
  })

  it('una tirada rechazada deja la linea FAILED aunque nunca llegue a acreditarse', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1', 1)],
      lines: [lineOf()],
      credits: new StubCredits({ kind: 'CREDITED', progression: progressionOf() }),
      rolls: { rollDefeats: () => Promise.resolve({ kind: 'REJECTED', reason: 'INVALID_HERO' }) },
    })

    await expect(useCase.run()).resolves.toMatchObject({ rewardsRejected: 1 })

    const stored = await reports.findByEnrollment(ENROLLMENT)

    expect(stored?.rewards[0]).toMatchObject({ status: 'FAILED', quantity: 0 })
  })

  it('una recompensa sin linea -- mision anulada -- se rechaza sin tocar el reporte', async () => {
    const { reports, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1')],
      lines: [lineOf()],
      status: 'VOIDED',
      credits: new StubCredits({ kind: 'CREDITED', progression: progressionOf() }),
    })

    await expect(useCase.run()).resolves.toMatchObject({ rewardsRejected: 1 })

    // La linea es de OTRA mision: se quedo como estaba.
    const stored = await reports.findByEnrollment(ENROLLMENT)

    expect(stored?.rewards[0]).toMatchObject({ status: 'PENDING', quantity: 0 })
  })

  it('el segundo barrido no vuelve a escribir la linea ya acreditada', async () => {
    const { reports, stored, useCase } = coordinationOf({
      rewards: [rewardOf('sombra-corrompida#1', 1)],
      lines: [lineOf()],
      credits: new StubCredits({ kind: 'CREDITED', progression: progressionOf() }),
    })

    await useCase.run()

    // La recompensa ya es terminal: el barrido siguiente no la encuentra.
    await expect(useCase.run()).resolves.toMatchObject({ rewardsCredited: 0 })

    const stored2 = await reports.findByEnrollment(ENROLLMENT)

    expect(stored2?.rewards[0]).toMatchObject({ status: 'CREDITED', quantity: 12 })
    expect((await stored.listByEnrollment(ENROLLMENT))[0]).toMatchObject({ status: 'CREDITED' })
  })
})
