import type { MissionBoss, MissionDefinition } from '../../domain/entities/MissionDefinition'
import { closeEnrollment, type MissionEnrollment } from '../../domain/entities/MissionEnrollment'
import {
  markHeroReleased,
  queueExecution,
  recordSimulation,
  requestSimulation,
  retryLater,
  settleExecution,
  voidedSettlement,
  voidExecution,
  type MissionExecution,
  type SimulationRequest,
} from '../../domain/entities/MissionExecution'
import { scalingOf } from '../../domain/value-objects/difficulty-scaling'
import { toIsoDuration } from '../../domain/value-objects/mission-category'
import type { ReportRecord, ReportRewardLine } from '../../domain/entities/MissionReport'
import {
  epicRewardsOf,
  heroSubtypeOf,
  masterConfigProblem,
  masterEncounterRecordsOf,
  simulationMasterOf,
} from '../../domain/policies/MasterPolicy'
import { missionReportOf, type ReportInput } from '../../domain/policies/ReportPolicy'
import {
  missionSettledFact,
  settlementOf,
  simulationFactsOf,
} from '../../domain/policies/SettlementPolicy'
import type { ClockPort } from '../ports/ClockPort'
import type { CombatSimulationPort } from '../ports/CombatSimulationPort'
import type { EnrollmentRepositoryPort } from '../ports/EnrollmentRepositoryPort'
import type { ExecutionRepositoryPort } from '../ports/ExecutionRepositoryPort'
import type { HeroProfilePort } from '../ports/HeroAbilitiesPort'
import type { HeroCommitmentPort } from '../ports/HeroCommitmentPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { MissionCatalogPort } from '../ports/MissionCatalogPort'

export interface ExecutionCycleSummary {
  readonly queued: number
  readonly simulated: number
  readonly retried: number
  readonly settled: number
  readonly voided: number
  readonly released: number
  readonly failed: number
}

type Tally = { -readonly [K in keyof ExecutionCycleSummary]: number }

const newTally = (): Tally => ({
  queued: 0,
  simulated: 0,
  retried: 0,
  settled: 0,
  voided: 0,
  released: 0,
  failed: 0,
})

export interface ExecutionOptions {
  readonly batchSize: number
  /** Un fallo en una mision no detiene a las demas; se informa aqui. */
  readonly onError?: (enrollmentId: string, error: unknown) => void
}

const MINUTE_MS = 60_000

/** El jefe con lo que da el contenido; lo que el curso no da queda en `null`. */
const bossProfileOf = (boss: MissionBoss): Readonly<Record<string, unknown>> =>
  boss.profile ?? {
    subtype: boss.heroType,
    maxHealth: boss.stats.health ?? null,
    attack: boss.stats.attack ?? null,
    defense: boss.stats.defense ?? null,
    damage: boss.stats.damage ?? null,
    abilities: null,
  }

/**
 * Solicitud a Combat con lo que Missions tiene congelado (P-S4): la duracion y
 * las rotaciones de la matricula, la dificultad de HU-75 y los encuentros del
 * contenido. El bloque `master` lleva la probabilidad ya resuelta para el
 * subtipo del heroe (HU-73, P-X2).
 */
