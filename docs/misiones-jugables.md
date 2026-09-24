# Contenido jugable y editable de misiones

La migración `010-playable-missions` carga El Templo Olvidado y La Cámara Sellada
en PostgreSQL. `GET /api/v1/admin/missions` y
`PUT /api/v1/admin/missions/{missionId}` permiten al rol `ADMINISTRATOR` leer y guardar
la definición completa. El formulario de Web está en `/admin/missions`. El mismo
catálogo alimenta el tablón del jugador y las solicitudes de Combat. Las
ediciones se validan antes de publicarse y una simulación conserva una copia
para que un cambio posterior no altere su cierre.

## Reglas decididas por el equipo

El curso fija cinco cámaras, 10 sombras, 5 guardianes de piedra, 3 espectros,
un jefe de 100 de vida y 12 horas para el Templo. No fija las demás
estadísticas ni la IA. El contenido inicial define las sombras con vida 5,
ataque 2, defensa 3 y daño 1; los guardianes de piedra con 8/3/6/1 e IA
`GUARDED`; los espectros con 7/4/4/2; el jefe con 100/2/5/1 e IA `BOSS`.
El jefe gana 3 de ataque por debajo de 50 % de vida. La misión tiene 90 turnos
como máximo por encuentro, 60 segundos simulados por turno, recupera 35 % de
vida entre encuentros y usa 10 % de probabilidad crítica con factor 1.5.
Para un sanador sin ataque numérico se define ataque de apoyo 10, daño 3 y
regeneración de vida 1 por turno. Cada valor vive en `combatRules` o en el
perfil del combatiente y puede modificarse en el editor.

Normal, Heroico y Legendario usan inicialmente factores enemigos 1, 1.5 y 2;
el equipo fijó 2.5 para Mítico. Cada misión puede editar los cuatro factores
en `combatRules.difficultyMultipliers`. La Cámara Sellada tiene perfiles y
jefe propios; vencer el Templo la desbloquea.

El Templo sortea hasta tres Fragmentos del Sello Antiguo al 60 % cada uno,
una armadura al 20 % y un arma al 15 %. El objetivo secundario de hallar tres
fragmentos se evalúa con la tirada real. La Cámara sortea un Núcleo del Sello
al 50 %. Combat tira los dados una sola vez por `operationId`; Missions guarda
lo obtenido en el reporte inmutable y lo agrega en el resumen del historial.
`productId: null` significa que el botín se conserva como coleccionable de
misión. Para que una armadura o arma se pueda equipar en Player/Inventory debe
existir como producto de Catalog y tener un `productId` vinculado; la entrega
de esos productos requiere completar el flujo de recompensas de HU-10.

## Prueba local

1. Ejecutar las migraciones de Missions y Combat.
2. Iniciar Player/Inventory, Combat y Missions con el mismo
   `INTERNAL_SERVICE_AUTH_SECRET`; en Missions usar
   `COMBAT_SIMULATION_DRIVER=http` y `MISSION_EXECUTION_ENABLED=true`.
3. Matricular un héroe en el Templo desde Web. Combat calcula y persiste el
   resultado al ejecutar el planificador; el jugador lo ve en el reporte cuando
   llega `endsAt`.
4. Para una prueba corta, guardar en el editor una copia de la misión con
   `estimatedDurationMinutes: 1`. Los demás parámetros siguen siendo editables.
5. Abrir `/missions/history` y el reporte: se muestran el jefe, objetivos,
   estadísticas y botín obtenido. El resumen acumula los objetos conseguidos.

En desarrollo, `PERSISTENCE_DRIVER=memory` y
`MISSIONS_EXAMPLE_CATALOG=true` cargan el mismo contenido, pero se pierde al
reiniciar. `COMBAT_SIMULATION_DRIVER=memory` es un doble con resultado fijo y no
verifica el combate real.
