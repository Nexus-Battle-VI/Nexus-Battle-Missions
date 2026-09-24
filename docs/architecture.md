# Arquitectura de Missions

Fuente de la decisión: [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md).
Este documento describe lo **previsto**; los contratos exactos se publican como OpenAPI en `Nexus-Battle-Infrastructure/docs/contracts` antes de implementarse.

## Responsabilidad

Implementa las misiones JcE asíncronas: tablón, matrícula del héroe, rotaciones de habilidades, niveles de dificultad, reportes, encuentros con Máster y logros. **No ejecuta reglas de combate**: pide la simulación a Combat.

## Datos que posee

- Definiciones de misión y tablón.
- Matrículas con su héroe, estado y temporizador.
- Rotaciones de habilidades (hasta tres, prioridad alta, media y baja).
- Progreso de dificultad por jugador y misión.
- Reportes e historial de misiones, y logros otorgados.

Motor: **PostgreSQL**, base lógica `missions` con usuario y credenciales propios en el nodo de datos.

## Invariantes que debe imponer el motor

- «Un héroe no está en dos misiones activas»: índice único parcial en PostgreSQL.
- «No se accede a una dificultad sin completar la anterior»: se valida contra el historial persistido (`mission_difficulty_clears`, clave primaria por jugador, misión y nivel; HU-75).
- Un logro se otorga una sola vez por jugador: restricción de unicidad.
- Las recompensas se entregan de forma idempotente por matrícula.

## Integraciones

- **Combat** (síncrono, `operationId`): ejecutar la simulación con semilla, combatientes y rotaciones. Toda la aleatoriedad ocurre allí.
- **Player/Inventory** (síncrono, `operationId`): perfil de combate del héroe, compromiso `MISSION`, recompensas en ítems.
- **Wallet** (síncrono, `operationId`): recompensas en créditos.
- **Notifications** (ingesta HTTP): fin de misión y logros.

Todas las llamadas salientes que mueven créditos o productos siguen el patrón de ADR-019:

1. Persistir la intención con un `operationId` antes de llamar.
2. Reservar en el dueño del recurso con ese `operationId`.
3. Capturar o liberar según el resultado del propio agregado.
4. Toda reserva nace con caducidad; `409` y `503` no autorizan a suponer que la operación no ocurrió: se reintenta con el mismo `operationId`.

## Contrato previsto

- `GET /api/v1/missions` — tablón.
- `GET /api/v1/missions/{missionId}/difficulties` — niveles de dificultad y su desbloqueo (HU-75, **implementado**; ver [hu-75-mission-difficulty.md](hu-75-mission-difficulty.md)).
- `POST /api/v1/missions/{missionId}/enrollments` — matricular un héroe (HU-70; HU-75 añade `difficulty`).
- `PUT /api/v1/missions/enrollments/{enrollmentId}/rotations` — rotaciones.
- `GET /api/v1/missions/me/reports/{enrollmentId}` — reporte.
- `GET /api/v1/missions/me/achievements` — logros.

## Temporizadores

Los vencimientos usan un intervalo dentro del proceso, apagado por defecto, con reclamación durable en el almacén (`FOR UPDATE SKIP LOCKED`). El estado vive en la base: un reinicio retrasa un vencimiento, no lo pierde. Mismo patrón que `AccountDeletionProcessingScheduler` en Account.

## Decisiones abiertas

- El epic está en el milestone M2 pero ninguna de sus Historias de Usuario lo está.
- HU-72 depende del motor de combate (HU-17 a HU-20 y HU-24): las HU que no lo necesitan (HU-70, HU-71, HU-75) pueden avanzar antes.
- HU-75 fija el incremento de Heroico (+50 %) y Legendario (+100 %). Qué estadísticas escalan, su redondeo y los parámetros de Mítico siguen pendientes del PO, igual que las tablas de Máster.