export const simulationRequestFor = (
  execution: MissionExecution,
  enrollment: MissionEnrollment,
  definition: MissionDefinition,
  heroProfile: Readonly<Record<string, unknown>>,
): SimulationRequest => {
  if (enrollment.startedAt === null || enrollment.endsAt === null) {
    throw new Error(`La matricula ${enrollment.enrollmentId} no tiene inicio y fin.`)
  }

  const enemiesByRef = new Map(definition.enemies.map((enemy) => [enemy.enemyRef, enemy]))
  const boss = definition.finalBoss

  return {
    schemaVersion: 1,
    operationId: execution.operationId,
    enrollmentId: enrollment.enrollmentId,
    missionId: enrollment.missionId,
    difficulty: enrollment.difficulty,
    enemyStatMultiplier:
      definition.combatRules?.difficultyMultipliers?.[enrollment.difficulty] ??
      scalingOf(enrollment.difficulty).enemyStatMultiplier,
    timeBudget: toIsoDuration(
      (enrollment.endsAt.getTime() - enrollment.startedAt.getTime()) / MINUTE_MS,
    ),
    hero: { heroId: enrollment.heroId, profile: heroProfile },
    strategy: {
      version: enrollment.strategyVersion,
      rotations: enrollment.rotations,
      fallback: 'BASIC_ATTACK',
    },
    encounters: definition.encounters.map((encounter) => ({
      index: encounter.index,
      kind: encounter.kind,
      powerStep: encounter.powerStep,
      enemies: encounter.enemies.map(({ enemyRef, count }) =>
        enemyRef === boss.enemyRef
          ? { enemyRef, name: boss.name, count, profile: bossProfileOf(boss) }
          : {
              enemyRef,
              name: enemiesByRef.get(enemyRef)?.name ?? enemyRef,
              count,
              profile: enemiesByRef.get(enemyRef)?.profile ?? null,
            },
      ),
    })),
    ...(definition.combatRules === undefined ? {} : { rules: definition.combatRules }),
    ...(definition.finalBoss.drops === undefined ? {} : { bossDrops: definition.finalBoss.drops }),
    contentSnapshot: definition,
    master:
      definition.masterEncounter === null
        ? null
        : simulationMasterOf(definition.masterEncounter, heroSubtypeOf(heroProfile)),
  }
}

/**
 * Orquestacion asincrona de HU-72 (Task HU-72.2, CU-72.1 a CU-72.3). Cada ciclo,
 * en el orden del diseno:
 *
 * 1. programa las misiones iniciadas (hecho `MissionEnrollmentStarted`);
 * 2. pide a Combat las simulaciones que tocan, con reintentos del mismo
 *    `operationId`, y anula las que Combat rechaza o superan el plazo;
 * 3. cierra las que llegaron a `endsAt`, en una sola transaccion;
 * 4. libera a los heroes de las misiones cerradas, una sola vez (P-S10).
 *
 * Missions no simula, no genera aleatoriedad y no decide acciones de la IA.
 */
export class RunMissionExecutions {
  constructor(
    private readonly executions: ExecutionRepositoryPort,
    private readonly enrollments: EnrollmentRepositoryPort,
    private readonly catalog: MissionCatalogPort,
    private readonly heroes: HeroProfilePort,
    private readonly combat: CombatSimulationPort,
    private readonly commitments: HeroCommitmentPort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly options: ExecutionOptions = { batchSize: 50 },
  ) {}

  async run(): Promise<ExecutionCycleSummary> {
    const tally = newTally()

    await this.queueStarted(tally)
    await this.simulateDue(tally)
    await this.closeDue(tally)
    await this.releaseHeroes(tally)

    return { ...tally }
  }

  async queueStarted(tally: Tally = newTally()): Promise<ExecutionCycleSummary> {
    for (const start of await this.executions.pendingStarts(this.options.batchSize)) {
      await this.guarded(start.enrollmentId, tally, async () => {
        const enrollment = await this.requireEnrollment(start.enrollmentId)

        if (enrollment.endsAt === null) {
          throw new Error(`La matricula ${enrollment.enrollmentId} empezo sin fin.`)
        }

        await this.executions.queue(
          queueExecution({
            enrollmentId: enrollment.enrollmentId,
            operationId: this.ids.newOperationId(),
            endsAt: enrollment.endsAt,
            now: this.clock.now(),
          }),
          start.factId,
        )
        tally.queued += 1
      })
    }

    return { ...tally }
  }

  async simulateDue(tally: Tally = newTally()): Promise<ExecutionCycleSummary> {
    for (const execution of await this.executions.due(this.clock.now(), this.options.batchSize)) {
      await this.guarded(execution.enrollmentId, tally, () => this.simulate(execution, tally))
    }

    return { ...tally }
  }

  async closeDue(tally: Tally = newTally()): Promise<ExecutionCycleSummary> {
    for (const execution of await this.executions.closable(
      this.clock.now(),
      this.options.batchSize,
    )) {
      await this.guarded(execution.enrollmentId, tally, () => this.close(execution, tally))
    }

    return { ...tally }
  }

