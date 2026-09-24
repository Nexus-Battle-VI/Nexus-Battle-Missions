# Recompensa de experiencia por derrota de un rival (HU-09)

Coordinación en Missions de la recompensa de experiencia por cada NPC derrotado en
una misión. Implementa la Task **HU-09.4** sobre el contrato
`hu-09-experience-reward-v1` (§4.1, §5.2, §6, §7 y §9).

Trazabilidad: [HU-09 #18](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/18) ·
[TASK HU-09.4 #442](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/issues/442).
Contrato: `Nexus-Battle-Infrastructure/docs/contracts/hu-09-experience-reward-v1.md`.

## Qué hace Missions y qué no

Missions **coordina y calcula**; no tira el dado ni escribe el estado del héroe:

| Paso                                           | Quién                                     | Dónde                                                       |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Enumerar las derrotas                          | Missions, de la bitácora de la simulación | `CombatLogPolicy`                                           |
| Persistir una recompensa `PENDING` por derrota | Missions, en la transacción del cierre    | `RunMissionExecutions.close` → `mission_experience_rewards` |
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

## Configuración

`EXPERIENCE_REWARDS_DRIVER` (`memory` en desarrollo, `http` en producción),
`EXPERIENCE_REWARD_ENABLED` (apagado por defecto) y `EXPERIENCE_REWARD_INTERVAL_MS`.
Reutiliza `COMBAT_BASE_URL`, `PLAYER_INVENTORY_BASE_URL` y
`INTERNAL_SERVICE_AUTH_SECRET`. Ver `.env.example`.

## Pendiente, con su dueño

| Pendiente                                             | Depende de                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Que la simulación emita `combatantDefeated` de verdad | **HU-72** (Combat): hoy solo existe el **ingreso** de solicitudes, que responde `503 SIMULATION_UNAVAILABLE`; el doble de desarrollo de Missions ya emite las bajas para poder recorrer el camino |
| La línea `EXPERIENCE` del reporte de misión           | **HU-10**: el reporte ya reserva el tipo, pero su `source` es `HU-10`                                                                                                                             |
| `P-2` (redondeo al más próximo o truncamiento)        | Decisión del PO: hoy está aislada en `experienceForRoll`                                                                                                                                          |
| Verificación extremo a extremo                        | **HU-09.6 (#444)**, y necesita las dos anteriores                                                                                                                                                 |
