# HU-75 — Niveles de dificultad escalonada (Missions)

- **Task:** HU-75.2 ([Management #384](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/384)).
- **Historia:** [HU-75 #60](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/60) · EPIC-08 · RF-75.
- **Contrato del que parte:** el contrato y el diseño HU-75.1 están en revisión en [Infrastructure #154](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/154); el GET de esta entrega está en `develop` de Missions y la matrícula con `difficulty` sigue en la PR #15.
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

Missions no escala ninguna estadística: HU-72 envía el multiplicador a Combat en cada solicitud de simulación, y Combat lo aplicará cuando publique esa ruta.

## Modelo de datos

`mission_difficulty_clears` guarda `player_id`, `mission_id`, `difficulty`, `completed_at` y `created_at`. Las dos invariantes del diseño viven en el motor:

- la clave primaria `(player_id, mission_id, difficulty)` impide duplicar un hecho;
- el `CHECK mission_difficulty_clears_nivel_conocido` impide persistir un nivel fuera del vocabulario.

La clave primaria empieza por `player_id, mission_id`, que es la consulta de desbloqueo, así que no hace falta otro índice. No hay claves foráneas: `player_id` es el `sub` del proveedor de identidad, y `mission_id` no referencia el tablón de HU-70 (migración `002`), que en producción todavía está vacío.

El registro es idempotente con `on conflict do nothing`: repetir el mismo hecho, incluso en paralelo, deja una fila, conserva la fecha del primero y devuelve `true` una sola vez.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                                    | Depende de                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responder 404 a una misión que no está en el catálogo                                        | Contenido del catálogo en PostgreSQL. El tablón de HU-70 ya existe, pero en producción está vacío: validar hoy dejaría esta ruta en 404 para toda misión                  |
| Registrar niveles completados en producción                                                  | La ruta de simulación de Combat. HU-72.2 ya registra el _clear_ al cerrar con éxito (solo `COMPLETED` cuenta, propuesta P-D1), pero sin Combat ninguna misión se completa |
| Aplicar el multiplicador a los enemigos                                                      | Combat. HU-72.2 ya se lo envía en cada solicitud de simulación                                                                                                            |
| Montos y objetos por `rewardTier`                                                            | HU-10 ([#19](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/19))                                                                                       |
| Qué estadísticas escalan, su redondeo, los parámetros de Mítico y la nomenclatura del tablón | Decisiones del PO                                                                                                                                                         |

Hasta que Combat publique la simulación, ninguna misión se completa en producción: la tabla sigue vacía y todo jugador ve solo Normal disponible. Es el estado real del sistema, no un fallo.

De la matriz de aislamiento, "matrícula sin terminar" se prueba desde HU-70 (`test/unit/hu-70-use-cases.spec.ts`): matricularse no crea un hecho de `mission_difficulty_clears`, y solo ese hecho desbloquea. "Fallo" se prueba desde HU-72 (`test/unit/hu-72-use-cases.spec.ts`): una misión fallida o anulada no registra el _clear_, y una completada desbloquea Heroico. "Abandono" sigue sin contrato de cancelación.

## Cómo integrarse

- **HU-70, matrícula (hecho en HU-70.2):** `EnrollInMission` lee `clearedLevels(playerId, missionId)` y llama a `assertDifficultyUnlocked` antes de persistir. El DTO acepta `difficulty` como cadena para que `parseDifficultyLevel` la rechace con `400 UNKNOWN_DIFFICULTY`. Ver [hu-70-matriculacion.md](hu-70-matriculacion.md).
- **HU-72.2 (hecho):** el cierre inserta el _clear_ en su misma transacción, solo si la misión termina `COMPLETED` y con la fecha del cierre. La solicitud a Combat lleva la dificultad y `scalingOf(difficulty).enemyStatMultiplier`. Ver [hu-72-simulacion.md](hu-72-simulacion.md).
- **Migraciones:** esta es la `001`. HU-70 añadió la `002`, HU-71 la `003` y HU-72 la `004`.

## Pruebas

| Suite                                                                                       | Qué demuestra                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/difficulty-policy.spec.ts`                                                       | La matriz de transición del diseño fila por fila, el motivo exacto del contrato y el 422 de la validación                                                                                                     |
| `test/unit/list-mission-difficulties.spec.ts`                                               | Los fixtures del contrato y la matriz de aislamiento: otra misión, otro jugador y un salto de nivel no desbloquean                                                                                            |
| `test/unit/difficulty-level.spec.ts` y `difficulty-scaling.spec.ts`                         | Vocabulario cerrado, escala del tablón rechazada y Mítico sin número inventado                                                                                                                                |
| `test/unit/in-memory-difficulty-clear-repository.spec.ts` y `missions-error-mapper.spec.ts` | Idempotencia del doble, claves sin colisión y los códigos `PROGRESSION_LOCKED`, `UNKNOWN_DIFFICULTY` y `DEPENDENCY_UNAVAILABLE`                                                                               |
| `test/integration/mission-difficulty-http.spec.ts`                                          | La ruta real con JWT y rol: 401, 403, respuesta completa, aislamiento por testimonio, 400 y 503                                                                                                               |
| `test/db/postgres-difficulty-clear-repository.spec.ts`                                      | PostgreSQL real: aislamiento, idempotencia concurrente, fecha del primer hecho, y que el motor rechaza un nivel desconocido y un duplicado sin pasar por el repositorio                                       |
| `test/db/hu-75-difficulty.e2e.spec.ts`                                                      | Task HU-75.4, de punta a punta con servidor Nest real, HTTP real y PostgreSQL real: los escenarios P-02 a P-05, la matriz de aislamiento, la idempotencia y que el progreso sobrevive a reiniciar el servicio |

## Cómo reproducir

```bash
npm ci
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```

Integración local con Web, sin Cognito: el servicio corre en memoria en el puerto al que el servidor de desarrollo de Web envía `/api`.

```bash
npm run build
NODE_ENV=development AUTH_MODE=disabled PERSISTENCE_DRIVER=memory PORT=3000 node dist/main.js
curl http://localhost:3000/api/v1/missions/msn_templo-olvidado/difficulties
```

Con `AUTH_MODE=disabled` la identidad es `anonymous` y la tabla está vacía, así que la respuesta es el primer fixture del contrato: solo Normal libre. Ese modo no arranca con `NODE_ENV=production`.
