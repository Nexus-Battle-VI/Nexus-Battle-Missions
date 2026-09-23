# HU-72 — Ejecución de la simulación de misión (Missions)

- **Task:** HU-72.2 ([Management #374](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/374)).
- **Historia:** [HU-72 #57](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/57) · EPIC-08 · RF-72.
- **Contrato del que parte:** [hu-72-mission-simulation-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-72-mission-simulation-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-72-simulacion-mision.md) de la Task HU-72.1 ([#373](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/373)), en revisión en [Infrastructure #132](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/132).
- **Fuente funcional:** HU-72 y las secciones 7.8.1, 7.8.5, 7.8.6, 7.8.8 y 7.8.12 del documento del curso.

## Qué implementa esta entrega

HU-72 no añade rutas públicas. Añade un planificador que lleva cada misión iniciada hasta su cierre:

1. **Programa** cada matrícula iniciada: consume el hecho `MissionEnrollmentStarted` de HU-70 y crea su `MissionExecution` en `QUEUED`, con un `operationId` propio hacia Combat.
2. **Pide la simulación** a Combat con todo lo que Combat necesita: el perfil del héroe, la copia congelada de las rotaciones (HU-71), la dificultad y su multiplicador (HU-75), los encuentros del contenido y la duración como presupuesto de tiempo. Guarda el resumen y la bitácora. El resultado queda **sellado**: la matrícula sigue `IN_PROGRESS` hasta `endsAt`.
3. **Cierra** al llegar `endsAt`. Evalúa los objetivos con los hechos del resumen y, en una sola transacción: la matrícula pasa a `COMPLETED` o `FAILED`, la ejecución a `SETTLED`, se registra el _clear_ de HU-75 si hubo éxito y el hecho `MissionSettled`.
4. **Libera al héroe** en Player/Inventory con el `operationId` del compromiso de HU-70, una sola vez, y anota `heroReleasedAt`.

Si Combat rechaza la solicitud, se agota el plazo o el cierre no tiene con qué decidir, la misión se **anula** (`VOIDED`): sin penalización, sin _clear_ y sin recompensas, y el héroe se libera.

El planificador está apagado por defecto (`MISSION_EXECUTION_ENABLED`), como el reconciliador de HU-70. El estado vive en la base: un reinicio retrasa la simulación o el cierre, no los pierde.

## Estados de la ejecución

| Desde                  | Hacia       | Disparador                                                                                | Matrícula (HU-70)      |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| —                      | `QUEUED`    | Hecho `MissionEnrollmentStarted`                                                          | Sigue `IN_PROGRESS`    |
| `QUEUED`               | `REQUESTED` | Se envía la solicitud a Combat                                                            | Sigue `IN_PROGRESS`    |
| `QUEUED` o `REQUESTED` | igual       | Sin respuesta definitiva, o sin el perfil del héroe: reintento                            | Sigue `IN_PROGRESS`    |
| `REQUESTED`            | `SIMULATED` | `200` de Combat: resultado guardado y sellado                                             | Sigue `IN_PROGRESS`    |
| `SIMULATED`            | `SETTLED`   | Llega `endsAt`                                                                            | `COMPLETED` o `FAILED` |
| `QUEUED` o `REQUESTED` | `VOIDED`    | Combat rechaza, el héroe ya no es del jugador o se agota el plazo                         | `VOIDED`               |
| `SIMULATED`            | `VOIDED`    | Al cerrar, la misión ya no está en el catálogo o el resultado guardado no trae los hechos | `VOIDED`               |

Tras `SETTLED` o `VOIDED` solo cambia `heroReleasedAt`.

## Reglas aplicadas

| Regla                                                                                   | Tipo                        | Dónde                                           |
| --------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| Se simula al iniciar y se cierra en `endsAt`; el resultado queda sellado hasta entonces | Propuestas P-S1 y P-S9      | `RunMissionExecutions`                          |
| Una ejecución por matrícula, con su propio `operationId`                                | Propuesta P-S2              | `MissionExecution` y PK de `mission_executions` |
| Los reintentos mandan la misma solicitud con el mismo `operationId`                     | Propuesta P-S3              | `requestSimulation` y `CombatSimulationClient`  |
| La solicitud lleva todo lo que Combat necesita; Combat no consulta a Missions           | Propuesta P-S4              | `simulationRequestFor`                          |
| Missions decide el resultado con los hechos del resumen; Combat no conoce los objetivos | Propuestas P-S5 y P-S6      | `SettlementPolicy`                              |
| Si el héroe cae, la misión falla aunque haya cumplido objetivos                         | Requisito explícito (CA-04) | `settlementOf`                                  |
| Con los objetivos principales cumplidos, la misión se completa                          | Requisito explícito (CA-06) | `settlementOf`                                  |
| Sin tiempo y sin los principales: `FAILED` con motivo `TIME_LIMIT`                      | Decisión 2 (propuesta)      | `settlementOf`                                  |
| Gana los combates pero falta un principal: `FAILED` con motivo `OBJECTIVES_NOT_MET`     | Decisión 2 (propuesta)      | `settlementOf`                                  |
| Anulación técnica sin penalización, sin _clear_ y sin recompensas                       | Propuesta P-S7              | `voidExecution` y `voidedSettlement`            |
| Plazo de reintentos: `endsAt + 30 min`                                                  | Propuesta P-S8              | `SIMULATION_GRACE_MS`                           |
| El héroe se libera después del cierre, una sola vez, con el `operationId` de HU-70      | Requisito (CA-05) y P-S10   | `releaseHeroes` y `markHeroReleased`            |
| Solo un éxito registra el _clear_ que desbloquea el nivel siguiente                     | HU-75 (propuesta P-D1)      | `close` y `mission_difficulty_clears`           |
| Un hecho `MissionSettled` por matrícula, aunque el cierre se repita                     | Diseño (T-03)               | `mission_facts_un_hecho_por_tipo`               |

Evaluación de los objetivos, como fija el contrato:

| Tipo                 | Se cumple si                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `DEFEAT_BOSS`        | `summary.bossDefeated`                                                |
| `CLEAR_ENCOUNTERS`   | `summary.encountersCompleted >= count`                                |
| `MIN_HEALTH_PERCENT` | `summary.minHealthPercent >= percent`                                 |
| `DEFEAT_MASTER`      | `summary.master.defeated`; si el Máster no apareció, no aplica        |
| Sin regla            | No es evaluable en esta versión (botín, HU-10) y no bloquea el cierre |

Los objetivos secundarios no cambian el resultado: alimentan las bonificaciones (HU-10) y los logros (HU-76). Un resumen al que le falte un hecho necesario no se da por bueno: el cliente lo trata como una respuesta desconocida y el cierre nunca inventa un resultado.

## Lo que Missions NO hace

La simulación es de Combat (ADR-019 y ADR-021): la IA de las rotaciones y de los enemigos (CA-02), las mecánicas y el generador de aleatoriedad de las batallas en línea (CA-03), el daño, los turnos y la bitácora. Missions no genera números aleatorios, no calcula daño y no decide acciones. Guarda `simulationId` y `seedRef` como referencias opacas.

## Dependencias de Team Alfa

**Ninguna de estas rutas existe todavía.** Son las propuestas de los contratos:

- **Simulación en Combat:** `POST /api/internal/v1/combat/simulations`, firmado con HMAC. `CombatSimulationClient` envía el cuerpo en JSON canónico, así que la solicitud congelada que vuelve de `jsonb` con otro orden de claves se envía y se firma igual.
  - `200` con el cuerpo del contrato: resultado. Uno con otro `operationId`, sin resumen, sin bitácora o con un `combatOutcome` desconocido no se da por bueno.
  - `422` con `code`: la misión se anula. `400` o `409` con `code` también, y además se avisa (`combat_rechazo_de_programacion`), porque es un error de programación.
  - Cualquier otra respuesta, un tiempo agotado o un error de red: resultado desconocido y reintento a los 5 s, 30 s, 2 min y 10 min, y después cada 10 min.
- **Perfil del héroe:** sale de la misma ruta propuesta a Player/Inventory para las habilidades de HU-71 (`GET /api/internal/v1/players/{playerId}/heroes/{heroId}`). Missions congela el cuerpo en la solicitud sin interpretarlo (decisión 10 del diseño): hasta que Team Alfa fije el esquema del perfil, se guarda y se reenvía a Combat el cuerpo entero de esa respuesta. Sin respuesta, la ejecución espera; si el héroe ya no es del jugador, la misión se anula (`HERO_NOT_OWNED`).
- **Liberación del héroe:** la de HU-70, `POST /api/internal/v1/inventory/commitments/{operationId}/release`.

Con `COMBAT_SIMULATION_DRIVER=http`, que es el valor de producción, cada misión espera a Combat y se anula al vencer su plazo, sin penalización. Es el resultado honesto: ADR-019 prefiere una misión que espera a una simulada con otras reglas.

`COMBAT_SIMULATION_DRIVER=memory` usa `ScriptedCombatSimulation`, un doble de desarrollo con un resultado **fijo**: el héroe vence todos los encuentros sin recibir daño. Sirve para recorrer el flujo, pero **no acredita CA-02 ni CA-03**. Con `NODE_ENV=production` el servicio no arranca en ese modo.

## Diferencias con el diseño

| Diseño                                                                         | Implementación                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| El planificador toma las ejecuciones con `FOR UPDATE SKIP LOCKED`              | Cada transición exige la `version` leída. Si dos procesos toman la misma ejecución, solo uno la pasa a `REQUESTED` y llama a Combat. Así no queda una transacción abierta durante la llamada HTTP (T-02).                                                  |
| La liberación se reintenta con el escalonado de la simulación                  | Se reintenta en cada ciclo del planificador (`MISSION_EXECUTION_INTERVAL_MS`) hasta que Player/Inventory la confirme.                                                                                                                                      |
| Un `401` de Combat se avisa y no se reintenta                                  | Se trata como resultado desconocido: se avisa (`combat_sin_resultado` con `status: 401`) y se reintenta hasta el plazo. Un secreto corregido deja seguir la misión; si no, se anula sin penalización.                                                      |
| No dice cuándo se anula                                                        | En cuanto se sabe: un rechazo de Combat anula la misión sin esperar a `endsAt` y libera al héroe enseguida.                                                                                                                                                |
| No contempla que la misión desaparezca del catálogo o el héroe cambie de dueño | La misión se anula con `MISSION_NOT_FOUND` (al pedir la simulación o al cerrar) o `HERO_NOT_OWNED`. Un resultado guardado sin los hechos del resumen se anula al cerrar con `INVALID_SIMULATION_RESULT`: ningún camino deja al héroe reservado sin salida. |

## Modelo de datos

La migración `004-mission-executions`:

- Admite `VOIDED` en `mission_enrollments` (CHECK `mission_enrollments_estado_conocido`). El tablón no lo cuenta como resultado de la misión: el jugador la ve disponible, como antes de matricularse.
- Crea `mission_executions`, una por matrícula (clave primaria y foránea `enrollment_id`), con `operation_id` único, la solicitud congelada, el resultado y el cierre. Los CHECK impiden, aun escribiendo a mano, un estado o un resultado fuera del vocabulario, una ejecución pedida sin solicitud, un resultado sin resumen o sin bitácora, un cierre sin desenlace y un héroe liberado de una misión sin cerrar.
- Añade los índices parciales de las búsquedas del planificador: `mission_facts_por_procesar` (misiones por programar), `mission_executions_pendientes` (intentos vencidos), `mission_executions_por_cerrar` (simuladas) y `mission_executions_por_liberar`. Para cerrar también usa `mission_enrollments_vencimiento`, de la migración 002: por eso la consulta repite `status = 'IN_PROGRESS'`, que es el predicado de ese índice.

El cierre escribe matrícula, ejecución, _clear_ y hecho en una transacción. Si otro proceso cambió antes la matrícula o la ejecución, se deshace todo. El _clear_ y el hecho usan `on conflict do nothing` sobre sus claves, así que repetir el cierre no los duplica.

Deshacer la migración falla si ya hay matrículas `VOIDED`: el CHECK anterior no las admite, y la migración no las convierte en otro estado.

## Configuración

| Variable                        | Por defecto                                  | Qué hace                                                                             |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `COMBAT_SIMULATION_DRIVER`      | `memory` en desarrollo, `http` en producción | `memory` es el doble de resultado fijo; prohibido en producción                      |
| `COMBAT_BASE_URL`               | —                                            | Sin valor, las misiones esperan y se anulan al vencer el plazo; lo avisa el registro |
| `COMBAT_SIMULATION_TIMEOUT_MS`  | `15000` (de 1000 a 120000)                   | Tiempo máximo de cada llamada de simulación                                          |
| `MISSION_EXECUTION_ENABLED`     | `false`                                      | Enciende el planificador                                                             |
| `MISSION_EXECUTION_INTERVAL_MS` | `15000` (de 1000 a 3600000)                  | Cada cuánto corre un ciclo                                                           |

El perfil del héroe usa `HERO_ABILITIES_DRIVER` y `PLAYER_INVENTORY_BASE_URL`, y la firma, `INTERNAL_SERVICE_AUTH_SECRET`.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                  | Depende de                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Ruta de simulación, IA de rotaciones y enemigos, y combatientes con perfil | Combat (Team Alfa). Hasta entonces, CA-02 y CA-03 no se acreditan        |
| Perfil de combate del héroe por `heroId`                                   | Player/Inventory (Team Alfa, decisión 10)                                |
| Abandonar una misión (`ABANDONED`) y su penalización                       | Decisión del PO (decisión 3); no hay contrato de cancelación             |
| Aprobar `VOIDED`, `TIME_LIMIT` y `OBJECTIVES_NOT_MET`                      | Decisión del PO (decisiones 2 y 4)                                       |
| Perfiles de los enemigos regulares y escalado por encuentro (`powerStep`)  | Contenido de las misiones (decisiones 7 y 8)                             |
| Sorteo y perfil del Máster (`master` va en `null`)                         | HU-73.2                                                                  |
| Recompensas, logros y aviso de fin de misión                               | HU-10, HU-76 y Notifications, a partir de `MissionSettled`               |
| Renovar el compromiso si Combat tarda más que el margen                    | Player/Inventory (decisión 11)                                           |
| Esquema del perfil de combate del héroe; hoy se congela el cuerpo entero   | Player/Inventory y Combat (Team Alfa, decisión 10)                       |
| Que abandonar (u otro cierre futuro) cierre también la ejecución           | La HU de cancelación; hoy solo HU-72 saca una matrícula de `IN_PROGRESS` |

## Cómo integrarse

- **HU-73 (Máster):** completa el bloque `master` de `simulationRequestFor`. El cierre ya evalúa `DEFEAT_MASTER` con `summary.master`.
- **HU-74.2 (hecho):** el cierre crea el reporte de la misión en su misma transacción; una anulación no tiene reporte. Ver [hu-74-reporte.md](hu-74-reporte.md).
- **HU-76 (logros) y HU-10 (recompensas):** consumen los `mission_facts` de tipo `MissionSettled` sin `processed_at`. El `payload` trae el resultado, el motivo, los objetivos y `simulationId`; el resumen y la bitácora están en `mission_executions`, y la foto, en `mission_reports`. Una anulación llega con `missionOutcome: VOIDED` y sin objetivos.
- **Web:** una misión anulada vuelve a mostrarse disponible. El resultado no existe para el jugador hasta `endsAt`.
- **Migraciones:** esta es la `004`. HU-74 añadió la `005`.

## Pruebas

| Suite                                           | Qué demuestra                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hu-72-domain.spec.ts`                | Transiciones de la ejecución y de la matrícula, escalonado de reintentos, lectura estricta del resumen y la tabla de resultados con los fixtures P-01, P-04 y T-05                                         |
| `test/unit/hu-72-use-cases.spec.ts`             | El ciclo completo: P-01, P-04, T-01 a T-04, el plazo, el perfil del héroe, la liberación una sola vez, los fallos aislados y la solicitud congelada que recibe Combat                                      |
| `test/unit/hu-72-adapters.spec.ts`              | Cliente de Combat (firma, cuerpo canónico y cada respuesta), doble de Combat, repositorio en memoria, planificador, perfil del héroe y configuración                                                       |
| `test/integration/hu-72-execution-http.spec.ts` | La aplicación completa con el reloj movido por la prueba: matrícula por HTTP, cierre visible en el tablón, Heroico desbloqueado, héroe libre, anulación y espera sin Combat configurado                    |
| `test/db/hu-72-executions.spec.ts`              | PostgreSQL real: `jsonb` de ida y vuelta, transiciones y cierres simultáneos, cierre atómico que se deshace entero, los CHECK de la migración 004 y el servicio completo con `PERSISTENCE_DRIVER=postgres` |

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
```

En menos de un segundo el registro muestra `mission_execution_cycle` con `queued: 1` y `simulated: 1`, y el tablón sigue mostrando la misión en curso: el resultado está sellado. El cierre llega a las doce horas de `startedAt`; la prueba de integración lo recorre moviendo el reloj.
