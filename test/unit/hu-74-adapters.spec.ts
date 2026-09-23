import { BadRequestException, NotFoundException } from '@nestjs/common'

import { toMissionsHttpException } from '../../src/adapters/inbound/http/missions-error.mapper'
import { InMemoryReportRepository } from '../../src/adapters/outbound/persistence/InMemoryReportRepository'
import { reportViewOf } from '../../src/application/use-cases/GetMissionReport'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
} from '../../src/application/use-cases/ListMissionHistory'
import type {
  MissionReport,
  ReportRecord,
  ReportRewardLine,
} from '../../src/domain/entities/MissionReport'
import {
  InvalidHistoryCursorError,
  ReportNotAvailableError,
  ReportNotFoundError,
} from '../../src/domain/errors/report-errors'

const ENDS = new Date('2026-10-02T03:00:00.000Z')
const CLOSED = new Date('2026-10-02T03:00:05.000Z')

const report = (enrollmentId: string, playerId: string, finishedAt: Date): MissionReport => ({
  schemaVersion: 1,
  enrollmentId,
  playerId,
  mission: {
    missionId: 'msn_templo_olvidado',
    name: 'El Templo Olvidado',
    category: 'STORY',
    difficulty: 'NORMAL',
  },
  summary: {
    outcome: 'COMPLETED',
    outcomeReason: null,
    hero: { heroId: 'heroe-1', name: 'Kaelen', subtype: 'PICARO_VENENO' },
    startedAt: new Date(finishedAt.getTime() - 12 * 3_600_000),
    finishedAt,
    simulatedDuration: 'PT9H40M',
  },
  combatStats: {
    encountersCompleted: 5,
    encountersTotal: 5,
    totalTurns: 142,
    damageDealt: 1830,
    damageTaken: 640,
    criticalEffects: 9,
    skillsUsed: [],
  },
  enemies: {
    defeated: [],
    boss: { enemyRef: 'guardian-eterno', name: 'El Guardián Eterno', defeated: true },
    masters: [],
  },
  objectives: [],
  generatedAt: new Date(finishedAt.getTime() + 5_000),
})

/** Linea del fixture R-4 del contrato de HU-74: 50 creditos pendientes de HU-10. */
const CREDITS: ReportRewardLine = {
  lineNo: 1,
  kind: 'CREDITS',
  reference: null,
  name: 'Créditos',
  rarity: null,
  quantity: 50,
  status: 'PENDING',
  source: 'HU-10',
  updatedAt: CLOSED,
}

describe('InMemoryReportRepository (HU-74)', () => {
  it('guarda la foto una sola vez: repetir el cierre no la reemplaza (P-T2)', async () => {
    const reports = new InMemoryReportRepository()
    const first: ReportRecord = { report: report('enr_1', 'sub-1', ENDS), rewards: [] }

    expect(reports.recordNow(first)).toBe(true)
    expect(
      reports.recordNow({ report: report('enr_1', 'sub-1', CLOSED), rewards: [CREDITS] }),
    ).toBe(false)
    await expect(reports.findByEnrollment('enr_1')).resolves.toEqual(first)
    await expect(reports.findByEnrollment('enr_x')).resolves.toBeNull()
  })

  it('lista los del jugador, del mas reciente al mas antiguo', async () => {
    const reports = new InMemoryReportRepository()
    reports.recordNow({ report: report('enr_viejo', 'sub-1', ENDS), rewards: [] })
    reports.recordNow({
      report: report('enr_nuevo', 'sub-1', new Date(ENDS.getTime() + 60_000)),
      rewards: [],
    })
    reports.recordNow({ report: report('enr_ajeno', 'sub-2', ENDS), rewards: [] })

    const ids = (await reports.listByPlayer('sub-1')).map(({ report: own }) => own.enrollmentId)

    expect(ids).toEqual(['enr_nuevo', 'enr_viejo'])
  })

  it('R-4: la linea pasa de PENDING a CREDITED sin tocar la foto (CU-74.4)', async () => {
    const reports = new InMemoryReportRepository()
    const snapshot = report('enr_1', 'sub-1', ENDS)
    reports.recordNow({ report: snapshot, rewards: [CREDITS] })
    const later = new Date(CLOSED.getTime() + 60_000)

    await expect(reports.updateRewardStatus('enr_1', 1, 'CREDITED', later)).resolves.toBe(true)

    const record = await reports.findByEnrollment('enr_1')
    expect(record?.report).toBe(snapshot)
    expect(record?.rewards).toEqual([{ ...CREDITS, status: 'CREDITED', updatedAt: later }])
    await expect(reports.updateRewardStatus('enr_1', 2, 'CREDITED', later)).resolves.toBe(false)
    await expect(reports.updateRewardStatus('enr_x', 1, 'CREDITED', later)).resolves.toBe(false)
  })
})

