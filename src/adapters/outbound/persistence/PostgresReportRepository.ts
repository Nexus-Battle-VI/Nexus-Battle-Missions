import type { Kysely, Selectable } from 'kysely'

import type { ReportRepositoryPort } from '../../../application/ports/ReportRepositoryPort'
import {
  REPORT_SCHEMA_VERSION,
  type MissionReport,
  type ReportRecord,
  type ReportRewardLine,
  type RewardStatus,
} from '../../../domain/entities/MissionReport'
import type { HeroProgressionSnapshot } from '../../../domain/value-objects/hero-progression'
import type { Database, MissionReportRewardsTable, MissionReportsTable } from './schema'

/**
 * La foto tal como se guarda en `snapshot` (jsonb): las fechas van en ISO-8601
 * y el jugador, en su columna.
 */
type ReportSnapshot = Omit<MissionReport, 'playerId' | 'summary' | 'generatedAt'> & {
  readonly summary: Omit<MissionReport['summary'], 'startedAt' | 'finishedAt'> & {
    readonly startedAt: string
    readonly finishedAt: string
  }
  readonly generatedAt: string
}

const snapshotOf = (report: MissionReport): ReportSnapshot => ({
  schemaVersion: report.schemaVersion,
  enrollmentId: report.enrollmentId,
  mission: report.mission,
  summary: {
    ...report.summary,
    startedAt: report.summary.startedAt.toISOString(),
    finishedAt: report.summary.finishedAt.toISOString(),
  },
  combatStats: report.combatStats,
  enemies: report.enemies,
  ...(report.loot === undefined ? {} : { loot: report.loot }),
  objectives: report.objectives,
  generatedAt: report.generatedAt.toISOString(),
})

/**
 * Solo se lee la version de la foto que este codigo sabe interpretar. Una foto
 * de otra version falla aqui, con un mensaje claro, en lugar de llegar a medias
 * a la respuesta o al historial.
 */
const reportOf = (row: Selectable<MissionReportsTable>): MissionReport => {
  if (row.schema_version !== REPORT_SCHEMA_VERSION) {
    throw new Error(
      `El reporte ${row.enrollment_id} tiene la version ${String(row.schema_version)}; ` +
        `este servicio solo lee la ${String(REPORT_SCHEMA_VERSION)}.`,
    )
  }

  const snapshot = row.snapshot as ReportSnapshot

  return {
    ...snapshot,
    playerId: row.player_id,
    summary: {
      ...snapshot.summary,
      startedAt: new Date(snapshot.summary.startedAt),
      finishedAt: new Date(snapshot.summary.finishedAt),
    },
    generatedAt: new Date(snapshot.generatedAt),
  }
}

/**
 * La progresion de una linea, tal como la dejo Player/Inventory (HU-09, Task
 * HU-09.5). Las cuatro columnas van juntas o ninguna -- lo garantiza un `check` de
 * la migracion 008 --, asi que una lectura parcial no existe.
 */
const progressionOf = (
  row: Selectable<MissionReportRewardsTable>,
): HeroProgressionSnapshot | null => {
  const {
    hero_level: level,
    hero_current_xp: currentXp,
    hero_max_level: maxLevel,
    levels_gained: levelsGained,
  } = row

  if (level === null || currentXp === null || maxLevel === null || levelsGained === null) {
    return null
  }

  return { level, currentXp, maxLevel, levelsGained }
}

const lineOf = (row: Selectable<MissionReportRewardsTable>): ReportRewardLine => ({
  lineNo: row.line_no,
  kind: row.kind,
  reference: row.reference,
  name: row.name,
  rarity: row.rarity,
  quantity: row.quantity,
  status: row.status,
  source: row.source,
  progression: progressionOf(row),
  updatedAt: row.updated_at,
})

/**
 * Escribe la foto y sus lineas. Lo llama el cierre de HU-72 DENTRO de su
 * transaccion (P-T1): una mision terminada sin reporte es imposible. Repetirlo
 * no cambia nada, porque la foto no se reemplaza.
 */
export const insertReport = async (
  db: Kysely<Database>,
  { report, rewards }: ReportRecord,
): Promise<void> => {
  const inserted = await db
    .insertInto('mission_reports')
    .values({
      enrollment_id: report.enrollmentId,
      player_id: report.playerId,
      mission_id: report.mission.missionId,
      category: report.mission.category,
      difficulty: report.mission.difficulty,
      outcome: report.summary.outcome,
      finished_at: report.summary.finishedAt,
      schema_version: report.schemaVersion,
      snapshot: JSON.stringify(snapshotOf(report)),
      generated_at: report.generatedAt,
    })
    .onConflict((conflict) => conflict.column('enrollment_id').doNothing())
    .returning('enrollment_id')
    .executeTakeFirst()

  if (inserted !== undefined && rewards.length > 0) {
    await db
      .insertInto('mission_report_rewards')
      .values(
        rewards.map((line) => ({
          enrollment_id: report.enrollmentId,
          line_no: line.lineNo,
          kind: line.kind,
          reference: line.reference,
          name: line.name,
          rarity: line.rarity,
          quantity: line.quantity,
          status: line.status,
          source: line.source,
          // Nacen nulas: la progresion del heroe solo se conoce cuando la entrega
          // se acredita (HU-09, Task HU-09.5).
          hero_level: line.progression?.level ?? null,
          hero_current_xp: line.progression?.currentXp ?? null,
          hero_max_level: line.progression?.maxLevel ?? null,
          levels_gained: line.progression?.levelsGained ?? null,
          updated_at: line.updatedAt,
        })),
      )
      .execute()
  }
}

/**
 * Reportes en PostgreSQL (HU-74). La foto no se actualiza nunca: un disparador
 * de la migracion 005 lo impide en el motor. Solo cambia el estado de las lineas
 * de recompensa.
 */
export class PostgresReportRepository implements ReportRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}

  async findByEnrollment(enrollmentId: string): Promise<ReportRecord | null> {
    const row = await this.db
      .selectFrom('mission_reports')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirst()

    if (row === undefined) {
      return null
    }

    const lines = await this.db
      .selectFrom('mission_report_rewards')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('line_no')
      .execute()

    return { report: reportOf(row), rewards: lines.map(lineOf) }
  }

  async listByPlayer(playerId: string): Promise<readonly ReportRecord[]> {
    const rows = await this.db
      .selectFrom('mission_reports')
      .selectAll()
      .where('player_id', '=', playerId)
      .orderBy('finished_at', 'desc')
      .orderBy('enrollment_id', 'desc')
      .execute()

    if (rows.length === 0) {
      return []
    }

    const lines = await this.db
      .selectFrom('mission_report_rewards')
      .selectAll()
      .where(
        'enrollment_id',
        'in',
        rows.map((row) => row.enrollment_id),
      )
      .orderBy('enrollment_id')
      .orderBy('line_no')
      .execute()
    const byReport = new Map<string, ReportRewardLine[]>()

    for (const line of lines) {
      byReport.set(line.enrollment_id, [...(byReport.get(line.enrollment_id) ?? []), lineOf(line)])
    }

    return rows.map((row) => ({
      report: reportOf(row),
      rewards: byReport.get(row.enrollment_id) ?? [],
    }))
  }

  async updateRewardStatus(
    enrollmentId: string,
    lineNo: number,
    status: RewardStatus,
    at: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('mission_report_rewards')
      .set({ status, updated_at: at })
      .where('enrollment_id', '=', enrollmentId)
      .where('line_no', '=', lineNo)
      .returning('line_no')
      .executeTakeFirst()

    return updated !== undefined
  }
}
