# HU-10.4 — Recompensas de finalización: forma y snapshot (Missions)

Missions modela y **congela** las recompensas de finalización de una misión. Esta página resume la forma que implementa este servicio; el contrato vive en Infrastructure y **no se duplica aquí**: [`hu-10-mission-completion-reward-v1` §4-§6](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/develop/docs/contracts/hu-10-mission-completion-reward-v1.md).

**Esta Task NO entrega nada**: no llama a Wallet, ni al endpoint de XP de HU-10, ni a `inventory/grants`, y no crea líneas del reporte. La liquidación y sus entregas son de HU-10.5.

## `rewards.completion` (bloque aditivo y opcional)

Vive dentro de `MissionDefinition.rewards`, en el `jsonb` del contenido: **no requiere migración** y un contenido sin el sigue cargando (simplemente no genera derechos HU-10). Las etiquetas de texto (`guaranteed`, `objectiveBonuses`, `firstTime`) siguen siendo **informativas**: **nunca se parsean** (`"50 créditos"` no es un monto).

```jsonc
"completion": {
  "schemaVersion": 1,
  "experience": { "amountByDifficulty": { "NORMAL": 0 } },           // enteros >= 1
  "entries": [{
    "key": "slug",                                                    // ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$, único
    "group": "GUARANTEED | OBJECTIVE_BONUS | FIRST_TIME",
    "grantOn": ["COMPLETED"],                                         // obligatorio, sin valor por defecto
    "objectiveId": "solo OBJECTIVE_BONUS, de un objetivo existente",
    "reward": { "kind": "CREDITS", "amountByDifficulty": { } }        // o
             // { "kind": "PRODUCT", "productId": "<uuid>", "quantityByDifficulty": { } }   (1..9999)
  }]
}
```

- **Sin valores por defecto**: si la dificultad ejecutada no figura en un mapa, **no hay derecho** (no se usa otra dificultad, ni se interpola, ni se multiplica). Los mapas solo admiten el vocabulario `NORMAL | HEROIC | LEGENDARY | MYTHIC` y no pueden ir vacíos.
- **No hay tipos `EPIC` ni `LOOT`**: la épica es de HU-73 y el botín del jefe de HU-72; `rewardTier` no se usa para derivar montos.
- **Ninguna misión real lleva `completion`** todavía: los montos son contenido aprobado (P-HU10-2), los desenlaces de créditos/garantizados los define el PO (P-HU10-3) y «primera vez» no está definida (P-HU10-4). Los `50 créditos` del Templo siguen siendo texto.

## `CompletionRewardPolicy` (pura)

`completionRewardsOf({ content, difficulty, outcome, objectives })` → derechos congelables (`rewardKey`, tipo, monto/cantidad). Sin base de datos, sin red, sin aleatoriedad, sin catálogo.

| Desenlace                                                     | Resultado                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `COMPLETED`                                                   | XP de finalización (si hay monto) + entradas que declaran `COMPLETED`         |
| `FAILED`                                                      | XP de finalización + **solo** las entradas que declaran `FAILED` en `grantOn` |
| `IN_PROGRESS`, `VOIDED`, `ABANDONED` (pendiente), desconocido | **sin derechos** (falla cerrado)                                              |

Una bonificación por objetivo exige `met === true`. `FIRST_TIME` se valida pero **no es liquidable** mientras P-HU10-4 siga abierta.

## Snapshot

`frozenContentOf(execution.request)` devuelve **solo** `request.contentSnapshot` (el contenido con el que se simuló). **No hay respaldo al catálogo vivo**: sin snapshot no hay derechos (`SNAPSHOT_MISSING`). El respaldo al catálogo que hoy tiene `close()` es de HU-72; HU-10.5 no puede usarlo. Probado: la configuración A congelada al simular sigue siendo A tras guardar una B en el catálogo, también tras reiniciar sobre PostgreSQL.

## Administración

`GET /v1/admin/missions` devuelve el bloque y `PUT` lo valida y lo conserva: listar → guardar lo mismo no lo pierde. El editor de Web aún no lo entiende (HU-10.6, #456); mientras tanto, un `PUT` que lo reenvíe tal cual lo preserva, y uno inválido se rechaza sin reemplazar el guardado.
