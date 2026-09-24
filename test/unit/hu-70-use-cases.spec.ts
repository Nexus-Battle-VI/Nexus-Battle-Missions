import { EXAMPLE_MISSIONS } from '../../src/adapters/outbound/persistence/example-missions'
import { InMemoryDifficultyClearRepository } from '../../src/adapters/outbound/persistence/InMemoryDifficultyClearRepository'
import { InMemoryEnrollmentRepository } from '../../src/adapters/outbound/persistence/InMemoryEnrollmentRepository'
import { InMemoryMissionCatalog } from '../../src/adapters/outbound/persistence/InMemoryMissionCatalog'
import { InMemoryStrategyRepository } from '../../src/adapters/outbound/persistence/InMemoryStrategyRepository'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { InsertPendingResult } from '../../src/application/ports/EnrollmentRepositoryPort'
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
import { GetMissionDetail } from '../../src/application/use-cases/GetMissionDetail'
import { ListMissionBoard } from '../../src/application/use-cases/ListMissionBoard'
import { ReconcilePendingEnrollments } from '../../src/application/use-cases/ReconcilePendingEnrollments'
import type { MissionDefinition } from '../../src/domain/entities/MissionDefinition'
import type { MissionEnrollment } from '../../src/domain/entities/MissionEnrollment'
import {
  EnrollmentExpiredError,
  EnrollmentPendingError,
  HeroBusyError,
  HeroNotOwnedError,
  HeroNotReadyError,
  IdempotencyKeyReusedError,
  LoadoutIncompleteError,
  MissionAlreadyInProgressError,
  MissionLockedError,
  MissionNotFoundError,
  StrategyVersionMismatchError,
} from '../../src/domain/errors/mission-errors'
import { ProgressionLockedError } from '../../src/domain/policies/DifficultyPolicy'
import { UnknownDifficultyError } from '../../src/domain/value-objects/difficulty-level'

const AT = new Date('2026-10-01T15:00:00.000Z')
const TEMPLO = 'msn_templo_olvidado'
const CAMARA = 'msn_camara_sellada'
const HERO = '7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60'
const HERO_2 = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
const KEY = '3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f'
const KEY_2 = '4c0a7d2f-9e3b-4a8c-8d5f-6b7c8d9e0f1a'