describe('La vista del reporte (contrato hu-74-mission-report-v1)', () => {
  it('fechas en ISO-8601, sin el jugador y con las lineas sin su numero interno', () => {
    const view = reportViewOf({ report: report('enr_1', 'sub-1', ENDS), rewards: [CREDITS] })

    expect(view).not.toHaveProperty('playerId')
    expect(view.summary).toMatchObject({
      startedAt: '2026-10-01T15:00:00.000Z',
      finishedAt: ENDS.toISOString(),
    })
    expect(view.generatedAt).toBe(CLOSED.toISOString())
    expect(view.rewards).toEqual([
      {
        kind: 'CREDITS',
        reference: null,
        name: 'Créditos',
        rarity: null,
        quantity: 50,
        status: 'PENDING',
        source: 'HU-10',
      },
    ])
  })
})

describe('Cursor del historial (HU-74)', () => {
  it('va y vuelve igual', () => {
    const position = { finishedAt: ENDS.getTime(), enrollmentId: 'enr_1' }

    expect(decodeHistoryCursor(encodeHistoryCursor(position))).toEqual(position)
    expect(encodeHistoryCursor(position)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

  it.each([
    ['texto que no es base64 de un JSON', 'no-es-un-cursor'],
    ['un objeto', encode({ finishedAt: ENDS.toISOString(), enrollmentId: 'enr_1' })],
    ['una fecha que no es la canonica', encode(['2026-10-02', 'enr_1'])],
    ['una fecha imposible', encode(['2026-13-45T00:00:00.000Z', 'enr_1'])],
    ['sin matricula', encode([ENDS.toISOString(), ''])],
    ['con datos de mas', encode([ENDS.toISOString(), 'enr_1', 'otro'])],
  ])('rechaza %s', (_caso, cursor) => {
    expect(() => decodeHistoryCursor(cursor)).toThrow(InvalidHistoryCursorError)
  })
})

describe('Errores de HU-74 en HTTP', () => {
  const bodyOf = (exception: unknown): unknown =>
    (exception as { getResponse: () => unknown }).getResponse()

  it('REPORT_NOT_AVAILABLE: 404 con la matricula y su fin (CA-04)', () => {
    const exception = toMissionsHttpException(new ReportNotAvailableError('enr_1', ENDS))

    expect(exception).toBeInstanceOf(NotFoundException)
    expect(bodyOf(exception)).toEqual({
      statusCode: 404,
      code: 'REPORT_NOT_AVAILABLE',
      message: 'La misión sigue en curso. El reporte estará listo cuando termine.',
      enrollmentId: 'enr_1',
      endsAt: ENDS.toISOString(),
    })
  })

  it('una matricula pendiente aun no tiene fin', () => {
    expect(
      bodyOf(toMissionsHttpException(new ReportNotAvailableError('enr_1', null))),
    ).toMatchObject({ code: 'REPORT_NOT_AVAILABLE', endsAt: null })
  })

  it('REPORT_NOT_FOUND: 404', () => {
    const exception = toMissionsHttpException(new ReportNotFoundError('enr_1'))

    expect(exception).toBeInstanceOf(NotFoundException)
    expect(bodyOf(exception)).toEqual({
      statusCode: 404,
      code: 'REPORT_NOT_FOUND',
      message: 'No encontramos ese reporte.',
      enrollmentId: 'enr_1',
    })
  })

  it('un cursor ajeno es VALIDATION_ERROR con la forma comun', () => {
    const exception = toMissionsHttpException(new InvalidHistoryCursorError())

    expect(exception).toBeInstanceOf(BadRequestException)
    expect(bodyOf(exception)).toEqual({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'La solicitud tiene datos que faltan o no son válidos.',
      violations: [
        {
          field: 'cursor',
          reasons: ['El cursor del historial no es válido. Vuelve a pedir la primera página.'],
        },
      ],
    })
  })
})
