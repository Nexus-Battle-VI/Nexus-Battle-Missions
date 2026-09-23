import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import {
  confirmEnrollment,
  enrollmentStartedFact,
  expireEnrollment,
  InvalidEnrollmentTransitionError,
  isActiveEnrollment,
  newPendingEnrollment,
  rejectEnrollment,
  type MissionEnrollment,
} from '../../src/domain/entities/MissionEnrollment'
import {
  HeroBusyError,
  MissionAlreadyInProgressError,
  MissionLockedError,
} from '../../src/domain/errors/mission-errors'
import {
  assertHeroFree,
  assertMissionNotInProgress,
  assertPrerequisitesMet,
  derivePlayerMissionStatus,
  lockReasonFor,
  missingPrerequisitesOf,
} from '../../src/domain/policies/EnrollmentPolicy'
import { isMissionCategory, toIsoDuration } from '../../src/domain/value-objects/mission-category'

const AT = new Date('2026-10-01T15:00:00.000Z')
const [TEMPLO, CAMARA] = EXAMPLE_MISSIONS as [MissionDefinition, MissionDefinition]
const NAMES = new Map(EXAMPLE_MISSIONS.map((mission) => [mission.missionId, mission.name]))

const pending = (overrides: Partial<MissionEnrollment> = {}): MissionEnrollment => ({
  ...newPendingEnrollment({
    enrollmentId: 'enr_1',
    playerId: 'sub-1',
    missionId: TEMPLO.missionId,
    heroId: '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60',
    difficulty: 'NORMAL',
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    requestFingerprint: 'fp',
    strategyVersion: null,
    requestedAt: AT,
  }),
  ...overrides,
})

describe('Vocabulario del tablon (HU-70)', () => {
  it.each([
    [720, 'PT12H'],
    [90, 'PT1H30M'],
    [45, 'PT45M'],
    [60, 'PT1H'],
  ])('%i minutos se publican como %s', (minutes, iso) => {
    expect(toIsoDuration(minutes)).toBe(iso)
  })

  it.each([0, -5, 1.5])('rechaza una duracion de %p minutos', (minutes) => {
    expect(() => toIsoDuration(minutes)).toThrow(RangeError)
  })

  it('reconoce solo las tres categorias del curso', () => {
    expect(isMissionCategory('STORY')).toBe(true)
    expect(isMissionCategory('RAID')).toBe(false)
  })
})

describe('MissionEnrollment: transiciones (HU-70)', () => {
  it('nace PENDING, activa y sin reserva', () => {
    const enrollment = pending()

    expect(enrollment).toMatchObject({ status: 'PENDING', version: 0, commitmentId: null })
    expect(isActiveEnrollment(enrollment.status)).toBe(true)
  })

  it('al confirmarse empieza ahora y vence al cumplir la duracion (CA-01)', () => {
    const confirmed = confirmEnrollment(pending(), 'cmt-1', AT, 12 * 60)

    expect(confirmed).toMatchObject({
      status: 'IN_PROGRESS',
      commitmentId: 'cmt-1',
      startedAt: AT,
      endsAt: new Date('2026-10-02T03:00:00.000Z'),
      version: 1,
    })
  })

  it('se rechaza guardando el motivo y deja de estar activa', () => {
    const rejected = rejectEnrollment(
      pending(),
      { code: 'LOADOUT_INCOMPLETE', detail: { missingSlots: [] } },
      AT,
    )

    expect(rejected).toMatchObject({ status: 'REJECTED', finishedAt: AT, version: 1 })
    expect(isActiveEnrollment(rejected.status)).toBe(false)
  })

  it('caduca sin confirmarse', () => {
    expect(expireEnrollment(pending(), AT)).toMatchObject({ status: 'EXPIRED', version: 1 })
  })

  it('solo una matricula PENDING puede cambiar de estado', () => {
    const confirmed = confirmEnrollment(pending(), 'cmt-1', AT, 60)

    expect(() => confirmEnrollment(confirmed, 'cmt-2', AT, 60)).toThrow(
      InvalidEnrollmentTransitionError,
    )
    expect(() => expireEnrollment(confirmed, AT)).toThrow(InvalidEnrollmentTransitionError)
    expect(() => rejectEnrollment(confirmed, { code: 'HERO_NOT_OWNED', detail: {} }, AT)).toThrow(
      InvalidEnrollmentTransitionError,
    )
  })

  it('el hecho de inicio lleva lo que necesita HU-72', () => {
    const fact = enrollmentStartedFact(confirmEnrollment(pending(), 'cmt-1', AT, 60))

    expect(fact).toMatchObject({
      type: 'MissionEnrollmentStarted',
      enrollmentId: 'enr_1',
      payload: {
        missionId: TEMPLO.missionId,
        difficulty: 'NORMAL',
        startedAt: AT.toISOString(),
        endsAt: '2026-10-01T16:00:00.000Z',
      },
    })
  })

  it('no hay hecho de inicio para una matricula que no esta en curso', () => {
    expect(() => enrollmentStartedFact(pending())).toThrow(InvalidEnrollmentTransitionError)
  })
})