  async releaseHeroes(tally: Tally = newTally()): Promise<ExecutionCycleSummary> {
    for (const execution of await this.executions.awaitingRelease(this.options.batchSize)) {
      await this.guarded(execution.enrollmentId, tally, async () => {
        const enrollment = await this.requireEnrollment(execution.enrollmentId)

        // El `operationId` es el del compromiso de HU-70, no el de la simulacion.
        if ((await this.commitments.release(enrollment.operationId)) !== 'RELEASED') {
          return
        }

        if (
          await this.executions.saveTransition(
            markHeroReleased(execution, this.clock.now()),
            execution.version,
          )
        ) {
          tally.released += 1
        }
      })
    }

    return { ...tally }
  }

  private async simulate(execution: MissionExecution, tally: Tally): Promise<void> {
    const enrollment = await this.requireEnrollment(execution.enrollmentId)

    if (this.clock.now().getTime() > execution.deadlineAt.getTime()) {
      await this.voidMission(execution, enrollment, 'SIMULATION_TIMEOUT', tally)
      return
    }

    const request = execution.request ?? (await this.buildRequest(execution, enrollment, tally))

    if (request === null) {
      return
    }

    const requested = requestSimulation(execution, request, this.clock.now())

    // Otro proceso ya la tomo: su llamada lleva el mismo operationId.
    if (!(await this.executions.saveTransition(requested, execution.version))) {
      return
    }

    const outcome = await this.combat.simulate(request)

    switch (outcome.kind) {
      case 'SIMULATED':
        if (
          await this.executions.saveTransition(
            recordSimulation(requested, outcome.result, this.clock.now()),
            requested.version,
          )
        ) {
          tally.simulated += 1
        }
        return
      case 'REJECTED':
        await this.voidMission(requested, enrollment, outcome.code, tally)
        return
      case 'UNKNOWN':
        if (
          await this.executions.saveTransition(
            retryLater(requested, outcome.reason, this.clock.now()),
            requested.version,
          )
        ) {
          tally.retried += 1
        }
    }
  }

  /** La solicitud se arma una vez; sin el perfil del heroe se espera, y un heroe ajeno anula. */
  private async buildRequest(
    execution: MissionExecution,
    enrollment: MissionEnrollment,
    tally: Tally,
  ): Promise<SimulationRequest | null> {
    const definition = await this.catalog.findById(enrollment.missionId)

    if (definition === null) {
      await this.voidMission(execution, enrollment, 'MISSION_NOT_FOUND', tally)
      return null
    }

    // HU-73 (P-X5): un Master mal configurado no llega a Combat.
    if (
      definition.masterEncounter !== null &&
      masterConfigProblem(definition.masterEncounter, definition.encounters.length) !== null
    ) {
      await this.voidMission(execution, enrollment, 'INVALID_MASTER_CONFIG', tally)
      return null
    }

    const hero = await this.heroes.profileOf(enrollment.playerId, enrollment.heroId)

    switch (hero.kind) {
      case 'UNKNOWN':
        if (
          await this.executions.saveTransition(
            retryLater(execution, `HERO_PROFILE_${hero.reason}`, this.clock.now()),
            execution.version,
          )
        ) {
          tally.retried += 1
        }
        return null
      case 'NOT_OWNED':
        await this.voidMission(execution, enrollment, 'HERO_NOT_OWNED', tally)
        return null
      case 'FOUND':
        return simulationRequestFor(execution, enrollment, definition, hero.profile)
    }
  }