class FixedClock implements ClockPort {
  constructor(public current: Date) {}
  now(): Date {
    return this.current
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
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

/** Player/Inventory con respuestas guionizadas; por defecto concede. */
class ScriptedCommitments implements HeroCommitmentPort {
  readonly outcomes: (CommitHeroOutcome | Error)[] = []
  readonly requests: CommitHeroRequest[] = []
  readonly releases: string[] = []
  releaseResult: 'RELEASED' | 'UNKNOWN' = 'RELEASED'

  commit(request: CommitHeroRequest): Promise<CommitHeroOutcome> {
    this.requests.push(request)
    const next = this.outcomes.shift()

    if (next instanceof Error) {
      return Promise.reject(next)
    }

    return Promise.resolve(next ?? { kind: 'GRANTED', commitmentId: `cmt-${request.operationId}` })
  }

  release(operationId: string): Promise<'RELEASED' | 'UNKNOWN'> {
    this.releases.push(operationId)
    return Promise.resolve(this.releaseResult)
  }
}

const setup = (definitions: readonly MissionDefinition[] = EXAMPLE_MISSIONS) => {
  const catalog = new InMemoryMissionCatalog(definitions)
  const enrollments = new InMemoryEnrollmentRepository()
  const clears = new InMemoryDifficultyClearRepository()
  const commitments = new ScriptedCommitments()
  const clock = new FixedClock(AT)
  const enroll = new EnrollInMission(
    catalog,
    enrollments,
    clears,
    new InMemoryStrategyRepository(),
    commitments,
    new SequenceIds(),
    clock,
  )

  return {
    catalog,
    enrollments,
    clears,
    commitments,
    clock,
    enroll,
    board: new ListMissionBoard(catalog, enrollments, clears),
    detail: new GetMissionDetail(catalog, enrollments, clears),
    reconcile: new ReconcilePendingEnrollments(catalog, enrollments, commitments, clock),
  }
}

const command = (overrides: Partial<EnrollCommand> = {}): EnrollCommand => ({
  playerId: 'sub-1',
  missionId: TEMPLO,
  heroId: HERO,
  difficulty: 'NORMAL',
  strategyVersion: null,
  idempotencyKey: KEY,
  ...overrides,
})

const completeTemplo = async (clears: InMemoryDifficultyClearRepository, playerId = 'sub-1') =>
  clears.record({ playerId, missionId: TEMPLO, difficulty: 'NORMAL', completedAt: AT })

describe('EnrollInMission (Task HU-70.2)', () => {
  it('P-01: matricula en curso, heroe reservado y temporizador iniciado (CA-01)', async () => {
    const { enroll, commitments, enrollments } = setup()

    await expect(enroll.execute(command())).resolves.toEqual({
      enrollmentId: 'enr_1',
      missionId: TEMPLO,
      heroId: HERO,
      difficulty: 'NORMAL',
      status: 'IN_PROGRESS',
      startedAt: '2026-10-01T15:00:00.000Z',
      endsAt: '2026-10-02T03:00:00.000Z',
    })
    // requestedAt + 2 min + 12 h + 30 min.
    expect(commitments.requests).toEqual([
      {
        operationId: 'op-1',
        playerId: 'sub-1',
        heroId: HERO,
        reference: 'enr_1',
        expiresAt: new Date('2026-10-02T03:32:00.000Z'),
        requireCompleteLoadout: true,
      },
    ])
    expect(enrollments.recordedFacts().map((fact) => fact.type)).toEqual([
      'MissionEnrollmentStarted',
    ])
  })

  it('T-01: la misma clave devuelve la misma matricula sin reservar otra vez', async () => {
    const { enroll, commitments } = setup()
    const first = await enroll.execute(command())

    await expect(enroll.execute(command())).resolves.toEqual(first)
    expect(commitments.requests).toHaveLength(1)
  })

  it('la misma clave con otro cuerpo es IDEMPOTENCY_KEY_REUSED', async () => {
    const { enroll } = setup()
    await enroll.execute(command())

    await expect(enroll.execute(command({ heroId: HERO_2 }))).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    )
  })

  it('P-02: el heroe en otra mision activa no se matricula y no deja fila (CA-02)', async () => {
    const { enroll, clears, enrollments } = setup()
    await completeTemplo(clears)
    await enroll.execute(command())

    await expect(
      enroll.execute(command({ missionId: CAMARA, idempotencyKey: KEY_2 })),
    ).rejects.toMatchObject({ busyWith: 'MISSION' })
    expect(await enrollments.listByPlayer('sub-1')).toHaveLength(1)
  })

  it('una segunda matricula activa en la misma mision es MISSION_ALREADY_IN_PROGRESS', async () => {
    const { enroll } = setup()
    await enroll.execute(command())

    await expect(
      enroll.execute(command({ heroId: HERO_2, idempotencyKey: KEY_2 })),
    ).rejects.toBeInstanceOf(MissionAlreadyInProgressError)
  })

  it('P-07: una mision con requisitos pendientes es MISSION_LOCKED y no escribe nada (CA-07)', async () => {
    const { enroll, enrollments, commitments } = setup()

    await expect(enroll.execute(command({ missionId: CAMARA }))).rejects.toMatchObject({
      missingPrerequisites: [TEMPLO],
      message: 'Completa primero «El Templo Olvidado».',
    })
    expect(await enrollments.listByPlayer('sub-1')).toHaveLength(0)
    expect(commitments.requests).toHaveLength(0)
  })

  it('T-04: con la mision bloqueada y el heroe ocupado gana la mision', async () => {
    const { enroll } = setup()
    await enroll.execute(command())

    await expect(
      enroll.execute(command({ missionId: CAMARA, idempotencyKey: KEY_2 })),
    ).rejects.toBeInstanceOf(MissionLockedError)
  })

  it('una mision inexistente es MISSION_NOT_FOUND', async () => {
    await expect(setup().enroll.execute(command({ missionId: 'msn_x' }))).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
  })

  it('una dificultad desconocida es UNKNOWN_DIFFICULTY, antes que cualquier otra cosa', async () => {
    await expect(
      setup().enroll.execute(command({ missionId: 'msn_x', difficulty: 'EXTREMO' })),
    ).rejects.toBeInstanceOf(UnknownDifficultyError)
  })

  it('sin el clear del nivel anterior es PROGRESSION_LOCKED (HU-75)', async () => {
    await expect(setup().enroll.execute(command({ difficulty: 'HEROIC' }))).rejects.toBeInstanceOf(
      ProgressionLockedError,
    )
  })

  // Matriz de aislamiento de HU-75, caso «matricula sin terminar»: matricularse
  // no crea un clear; solo lo registra HU-72 al terminar con exito.
  it('una matricula en curso en Normal no desbloquea Heroico', async () => {
    const { enroll, clears } = setup()
    await enroll.execute(command())

    expect([...(await clears.clearedLevels('sub-1', TEMPLO))]).toEqual([])
    await expect(
      enroll.execute(command({ difficulty: 'HEROIC', heroId: HERO_2, idempotencyKey: KEY_2 })),
    ).rejects.toBeInstanceOf(ProgressionLockedError)
  })

  it('pedir una version de estrategia sin estrategias guardadas es STRATEGY_VERSION_MISMATCH', async () => {
    await expect(setup().enroll.execute(command({ strategyVersion: 1 }))).rejects.toMatchObject({
      expectedVersion: 1,
      currentVersion: null,
    })
    await expect(setup().enroll.execute(command({ strategyVersion: 1 }))).rejects.toBeInstanceOf(
      StrategyVersionMismatchError,
    )
  })

  it('P-03: el heroe en un torneo activo es HERO_BUSY con busyWith TOURNAMENT (CA-03)', async () => {
    const { enroll, commitments, enrollments } = setup()
    commitments.outcomes.push({
      kind: 'REJECTED',
      rejection: { code: 'HERO_COMMITTED', busyWith: 'TOURNAMENT' },
    })

    await expect(enroll.execute(command())).rejects.toMatchObject({ busyWith: 'TOURNAMENT' })
    expect((await enrollments.findById('enr_1'))?.status).toBe('REJECTED')
    // La misma clave repite el mismo rechazo sin volver a preguntar.
    await expect(enroll.execute(command())).rejects.toBeInstanceOf(HeroBusyError)
    expect(commitments.requests).toHaveLength(1)
  })

  it.each([
    [
      'P-04: mazo incompleto (CA-04)',
      { code: 'LOADOUT_INCOMPLETE', missingSlots: [{ family: 'WEAPON', missing: 1 }] } as const,
      LoadoutIncompleteError,
    ],
    [
      'heroe no listo',
      { code: 'HERO_NOT_READY', blockers: [{ code: 'HERO_NOT_ACTIVE', slot: null }] } as const,
      HeroNotReadyError,
    ],
    ['heroe ajeno', { code: 'HERO_NOT_OWNED' } as const, HeroNotOwnedError],
  ])('%s se rechaza y queda guardado', async (_caso, rejection, errorType) => {
    const { enroll, commitments } = setup()
    commitments.outcomes.push({ kind: 'REJECTED', rejection })

    await expect(enroll.execute(command())).rejects.toBeInstanceOf(errorType)
    await expect(enroll.execute(command())).rejects.toBeInstanceOf(errorType)
  })

  it('T-03: sin respuesta de Player/Inventory queda PENDING y responde 503', async () => {
    const { enroll, commitments, enrollments } = setup()
    commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })

    await expect(enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentPendingError)
    expect((await enrollments.findById('enr_1'))?.status).toBe('PENDING')
    await expect(enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentPendingError)
  })

