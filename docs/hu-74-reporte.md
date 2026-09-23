# HU-74 — Reporte e historial de misiones (Missions)

- **Task:** HU-74.2 ([Management #380](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/380)).
- **Historia:** [HU-74 #59](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/59) · EPIC-08 · RF-74.
- **Contrato del que parte:** [hu-74-mission-report-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-74-mission-report-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-74-reporte-mision.md) de la Task HU-74.1 ([#379](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/379)), en revisión en [Infrastructure #135](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/135).
- **Fuente funcional:** HU-74 y la sección 7.8.8 (reporte e historial) del documento del curso.

## Qué implementa esta entrega

- `GET /api/v1/missions/me/reports/{enrollmentId}` (JWT, rol `PLAYER`): el reporte de una misión terminada del jugador. Si la misión sigue en curso: `404 REPORT_NOT_AVAILABLE`, con `endsAt` (CA-04). Si no existe, es de otro jugador o se anuló: `404 REPORT_NOT_FOUND`.
- `GET /api/v1/missions/me/history?limit=&cursor=`: las misiones terminadas del jugador, de la más reciente a la más antigua, paginadas por un cursor opaco (`limit` de 1 a 50, 20 por defecto). Las anuladas aparecen con `reportAvailable: false`.
- `GET /api/v1/missions/me/history/summary`: estadísticas por tipo, mejores tiempos, colección de épicas y progreso en las cadenas narrativas (CA-05).
- El reporte nace en la misma transacción que cierra la misión en HU-72, y la migración `005-mission-reports` que lo guarda. Si la base rechaza el reporte, el cierre entero se deshace y se reintenta en el siguiente ciclo.

El jugador sale siempre del testimonio, nunca de la ruta ni de la consulta: nadie lee los reportes de otro.

## Reglas aplicadas

| Regla                                                                                  | Tipo            | Dónde                                                         |
| -------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| El reporte se crea en la transacción del cierre                                        | Propuesta P-T1  | `RunMissionExecutions.close` y `ExecutionRepositoryPort`      |
| La foto es inmutable; solo cambia el estado de cada línea de recompensa                | Propuesta P-T2  | Disparador `mission_reports_inmutable` y `updateRewardStatus` |
| Reporte para `COMPLETED` y `FAILED`; una anulación aparece en el historial sin reporte | Propuesta P-T3  | `missionReportOf` y `ListMissionHistory`                      |
| Cada bloque sale de quien lo produce; lo que Combat no manda queda en `null`           | Propuesta P-T4  | `ReportPolicy`                                                |
| El mejor tiempo es la menor duración simulada de las misiones completadas              | Propuesta P-T5  | `bestTimesOf`                                                 |
| Una cadena narrativa son las misiones `STORY` unidas por requisitos previos            | Propuesta P-T6  | `narrativeChainsOf`                                           |
| El historial y su resumen se calculan al leer, sin tablas de agregados                 | Propuesta P-T7  | `ListMissionHistory` y `GetMissionHistorySummary`             |
| Un reporte ajeno responde igual que uno inexistente, sin revelar qué matrículas hay    | Propuesta P-T8  | `GetMissionReport`                                            |
| Una misión en curso no tiene reporte                                                   | Requisito CA-04 | `GetMissionReport`                                            |

## Qué trae el reporte, y de dónde sale

| Bloque                              | Sale de                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `summary.outcome`, `outcomeReason`  | El cierre de HU-72                                                                  |
| `summary.hero` (`name`, `subtype`)  | El perfil del héroe que HU-72 congela; el doble de desarrollo no los trae           |
| `summary.startedAt` y `finishedAt`  | La matrícula: `finishedAt` es su `endsAt`, cuando la misión termina para el jugador |
| `summary.simulatedDuration`         | El resumen de Combat, si es una duración ISO-8601 válida                            |
| `combatStats`                       | El resumen de Combat; un dato que falta o no cumple queda en `null`                 |
| `enemies.defeated` y `enemies.boss` | El resumen de Combat, con los nombres del contenido                                 |
| `enemies.masters`                   | **Vacío hasta HU-73.2**: HU-72 todavía no pide sortear Máster                       |
| `objectives`                        | Los objetivos evaluados en el cierre; `bonus` en `null` hasta HU-10                 |
| `rewards`                           | **Vacío hasta HU-10 y HU-73.2**, que crearán las líneas y su estado                 |
| `generatedAt`                       | El momento del cierre                                                               |

La bitácora completa no va en el reporte (decisión 7 del diseño): sigue guardada en `mission_executions`.

## Diferencias con el diseño

| Diseño                                                                    | Implementación                                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cada bloque en su columna `jsonb` y la duración como `interval`           | La foto va entera en `snapshot` (`jsonb`, con `schema_version`); las columnas sueltas son las que se consultan. La duración se guarda como el texto ISO-8601 que da Combat. |
| Inmutabilidad en la aplicación y, si el equipo lo decide, `REVOKE UPDATE` | Un disparador rechaza cualquier `UPDATE` de `mission_reports`. Borrar sí se puede: la retención sigue pendiente.                                                            |
| Índices por jugador y fecha, por misión y por dificultad                  | Un índice por jugador y fecha: el historial y su resumen se calculan en la aplicación sobre los reportes del jugador (P-T7).                                                |
| La cadena narrativa no fija un mínimo ni su identificador                 | Una misión suelta no es una cadena; `chainId` es la primera misión de la cadena.                                                                                            |
| El historial siempre trae la categoría                                    | `category` es `null` solo si la misión ya no está en el catálogo y no tiene reporte. En PostgreSQL no puede pasar: la matrícula referencia la misión.                       |

## Modelo de datos

La migración `005-mission-reports`:

- Crea `mission_reports`, una por matrícula (clave primaria y foránea `enrollment_id`), con la foto en `snapshot` y las columnas que se consultan: jugador, misión, categoría, dificultad, desenlace y fin. Los CHECK impiden un desenlace, una categoría o un nivel fuera del vocabulario, una versión no positiva y una foto que no sea un objeto. El índice `mission_reports_por_jugador` sirve el historial.
- Añade el disparador `mission_reports_sin_cambios`, que rechaza cualquier `UPDATE` de la foto.
- Crea `mission_report_rewards`, con clave primaria (`enrollment_id`, `line_no`), y CHECK de tipo, cantidad, estado y origen. Es lo único que cambia después del cierre.

El cierre inserta la foto con `on conflict do nothing`: repetirlo no la duplica ni la cambia.

## Cuando el reporte no se puede crear o leer

- **La foto no se puede armar** (por ejemplo, a la matrícula le falta `startedAt` o `endsAt`): la misión se cierra igual, sin reporte, y el fallo llega a `onError`, que lo registra como `mission_execution_error`. Así un dato raro no deja la misión trabada en cada ciclo; en el historial aparece con `reportAvailable: false`.
- **La base rechaza el reporte** (un CHECK de la 005, por ejemplo): la transacción del cierre se deshace entera y el ciclo siguiente lo reintenta. Si el error persiste, se ve en el registro en cada ciclo.
- **Una foto de otra `schema_version`**: el repositorio falla con un mensaje claro en lugar de devolverla a medias. La respuesta es un `500` hasta que este servicio aprenda a leer esa versión.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                             | Depende de                                 |
| --------------------------------------------------------------------- | ------------------------------------------ |
| Que se generen reportes en producción                                 | La ruta de simulación de Combat (HU-72)    |
| El Máster en el reporte y la épica en las recompensas (CA-03)         | HU-73.2                                    |
| Créditos, productos, experiencia y bonificaciones por objetivo        | HU-10, en el Backlog                       |
| Reporte e historial en Web                                            | HU-74.3                                    |
| Reporte de una misión abandonada                                      | La cancelación (decisión 3 de HU-72)       |
| Aprobar P-T3, P-T5 y P-T6 (anuladas, mejor tiempo y cadena narrativa) | Decisiones del PO (1, 3 y 4 del diseño)    |
| Nivel del héroe en el resumen                                         | No existe en Player/Inventory (decisión 5) |
| Retención de reportes y bitácoras                                     | Decisión del PO (decisión 6)               |

## Cómo integrarse

- **Web (HU-74.3):** ante `404 REPORT_NOT_AVAILABLE` muestra `endsAt`. El historial pagina con `nextCursor` sin interpretarlo, y una misión con `reportAvailable: false` no tiene reporte que abrir.
- **HU-73.2:** completa `enemies.masters` en `missionReportOf` con su evidencia y crea la línea `EPIC` (`source: HU-73`) en el mismo cierre. La colección de épicas del resumen ya lee esas líneas.
- **HU-10:** crea sus líneas (`CREDITS`, `PRODUCT` y `EXPERIENCE`, `source: HU-10`) en el cierre y actualiza su estado con `updateRewardStatus` (CU-74.4).
- **Migraciones:** esta es la `005`. La siguiente historia usa la `006`.

## Pruebas

| Suite                                         | Qué demuestra                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/hu-74-domain.spec.ts`              | La foto con los fixtures R-1 y R-2, la lectura tolerante del resumen, las duraciones ISO-8601 y las proyecciones del historial con el escenario H-1                                  |
| `test/unit/hu-74-use-cases.spec.ts`           | El reporte creado en el cierre real de HU-72, los 404 del reporte (R-5 y R-6, pendiente y anulada), el historial con varias misiones y su cursor, y el resumen                       |
| `test/unit/hu-74-adapters.spec.ts`            | El doble en memoria con la inmutabilidad y R-4, la vista del contrato, el cursor y los errores en HTTP                                                                               |
| `test/integration/hu-74-reports-http.spec.ts` | Las tres rutas con JWT y rol sobre la aplicación completa: el reporte en curso y terminado, el historial paginado, el resumen, el aislamiento entre jugadores y las validaciones     |
| `test/db/hu-74-reports.spec.ts`               | PostgreSQL real: la foto de ida y vuelta, el cierre que no deja reporte si otro proceso se adelantó, el disparador de inmutabilidad, R-4, los CHECK de la 005 y el servicio completo |

## Cómo reproducir

```bash
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```

Prueba local con el catálogo de ejemplo, sin Cognito y con el doble de Combat:

```bash
npm run build
NODE_ENV=development AUTH_MODE=disabled PERSISTENCE_DRIVER=memory MISSIONS_EXAMPLE_CATALOG=true \
  MISSION_EXECUTION_ENABLED=true MISSION_EXECUTION_INTERVAL_MS=1000 PORT=3000 node dist/main.js
curl -X POST http://localhost:3000/api/v1/missions/msn_templo_olvidado/enrollments \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f' \
  -d '{"heroId":"7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60","difficulty":"NORMAL","strategyVersion":null}'
curl http://localhost:3000/api/v1/missions/me/reports/<enrollmentId>
curl http://localhost:3000/api/v1/missions/me/history/summary
```

El reporte responde `404 REPORT_NOT_AVAILABLE` con el `endsAt` de la misión, y el resumen trae la cadena del Templo con 0 de 2 misiones completadas. El reporte aparece a las doce horas de `startedAt`; la prueba de integración lo recorre moviendo el reloj.