  /** CU-72.2: se evaluan los objetivos y se cierra todo en una transaccion. */
  private async close(execution: MissionExecution, tally: Tally): Promise<void> {
    const enrollment = await this.requireEnrollment(execution.enrollmentId)
    const definition =
      execution.request?.contentSnapshot ?? (await this.catalog.findById(enrollment.missionId))
    const result = execution.result
    const facts = simulationFactsOf(result?.summary)

    // Sin contenido o sin hechos no hay con que decidir. Fallar en cada ciclo
    // dejaria al heroe reservado para siempre: se anula, sin penalizacion.
    if (definition === null) {
      await this.voidMission(execution, enrollment, 'MISSION_NOT_FOUND', tally)
      return
    }

    // HU-73: la evidencia del Master tiene que cuadrar con lo que se envio.
    const evidence =
      result === null || facts === null
        ? null
        : masterEncounterRecordsOf({
            enrollmentId: enrollment.enrollmentId,
            config: definition.masterEncounter,
            sent: execution.request?.master ?? null,
            summary: result.summary,
            facts,
          })

    if (result === null || facts === null || evidence === null) {
      await this.voidMission(execution, enrollment, 'INVALID_SIMULATION_RESULT', tally)
      return
    }

    const now = this.clock.now()
    const settlement = settlementOf(result.combatOutcome, definition.objectives, facts)
    const epics = epicRewardsOf(evidence, definition.masterEncounter, now)
    const closed = await this.executions.close({
      enrollment: closeEnrollment(enrollment, settlement.outcome, now),
      enrollmentVersion: enrollment.version,
      execution: settleExecution(execution, settlement, now),
      executionVersion: execution.version,
      // HU-75: solo un exito desbloquea el nivel siguiente (propuesta P-D1).
      clear:
        settlement.outcome === 'COMPLETED'
          ? {
              playerId: enrollment.playerId,
              missionId: enrollment.missionId,
              difficulty: enrollment.difficulty,
              completedAt: now,
            }
          : null,
      fact: missionSettledFact(enrollment, settlement, result.simulationId, now, epics.records),
      // HU-73: la evidencia del Master y las entregas pendientes de sus epicas.
      masters: epics.records,
      report: this.reportFor(
        {
          enrollment,
          definition,
          result,
          settlement,
          heroProfile: execution.request?.hero.profile ?? null,
          masters: epics.records,
          generatedAt: now,
        },
        epics.rewards,
      ),
    })

    if (closed) {
      tally.settled += 1
    }
  }

  /**
   * HU-74 (P-T1): el reporte nace en la misma transaccion del cierre. Por ahora
   * solo HU-73 aporta lineas (la epica de cada Master derrotado); las de
   * creditos, productos y experiencia las calculara HU-10.
   *
   * Si la foto no se puede armar, la mision se cierra igual y el fallo se
   * informa: queda en el historial sin reporte, que es mejor que un heroe
   * reservado para siempre por un cierre que falla en cada ciclo.
   */
  private reportFor(input: ReportInput, rewards: readonly ReportRewardLine[]): ReportRecord | null {
    try {
      return { report: missionReportOf(input), rewards }
    } catch (error: unknown) {
      this.options.onError?.(input.enrollment.enrollmentId, error)
      return null
    }
  }

  /** CU-72.3: anulacion tecnica, sin penalizacion, sin clear y sin recompensas. */
  private async voidMission(
    execution: MissionExecution,
    enrollment: MissionEnrollment,
    reason: string,
    tally: Tally,
  ): Promise<void> {
    const now = this.clock.now()
    const closed = await this.executions.close({
      enrollment: closeEnrollment(enrollment, 'VOIDED', now),
      enrollmentVersion: enrollment.version,
      execution: voidExecution(execution, reason, now),
      executionVersion: execution.version,
      clear: null,
      // Si Combat llego a simular, su referencia queda para auditoria.
      fact: missionSettledFact(
        enrollment,
        voidedSettlement(reason),
        execution.result?.simulationId ?? null,
        now,
      ),
      // Una anulacion no deja evidencia del Master ni epica (P-X6).
      masters: [],
      // HU-74 (P-T3): una anulacion aparece en el historial sin reporte.
      report: null,
    })

    if (closed) {
      tally.voided += 1
    }
  }

  private async requireEnrollment(enrollmentId: string): Promise<MissionEnrollment> {
    const enrollment = await this.enrollments.findById(enrollmentId)

    if (enrollment === null) {
      throw new Error(`La matricula ${enrollmentId} no existe.`)
    }

    return enrollment
  }

  private async guarded(enrollmentId: string, tally: Tally, work: () => Promise<void>) {
    try {
      await work()
    } catch (error: unknown) {
      tally.failed += 1
      this.options.onError?.(enrollmentId, error)
    }
  }
}

export const RUN_MISSION_EXECUTIONS = Symbol('RunMissionExecutions')
