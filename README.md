# Nexus-Battle-Missions

Servicio de Nexus Battles VI para el bounded context **Missions**: misiones JcE, rotaciones, dificultad, reportes y logros.

Implementa las misiones JcE asíncronas: tablón, matrícula del héroe, rotaciones de habilidades, niveles de dificultad, reportes, encuentros con Máster y logros. **No ejecuta reglas de combate**: pide la simulación a Combat.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Decisión que lo crea:** [ADR-019](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-019-sprint-2-bounded-contexts.md) (`Accepted`)
- **Épicas:** [EPIC-08 Misiones](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/8)
- **Team propietario:** Team Beta
- **Arquitectura interna:** Clean + Hexagonal ([ADR-002](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-002-backend-stack.md))
- **Base de datos:** PostgreSQL, propia y exclusiva ([ADR-005](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/adr/ADR-005-data-strategy.md))
- **Puerto:** 3007

## Estado

La configuración jugable y el editor de misiones se describen en
[docs/misiones-jugables.md](docs/misiones-jugables.md). La integración real
requiere desplegar también los cambios correspondientes de Combat y
Player/Inventory.

Desde el 2026-09-16 corre en producción en el nodo `app` y Caddy le envía `https://nexus.simuladorupbbga.app/api/v1/missions*`. Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base, que ya existe con usuario propio.

**Primera ruta de negocio: HU-75** (Task HU-75.2, ver [docs/hu-75-mission-difficulty.md](docs/hu-75-mission-difficulty.md)). `mission_difficulty_clears` (migración `001-mission-difficulty-clears`) es la primera tabla. Cualquier otra ruta bajo el prefijo sigue respondiendo `404` desde NestJS hasta que la HU correspondiente la añada. Llega a producción con la siguiente promoción de `develop` a `main`.

**Tablón, detalle y matrícula: HU-70** (Task HU-70.2, ver [docs/hu-70-matriculacion.md](docs/hu-70-matriculacion.md)). `GET /api/v1/missions`, `GET /api/v1/missions/{missionId}` y `POST /api/v1/missions/{missionId}/enrollments`, con la migración `002-mission-enrollments`. La reserva del héroe depende de una ruta de Player/Inventory que todavía no existe: hasta que se publique, una matrícula queda `PENDING` y responde `503`.

**Estrategia de rotaciones: HU-71** (Task HU-71.2, ver [docs/hu-71-rotaciones.md](docs/hu-71-rotaciones.md)). `GET` y `PUT /api/v1/missions/{missionId}/strategies/{heroId}` guardan hasta tres rotaciones por jugador, héroe y misión, con versión optimista, y la matrícula congela una copia (migración `003-mission-strategies`). Validar las habilidades también depende de una ruta de Player/Inventory que no existe: hasta entonces, guardar responde `503`.

**Simulación y cierre: HU-72** (Task HU-72.2, ver [docs/hu-72-simulacion.md](docs/hu-72-simulacion.md)). El planificador (`MISSION_EXECUTION_ENABLED`) pide a Combat la simulación real de cada misión iniciada, conserva una copia del contenido y la cierra al llegar `endsAt` (`COMPLETED` o `FAILED`), registra el _clear_ de HU-75 y libera al héroe. La configuración jugable y las dos misiones iniciales se cargan con la migración `010-playable-missions`.

**Reporte e historial: HU-74** (Task HU-74.2, ver [docs/hu-74-reporte.md](docs/hu-74-reporte.md)). `GET /api/v1/missions/me/reports/{enrollmentId}`, `GET /api/v1/missions/me/history` y `GET /api/v1/missions/me/history/summary`. El reporte es una foto inmutable que nace en la transacción del cierre de HU-72 (migración `005-mission-reports`) e incluye el botín obtenido del jefe; el resumen agrega ese botín por jugador. Como ninguna misión se cierra en producción sin la ruta de Combat, todavía no hay reportes; los créditos y productos de Catalog llegarán con HU-10, y la experiencia, con HU-09.

