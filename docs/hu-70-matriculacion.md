# HU-70 — Matriculación en una misión (Missions)

- **Task:** HU-70.2 ([Management #366](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/366)).
- **Historia:** [HU-70 #55](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/55) · EPIC-08 · RF-70.
- **Contrato del que parte:** [hu-70-mission-enrollment-v1](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-70-mission-enrollment-v1.md) y el [diseño](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/architecture/hu-70-matriculacion-mision.md) de la Task HU-70.1 ([#365](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/365)), en revisión en [Infrastructure #131](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/131). Con dos extensiones: `difficulty` de HU-75 ([Infrastructure #125](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/125)) y `strategyVersion` de HU-71 ([Infrastructure #133](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/pull/133)).
- **Fuente funcional:** HU-70 y la sección 7.8 del documento del curso. El ejemplo es la misión de 7.8.14.

## Qué implementa esta entrega

- `GET /api/v1/missions` (JWT, rol `PLAYER`): el tablón, con los filtros opcionales `category` y `status`. Cada tarjeta trae `playerStatus`, `canEnroll`, `lockReason` y `activeEnrollmentId`, derivados para el jugador del testimonio.
- `GET /api/v1/missions/{missionId}`: el detalle con todos los bloques de CA-06. Una misión sin Máster muestra probabilidad `0` y ningún candidato. Si no existe o no está activa: `404 MISSION_NOT_FOUND`.
- `POST /api/v1/missions/{missionId}/enrollments` con la cabecera `Idempotency-Key` obligatoria. Valida en el orden del contrato, guarda la intención `PENDING`, reserva al héroe en Player/Inventory (compromiso `MISSION`) y confirma `IN_PROGRESS` con `startedAt` y `endsAt`. En la misma transacción registra el hecho interno `MissionEnrollmentStarted`, que consume HU-72 ([hu-72-simulacion.md](hu-72-simulacion.md)).
- Un reconciliador de matrículas `PENDING`, apagado por defecto.
- `400 VALIDATION_ERROR` con la forma común `{ code, message }` en todas las rutas. Lo produce `createValidationPipe`, que usan `main.ts` y las pruebas.
- La migración `002-mission-enrollments`.

## Reglas aplicadas

| Regla                                                                                        | Tipo                                      | Dónde                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Matricular exige misión activa, requisitos previos cumplidos y héroe libre                   | Requisito explícito (CA-01, CA-02, CA-07) | `application/use-cases/EnrollInMission.ts`             |
| Un requisito previo se cumple con al menos un _clear_ de esa misión, en cualquier dificultad | Propuesta P-M10                           | `DifficultyClearRepositoryPort.completedMissions`      |
| Nivel de dificultad desbloqueado                                                             | HU-75                                     | `DifficultyPolicy.assertDifficultyUnlocked`            |
| Primero lo de la misión y después lo del héroe                                               | Propuesta P-M4                            | `EnrollInMission.ts`                                   |
| Héroe ocupado: `409 HERO_BUSY`. Misión bloqueada: `422 MISSION_LOCKED`                       | Propuesta P-M5                            | `missions-error.mapper.ts`                             |
| Una matrícula activa por jugador y misión                                                    | Propuesta P-M2                            | Índice `mission_enrollments_jugador_mision_activa`     |
| Un héroe no está en dos matrículas activas                                                   | CA-02 y ADR-019                           | Índice `mission_enrollments_heroe_activo`              |
| `Idempotency-Key` obligatoria; repetirla devuelve lo guardado                                | Propuesta P-M3                            | Controlador y `EnrollInMission`                        |
| Estados de la matrícula; activos: `PENDING` e `IN_PROGRESS`                                  | Propuesta P-M1                            | `domain/entities/MissionEnrollment.ts`                 |
| La disponibilidad del héroe y el mazo completo los evalúa Player/Inventory                   | Propuestas P-M6 y P-M7                    | `HeroCommitmentPort`                                   |
| `PENDING` dura 2 minutos; el compromiso caduca en `requestedAt + 2 min + duración + 30 min`  | Propuesta P-M8                            | `EnrollInMission.ts`, `ReconcilePendingEnrollments.ts` |
| El temporizador es un dato: `startedAt` y `endsAt` se fijan al confirmar                     | Propuesta P-M9                            | `confirmEnrollment`                                    |
| El poder recomendado es informativo y no bloquea                                             | Propuesta P-M11                           | Tablón y detalle                                       |
| `strategyVersion` debe coincidir con la estrategia guardada                                  | Extensión de HU-71                        | `EnrollInMission.ts`                                   |

## Reserva del héroe en Player/Inventory

Sigue el patrón de reserva de ADR-019: primero se guarda la intención con su `operationId`, después se reserva con el dueño del héroe y al final se confirma o se compensa.

- `PlayerInventoryCommitmentClient` llama a `POST /api/internal/v1/inventory/heroes/{heroId}/commitments` y a `POST /api/internal/v1/inventory/commitments/{operationId}/release`. Firma con HMAC la ruta completa, porque Player/Inventory verifica `originalUrl`.
- Solo `201`, `200` y `422` son respuestas definitivas. Un `404`, `409` o `5xx`, un tiempo agotado o un error de red son un resultado desconocido: la matrícula sigue `PENDING` y el jugador recibe `503 DEPENDENCY_UNAVAILABLE` con `enrollmentStatus: PENDING`.
- **Esas rutas todavía no existen en Player/Inventory**: son la propuesta del contrato para Team Alfa. Con `HERO_COMMITMENTS_DRIVER=http`, que es el valor de producción, toda matrícula queda `PENDING` hasta que existan. Es el resultado honesto, no un fallo.
- `HERO_COMMITMENTS_DRIVER=memory` es un doble de desarrollo que concede la reserva salvo que el héroe ya tenga otra. Con `NODE_ENV=production` el servicio no arranca en ese modo.
- Con `ENROLLMENT_RECONCILER_ENABLED=true`, el reconciliador revisa cada `ENROLLMENT_RECONCILER_INTERVAL_MS` las matrículas `PENDING` de más de 10 segundos y las reintenta con el mismo `operationId`. Pasados 2 minutos sin confirmación, libera la reserva. Solo marca `EXPIRED` si Player/Inventory confirma esa liberación.

**Antes de cargar misiones en producción** debe existir la ruta de Player/Inventory. Hoy el catálogo de PostgreSQL está vacío y nadie puede matricularse. Con misiones pero sin esa ruta, cada matrícula quedaría `PENDING` y ocuparía al héroe y a la misión de ese jugador: sin liberación confirmada no se puede marcar `EXPIRED`.

## Modelo de datos

La migración `002-mission-enrollments` crea tres tablas:

- `mission_definitions`: lo que muestra el tablón. Objetivos, enemigos, jefe, Máster y recompensas van en `content` (`jsonb`), que se lee entero.
- `mission_enrollments`: una fila por matrícula, con `version` para el bloqueo optimista de cada transición.
- `mission_facts`: hechos internos. HU-72 marca `processed_at` al programar la simulación de cada `MissionEnrollmentStarted`.

Las invariantes viven en el motor:

- Los índices únicos parciales `mission_enrollments_heroe_activo` y `mission_enrollments_jugador_mision_activa` solo cuentan las matrículas `PENDING` e `IN_PROGRESS`.
- Hay una clave única por jugador (`mission_enrollments_clave_idempotencia`) y un `operation_id` único.
- Los CHECK impiden un estado, un nivel o una categoría fuera del vocabulario y una duración no positiva. Una matrícula `IN_PROGRESS` exige inicio, fin posterior y compromiso; una `REJECTED` exige motivo.
- `mission_facts_un_hecho_por_tipo`: un hecho por tipo y matrícula, aunque la transición se reintente.

El repositorio no lee antes de escribir para «comprobar», porque bajo concurrencia esa lectura mentiría: inserta y traduce la restricción violada al conflicto que entiende el caso de uso. `player_id` y `hero_id` no son claves foráneas (ADR-005).

Una fila que viola varias restricciones solo informa la primera que el motor comprueba, y ese orden no está garantizado. El reintento simultáneo de una pulsación viola a la vez la clave, el héroe y la misión. Por eso, ante cualquier conflicto con una matrícula activa, el caso de uso mira primero si es la de la misma clave del mismo jugador. Si lo es, repite esa matrícula en lugar de responder que el héroe o la misión están ocupados.

## Lo que queda pendiente, y de qué depende

| Pendiente                                                                            | Depende de                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Rutas de compromiso y de liberación en Player/Inventory                              | Team Alfa, con la propuesta del contrato de HU-70                     |
| Misiones reales en el catálogo de PostgreSQL                                         | Contenido aprobado por el PO; hoy solo existe el ejemplo en memoria   |
| Qué es «mazo completo»                                                               | Decisión del PO (P-M7)                                                |
| Abandonar una matrícula en curso (`ABANDONED`)                                       | Decisión del PO: no hay contrato de cancelación (decisión 3 de HU-72) |
| Rechazar JcJ, torneo o cambios de equipo mientras la matrícula está en curso (CA-05) | Combat, Torneo y Player/Inventory, con el compromiso vigente          |
| Mensajes que nombren las ranuras que faltan                                          | Los nombres de familia y de ranura, que fija Player/Inventory         |

## Cómo integrarse

- **Web:** genera la `Idempotency-Key` al pulsar «Iniciar misión» y la reutiliza en los reintentos de esa pulsación. Ante un `503` con `enrollmentStatus: PENDING`, reintenta con la misma clave. Muestra `message` tal cual.
- **HU-72.2 (hecho):** consume los `mission_facts` de tipo `MissionEnrollmentStarted`, pide la simulación a Combat y cierra la matrícula con `closeEnrollment` (`COMPLETED`, `FAILED` o `VOIDED`), exigiendo la `version` leída. Libera al héroe con el `operationId` de esta reserva. Ver [hu-72-simulacion.md](hu-72-simulacion.md).
- **HU-71.2 (hecho):** la matrícula compara `strategyVersion` con la estrategia guardada para ese jugador, héroe y misión, y congela una copia de sus rotaciones. Ver [hu-71-rotaciones.md](hu-71-rotaciones.md).
- **Migraciones:** esta es la `002`. HU-71 añadió la `003` y HU-72 la `004`.

## Pruebas

| Suite                                          | Qué demuestra                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/hu-70-domain.spec.ts`               | Transiciones de la matrícula, estado de cada misión para el jugador y motivo de bloqueo                                                                                                                                                                                                              |
| `test/unit/hu-70-use-cases.spec.ts`            | Los escenarios P-01 a P-04, P-06, P-07, T-01, T-03 y T-04 del diseño; la réplica por clave, también cuando el motor informa otra restricción o la ganadora aparece durante las comprobaciones; el reconciliador; y que una matrícula sin terminar no desbloquea Heroico                              |
| `test/unit/hu-70-adapters.spec.ts`             | Dobles en memoria, cliente de Player/Inventory (ruta, cabeceras, firma y cada respuesta), planificador, códigos HTTP y configuración                                                                                                                                                                 |
| `test/integration/hu-70-missions-http.spec.ts` | Las tres rutas con JWT y rol, con los cuerpos del contrato para `201`, `400`, `404`, `409`, `422` y `503`                                                                                                                                                                                            |
| `test/db/hu-70-enrollments.spec.ts`            | PostgreSQL real: los tres índices únicos con escrituras simultáneas (T-02 para el héroe), tres envíos simultáneos de la misma pulsación por el caso de uso (T-01 con concurrencia real), CHECK, transición y hecho en la misma transacción, y el servicio completo con `PERSISTENCE_DRIVER=postgres` |

## Cómo reproducir

```bash
npm ci
npm run test:unit
npm run test:integration
npm run test:db        # requiere Docker: levanta PostgreSQL real con Testcontainers
npm run build
```

Prueba local con el catálogo de ejemplo, sin Cognito:

```bash
npm run build
NODE_ENV=development AUTH_MODE=disabled PERSISTENCE_DRIVER=memory MISSIONS_EXAMPLE_CATALOG=true PORT=3000 node dist/main.js
curl http://localhost:3000/api/v1/missions
curl -X POST http://localhost:3000/api/v1/missions/msn_templo_olvidado/enrollments \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 3b9f6c1e-8d2a-4f7b-9c4e-5a6b7c8d9e0f' \
  -d '{"heroId":"7f3c2a9e-2d4b-4c1a-9e7f-1b2c3d4e5f60","difficulty":"NORMAL","strategyVersion":null}'
```

El tablón muestra «El Templo Olvidado» disponible y «La Cámara Sellada» bloqueada. La matrícula responde `201` con `IN_PROGRESS` y un `endsAt` doce horas después de `startedAt`. Repetir el mismo `curl` devuelve la misma matrícula. Con `AUTH_MODE=disabled` la identidad es `anonymous`; ese modo no arranca con `NODE_ENV=production`.