  it('una clave cuya matricula caduco responde ENROLLMENT_EXPIRED', async () => {
    const { enroll, commitments, reconcile, clock } = setup()
    commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await expect(enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentPendingError)

    clock.advance(3 * 60_000)
    commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await expect(reconcile.execute()).resolves.toMatchObject({ expired: 1 })

    await expect(enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentExpiredError)
  })

  describe('conflictos que resuelve el motor', () => {
    const withConflict = (reason: 'HERO_ACTIVE' | 'PLAYER_MISSION_ACTIVE' | 'IDEMPOTENCY_KEY') => {
      const context = setup()
      context.enrollments.insertPending = (): Promise<InsertPendingResult> =>
        Promise.resolve({ kind: 'CONFLICT', reason })

      return context
    }

    it('HERO_ACTIVE es HERO_BUSY', async () => {
      await expect(withConflict('HERO_ACTIVE').enroll.execute(command())).rejects.toBeInstanceOf(
        HeroBusyError,
      )
    })

    it('PLAYER_MISSION_ACTIVE es MISSION_ALREADY_IN_PROGRESS; sin matricula visible, con enrollmentId null', async () => {
      const failure = withConflict('PLAYER_MISSION_ACTIVE').enroll.execute(command())

      await expect(failure).rejects.toBeInstanceOf(MissionAlreadyInProgressError)
      await expect(failure).rejects.toMatchObject({ enrollmentId: null })
    })

    it('IDEMPOTENCY_KEY sin matricula visible no inventa un resultado', async () => {
      const failure = withConflict('IDEMPOTENCY_KEY').enroll.execute(command())

      await expect(failure).rejects.toThrow('La clave de idempotencia choco')
      await expect(failure).rejects.not.toBeInstanceOf(IdempotencyKeyReusedError)
    })

    // El reintento simultaneo de una pulsacion viola la clave, el heroe y la
    // mision a la vez, y el motor puede informar cualquiera de las tres.
    it.each(['HERO_ACTIVE', 'PLAYER_MISSION_ACTIVE', 'IDEMPOTENCY_KEY'] as const)(
      'con %s, la misma clave repite la matricula ganadora',
      async (reason) => {
        const { enroll, enrollments } = withConflict(reason)
        const winner = await buildInProgress()
        let lookups = 0
        // Antes de insertar no hay nada; tras el conflicto aparece la ganadora.
        enrollments.findByIdempotencyKey = (): Promise<MissionEnrollment | null> => {
          lookups += 1
          return Promise.resolve(lookups === 1 ? null : winner)
        }

        await expect(enroll.execute(command())).resolves.toMatchObject({
          enrollmentId: winner.enrollmentId,
          status: 'IN_PROGRESS',
        })
      },
    )
  })

