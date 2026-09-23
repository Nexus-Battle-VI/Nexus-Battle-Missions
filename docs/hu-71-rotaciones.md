# HU-71 — Configuración de rotaciones de habilidades (Missions)

- **Task:** HU-71.2 ([Management #370](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/370)).
- **Historia:** [HU-71 #56](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/56) · EPIC-08 · RF-71.
- **Contrato del que parte:** [hu-71-mission-strategy-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-71-mission-strategy-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-71-rotaciones-habilidades.md) de la Task HU-71.1 ([#369](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/369)), en revisión en [Infrastructure #133](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/133).
- **Fuente funcional:** HU-71 y las secciones 7.8.5 (rotaciones y lógica de decisión) y 7.8.12 (configuraciones guardadas) del documento del curso.

## Qué implementa esta entrega

- `GET /api/v1/missions/{missionId}/strategies/{heroId}` (JWT, rol `PLAYER`): la estrategia que el jugador guardó para ese héroe en esa misión, con su versión. Sin estrategia: `404 STRATEGY_NOT_FOUND`.
- `PUT /api/v1/missions/{missionId}/strategies/{heroId}`: guarda hasta tres rotaciones. Responde `201` al crear la versión 1 (`expectedVersion: null`) y `200` al reemplazar la versión leída.
- La matrícula de HU-70 compara `strategyVersion` con la estrategia guardada y congela una copia de sus rotaciones. Editar la estrategia después no cambia una misión ya iniciada.
- La migración `003-mission-strategies`.

El jugador sale siempre del testimonio: nadie lee ni guarda la estrategia de otro.

## Reglas aplicadas

| Regla                                                                                       | Tipo                         | Dónde                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| Hasta tres rotaciones; una cuarta es `422 TOO_MANY_ROTATIONS`, no un `400`                  | Requisito explícito (CA-04)  | `StrategyPolicy.assertRotationShape` y CHECK del motor      |
| Prioridades Alta, Media y Baja, en ese orden y sin huecos                                   | Propuesta P-R2               | `StrategyPolicy.rotationViolations`                         |
| Entre una y tres acciones por rotación                                                      | Propuesta P-R3               | `StrategyPolicy.rotationViolations`                         |
| Cada `ABILITY` usa una habilidad que el héroe tiene                                         | Propuesta P-R4               | `StrategyPolicy.assertAbilitiesKnown` y `HeroAbilitiesPort` |
| La estrategia es por jugador, héroe y misión, y la matrícula la congela                     | Propuesta P-R1               | `mission_strategies` y `EnrollInMission`                    |
| La matrícula lleva `strategyVersion`; si no es la guardada, `409 STRATEGY_VERSION_MISMATCH` | Propuesta P-R8               | `StrategyPolicy.assertStrategyVersionMatches`               |
| Sin estrategia guardada, la matrícula sigue adelante sin rotaciones                         | Propuesta P-R9               | `EnrollInMission`                                           |
| Dos ediciones no se pisan: cada guardado indica la versión que leyó                         | Versión optimista del diseño | `PostgresStrategyRepository.save`                           |

Orden de validación del guardado, como fija el contrato: cuerpo (`400 VALIDATION_ERROR`), misión (`404`), cantidad de rotaciones (`422 TOO_MANY_ROTATIONS`), prioridades y acciones (`422 INVALID_ROTATION`), el héroe y sus habilidades en Player/Inventory (`422 HERO_NOT_OWNED`, `422 UNKNOWN_ABILITY` o `503`) y la versión (`409 VERSION_CONFLICT`). La versión se comprueba en la misma escritura, así que dos guardados simultáneos no se pisan.

## Lo que Missions NO hace

La decisión de cada turno es de Combat (ADR-019 y ADR-021): qué rotación es viable por Poder, recarga y salud (CA-02), el ataque básico de respaldo sin consumir Poder (CA-03), el cursor de cada rotación y la anotación en la bitácora (propuestas P-R5 a P-R7). Missions guarda la estrategia, la valida y congela la copia que HU-72 enviará a Combat en el bloque `strategy` de la simulación.

## Habilidades del héroe en Player/Inventory

`PlayerInventoryAbilitiesClient` consulta las habilidades de un héroe concreto. **Esa ruta todavía no existe**: es la decisión 7 del diseño, abierta con Team Alfa. Hoy Player/Inventory solo publica el héroe _seleccionado_ del jugador (`equipped-hero`, para Combat), y `missions` no está entre sus servicios autorizados. La propuesta mantiene la misma forma para cualquier héroe del jugador:

- `GET /api/internal/v1/players/{playerId}/heroes/{heroId}`, firmado con HMAC como el resto del contrato interno. Un `GET` se firma con cuerpo vacío, y el jugador y el héroe van en la ruta porque Player/Inventory firma la ruta sin la consulta.
- `200` con el cuerpo de `equipped-hero`: se leen `heroId` y `abilities[].abilityId`. Si el cuerpo no cumple, no se inventa una lista vacía.
- `404` con `code: HERO_NOT_OWNED`: el héroe no es de ese jugador. El `404` de una ruta inexistente no trae `code` y es un resultado desconocido.

Cualquier resultado desconocido responde `503 DEPENDENCY_UNAVAILABLE` y la estrategia no se guarda sin validar. Con `HERO_ABILITIES_DRIVER=memory`, un doble de desarrollo da a todo héroe las habilidades del ejemplo del curso; con `NODE_ENV=production` el servicio no arranca en ese modo. Los `abilityId` reales son `productId` de Catalog: Missions acota la forma, pero el vocabulario es de Catalog.

## Modelo de datos

La migración `003-mission-strategies`:

- Crea `mission_strategies`, con clave primaria (`player_id`, `hero_id`, `mission_id`), `rotations` en `jsonb`, `version` y `updated_at`. Los CHECK `mission_strategies_entre_una_y_tres` y `mission_strategies_version_positiva` impiden, aun escribiendo a mano, una cuarta rotación o una versión no positiva.
- Añade `mission_enrollments.rotations` (`jsonb`, `[]` por defecto) con el CHECK `mission_enrollments_estrategia_congelada`: una matrícula sin versión no lleva copia y una con versión sí, de hasta tres rotaciones. La entidad `MissionEnrollment` impone lo mismo al crearse.

El guardado usa `insert ... on conflict do nothing` para la primera versión y `update ... where version = esperada` para las siguientes. Cero filas escritas es `VERSION_CONFLICT`, con la versión que hay ahora.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                     | Depende de                                                 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Habilidades por `heroId` en Player/Inventory, y autorizar a `missions`        | Team Alfa (decisión 7 del diseño)                          |
| Aplicar la estrategia en cada turno y anotarlo en la bitácora (CA-02 y CA-03) | Combat (Team Alfa); HU-72.2 ya le envía la copia congelada |
| Editor de rotaciones en Web                                                   | HU-71.3                                                    |
| Qué es el «estado de salud del héroe» en la viabilidad                        | Decisión del PO (decisión 5)                               |
| Si la habilidad épica cabe en una rotación                                    | HU-31 y el PO (decisión 6)                                 |
| Si la estrategia es por misión o reutilizable entre misiones                  | Decisión del PO (decisión 1)                               |

## Cómo integrarse

- **Web (HU-71.3):** un `404 STRATEGY_NOT_FOUND` significa que aún no hay estrategia. Guarda con la `expectedVersion` que leyó; ante `409 VERSION_CONFLICT`, recarga antes de volver a guardar. Al matricularse envía la versión que muestra, y ante `409 STRATEGY_VERSION_MISMATCH` recarga la estrategia. Sin estrategia debe avisar de que la IA solo usará el ataque básico (P-R9).
- **HU-72.2 (hecho):** `simulationRequestFor` arma el bloque `strategy` con `strategyVersion` y `rotations` de la matrícula, más `fallback: BASIC_ATTACK`. Si `rotations` está vacío, todas las acciones son el respaldo. Ver [hu-72-simulacion.md](hu-72-simulacion.md).
- **Migraciones:** esta es la `003`. HU-72 añadió la `004`.

## Pruebas

| Suite                                            | Qué demuestra                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hu-71-domain.spec.ts`                 | Forma de la estrategia regla por regla, habilidades conocidas, la tabla de versiones de la matrícula y el invariante de la copia congelada                                   |
| `test/unit/hu-71-use-cases.spec.ts`              | Los escenarios P-01, P-04 y T-01 a T-04 del diseño, el orden de validación y el congelado en la matrícula, también cuando la estrategia cambia después                       |
| `test/unit/hu-71-adapters.spec.ts`               | Doble en memoria, cliente de Player/Inventory (firma del `GET`, 404 de negocio frente a 404 de ruta inexistente, registro sin identificadores), códigos HTTP y configuración |
| `test/integration/hu-71-strategies-http.spec.ts` | Las dos rutas con JWT y rol: `201` y `200`, los cuerpos del contrato, las validaciones `400`, el aislamiento entre jugadores y el congelado por la matrícula real            |
| `test/db/hu-71-strategies.spec.ts`               | PostgreSQL real: bloqueo optimista con guardados simultáneos, los CHECK de la migración 003 y el servicio completo con `PERSISTENCE_DRIVER=postgres`                         |

## Cómo reproducir

```bash
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```

Prueba local con el catálogo de ejemplo, sin Cognito:

```bash
npm run build
NODE_ENV=development AUTH_MODE=disabled PERSISTENCE_DRIVER=memory MISSIONS_EXAMPLE_CATALOG=true PORT=3000 node dist/main.js
curl -X PUT http://localhost:3000/api/v1/missions/msn_templo_olvidado/strategies/7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60 \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":null,"rotations":[{"priority":"HIGH","steps":[{"kind":"ABILITY","abilityId":"golpe-de-tormenta"},{"kind":"BASIC_ATTACK"}]}]}'
curl -X POST http://localhost:3000/api/v1/missions/msn_templo_olvidado/enrollments \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f' \
  -d '{"heroId":"7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60","difficulty":"NORMAL","strategyVersion":1}'
```

El `PUT` responde `201` con la versión 1 y la matrícula `201` con la estrategia congelada. Repetir el `PUT` con `"expectedVersion":1` responde `200` con la versión 2; volver a usar la versión 1 responde `409 VERSION_CONFLICT`.