**Encuentro con el Máster: HU-73** (Task HU-73.2, ver [docs/hu-73-master.md](docs/hu-73-master.md)). Sin rutas nuevas: la solicitud a Combat lleva el bloque `master` con la probabilidad del subtipo del héroe, el cierre guarda la evidencia de cada punto de evaluación (migración `006-mission-master-encounters`) y el planificador pide la épica de cada Máster derrotado a Player/Inventory, una sola vez. Player/Inventory todavía no acepta a `missions` en su ruta de entregas y la épica aún no es un producto de Catalog: hasta entonces, cada entrega queda pendiente y se reintenta.

**Logros y reconocimientos: HU-76** (Task HU-76.2, ver [docs/hu-76-logros.md](docs/hu-76-logros.md)). `GET /api/v1/missions/me/achievements` devuelve los logros del jugador con su progreso y su reconocimiento. Un paso del mismo planificador los evalúa con lo que ya guardan los clears, los reportes y la evidencia del Máster, y los desbloquea una sola vez (migración `009-mission-achievements`); los títulos y las insignias quedan registrados y los cosméticos se piden a Player/Inventory como las épicas. El catálogo aprobado son los siete logros del contrato, aprobados por el PO el 2026-09-24.

**Recompensa de experiencia: HU-09** (Tasks HU-09.4 #442 y HU-09.6 #444, ver [docs/hu-09-experiencia.md](docs/hu-09-experiencia.md)). Sin rutas nuevas: el cierre de HU-72 deja una recompensa `PENDING` por **cada NPC derrotado** (migración `007-experience-rewards`) y la línea `EXPERIENCE` que la refleja en el reporte (migración `008-report-experience`), en su misma transacción y antes de pedir ninguna tirada; un segundo planificador (`EXPERIENCE_REWARD_ENABLED`, apagado por defecto) pide a Combat el lote de tiradas, calcula `10 × 1,2^(1d8)`, acredita cada derrota en Player/Inventory con su propia clave y mueve su línea del reporte en la misma escritura. El reporte publica además un bloque `experience` derivado, con la experiencia acreditada y el nivel del héroe. La cadena completa se verifica de extremo a extremo con las tres piezas reales (`npm run test:e2e:chain`). **La simulación se recorre con el doble de desarrollo porque el perfil de combate del héroe todavía no está disponible (`HU-71.2`)**: la ruta de simulación de Combat existe, pero lo primero que valida es `hero.profile.effectiveStats` y `hero.profile.subtype`, y sin la ruta interna de perfil de Player/Inventory no hay perfil real que enviarle.

## Qué posee este contexto

- Definiciones de misión y tablón.
- Matrículas con su héroe, estado y temporizador.
- Rotaciones de habilidades (hasta tres, prioridad alta, media y baja).
- Progreso de dificultad por jugador y misión.
- Reportes e historial de misiones, y logros otorgados.

Ningún otro servicio accede a este almacén, ni directamente ni con claves foráneas.

## Historias de Usuario que viven aquí

| HU    | Historia                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| HU-70 | [Matriculación en una misión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/55)                                |
| HU-71 | [Configuración de rotaciones de habilidades](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/56)                 |
| HU-72 | [Ejecución de la simulación de misión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/57)                       |
| HU-73 | [Encuentro aleatorio con enemigo Máster](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/58)                     |
| HU-74 | [Generación de reporte de misión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/59)                            |
| HU-75 | [Niveles de dificultad escalonada de misión](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/60)                 |
| HU-76 | [Sistema de logros y reconocimientos](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/61)                        |
| HU-32 | [Obtención de habilidad épica mediante derrota de un Máster](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/79) |
| HU-10 | [Otorgar experiencia y recompensas por misión completada](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/19)    |

## Integraciones previstas

- **Combat** (síncrono, `operationId`): ejecutar la simulación con semilla, combatientes y rotaciones (HU-72, ruta propuesta `POST /api/internal/v1/combat/simulations`). Toda la aleatoriedad ocurre allí.
- **Player/Inventory** (síncrono, `operationId`): perfil de combate del héroe, compromiso `MISSION`, recompensas en ítems.
- **Wallet** (síncrono, `operationId`): recompensas en créditos.
- **Notifications** (ingesta HTTP): fin de misión y logros.

Detalle en [docs/architecture.md](docs/architecture.md).

## Estructura

```text
src/
  domain/            Entidades, objetos de valor, políticas y eventos
  application/       Casos de uso, puertos, DTO y errores
  adapters/
    inbound/http/    Controladores, DTO HTTP y guards
    outbound/        Persistencia, identidad, clientes de otros servicios
  infrastructure/    config, observabilidad, salud, persistencia y composición
```

El dominio no importa NestJS, drivers ni adaptadores, y la aplicación depende solo de sus puertos: lo impide ESLint en CI. Los casos de uso son clases sin decoradores registradas con fábricas en `src/infrastructure/bootstrap/app.module.ts`.

## Verificación local

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm run test:coverage
npm run test:db        # requiere Docker: levanta PostgreSQL con Testcontainers
npm run build
```

Y la **cadena de HU-09 de extremo a extremo** (Task HU-09.6), que no entra en
`npm test` ni en `test:db` porque necesita los tres repositorios clonados juntos
y Docker:

```bash
npm run test:e2e:chain
```

Levanta la app de Missions con PostgreSQL real y arranca **Combat y
Player/Inventory como procesos reales** sobre un MongoDB real en réplica. El
workflow [`cadena-hu-09.yml`](.github/workflows/cadena-hu-09.yml) los clona y la
ejecuta en CI; el reporte de ejecución queda en
`test/e2e/out/hu-09-ejecucion-e2e.json`.

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                                       | Resultado                |
| --------------------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`                  | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory`           | **No arranca** (ADR-019) |
| `PERSISTENCE_DRIVER=postgres` sin `DATABASE_URL`                | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                              | **No arranca**           |
| `NODE_ENV=production` con `HERO_COMMITMENTS_DRIVER=memory`      | **No arranca** (ADR-019) |
| `NODE_ENV=production` con `HERO_ABILITIES_DRIVER=memory`        | **No arranca**           |
| `NODE_ENV=production` con `COMBAT_SIMULATION_DRIVER=memory`     | **No arranca**           |
| `NODE_ENV=production` con `EPIC_GRANTS_DRIVER=memory`           | **No arranca**           |
| `MISSIONS_EXAMPLE_CATALOG=true` sin `PERSISTENCE_DRIVER=memory` | **No arranca**           |

## Identidad y autorización

- **Toda ruta nace protegida.** El guard es global; abrir una ruta exige `@Public()`.
- La identidad sale del token de acceso verificado contra el JWKS del pool (`aws-jwt-verify`), nunca del cuerpo ni de la URL.
- `@Roles(...)` restringe por rol; `SUPER_ADMINISTRATOR` satisface lo que se exige a `ADMINISTRATOR`, y no al revés.
- Las rutas `@InternalOnly()` exigen firma HMAC-SHA256 (`x-internal-service`, `x-internal-timestamp`, `x-internal-signature`) de un servicio de la lista `INTERNAL_CALLERS`. Sin secreto configurado responden `503`. Caddy bloquea `/api/internal*` desde fuera.

## Sondas

| Ruta                    | Semántica                                     |
| ----------------------- | --------------------------------------------- |
| `GET /api/health/live`  | El proceso responde. No consulta dependencias |
| `GET /api/health/ready` | Hace ping a PostgreSQL. `503` si no responde  |
| `GET /api/version`      | Servicio, versión y entorno                   |

## Ramas

`main` y `develop` están protegidas. Todo Pull Request va a **`develop`**; `main` solo recibe la promoción completa de `develop`, y el workflow `Flujo de ramas` lo hace cumplir. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

Licensing pending project governance.