  describe('la misma clave llega mientras la primera peticion guarda', () => {
    // La busqueda por clave de la segunda peticion corre antes de que la primera
    // guarde; las comprobaciones siguientes ya ven la matricula de la primera.
    const withLateKey = (context: ReturnType<typeof setup>) => {
      const findByKey = context.enrollments.findByIdempotencyKey.bind(context.enrollments)
      let lookups = 0
      context.enrollments.findByIdempotencyKey = (
        playerId: string,
        key: string,
      ): Promise<MissionEnrollment | null> => {
        lookups += 1
        return lookups === 1 ? Promise.resolve(null) : findByKey(playerId, key)
      }
    }

    it('repite la matricula en lugar de responder MISSION_ALREADY_IN_PROGRESS', async () => {
      const context = setup()
      const first = await context.enroll.execute(command())
      withLateKey(context)

      await expect(context.enroll.execute(command())).resolves.toEqual(first)
    })

    it('para otra mision con el mismo heroe es IDEMPOTENCY_KEY_REUSED, no HERO_BUSY', async () => {
      const context = setup()
      await completeTemplo(context.clears)
      await context.enroll.execute(command())
      withLateKey(context)

      await expect(context.enroll.execute(command({ missionId: CAMARA }))).rejects.toBeInstanceOf(
        IdempotencyKeyReusedError,
      )
    })
  })

  it('si otro proceso ya confirmo la matricula, responde con la confirmada', async () => {
    const { enroll, enrollments } = setup()
    enrollments.saveTransition = (): Promise<boolean> => Promise.resolve(false)
    const confirmed: MissionEnrollment = {
      ...(await buildInProgress()),
      enrollmentId: 'enr_1',
    }
    enrollments.findById = (): Promise<MissionEnrollment | null> => Promise.resolve(confirmed)

    await expect(enroll.execute(command())).resolves.toMatchObject({ status: 'IN_PROGRESS' })
  })

  it('si la matricula desaparece en la carrera, queda sin confirmar', async () => {
    const { enroll, enrollments } = setup()
    enrollments.saveTransition = (): Promise<boolean> => Promise.resolve(false)
    enrollments.findById = (): Promise<MissionEnrollment | null> => Promise.resolve(null)

    await expect(enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentPendingError)
  })
})

/** Matricula en curso real, construida por el propio caso de uso. */
const buildInProgress = async (): Promise<MissionEnrollment> => {
  const { enroll, enrollments } = setup()
  const view = await enroll.execute(command())

  return (await enrollments.findById(view.enrollmentId))!
}

