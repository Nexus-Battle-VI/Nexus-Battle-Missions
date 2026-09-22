# HU-75 — Niveles de dificultad escalonada (Missions)

- **Task:** HU-75.2 ([Management #384](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/384)).
- **Historia:** [HU-75 #60](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/60) · EPIC-08 · RF-75.
- **Contrato del que parte:** [hu-75-mission-difficulty-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-75-mission-difficulty-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-75-dificultad-escalonada.md) de la Task HU-75.1, en revisión en [Infrastructure #125](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/125).
- **Fuente funcional:** HU-75 y la sección 7.8.11 del documento del curso.

## Qué implementa esta entrega

Missions pasa de andamiaje a tener su primera ruta y su primera tabla de negocio.

- `GET /api/v1/missions/{missionId}/difficulties` (JWT, rol `PLAYER`): los cuatro niveles de esa misión para el jugador autenticado, con `unlocked`, `lockReason`, `enemyStatMultiplier` y `rewardTier`. El jugador sale del `sub` del testimonio, nunca de la ruta ni de la consulta.
- `mission_difficulty_clears` (migración `001-mission-difficulty-clears`): un hecho por jugador, misión y nivel completado.
- La validación que usará la matrícula de HU-70: `assertDifficultyUnlocked` lanza `ProgressionLockedError`, que `toMissionsHttpException` traduce a `422 PROGRESSION_LOCKED` con el cuerpo del contrato. `parseDifficultyLevel` rechaza un valor fuera del vocabulario con `UnknownDifficultyError`, que se traduce a `400 UNKNOWN_DIFFICULTY`.

## Reglas aplicadas

| Regla                                                                                             | Tipo                                                        | Dónde                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Cuatro niveles: Normal, Heroico, Legendario y Mítico                                              | Requisito explícito (HU-75, curso 7.8.11)                   | `domain/value-objects/difficulty-level.ts`   |
| Cada nivel exige haber completado el inmediatamente inferior al menos una vez, en la misma misión | Requisito explícito                                         | `domain/policies/DifficultyPolicy.ts`        |
| Normal siempre disponible                                                                         | Propuesta P-D2 del diseño, pendiente de confirmación del PO | `DifficultyPolicy.ts`                        |
| Repetir un nivel ya completado está permitido                                                     | Propuesta P-D3                                              | `DifficultyPolicy.ts`                        |
| Heroico `1.5` y Legendario `2` sobre las estadísticas enemigas                                    | Requisito explícito (50 % y 100 % más)                      | `domain/value-objects/difficulty-scaling.ts` |
| Mítico sin multiplicador (`null`)                                                                 | Pendiente del PO: ni la HU ni el curso dan un número        | `difficulty-scaling.ts`                      |
| `rewardTier`: `STANDARD`, `IMPROVED`, `PREMIUM` y `EXCLUSIVE`                                     | Propuesta P-D7, sujeta a acuerdo con HU-10                  | `difficulty-scaling.ts`                      |

Missions no escala ninguna estadística: entrega el multiplicador y Combat lo aplicará cuando exista la simulación de HU-72.

## Modelo de datos

`mission_difficulty_clears` guarda `player_id`, `mission_id`, `difficulty`, `completed_at` y `created_at`. Las dos invariantes del diseño viven en el motor:

- la clave primaria `(player_id, mission_id, difficulty)` impide duplicar un hecho;
- el `CHECK mission_difficulty_clears_nivel_conocido` impide persistir un nivel fuera del vocabulario.

La clave primaria empieza por `player_id, mission_id`, que es la consulta de desbloqueo, así que no hace falta otro índice. No hay claves foráneas: `player_id` es el `sub` del proveedor de identidad y el tablón de HU-70 todavía no existe.

El registro es idempotente con `on conflict do nothing`: repetir el mismo hecho, incluso en paralelo, deja una fila, conserva la fecha del primero y devuelve `true` una sola vez.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                                    | Depende de                                                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Guardar la dificultad al matricular (`POST .../enrollments`)                                 | HU-70.2 ([#366](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/366))                                     |
| Responder 404 a una misión inexistente                                                       | HU-70, que crea el tablón                                                                                                   |
| Registrar un nivel completado al terminar con éxito                                          | HU-72 ([#57](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/57)). Solo `SUCCESS` cuenta (propuesta P-D1) |
| Enviar la dificultad y el multiplicador a Combat                                             | HU-72 y el endpoint interno de simulación de Combat                                                                         |
| Montos y objetos por `rewardTier`                                                            | HU-10 ([#19](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/19))                                         |
| Qué estadísticas escalan, su redondeo, los parámetros de Mítico y la nomenclatura del tablón | Decisiones del PO                                                                                                           |

Hasta que HU-72 registre niveles completados, la tabla está vacía en producción y todo jugador ve solo Normal disponible. Es el estado real del sistema, no un fallo.

Dos casos de la matriz de aislamiento, "fallo o abandono" y "matrícula sin terminar", todavía no son representables porque no existen matrículas ni simulaciones. Se cumplen por construcción: solo un hecho de `mission_difficulty_clears` desbloquea, y matricularse no lo crea. Sus pruebas llegan con HU-70 y HU-72.

## Cómo integrarse

- **HU-70, matrícula:** antes de persistir, leer `clearedLevels(playerId, missionId)` y llamar a `assertDifficultyUnlocked`. Para que el `400` lleve `UNKNOWN_DIFFICULTY`, el DTO debe aceptar `difficulty` como cadena y dejar que `parseDifficultyLevel` la rechace. Los errores se traducen con `toMissionsHttpException`.
- **HU-72, simulación:** al recibir `SUCCESS`, llamar a `record(...)` con el `completedAt` del resultado, y enviar a Combat lo que devuelve `scalingOf(difficulty)`.
- **Migraciones:** esta es la `001`. La siguiente historia usa la `002`.

## Pruebas

| Suite                                                                                       | Qué demuestra                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/difficulty-policy.spec.ts`                                                       | La matriz de transición del diseño fila por fila, el motivo exacto del contrato y el 422 de la validación                                                               |
| `test/unit/list-mission-difficulties.spec.ts`                                               | Los fixtures del contrato y la matriz de aislamiento: otra misión, otro jugador y un salto de nivel no desbloquean                                                      |
| `test/unit/difficulty-level.spec.ts` y `difficulty-scaling.spec.ts`                         | Vocabulario cerrado, escala del tablón rechazada y Mítico sin número inventado                                                                                          |
| `test/unit/in-memory-difficulty-clear-repository.spec.ts` y `missions-error-mapper.spec.ts` | Idempotencia del doble, claves sin colisión y los códigos `PROGRESSION_LOCKED`, `UNKNOWN_DIFFICULTY` y `DEPENDENCY_UNAVAILABLE`                                         |
| `test/integration/mission-difficulty-http.spec.ts`                                          | La ruta real con JWT y rol: 401, 403, respuesta completa, aislamiento por testimonio, 400 y 503                                                                         |
| `test/db/postgres-difficulty-clear-repository.spec.ts`                                      | PostgreSQL real: aislamiento, idempotencia concurrente, fecha del primer hecho, y que el motor rechaza un nivel desconocido y un duplicado sin pasar por el repositorio |