describe('EnrollmentPolicy (HU-70)', () => {
  const context = {
    completedMissionIds: new Set<string>(),
    missionNames: NAMES,
    activeEnrollmentId: null,
    lastFinishedStatus: null,
  }

  it('una mision sin requisitos esta disponible', () => {
    expect(derivePlayerMissionStatus(TEMPLO, context)).toEqual({
      status: 'AVAILABLE',
      canEnroll: true,
      lockReason: null,
      missingPrerequisites: [],
      activeEnrollmentId: null,
    })
  })

  it('una mision con requisitos pendientes esta bloqueada y nombra lo que falta (CA-07)', () => {
    expect(derivePlayerMissionStatus(CAMARA, context)).toMatchObject({
      status: 'LOCKED',
      canEnroll: false,
      lockReason: 'Completa primero «El Templo Olvidado».',
      missingPrerequisites: [TEMPLO.missionId],
    })
  })

  it('con el requisito completado deja de estar bloqueada', () => {
    const view = derivePlayerMissionStatus(CAMARA, {
      ...context,
      completedMissionIds: new Set([TEMPLO.missionId]),
    })

    expect(view.status).toBe('AVAILABLE')
  })

  it('una matricula activa gana sobre todo lo demas', () => {
    expect(
      derivePlayerMissionStatus(CAMARA, { ...context, activeEnrollmentId: 'enr_9' }),
    ).toMatchObject({ status: 'IN_PROGRESS', canEnroll: false, activeEnrollmentId: 'enr_9' })
  })

  it.each(['COMPLETED', 'FAILED', 'ABANDONED'] as const)(
    'muestra %s como resultado de la ultima vez y permite repetir',
    (last) => {
      expect(
        derivePlayerMissionStatus(TEMPLO, { ...context, lastFinishedStatus: last }),
      ).toMatchObject({ status: last, canEnroll: true })
    },
  )

  it('REJECTED y EXPIRED no son resultados de la mision', () => {
    expect(
      derivePlayerMissionStatus(TEMPLO, { ...context, lastFinishedStatus: 'EXPIRED' }).status,
    ).toBe('AVAILABLE')
  })

  it('nombra varias misiones previas y usa el id de las que no estan en el catalogo', () => {
    expect(lockReasonFor(['a', 'b', 'c'], new Map([['a', 'Alfa']]))).toBe(
      'Completa primero «Alfa», «b» y «c».',
    )
    expect(lockReasonFor(['a', 'b'], new Map())).toBe('Completa primero «a» y «b».')
  })

  it('calcula los requisitos pendientes', () => {
    expect(missingPrerequisitesOf(CAMARA, new Set())).toEqual([TEMPLO.missionId])
  })

  it('assertPrerequisitesMet rechaza con MissionLockedError', () => {
    expect(() => {
      assertPrerequisitesMet(CAMARA, new Set(), NAMES)
    }).toThrow(MissionLockedError)
    expect(() => {
      assertPrerequisitesMet(TEMPLO, new Set(), NAMES)
    }).not.toThrow()
  })

  it('assertMissionNotInProgress y assertHeroFree solo rechazan con una matricula activa', () => {
    expect(() => {
      assertMissionNotInProgress(TEMPLO.missionId, pending())
    }).toThrow(MissionAlreadyInProgressError)
    expect(() => {
      assertHeroFree('heroe', pending())
    }).toThrow(HeroBusyError)
    expect(() => {
      assertMissionNotInProgress(TEMPLO.missionId, null)
    }).not.toThrow()
    expect(() => {
      assertHeroFree('heroe', null)
    }).not.toThrow()
  })

  it('el heroe ocupado en otra mision informa MISSION', () => {
    expect.assertions(1)
    try {
      assertHeroFree('heroe', pending())
    } catch (error: unknown) {
      expect(error).toMatchObject({
        busyWith: 'MISSION',
        message: 'Este héroe ya está en otra misión.',
      })
    }
  })
})
