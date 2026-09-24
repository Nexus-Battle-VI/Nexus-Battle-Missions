# HU-76 — Sistema de logros y reconocimientos (Missions)

- **Task:** HU-76.2 ([Management #388](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/388)).
- **Historia:** [HU-76 #61](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/61) · EPIC-08 · RF-76.
- **Contrato del que parte:** [hu-76-mission-achievements-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/docs/hu-74-reporte-mision/docs/contracts/hu-76-mission-achievements-v1.md), sus [escenarios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/docs/hu-74-reporte-mision/docs/contracts/hu-76-mission-achievements-fixtures-v1.json) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/docs/hu-74-reporte-mision/docs/architecture/hu-76-logros-misiones.md) de la Task HU-76.1 ([#387](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/387)). Se fusionaron con [Infrastructure #136](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/136) en la rama `docs/hu-74-reporte-mision` de la pila de diseños; todavía no están en `develop`.
- **Fuente funcional:** HU-76 y el bloque de logros de la sección 7.8.11 («Sistema de progresión») del documento del curso. Es una lista ilustrativa: no fija el catálogo, los umbrales ni los reconocimientos.

## Qué implementa esta entrega

- `GET /api/v1/missions/me/achievements`: los logros del jugador, cada uno con su estado (`LOCKED`, `IN_PROGRESS` o `UNLOCKED`), su progreso y su reconocimiento, con la forma del contrato (CA-01).
- Un paso nuevo del planificador de HU-72, después de la entrega de épicas de HU-73, evalúa a cada jugador con algo nuevo y desbloquea cada logro cuyo criterio se cumple con evidencia (CA-02). Nunca otorga un logro con progreso parcial ni con un objetivo vacío (CA-03).
- Los cinco criterios del contrato: todas las misiones de una categoría, todos los Máster, misión sin daño, tiempo récord y colección de épicas.
- Un título o una insignia quedan registrados en Missions en el mismo momento del desbloqueo. Un cosmético se pide a Player/Inventory con el contrato de entregas de HU-59, una sola vez y con reintentos, igual que la épica de HU-73.
- El catálogo vive en código y se valida al arrancar. El aprobado está vacío hasta que lo fije el PO (decisión 1). Los siete logros de ejemplo del contrato solo se cargan con `MISSIONS_EXAMPLE_CATALOG=true`.

Missions no calcula daño ni tiempos: lee lo que Combat informó y HU-74 guardó en el reporte. Acreditar un cosmético en el inventario es de Player/Inventory.

## De dónde sale el progreso

Missions **no guarda progreso**. Una sola función (`progressOf`) lo calcula en cada evaluación y en cada consulta con lo que ya guardan otras historias del servicio, así que la evaluación y la consulta nunca discrepan:

| Evidencia                                                                  | Dónde está                                                                       | Quién la escribe                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| Misiones completadas al menos una vez, en cualquier dificultad (P-M10)     | `mission_difficulty_clears`                                                      | El cierre de HU-72 (HU-75)              |
| Daño recibido, duración simulada y encuentros de cada misión completada    | `mission_reports`, con una lectura tolerante propia                              | El cierre de HU-72 (HU-74)              |
| Máster derrotados y estado de la entrega de cada épica                     | `mission_master_encounters` de las matrículas `COMPLETED` o `FAILED` del jugador | El cierre de HU-72 y la entrega (HU-73) |
| Objetivos: misiones activas por categoría, Máster disponibles y sus épicas | Definiciones activas (P-L6)                                                      | Contenido de HU-70                      |

Es el «hecho normalizado» del contrato, visto por jugador en el momento de evaluar. Solo se lee la evidencia que necesitan los logros que el jugador aún no tiene.

## Criterios

| Criterio                | Objetivo                                                                                            | Qué cuenta                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALL_CATEGORY_MISSIONS` | Las misiones activas de la categoría                                                                | Las completadas al menos una vez, en cualquier dificultad y con la categoría que tienen hoy (P-04)                                                                 |
| `ALL_MASTERS_DEFEATED`  | Los Máster disponibles: con una configuración válida y alguna probabilidad mayor que 0, sin repetir | Los derrotados, también en una misión que terminó `FAILED` (L-6)                                                                                                   |
| `ALL_MASTER_EPICS`      | Las épicas de esos Máster, sin repetir                                                              | Con `epicState: CREDITED` (por defecto) solo las entregadas; con `WON`, también las pendientes. Nunca las rechazadas                                               |
| `FLAWLESS_MISSION`      | `count` misiones distintas; 1 por defecto                                                           | Completadas con el daño informado e igual a 0 y el recorrido entero (`encountersCompleted = encountersTotal ≥ 1`), de la primera terminada en adelante             |
| `RECORD_TIME`           | 1                                                                                                   | Una finalización de la misión, y de su dificultad si la regla la fija, con la duración simulada dentro del umbral. La prueba es la mejor marca, como `bestTimesOf` |

Reglas comunes:

- **Un objetivo de 0 no es evaluable.** Un «todas» sin contenido (en el ejemplo, Desafío y Exploración) queda `LOCKED` 0/0 y nunca se otorga (CA-03). El motor lo impone también: `progress_target >= 1 and progress_current >= progress_target`.
- **Un dato que falta no es 0.** Un reporte sin `damageTaken`, de otra versión o con datos que no cumplen no prueba nada (CA-02). La lectura nunca falla por la forma de la foto.
- **Sin umbral no hay tiempo récord.** Con `maxSimulatedDuration: null` (el ejemplo, pendiente de la decisión 3) el logro queda `LOCKED` 0/1 y no se lee ningún reporte para él.
- **La prueba queda guardada:** las referencias que cuentan (misiones, Máster o épicas) y las matrículas que lo demuestran, para que CA-02 se pueda auditar. Los clears no guardan la matrícula: la historia solo lleva referencias.

## Cuándo se evalúa

El planificador de HU-72 corre, en este orden: cierre, épicas de HU-73, logros y cosméticos. Así, una épica entregada en el ciclo ya cuenta para la colección y un cosmético recién desbloqueado se pide en el mismo ciclo. El paso de logros evalúa, de 50 en 50, a cada jugador que:

- tiene un número distinto de hechos `MissionSettled`, también de misiones anuladas: cuentan como disparador, no como evidencia;
- tiene un número distinto de épicas `GRANTED`: una épica que llega semanas después dispara la evaluación sola;
- tiene otra huella: la del catálogo de logros, el contenido activo y `ACHIEVEMENT_POLICY_VERSION`;
- tenía un reintento pendiente que ya venció.

Primero van los que nunca se evaluaron; después, los evaluados hace más tiempo. Los conteos se leen **antes** que la evidencia. Como todas las fuentes solo crecen y el cierre escribe hecho, clear, reporte y evidencia del Máster en una misma transacción, una evidencia que llegue entre medias provoca como mucho una evaluación de más, nunca un desbloqueo perdido.

En una transacción se guardan los desbloqueos nuevos y el punto de control del jugador (lo que se vio y la huella). **Repetir no duplica nada (P-05):** un logro se otorga una sola vez por jugador (clave primaria), y un jugador sin cambios no se vuelve a evaluar. Si la evaluación de un jugador falla, los demás siguen y ese se aplaza a los 5 s, 30 s, 2 min y 10 min, y después cada 10 min. El fallo se registra como `achievement_evaluation_error`, sin el identificador del jugador.

## Reconocimientos

| Reconocimiento     | Qué hace Missions                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `TITLE` y `BADGE`  | Quedan `RECORDED` en la misma fila del desbloqueo y se muestran en la consulta. No llaman a nadie                                      |
| `COSMETIC_PRODUCT` | Nace `PENDING` y se pide a Player/Inventory: `POST /api/internal/v1/inventory/grants` con un producto y `quantity: 1`, como `missions` |

La entrega del cosmético repite el patrón de la épica de HU-73. El `operationId` es un UUID versión 5 del jugador y el logro, sin la versión: nunca hay dos entregas. El producto sale del catálogo vigente y **se congela antes del primer envío**, con una escritura condicional que ningún guardado posterior cambia. Nunca hay una transacción abierta durante la llamada.

| Situación                                                 | Qué hace Missions                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `200` de la misma operación                               | `CREDITED`, con su fecha                                                                          |
| `422` o `400`                                             | `FAILED`, definitivo y visible en la consulta: Player/Inventory responde lo mismo a esa operación |
| `409`, `401`, `404`, `5xx`, tiempo agotado o red          | Sigue `PENDING`; se reintenta con el mismo `operationId` y el escalonado de HU-72                 |
| Sin `productId` de Catalog, o el logro ya no es cosmético | Sigue `PENDING` con `RECOGNITION_PRODUCT_MISSING`, sin llamar a Player/Inventory                  |
| Un error interno                                          | Se registra como `achievement_recognition_error` y la entrega se aplaza (`INTERNAL_ERROR`)        |

## La consulta

`GET /api/v1/missions/me/achievements` requiere un JWT con el rol `PLAYER`; el jugador sale siempre del token y un `?playerId=` se ignora. Devuelve un elemento por logro del catálogo y, además, los desbloqueados que ya no estén en él:

- Solo es `UNLOCKED` lo que está guardado, con el progreso, el nombre y el reconocimiento **congelados** del momento del desbloqueo (P-L5): no cambian aunque cambie el catálogo o crezca el objetivo, y nada se revoca.
- El resto se calcula al leer: `IN_PROGRESS` si hay algo de progreso y `LOCKED` si no; `unlockedAt` y `recognition.status` quedan en `null`. Un criterio ya cumplido que el evaluador aún no guardó se ve `IN_PROGRESS` con el progreso completo, como mucho durante un ciclo: la consulta nunca desbloquea.
- Orden: primero los desbloqueados, del más reciente al más antiguo (a igual momento, en el orden del catálogo); después el resto, en el orden del catálogo. Reproduce el ejemplo del contrato.
- `401` sin token, `403` sin el rol `PLAYER` y `503 DEPENDENCY_UNAVAILABLE` ante un fallo inesperado, sin detalle. Un reporte de otra versión no da `503`.

## Diferencias con el diseño

| Diseño o contrato                                                                        | Implementación                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tabla `achievement_progress` con conjuntos por jugador (P-L3)                            | No hay tabla de progreso: se calcula en cada evaluación y en cada consulta con los clears, los reportes, la evidencia del Máster y el contenido activo. Así no hay una segunda fuente de verdad que pueda divergir ni actualizaciones perdidas entre dos procesos. |
| `achievement_processed_facts` y marcar el hecho procesado (P-L4, pasos 2 y 6 de CU-76.1) | Un punto de control por jugador con el número de `MissionSettled`, el de épicas `GRANTED` y la huella. `mission_facts.processed_at` no se toca: es de HU-72, y HU-10 y el aviso de fin de misión siguen viendo los hechos.                                         |
| `FOR UPDATE SKIP LOCKED`                                                                 | Las lecturas no bloquean filas y las escrituras son idempotentes o condicionales, como en HU-72. Hay una réplica (ADR-019).                                                                                                                                        |
| El hecho `MissionFinishedForAchievements` se arma al cerrar                              | No se arma ni se guarda: es la evidencia del jugador al evaluar. `epicsCredited` es el estado actual de cada entrega. El `payload` de `MissionSettled` no cambia.                                                                                                  |
| Tabla `achievement_definitions`                                                          | El catálogo vive en código, detrás de `AchievementCatalogPort`, y se valida al arrancar. `APPROVED_ACHIEVEMENTS` queda vacío hasta la decisión 1. Se conserva la versión de cada logro (P-L1 en parte).                                                            |
| Tabla `achievement_recognition_grants`                                                   | La entrega va en la fila del desbloqueo, con lo que añadió HU-73: intentos, próximo intento, último error, producto congelado y fecha de acreditación.                                                                                                             |
| Nombres de tablas `achievement_*`                                                        | Llevan el prefijo `mission_` y las restricciones, nombres en español. Sin claves foráneas.                                                                                                                                                                         |
| Las misiones `ABANDONED` y `VOIDED` no generan el hecho (línea 55 del contrato)          | Las anulaciones sí generan `MissionSettled` (`VOIDED`): cuentan como disparador, pero no aportan evidencia.                                                                                                                                                        |
| Misión sin daño (P-L8)                                                                   | Más estricta: hace falta el reporte, el daño informado e igual a 0 (`null` no cuenta) y el recorrido completo. No se usa `minHealthPercent`.                                                                                                                       |
| Máster disponibles (P-L6)                                                                | Solo configuraciones válidas y candidatos con probabilidad mayor que 0, sin repetir `masterRef`. Las épicas se cuentan por `epicRef`, sin repetir.                                                                                                                 |
| «Todas» con un objetivo vacío                                                            | No es evaluable: queda `LOCKED` 0/0, y el CHECK del progreso lo impone en el motor (CA-03).                                                                                                                                                                        |
| Qué pasa al ampliar el catálogo                                                          | Hay retroactividad: al añadir un logro o cambiar el contenido o la política cambia la huella y se reevalúa a todos, y lo que ya se cumplía se otorga. P-L5 se mantiene: nada se revoca.                                                                            |
| `unlockedAt`                                                                             | Es el momento de la evaluación, no `settledAt` ni `finishedAt`. La prueba guarda referencias y matrículas.                                                                                                                                                         |
| Parámetros del ejemplo del contrato                                                      | Se añaden opcionales, con el valor del contrato por defecto: `FLAWLESS_MISSION.count` (1), `RECORD_TIME.difficulty` (`null`: cualquiera) y `ALL_MASTER_EPICS.epicState` (`CREDITED`, decisión 6).                                                                  |
| Un cliente para los cosméticos                                                           | Se reutiliza el de las épicas de HU-73 (`RECOGNITION_GRANTS` con `useExisting: EPIC_GRANTS`), con su propio espacio de nombres UUID. No hay variable de entorno nueva.                                                                                             |
| La consulta devuelve `UNLOCKED` al cumplirse el criterio                                 | Solo si el desbloqueo está guardado; hasta el ciclo siguiente se ve `IN_PROGRESS` con el progreso completo. Orden: desbloqueados primero y después el catálogo.                                                                                                    |
| Leer los reportes del jugador                                                            | Con una proyección SQL tolerante propia, no con `ReportRepositoryPort.listByPlayer`, que falla ante una foto de otra versión.                                                                                                                                      |
| L-8: «dos de tres» en la prosa del diseño                                                | Se sigue el escenario (1 de 2). Los escenarios L-1 a L-7 no traen encuentros ni estado de la entrega: las pruebas los añaden.                                                                                                                                      |
| Planificador de HU-72                                                                    | Cambio fuera de HU-76, a propósito: cada paso tiene su propio control de errores. Un paso que falla ya no impide que corran los siguientes, y `mission_execution_failed` lleva el campo `step`.                                                                    |

## Modelo de datos

La migración `009-mission-achievements` crea dos tablas, sin claves foráneas (`player_id` es el `sub` del proveedor de identidad), así que los `truncate` de las pruebas de HU-72, HU-73 y HU-74 no cambian:

- `mission_achievement_unlocks`: un desbloqueo por jugador y logro (clave primaria `player_id`, `achievement_id`), con la versión y el criterio, el nombre, el progreso congelado, la prueba en `jsonb`, el reconocimiento y, en un cosmético, su entrega. `grant_operation_id` es único y un índice parcial sirve las entregas pendientes. Los CHECK imponen que el progreso esté completo con un objetivo de verdad, que los vocabularios sean los del contrato, que solo un cosmético tenga entrega y estados de entrega, que un pendiente tenga próximo intento, y que uno acreditado tenga fecha y producto.
- `mission_achievement_evaluations`: el punto de control técnico de cada jugador (conteos vistos, huella, fecha y reintento). Borrarlo no cambia ningún resultado: solo hace que se vuelva a evaluar.

## Configuración

No hay variables nuevas. La evaluación y la entrega corren en el ciclo del planificador (`MISSION_EXECUTION_ENABLED`, apagado por defecto, y `MISSION_EXECUTION_INTERVAL_MS`). `EPIC_GRANTS_DRIVER` gobierna las dos entregas: la épica y el cosmético. `MISSIONS_EXAMPLE_CATALOG=true`, que ya exige persistencia en memoria, carga también los logros de ejemplo.

`ACHIEVEMENT_POLICY_VERSION` vive en `AchievementPolicy`: se sube cuando cambia cómo se evalúa un criterio, y así se reevalúa a todos, también a quien ya no juega.

## El ejemplo y la producción

Con `MISSIONS_EXAMPLE_CATALOG=true` y el doble de Combat (`COMBAT_SIMULATION_DRIVER=memory`), la demo local se ve así. **Nada de esto acredita CA-02 ni CA-03**: el doble nunca recibe daño y su resultado es fijo.

- La historia se desbloquea al completar el Templo y la Cámara.
- Desafío y Exploración quedan `LOCKED` 0/0: el ejemplo no tiene misiones de esas categorías.
- El cazador y el coleccionista quedan `LOCKED` 0/1: el doble solo saca un Máster con probabilidad 1 y el del ejemplo tiene 0,15.
- «Sin un rasguño» se desbloquea en la primera misión, porque el doble siempre da `damageTaken: 0`.
- El tiempo récord no se evalúa: no hay umbral.

El catálogo aprobado de logros sigue vacío y la ruta responde `200 { items: [] }` hasta que se publiquen sus definiciones. Las dos definiciones de misión jugables y la simulación de Combat están preparadas en las PR de Missions y Combat; el planificador debe habilitarse en el despliegue.

## Criterios de aceptación

| Criterio                                                            | Estado                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CA-01: registrar el logro en el perfil y entregar su reconocimiento | Missions registra el logro y su título o insignia, y los expone en la consulta; mostrarlos en el perfil es de Web (HU-76.3). El cosmético se pide, pero su acreditación real depende de Player/Inventory y Catalog |
| CA-02: otorgar solo con evidencia                                   | Hecho con la evidencia que guardan HU-72 a HU-75, y demostrado con evidencia sembrada. La evidencia real del daño y del tiempo llegará cuando Combat simule                                                        |
| CA-03: nunca con progreso parcial                                   | Hecho: el evaluador exige el progreso completo con un objetivo de al menos 1, y el motor lo impone                                                                                                                 |

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                                                                                    | Depende de                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Aprobar las diferencias estructurales (sin tabla de progreso, sin registro de hechos procesados y catálogo en código)                        | PO y SM; y publicar el diseño y el contrato en `develop` de Infrastructure (ADR-019)         |
| El catálogo definitivo: ids, nombres, reconocimientos y versión. Se recomienda empezar con títulos e insignias                               | Decisión 1 del PO                                                                            |
| El umbral de tiempo récord por misión, y si depende de la dificultad o es un récord personal                                                 | Decisión 3 del PO                                                                            |
| Qué Máster cuentan como disponibles: con probabilidades del 0,01 % al 0,1 %, el logro es casi inalcanzable                                   | P-L6, PO                                                                                     |
| «Sin daño»: `damageTaken = 0` o `minHealthPercent = 100`, la guarda del recorrido completo y el plural del curso (`count`)                   | P-L8, PO y Team Alfa                                                                         |
| Si la colección cuenta la épica acreditada (`CREDITED`) o la ganada (`WON`)                                                                  | Decisión 6 del PO                                                                            |
| Si se quiere retroactividad al cargar o ampliar el catálogo; si no, un `effectiveFrom` por logro                                             | PO                                                                                           |
| Dónde viven títulos e insignias: en Missions, leídos por la consulta, o en Account, cuyo `PATCH` hoy no los admite                           | Decisión 4; Team Alfa                                                                        |
| Que Player/Inventory acepte a `missions` en `inventory/grants`, que Catalog tenga un tipo cosmético y la política de reentrega tras un `422` | Team Alfa (ADR-019) y Team Gama (ADR-013); decisión del equipo                               |
| Los logros como datos personales exportables: no tienen dueño en la matriz de datos y no hay evento de borrado de cuenta                     | Política de privacidad v0.3 (§7.3)                                                           |
| Notificar los logros (7.8.9 y ADR-019): haría falta un _outbox_ a partir de la fila del desbloqueo                                           | Notifications                                                                                |
| Mostrar los logros en el perfil                                                                                                              | HU-76.3 (Web, [#389](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/389)) |
| Matriz completa de pruebas                                                                                                                   | HU-76.4 ([#390](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/390))      |

## Cómo integrarse

- **Web (HU-76.3):** la consulta sigue el contrato. El panel de «Estadísticas y logros» de HU-06 solo admite logros obtenidos y su prueba prohíbe palabras como «bloqueado», «desbloqueo», «nivel» o «puntos»: para reutilizarlo hay que filtrar `UNLOCKED` y mapear `achievementId` a `id` y `unlockedAt` a `obtainedAt`. El contrato no trae descripción. Conviene enlazarlo con la Task [#110](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/110).
- **Player/Inventory:** añadir `missions` a los servicios autorizados de `inventory/grants`; el cuerpo es el de HU-59 sin cambios.
- **Catalog:** publicar el cosmético como producto y poner su `productId` en `recognition.productId`; las entregas en espera siguen solas.
- **PO:** el catálogo aprobado se carga con un PR que rellena `APPROVED_ACHIEVEMENTS`. Al desplegarlo cambia la huella y se evalúa a todos los jugadores, de 50 en 50.
- **HU-10 y el aviso de fin de misión:** `mission_facts.processed_at` sigue siendo de HU-72; los `MissionSettled` no se marcan. Cada consumidor lleva su propio registro.
- **Una fuente nueva de evidencia** debe añadir su contador a `playersToEvaluate` (y al doble en memoria): el detector supone que las fuentes solo crecen y, sin contador, sus cambios no se evaluarán. Para corregir una regla, se sube `ACHIEVEMENT_POLICY_VERSION`.
- **Migraciones:** esta es la `009` (la `007` y la `008` son de HU-09). La siguiente historia usa la `011`.

## Pruebas

| Suite                                              | Qué demuestra                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hu-76-domain.spec.ts`                   | Los escenarios L-1 a L-9 del contrato, CA-02 (un dato que falta no es 0, el recorrido completo, la versión de la foto), CA-03 (objetivo vacío, progreso parcial, `count`), el tiempo récord, el contenido activo y la categoría (P-04), `CREDITED` y `WON`, la conmutatividad, la vista del contrato, cada motivo de catálogo inválido, la huella y la entrega |
| `test/unit/hu-76-use-cases.spec.ts`                | P-01 a P-05 sobre el cierre real de HU-72 y las épicas de HU-73: L-1, L-4 a L-9, la épica que llega tarde, la misión sin reporte, la anulada, el catálogo vacío y la retroactividad, los fallos aplazados y cada camino del cosmético                                                                                                                          |
| `test/unit/hu-76-adapters.spec.ts`                 | Los dobles en memoria (selección, orden, límite, escrituras condicionales y evidencia), el catálogo estático y el planificador con sus cuatro pasos aislados                                                                                                                                                                                                   |
| `test/integration/hu-76-achievements-http.spec.ts` | La aplicación completa: dos misiones por HTTP y el ciclo del planificador, la respuesta y el orden del contrato, el cosmético entregado una vez, el aislamiento entre jugadores, `401` y `403`, el catálogo vacío y el de ejemplo                                                                                                                              |
| `test/db/hu-76-achievements.spec.ts`               | PostgreSQL real: cada CHECK de la `009`, la detección con SQL, la lectura tolerante de los reportes, la transacción, dos evaluadores a la vez, L-9, `processed_at` intacto y el servicio completo                                                                                                                                                              |

La CI corre `test:db` con PostgreSQL 17 en Testcontainers; en local se verificó con PostgreSQL 16.

## Cómo reproducir

```bash
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```
