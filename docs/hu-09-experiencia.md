# Recompensa de experiencia por derrota de un rival (HU-09)

Coordinación en Missions de la recompensa de experiencia por cada NPC derrotado en
una misión. Implementa las Tasks **HU-09.4** (la coordinación) y **HU-09.5** (la
experiencia en el reporte) sobre el contrato `hu-09-experience-reward-v1` (§4.1,
§5.2, §6, §7 y §9).

Trazabilidad: [HU-09 #18](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/18) ·
[TASK HU-09.4 #442](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/442) ·
[TASK HU-09.5 #443](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/443).
Contrato: `Nexus-Battle-Infrastructure/docs/contracts/hu-09-experience-reward-v1.md`.

## Qué hace Missions y qué no

Missions **coordina y calcula**; no tira el dado ni escribe el estado del héroe:

| Paso                                           | Quién                                     | Dónde                                                       |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Enumerar las derrotas                          | Missions, de la bitácora de la simulación | `CombatLogPolicy`                                           |
| Persistir una recompensa `PENDING` por derrota | Missions, en la transacción del cierre    | `RunMissionExecutions.close` → `mission_experience_rewards` |
| Escribir la línea `EXPERIENCE` de cada derrota | Missions, en la transacción del cierre    | `RunMissionExecutions.close` → `mission_report_rewards`     |
| Tirar `1d8` por derrota                        | **Combat** (`ADR-021`)                    | `POST /api/internal/v1/combat/experience-rolls`             |
| Calcular `10 × 1,2^(1d8)`                      | **Missions**, en un único punto           | `ExperienceRewardPolicy`                                    |
| Acreditar la XP                                | **Player/Inventory** (`ADR-019`)          | `POST /api/internal/…/heroes/{heroId}/experience`           |

La aleatoriedad es autoridad exclusiva de Combat: esta operación no acepta rango,
no devuelve el índice ni la semilla y es idempotente por `operationId`.

## Una recompensa por INSTANCIA, no por misión

La identidad de una derrota es el **encuentro** y el **enemigo concreto** del
`combatLog` de HU-72:

```json
{
  "seq": 4,
  "type": "combatantDefeated",
  "encounter": 1,
  "turn": 1,
  "combatant": "sombra-corrompida#1"
}
```

`summary.enemiesDefeated[]` **no sirve** para esto: agrega por arquetipo y perdería
las derrotas repetidas (una misión con `count: 4` y `count: 6` del mismo enemigo
deja diez recompensas, no dos). Un evento ilegible se descarta y se informa al
registro, en lugar de lanzar: lanzar dejaría la misión sin cerrar en cada ciclo y
al héroe reservado para siempre.

## La regla de orden, que es la que sostiene la garantía

```text
1. El cierre persiste una recompensa PENDING por derrota   <- ANTES de pedir nada
2. El ciclo pide el lote de tiradas y guarda tirada+importe (ROLLED)
3. El ciclo acredita cada derrota con su clave             (CREDITED)
```

Persistir **antes** es lo que hace imposible la tirada huérfana: toda tirada que
Combat llegue a guardar corresponde a una recompensa que ya existe y que el barrido
puede terminar. Una tirada persistida sin acreditar es aceptable mientras exista una
recompensa no terminal que la reclame.

`PENDING → ROLLED → CREDITED`, con `FAILED` terminal ante un rechazo definitivo. Un
reintento **no vuelve a tirar**: si el proceso cae entre la tirada y la acreditación,
la recompensa queda `ROLLED` con su importe y el ciclo siguiente solo acredita. Una
derrota que falla **no arrastra a las demás**, y una misión anulada no devenga nada
(CA-08).

## Estados y clave

| Estado     | Significa                                            | Se recupera tras reinicio            |
| ---------- | ---------------------------------------------------- | ------------------------------------ |
| `PENDING`  | Recompensa creada; aún no se pidió su tirada         | Reintenta el lote con la misma clave |
| `ROLLED`   | La tirada está persistida en Combat; falta acreditar | Reintenta **solo** la acreditación   |
| `CREDITED` | Terminal. Acreditación confirmada                    | No-op                                |
| `FAILED`   | Terminal. Rechazo definitivo, con su motivo          | No reintenta solo; queda visible     |

- Lote por misión: `mission:{enrollmentId}:xp-rolls`.
- Acreditación por derrota: `mission:{enrollmentId}:encounter:{encounterId}:enemy:{enemyInstanceId}:hero:{heroId}:xp`.

## La experiencia en el reporte (HU-09.5)

El jugador ve la experiencia en el reporte de HU-74: **una línea `EXPERIENCE` por cada
derrota**, más un bloque `experience` agregado.

- La línea nace **con el cierre**, en la misma transacción, con `quantity: 0`,
  `status: PENDING` y `source: HU-09`. No puede nacer con importe: lo decide la tirada,
  que ocurre después.
- El avance de la recompensa **mueve su línea en la misma transacción**: `CREDITED` con
  el importe acreditado y la progresión del héroe, o `FAILED` sin importe. Si la línea no
  se puede escribir, la recompensa tampoco se mueve (las dos o ninguna).
- En una línea de experiencia, `quantity` **es la experiencia acreditada**, y
  `hero_level`, `hero_current_xp`, `hero_max_level` y `levels_gained` son la progresión
  que Player/Inventory devuelve con la acreditación (§7). Missions no la calcula: la
  tabla de niveles de HU-08 es suya (`ADR-019`).
- Si el `200` de Player/Inventory no trae la progresión, la línea queda acreditada **con
  su importe y sin nivel**. El `200` dice que la experiencia entró, y darla por fallida
  sería mentir sobre el inventario del jugador.
- El bloque `experience` del reporte es **derivado, no una columna**: `defeats`,
  `totalXp`, `credited`, `pending`, `failed`, `level`, `currentXp`, `maxLevel`,
  `levelsGained` y `leveledUp`. El nivel es el **máximo** de las líneas acreditadas
  (nivel y experiencia solo crecen), así que no depende del orden en que el barrido
  acreditó las derrotas.
- Un reporte anterior a esta Task no tiene líneas `HU-09`: su bloque sale con ceros y con
  `level: null`, que es la verdad de esa misión.

El contrato del reporte sigue siendo `hu-74-mission-report-v1`, con el bloque nuevo;
su forma se documenta en `docs/hu-74-reporte.md`.

## Verificación de extremo a extremo (Task HU-09.6)

`npm run test:e2e:chain` recorre **la cadena completa con las tres piezas reales**: la app
de Missions en proceso con PostgreSQL real, y **Combat y Player/Inventory como procesos
reales** (`node dist/main.js`, cada uno con su MongoDB real en réplica). Comprueba lo que
ninguna Task probó por separado: que la tirada que produjo Combat es la que usó Missions,
que el importe que calculó Missions es el que acreditó Player/Inventory, y que un
reintento en cualquier punto no duplica nada.

**Por qué procesos y no importaciones.** HU-23 intentó levantar dos `AppModule` de repos
distintos en el mismo proceso de Jest y no se pudo (dos copias de `@nestjs/core` y sus
guards globales). Aquí no se importa nada de los repos hermanos: se compilan y se arrancan
como procesos, y lo único que cruza es HTTP firmado, que es justo lo que se prueba.

**Dónde y cómo.** La suite vive en `test/e2e/`, en su propia configuración
(`jest.e2e.config.ts`), y **no** entra en `npm test` ni en `test:db`: quien trabaja en el
dominio no debería necesitar Docker ni dos repos hermanos compilados. Necesita los tres
repos clonados juntos (por defecto `../Nexus-Battle-Combat` y
`../Nexus-Battle-Player-Inventory`, o `HU09_E2E_COMBAT_DIR` y
`HU09_E2E_PLAYER_INVENTORY_DIR`) y Docker. El workflow `cadena-hu-09.yml` los clona y la
ejecuta; el reporte de ejecución queda en `test/e2e/out/hu-09-ejecucion-e2e.json`.

**Qué se sustituye, y se declara:** el resultado de la simulación de Combat y el perfil del
héroe, que son **la misma dependencia** — la ruta de simulación de Combat existe, pero lo
primero que valida es `hero.profile.effectiveStats` y `hero.profile.subtype`, y sin la ruta
interna de perfil de Player/Inventory (`HU-71.2`) no hay perfil real que enviarle: con
`COMBAT_SIMULATION_DRIVER=http` la misión se anula con `MISSION_CONTENT_INVALID`; el
compromiso del héroe, el testimonio del jugador, y en el escenario de los ocho valores de
`1d8` el puerto de tirada (con la acreditación real). El reloj **no** se sustituye: los sellos
HMAC caducan a los 30 s, así que el tiempo se maneja con dos datos de partida — la ventana de
la matrícula se desplaza al pasado y el escalonado de reintento se vence escribiendo
`next_attempt_at`.

**Casos:** S-00 las tres piezas reales; S-01 la cadena completa con tiradas reales; S-02
los ocho valores del contrato acreditados; S-03 subida de uno, de varios y nivel máximo sin
descarte; S-04 idempotencia del cierre; S-05 replay de la acreditación; S-06 `409` en las
dos fronteras; S-07 `CA-08`; S-08 dos derrotas del mismo arquetipo; S-09 recuperación de una
tirada sin acreditar; S-10 auditoría cruzada y controles del informe; S-11 las guardas de
no-duplicación, que se ejecutan sobre el commit que se está probando y **fallan si su control
negativo desaparece**.

**En CI.** El workflow `cadena-hu-09.yml` clona los tres repositorios y publica el reporte
como artefacto. Prueba el `develop` de los hermanos, así que acepta `combat_ref` e
`inventory_ref` por `workflow_dispatch` para poder verificar el conjunto antes de mergearlo;
el ref elegido queda escrito en el ambiente del reporte.

La evidencia publicable vive en
`Nexus-Battle-Infrastructure/docs/evidence/HU-09-experiencia-por-derrota-de-un-rival.md`, con
la tabla de qué piezas fueron reales y cuáles simuladas y el
[reporte de ejecución](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/evidence/hu-09-ejecucion-e2e.json).

## Configuración

`EXPERIENCE_REWARDS_DRIVER` (`memory` en desarrollo, `http` en producción),
`EXPERIENCE_REWARD_ENABLED` (apagado por defecto) y `EXPERIENCE_REWARD_INTERVAL_MS`.
Reutiliza `COMBAT_BASE_URL`, `PLAYER_INVENTORY_BASE_URL` y
`INTERNAL_SERVICE_AUTH_SECRET`. Ver `.env.example`.

## Pendiente, con su dueño

| Pendiente                                                                   | Depende de                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Que la simulación la produzca Combat de verdad                              | **HU-71.2**: su ruta de simulación ya existe y **rechaza** la petición con `422 MISSION_CONTENT_INVALID` porque el perfil que Missions puede enviar hoy es el doble de desarrollo, sin `subtype` ni `effectiveStats`. Cuando el perfil sea real, `COMBAT_SIMULATION_DRIVER` pasa a `http` |
| Las líneas de créditos, productos y de la experiencia por misión completada | **HU-10**: el reporte ya reserva sus tipos                                                                                                                                                                                                                                                |
| La vista de la experiencia en la Web                                        | **HU-09.5 (#443)**, en `Nexus-Battle-Web`: consume `GET /api/v1/missions/me/reports/{enrollmentId}`                                                                                                                                                                                       |
| `P-2` (redondeo al más próximo o truncamiento)                              | Decisión del PO: hoy está aislada en `experienceForRoll`                                                                                                                                                                                                                                  |
| Verificación extremo a extremo                                              | **Entregada** en **HU-09.6 (#444)**: `npm run test:e2e:chain`, 12/12 en local y en CI. **No es la aceptación de la HU**: eso exige revisión por pares y aprobación del PO                                                                                                                 |
