-- Diagnostico: "Limpieza y Desinfeccion" sale a las 22:06 en el reporte, pero el bulto/Alistamiento
-- de la MISMA orden salen a las 16:44 -- horas antes en el reloj de pared, pese a que Limpieza
-- deberia ser el paso 1 (el mas temprano). El reporte (ConsProduccionSeguimiento.vb) solo muestra
-- HH:mm, no la fecha completa -- si Limpieza quedo de un intento anterior EN OTRO DIA calendario
-- (la orden se dejo pausada de un dia para el otro, ver id_ejecucion que es fijo por orden y se
-- reusa al retomar), esto se veria "al reves" sin ser ningun bug de datos: Limpieza real fue ayer
-- 22:06, el resto de hoy 16:44 -- un salto de dias que el reporte no distingue.
-- Este script trae las fechas COMPLETAS (no solo la hora) para confirmar cual de los dos es.
-- Solo lectura -- ajustar el WHERE del PASO 1 con el serial/pedido real si hace falta.

-- PASO 1 CORREGIDO: el "No. Tiquete Rollo" del reporte sale de SEL_RolloEjecucion.Serial
-- (ver ConsProduccionSeguimiento.vb:482-489), NO de SEL_Bultos.serialPadre -- por eso la primera
-- version de este script salio vacia. Se busca por ahi.
SELECT re.Id, re.id_ejecucion, re.id_bulto, re.Serial, re.EsInicio,
       CONVERT(VARCHAR(19), re.FechaHora, 120) AS FechaHora_Completa,
       ej.IdOrden, ej.Operario, ord.NumeroPedido, ord.Elemento
FROM SEL_RolloEjecucion re
INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = re.id_ejecucion
INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
WHERE re.Serial = '2026000512006916157';

-- PASO 2: con el id_ejecucion de arriba, TODAS las filas de SEL_TiempoMuerto de esa ejecucion,
-- con fecha Y hora completas (CONVERT 120 = 'yyyy-mm-dd hh:mi:ss') -- comparar el DIA de Limpieza
-- contra el DIA del Alistamiento/bulto.
DECLARE @IdEjecucion INT = (SELECT TOP 1 id_ejecucion FROM SEL_RolloEjecucion WHERE Serial = '2026000512006916157');

SELECT id, Tipo, Subtipo,
       CONVERT(VARCHAR(19), HoraInicio, 120) AS HoraInicio_Completa,
       CONVERT(VARCHAR(19), HoraFin, 120) AS HoraFin_Completa,
       Observaciones, OrdenProduccion
FROM SEL_TiempoMuerto
WHERE id_ejecucion = @IdEjecucion
ORDER BY HoraInicio;

-- PASO 3: los bultos de esa misma ejecucion, con fecha y hora completas
SELECT id, num_bulto, agno, mes, dia,
       CONVERT(VARCHAR(19), HoraInicio, 120) AS HoraInicio_Completa,
       CONVERT(VARCHAR(19), HoraFin, 120) AS HoraFin_Completa,
       estado, serialPadre
FROM SEL_Bultos
WHERE id_ejecucion = @IdEjecucion
ORDER BY HoraInicio;

-- PASO 3.5: TODOS los rollos montados (Iniciar/Añadir Rollo) de esta misma ejecucion -- confirma
-- si hubo mas de un rollo y en que dia/hora entro cada uno.
SELECT Id, Serial, EsInicio, id_bulto,
       CONVERT(VARCHAR(19), FechaHora, 120) AS FechaHora_Completa
FROM SEL_RolloEjecucion
WHERE id_ejecucion = @IdEjecucion
ORDER BY FechaHora;

-- PASO 4: el/los registro(s) de PRDProduccion de esos mismos bultos, fecha y hora completas
SELECT p.Detalle, p.Fecha,
       CONVERT(VARCHAR(19), p.HoraInicio, 120) AS HoraInicio_Completa,
       CONVERT(VARCHAR(19), p.HoraFinal, 120) AS HoraFinal_Completa,
       p.OrdenProduccion
FROM PRDProduccion p
INNER JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
WHERE b.id_ejecucion = @IdEjecucion
ORDER BY p.HoraInicio;

-- PASO 5 (aparte, solo por si acaso): confirmar que el reloj de la base y el del server Node
-- coinciden -- si esto muestra una hora distinta a la del reloj de pared real en este momento,
-- hay un problema de reloj/zona horaria en el servidor de SQL Server (no en el codigo).
SELECT GETDATE() AS HoraLocalSQLServer, GETUTCDATE() AS HoraUTC, SYSDATETIMEOFFSET() AS ConOffset;
