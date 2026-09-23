import { sql, type Kysely, type NotNull } from 'kysely'

import type { AchievementEvidencePort } from '../../../application/ports/AchievementEvidencePort'
import {
  completedReportEvidenceOf,
  type CompletedReportEvidence,
  type DefeatedMasterEvidence,
} from '../../../domain/policies/AchievementPolicy'
import type { Database } from './schema'

/**
 * Evidencia de los logros de HU-76 en PostgreSQL. Solo lee tablas que escriben
 * HU-73 y HU-74 en el cierre de HU-72.
 *
 * Los reportes se leen con una proyeccion propia y tolerante: solo los cuatro
 * datos de la foto que usan los logros, sin interpretar la foto entera. Un
 * reporte de otra version no hace fallar la evaluacion ni la consulta, al
 * contrario que `PostgresReportRepository`, que la rechaza.
 */
export class PostgresAchievementEvidence implements AchievementEvidencePort {
  constructor(private readonly db: Kysely<Database>) {}

  async completedReportsOf(playerId: string): Promise<readonly CompletedReportEvidence[]> {
    const rows = await this.db
      .selectFrom('mission_reports')
      .select([
        'enrollment_id',
        'mission_id',
        'difficulty',
        'finished_at',
        'schema_version',
        sql`snapshot #> '{combatStats,damageTaken}'`.as('damage_taken'),
        sql`snapshot #> '{combatStats,encountersCompleted}'`.as('encounters_completed'),
        sql`snapshot #> '{combatStats,encountersTotal}'`.as('encounters_total'),
        sql`snapshot #> '{summary,simulatedDuration}'`.as('simulated_duration'),
      ])
      .where('player_id', '=', playerId)
      .where('outcome', '=', 'COMPLETED')
      .orderBy('finished_at')
      .orderBy('enrollment_id')
      .execute()

    return rows.map((row) =>
      completedReportEvidenceOf({
        enrollmentId: row.enrollment_id,
        missionId: row.mission_id,
        difficulty: row.difficulty,
        finishedAt: row.finished_at,
        schemaVersion: row.schema_version,
        damageTaken: row.damage_taken,
        simulatedDuration: row.simulated_duration,
        encountersCompleted: row.encounters_completed,
        encountersTotal: row.encounters_total,
      }),
    )
  }

  async defeatedMastersOf(playerId: string): Promise<readonly DefeatedMasterEvidence[]> {
    const rows = await this.db
      .selectFrom('mission_master_encounters as m')
      .innerJoin('mission_enrollments as e', 'e.enrollment_id', 'm.enrollment_id')
      .select(['m.enrollment_id', 'm.sequence', 'm.master_ref', 'm.epic_ref', 'm.grant_status'])
      .where('e.player_id', '=', playerId)
      .where('e.status', 'in', ['COMPLETED', 'FAILED'])
      .where('m.status', '=', 'APPEARED_DEFEATED')
      // Un Master derrotado siempre tiene nombre (CHECK de la 006); se filtra por el tipo.
      .where('m.master_ref', 'is not', null)
      .$narrowType<{ master_ref: NotNull }>()
      .orderBy('m.enrollment_id')
      .orderBy('m.sequence')
      .execute()

    return rows.map((row) => ({
      enrollmentId: row.enrollment_id,
      sequence: row.sequence,
      masterRef: row.master_ref,
      epicRef: row.epic_ref,
      grantStatus: row.grant_status,
    }))
  }
}
