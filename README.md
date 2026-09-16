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

**Andamiaje desplegado.** Desde el 2026-09-16 corre en producción en el nodo `app` y Caddy le envía `https://nexus.simuladorupbbga.app/api/v1/missions*`. Arranca, verifica identidad, firma y comprueba el contrato interno, expone sus sondas y conecta con su base, que ya existe con usuario propio.

**No tiene todavía ninguna ruta de negocio ni ninguna tabla o colección**: las añade cada Historia de Usuario. Mientras tanto, cualquier ruta bajo ese prefijo responde `404` desde NestJS.

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

- **Combat** (síncrono, `operationId`): ejecutar la simulación con semilla, combatientes y rotaciones. Toda la aleatoriedad ocurre allí.
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

Cobertura mínima del **80 %** en ambas suites; por debajo, el comando falla.

## Configuración

Ver [.env.example](.env.example). Las reglas que hacen fallar el arranque son deliberadas:

| Situación                                             | Resultado                |
| ----------------------------------------------------- | ------------------------ |
| `NODE_ENV=production` con `AUTH_MODE=disabled`        | **No arranca** (ADR-004) |
| `NODE_ENV=production` con `PERSISTENCE_DRIVER=memory` | **No arranca** (ADR-019) |
| `PERSISTENCE_DRIVER=postgres` sin `DATABASE_URL`      | **No arranca**           |
| `AUTH_MODE=jwt` sin pool o cliente                    | **No arranca**           |

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