describe('ListMissionBoard (Task HU-70.2)', () => {
  it('deriva el estado de cada mision para el jugador', async () => {
    const { board } = setup()
    const { items } = await board.execute('sub-1', { category: null, status: null })

    expect(items.map((card) => [card.missionId, card.playerStatus, card.canEnroll])).toEqual([
      [TEMPLO, 'AVAILABLE', true],
      [CAMARA, 'LOCKED', false],
    ])
    expect(items[0]).toMatchObject({ estimatedDuration: 'PT12H', recommendedPower: 15 })
    expect(items[1]?.lockReason).toBe('Completa primero «El Templo Olvidado».')
  })

  it('una matricula activa deja la mision EN CURSO con su id', async () => {
    const { board, enroll } = setup()
    await enroll.execute(command())

    const templo = (await board.execute('sub-1', { category: null, status: null })).items[0]

    expect(templo).toMatchObject({ playerStatus: 'IN_PROGRESS', activeEnrollmentId: 'enr_1' })
  })

  it('el estado es de cada jugador', async () => {
    const { board, enroll } = setup()
    await enroll.execute(command())

    expect(
      (await board.execute('sub-2', { category: null, status: null })).items[0]?.playerStatus,
    ).toBe('AVAILABLE')
  })

  it('filtra por categoria y por estado', async () => {
    const { board } = setup()

    expect((await board.execute('sub-1', { category: 'EXPLORATION', status: null })).items).toEqual(
      [],
    )
    expect(
      (await board.execute('sub-1', { category: 'STORY', status: 'LOCKED' })).items.map(
        (card) => card.missionId,
      ),
    ).toEqual([CAMARA])
  })

  it('muestra el resultado de la ultima matricula terminada', async () => {
    const { board, enrollments } = setup()
    const base = await buildInProgress()
    await enrollments.insertPending({
      ...base,
      enrollmentId: 'enr_a',
      idempotencyKey: 'a',
      status: 'COMPLETED',
      finishedAt: new Date('2026-10-02T03:00:00.000Z'),
    })
    await enrollments.insertPending({
      ...base,
      enrollmentId: 'enr_b',
      idempotencyKey: 'b',
      status: 'FAILED',
      finishedAt: new Date('2026-10-05T03:00:00.000Z'),
    })
    await enrollments.insertPending({
      ...base,
      enrollmentId: 'enr_c',
      idempotencyKey: 'c',
      status: 'EXPIRED',
      finishedAt: new Date('2026-10-06T03:00:00.000Z'),
    })

    expect(
      (await board.execute('sub-1', { category: null, status: null })).items[0]?.playerStatus,
    ).toBe('FAILED')
  })
})

describe('GetMissionDetail (Task HU-70.2)', () => {
  it('P-06: trae todos los bloques que exige CA-06', async () => {
    const detail = await setup().detail.execute('sub-1', TEMPLO)

    expect(detail).toMatchObject({
      missionId: TEMPLO,
      estimatedDuration: 'PT12H',
      prerequisites: [],
      finalBoss: { name: 'El Guardián Eterno', stats: { health: 100 } },
      masterEncounter: {
        probability: 0.15,
        // P-J2: sin producto en Catalog la epica no se promete; el Master aparece igual.
        candidates: [{ name: 'Sombra del Olvido', epic: null }],
      },
      playerStatus: 'AVAILABLE',
      canEnroll: true,
    })
    expect(detail.objectives).toHaveLength(5)
    expect(detail.enemies).toHaveLength(3)
    // Las referencias internas para Combat no salen al jugador.
    expect(detail.enemies[0]).toEqual({
      name: 'Sombras Corrompidas',
      count: 10,
      description: 'Enemigos básicos con ataque moderado.',
    })
    expect(detail.finalBoss).not.toHaveProperty('enemyRef')
    // P-J2: solo lo que se entrega. El contenido de ejemplo no enlaza productos, y los
    // creditos, el cofre y el titulo son texto que nadie entrega todavia (HU-10).
    expect(detail.rewards).toEqual({
      experience: true,
      guaranteed: [],
      potential: [],
      objectiveBonuses: [],
      firstTime: [],
    })
  })

  it('P-J2: con productos enlazados promete la epica y el botin, con su probabilidad', async () => {
    const base = EXAMPLE_MISSIONS[0]!
    const master = base.masterEncounter!
    const linked = {
      ...base,
      finalBoss: {
        ...base.finalBoss,
        drops: (base.finalBoss.drops ?? []).map((drop, index) => ({
          ...drop,
          productId: index < 2 ? `1111111${String(index)}-1111-4111-8111-111111111111` : null,
        })),
      },
      masterEncounter: {
        ...master,
        candidates: master.candidates.map((candidate) => ({
          ...candidate,
          epic: { ...candidate.epic, productId: '22222222-2222-4222-8222-222222222222' },
        })),
      },
    }
    const detail = await setup([linked]).detail.execute('sub-1', TEMPLO)

    expect(detail.masterEncounter.candidates[0]?.epic).toMatchObject({ name: 'Velo de Sombras' })
    expect(detail.rewards.potential).toEqual([
      { label: 'Fragmento del Sello Antiguo', probability: 0.6, rolls: 3 },
      { label: 'Armadura «Piel del Guardián»', probability: 0.2, rolls: 1 },
    ])
  })

  it('una mision sin Master muestra probabilidad 0 y ningun candidato', async () => {
    expect((await setup().detail.execute('sub-1', CAMARA)).masterEncounter).toEqual({
      probability: 0,
      candidates: [],
    })
  })

  it('una mision inexistente o inactiva es MISSION_NOT_FOUND', async () => {
    const inactive = { ...EXAMPLE_MISSIONS[0]!, active: false }

    await expect(setup().detail.execute('sub-1', 'msn_x')).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
    await expect(setup([inactive]).detail.execute('sub-1', TEMPLO)).rejects.toBeInstanceOf(
      MissionNotFoundError,
    )
  })
})

