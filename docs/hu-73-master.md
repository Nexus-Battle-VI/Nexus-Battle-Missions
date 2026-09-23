# HU-73 — Encuentro con enemigo Máster (Missions)

- **Task:** HU-73.2 ([Management #377](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/377)).
- **Historia:** [HU-73 #58](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/58) · EPIC-08 · RF-73.
- **Contrato del que parte:** [hu-73-master-encounter-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-73-master-encounter-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-73-encuentro-master.md) de la Task HU-73.1 ([#376](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/376)), en revisión en [Infrastructure #134](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/134).
- **Fuente funcional:** HU-73 y las secciones 7.8.3, 7.8.4 y 7.8.14 del documento del curso.

## Qué implementa esta entrega

- La configuración del Máster en la definición de la misión, con la forma del contrato (P-X1): puntos de evaluación, tope de apariciones y, por candidato, subtipo, desfase de nivel, perfil, probabilidad por subtipo del héroe y épica.
- La solicitud de simulación de HU-72 lleva el bloque `master` con la probabilidad ya resuelta para el subtipo del héroe matriculado (P-X2). Si ningún candidato tiene probabilidad para ese subtipo, el bloque no se envía (M-6).
- Al cerrar la misión, en la misma transacción de HU-72, Missions comprueba la evidencia que manda Combat y guarda una fila por punto de evaluación en `mission_master_encounters` (P-X7, CA-02).
- Cada Máster derrotado deja pendiente la entrega de su épica, con un `operationId` determinista (P-X6), y una línea `EPIC` en el reporte de HU-74 (CA-01).
- El planificador de HU-72 entrega después las épicas pendientes por el contrato de entregas de Player/Inventory (HU-59), con reintentos. Al confirmarse, la línea del reporte pasa a `CREDITED`; ante un rechazo definitivo, a `FAILED`.
- El hecho `MissionSettled` añade `masterEncounters`; el reporte muestra los Máster que aparecieron; el detalle de HU-70 muestra la probabilidad por subtipo.

Missions no tira dados ni calcula estadísticas: la tirada, el encuentro y la conversión del desfase de nivel en estadísticas son de Combat (ADR-021). Acreditar la épica en el inventario es de Player/Inventory (HU-32).

## Reglas aplicadas

| Regla                                                                                                                               | Tipo           | Dónde                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------- |
| La configuración vive en la definición de la misión                                                                                 | Propuesta P-X1 | `MissionDefinition.masterEncounter`          |
| La probabilidad se resuelve para el subtipo del héroe; `"*"` vale para cualquiera; sin probabilidad, `NOT_APPLICABLE`               | Propuesta P-X2 | `probabilityFor` y `simulationMasterOf`      |
| Una oportunidad por punto, como mucho un Máster por punto y nunca por encima del tope (1 si el contenido no lo fija)                | Propuesta P-X3 | `masterEncounterRecordsOf`                   |
| El Máster es un encuentro más: si cae el héroe, la misión falla (HU-72)                                                             | Propuesta P-X4 | `settlementOf`, sin cambios                  |
| Probabilidades en [0, 1], referencias obligatorias y únicas, desfase entero no negativo, puntos dentro de los encuentros y tope ≥ 1 | Propuesta P-X5 | `masterConfigProblem`                        |
| La épica se pide al cerrar, una sola vez y nunca en una misión `VOIDED`                                                             | Propuesta P-X6 | `epicRewardsOf` y `GrantMasterEpics`         |
| Cada evaluación y cada encuentro quedan como evidencia                                                                              | Propuesta P-X7 | `mission_master_encounters`                  |
| Missions envía `levelOffset: 2` y exige que Combat devuelva el mismo; las estadísticas las calcula Combat                           | Propuesta P-X8 | Bloque `master` y `masterEncounterRecordsOf` |
| Si se derrota al Máster, la épica se entrega (CA-01); si no, no (CA-03)                                                             | Requisito      | `epicRewardsOf`                              |

## Qué comprueba Missions en el resumen de Combat

La épica no se entrega sobre evidencia dudosa. Si el resumen no cuadra con el bloque enviado, la misión se anula sin penalización (`INVALID_SIMULATION_RESULT`), igual que en HU-72:

- cada punto que la misión alcanzó (`encountersCompleted ≥ afterEncounter`) tiene su evaluación, y ningún punto no alcanzado o posterior al tope la tiene;
- las evaluaciones y los encuentros nombran puntos y candidatos que se enviaron;
- aparece como mucho un Máster por punto, cada aparición tiene su encuentro y cada encuentro su aparición;
- el desenlace es `DEFEATED`, `HERO_DEFEATED` o `ESCAPED`, y el desfase de nivel es el que se envió (CA-04);
- el resumen corto de HU-72 (`master.appeared` y `master.defeated`) dice lo mismo que los encuentros;
- sin bloque enviado, Combat no puede decir que apareció un Máster.

Los turnos son informativos: si no son un entero que quepa en la columna, se guardan como `null` sin anular nada.

| Resultado del punto                          | Fila                                           |
| -------------------------------------------- | ---------------------------------------------- |
| Evaluado, no aparece                         | `NOT_APPEARED`                                 |
| Aparece y cae el Máster                      | `APPEARED_DEFEATED`, con la épica y su entrega |
| Aparece y cae el héroe                       | `APPEARED_HERO_DEFEATED`                       |
| Aparece y nadie cae dentro del límite        | `APPEARED_ESCAPED`                             |
| Se alcanzó, pero ya estaba cubierto el tope  | `SKIPPED_MAX_REACHED`                          |
| La misión no llegó a ese punto               | Sin fila                                       |
| Hay configuración pero no se envió el bloque | Una fila `NOT_APPLICABLE`, sin punto           |

## Entrega de la épica

`GrantMasterEpics` corre en cada ciclo del planificador, después del cierre. Pide `POST /api/internal/v1/inventory/grants` con un lote de un solo producto (`quantity: 1`), firmado con el HMAC de ADR-019 como `missions`. El `operationId` es un UUID versión 5 de la matrícula, el Máster y el número de aparición: repetir el cierre o la llamada no entrega dos veces (M-7).

El producto sale del contenido vigente, buscado por Máster y épica, y **se congela antes del primer envío**, con una escritura condicional que ninguna otra borra: aunque falle el guardado posterior, se caiga el proceso o cambie el contenido, cada reintento lleva el mismo cuerpo, porque Player/Inventory respondería `409` a la misma operación con otro producto. Si otro proceso se adelantó a congelarlo, este no envía.

| Situación                                                | Qué hace Missions                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `200` con la misma operación y `applied: true`           | `GRANTED`; la línea `EPIC` pasa a `CREDITED` en la misma transacción                                               |
| `422` o `400`                                            | `REJECTED`, queda para revisión; la línea pasa a `FAILED`                                                          |
| `409`, `401`, `404`, `5xx`, tiempo agotado o red         | Sigue `PENDING`; se reintenta con el mismo `operationId` a los 5 s, 30 s, 2 min y 10 min, y después cada 10 min    |
| La épica aún no tiene `productId` de Catalog             | Sigue `PENDING` con `EPIC_PRODUCT_MISSING` y el mismo escalonado; se entrega cuando el contenido tenga el producto |
| Un error interno (la matrícula no existe, la base falla) | Se informa como `epic_grant_error` y la entrega se aplaza con el mismo escalonado (`INTERNAL_ERROR`)               |

Un contenido roto después de la matrícula no deja la misión sin cerrar: el nombre de la épica cae en su referencia y, sin producto, la entrega espera.

## Diferencias con el diseño

| Diseño o contrato                                        | Implementación                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Columna `mission_definitions.master_encounter`           | La configuración va en `content.masterEncounter`, el mismo `jsonb` que ya usa HU-70. No hace falta migrar `mission_definitions`.                                                                                                                                                                                                           |
| Validar la configuración al cargar la definición         | Missions no carga contenido: no hay ruta ni semilla. El catálogo en memoria valida al arrancar; con PostgreSQL, el planificador anula la misión con `INVALID_MASTER_CONFIG` antes de llamar a Combat.                                                                                                                                      |
| Cuatro motivos de `INVALID_MASTER_CONFIG`                | Añade `DUPLICATE_REFERENCE` (dos candidatos con el mismo `masterRef` harían ambigua la épica ganada) e `INVALID_LEVEL_OFFSET` (la HU pide niveles por encima del héroe y el desfase acaba en una columna `integer`: ha de ser un entero no negativo que quepa en ella). Un punto repetido se rechaza como `EVALUATION_POINT_OUT_OF_RANGE`. |
| `maxAppearances` ≥ 1 en las validaciones                 | Si el contenido lo omite vale 1, como dice P-X3.                                                                                                                                                                                                                                                                                           |
| `409`: error de programación, se registra                | Se registra y se reintenta: Player/Inventory también responde `409` a una escritura concurrente. Congelar el producto evita el `409` por cambio de contenido.                                                                                                                                                                              |
| La tabla solo guarda `grant_operation_id` y `granted_at` | Añade el estado, los intentos, el próximo intento, el último error y el producto de la entrega, la línea del reporte, el desfase y los turnos.                                                                                                                                                                                             |
| `NOT_APPLICABLE` en la secuencia 1                       | Sin punto (`after_encounter` nulo): no hubo nada que evaluar.                                                                                                                                                                                                                                                                              |
| El detalle de HU-70 da una sola `probability`            | Sigue dándola (la mayor configurada) y añade `probabilityByHeroType` por candidato, porque la que aplica depende del héroe.                                                                                                                                                                                                                |

## Modelo de datos

La migración `006-mission-master-encounters` crea `mission_master_encounters`: una fila por matrícula y punto (clave primaria `enrollment_id`, `sequence`; foránea a `mission_enrollments`). Los CHECK imponen en el motor que:

- el estado sea del vocabulario del contrato y solo `NOT_APPLICABLE` no tenga punto;
- una aparición nombre a su Máster y sin aparición no haya Máster;
- solo un Máster derrotado tenga épica y entrega, y siempre las tenga (CA-01 y CA-03);
- la entrega tenga estado; `granted_at` exista solo si está `GRANTED`, y una entregada lleve su producto.

`grant_operation_id` es único y un índice parcial sirve las entregas pendientes. El cierre inserta con `on conflict do nothing`: repetirlo no cambia nada. Con la `006`, cualquier `truncate` de `mission_enrollments` en pruebas debe incluir `mission_master_encounters`.

## Configuración

| Variable             | Valores                                                               | Por defecto                                  |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| `EPIC_GRANTS_DRIVER` | `http` (Player/Inventory) o `memory` (doble, prohibido en producción) | `memory` en desarrollo, `http` en producción |

Usa `PLAYER_INVENTORY_BASE_URL`, `INTERNAL_SERVICE_AUTH_SECRET` e `INTERNAL_HTTP_TIMEOUT_MS`, los mismos de la reserva del héroe. Corre en el ciclo del planificador (`MISSION_EXECUTION_ENABLED`).

## Criterios de aceptación

| Criterio                                                           | Estado                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| CA-01: registrar el encuentro y entregar la épica                  | Missions registra y pide la entrega; demostrado con los dobles. La acreditación real depende de Player/Inventory (HU-32) |
| CA-02: registrar la aparición o no aparición según la probabilidad | Missions envía la probabilidad y registra el resultado; la tirada es de Combat                                           |
| CA-03: sin épica si el Máster no cae                               | Hecho: sin derrota no hay entrega, y el motor lo impide                                                                  |
| CA-04: dos niveles por encima y estadísticas superiores            | Missions envía `levelOffset: 2` y exige el mismo en la evidencia; la fórmula es del PO y la aplica Combat                |

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                                                                     | Depende de                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| La tirada, el encuentro y las estadísticas del Máster                                                                         | Combat (Team Alfa), con la ruta de simulación de HU-72 |
| Que Player/Inventory acepte a `missions` en `inventory/grants` y acredite épicas                                              | Team Alfa (ADR-019 y HU-32)                            |
| La épica como producto de Catalog (`productId`)                                                                               | Dueño de Catalog (decisión 7)                          |
| Cómo revisar un rechazo: Player/Inventory conserva el `422` de esa operación, así que reintentar exige un `operationId` nuevo | Decisión del equipo (decisión 7 del diseño)            |
| Fuente y unidad de la probabilidad, puntos y tope por tipo de misión                                                          | Decisiones del PO (1 y 4)                              |
| Nivel del héroe y fórmula de «estadísticas superiores»                                                                        | Decisiones del PO (2 y 3)                              |
| Épica ya obtenida y Máster posibles por tipo de héroe                                                                         | Decisiones del PO (6 y 9)                              |
| Carga de contenido con validación                                                                                             | Decisión 7 de HU-70                                    |
| Matriz completa de pruebas                                                                                                    | HU-73.3                                                |

## Cómo integrarse

- **Combat:** recibe el bloque `master` de la solicitud y devuelve en `summary.master` las evaluaciones y los encuentros del contrato, con el mismo `levelOffset`.
- **Player/Inventory:** añadir `missions` a los servicios autorizados de `inventory/grants`; el cuerpo es el de HU-59 sin cambios.
- **Catalog:** publicar la épica como producto y poner su `productId` en `epic.productId`; las entregas en espera siguen solas.
- **HU-10:** el hecho `MissionSettled` trae `masterEncounters`.
- **HU-76 (hecho en HU-76.2):** lee de `mission_master_encounters` los Máster derrotados y el estado de la entrega de cada épica, y cuenta las entregadas (`GRANTED`) de cada jugador para evaluarlo otra vez cuando una llega tarde. Ver [hu-76-logros.md](hu-76-logros.md).
- **Migraciones:** esta es la `006`. HU-76 añadió la `007`; la siguiente historia usa la `008`.

## Pruebas

| Suite                                        | Qué demuestra                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hu-73-domain.spec.ts`             | P-X5 con C-1, C-2 y las referencias repetidas, la probabilidad por subtipo, la evidencia de M-1 a M-6 con uno y dos candidatos, cada forma de evidencia que no cuadra, dos Máster derrotados, M-7 y la entrega  |
| `test/unit/hu-73-use-cases.spec.ts`          | P-01 a P-03 y P-05 sobre el cierre real, M-6, P-X5, la evidencia dudosa, el producto congelado, la espera sin producto, el rechazo, la anulación, los fallos aplazados, el contenido roto y el detalle de HU-70 |
| `test/unit/hu-73-adapters.spec.ts`           | El cliente de entregas contra el contrato de HU-59, los dobles, el repositorio en memoria, el doble de Combat, la configuración y el planificador                                                               |
| `test/integration/hu-73-master-http.spec.ts` | La aplicación completa: matrícula, ciclo del planificador, épica entregada una vez, reporte, historial y detalle                                                                                                |
| `test/db/hu-73-master-encounters.spec.ts`    | PostgreSQL real: la evidencia en la transacción del cierre, la entrega, su producto y su línea juntos, cada CHECK de la 006, el catálogo sin la clave y el servicio completo                                    |

## Cómo reproducir

```bash
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```