describe('ReconcilePendingEnrollments (Task HU-70.2)', () => {
  const leavePending = async (context: ReturnType<typeof setup>) => {
    context.commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    await expect(context.enroll.execute(command())).rejects.toBeInstanceOf(EnrollmentPendingError)
  }

  it('confirma con el mismo operationId y el mismo cuerpo', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(11_000)

    await expect(context.reconcile.execute()).resolves.toMatchObject({ confirmed: 1 })
    expect((await context.enrollments.findById('enr_1'))?.status).toBe('IN_PROGRESS')
    expect(context.commitments.requests[1]).toEqual(context.commitments.requests[0])
  })

  it('no toca matriculas recientes: su peticion puede estar resolviendolas', async () => {
    const context = setup()
    await leavePending(context)

    await expect(context.reconcile.execute()).resolves.toMatchObject({
      confirmed: 0,
      stillPending: 0,
    })
  })

  it('registra un rechazo terminal', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(11_000)
    context.commitments.outcomes.push({ kind: 'REJECTED', rejection: { code: 'HERO_NOT_OWNED' } })

    await expect(context.reconcile.execute()).resolves.toMatchObject({ rejected: 1 })
  })

  it('antes del plazo, sin respuesta, sigue PENDING y no libera', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(30_000)
    context.commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })

    await expect(context.reconcile.execute()).resolves.toMatchObject({ stillPending: 1 })
    expect(context.commitments.releases).toEqual([])
  })

  it('pasado el plazo libera por operationId y marca EXPIRED', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(3 * 60_000)
    context.commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })

    await expect(context.reconcile.execute()).resolves.toMatchObject({ expired: 1 })
    expect(context.commitments.releases).toEqual(['op-1'])
    expect((await context.enrollments.findById('enr_1'))?.status).toBe('EXPIRED')
  })

  it('sin liberacion confirmada no marca EXPIRED', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(3 * 60_000)
    context.commitments.outcomes.push({ kind: 'UNKNOWN', reason: 'HTTP_503' })
    context.commitments.releaseResult = 'UNKNOWN'

    await expect(context.reconcile.execute()).resolves.toMatchObject({ stillPending: 1 })
    expect((await context.enrollments.findById('enr_1'))?.status).toBe('PENDING')
  })

  it('una mision retirada del catalogo solo se compensa al vencer el plazo', async () => {
    const context = setup()
    await leavePending(context)
    const withoutCatalog = new ReconcilePendingEnrollments(
      new InMemoryMissionCatalog([]),
      context.enrollments,
      context.commitments,
      context.clock,
    )
    context.clock.advance(11_000)
    await expect(withoutCatalog.execute()).resolves.toMatchObject({ stillPending: 1 })

    context.clock.advance(3 * 60_000)
    await expect(withoutCatalog.execute()).resolves.toMatchObject({ expired: 1 })
  })

  it('un fallo no detiene el ciclo', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(11_000)
    context.commitments.outcomes.push(new Error('socket hang up'))

    await expect(context.reconcile.execute()).resolves.toMatchObject({ failed: 1 })
  })

  it('si otro proceso gano la carrera, la deja como este', async () => {
    const context = setup()
    await leavePending(context)
    context.clock.advance(11_000)
    context.enrollments.saveTransition = (): Promise<boolean> => Promise.resolve(false)

    await expect(context.reconcile.execute()).resolves.toMatchObject({ stillPending: 1 })
  })
})
