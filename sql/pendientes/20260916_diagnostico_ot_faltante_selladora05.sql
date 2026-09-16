-- Diagnostico: por que el bulto Detalle=2026000916000134661 (SELLADORA 05) quedo sin
-- OrdenProduccion. Ver sel-inventario-mp.js:finalizarControlParcialSellado -- dos caminos posibles:
--  (1) el ULTIMO bulto de la misma orden (SEL_EjecucionOrden.IdOrden) tenia refsalida NULL/0,
--      lo que corta la generacion de OT para TODA la orden (linea 616: if (nUltimoElemento===0) return)
--  (2) obtenerOCrearOrdenProduccion tiro una excepcion y devolvio '' en silencio (try/catch linea 498-504)
-- Solo lectura.

-- 1) El bulto puntual: su Elemento (refsalida), estado, y a que orden/ejecucion pertenece
SELECT b.id, b.serialPadre, b.num_bulto, b.refsalida, b.estado, b.CantidadTotal,
       b.agno, b.mes, b.dia, ej.IdOrden, ej.IdEjecucion, ej.Operario
FROM SEL_Bultos b
INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
WHERE b.serialPadre = '2026000916000134661';

-- 2) TODOS los bultos de esa misma orden (ordenados igual que el codigo, num_bulto ASC) --
--    si el ULTIMO de esta lista tiene refsalida NULL o 0, ese es el bug (caso 1)
SELECT b.id, b.num_bulto, b.refsalida, b.estado, b.serialPadre, b.CantidadTotal
FROM SEL_Bultos b
INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
WHERE ej.IdOrden = (
    SELECT ej2.IdOrden FROM SEL_Bultos b2
    INNER JOIN SEL_EjecucionOrden ej2 ON ej2.IdEjecucion = b2.id_ejecucion
    WHERE b2.serialPadre = '2026000916000134661'
)
ORDER BY b.num_bulto ASC;

-- 3) El registro ya insertado en PRDProduccion para este serial (confirma que si se llego a insertar,
--    solo que sin OrdenProduccion)
SELECT Fecha, Maquina, Elemento, Linea, Cantidad, Unidades, OrdenProduccion, NumeroPedido, HoraInicio, HoraFinal
FROM PRDProduccion
WHERE Detalle = '2026000916000134661';

-- 4) Si ya existe una OT para esa Fecha/Lote/Elemento/LineaAncla pero quedo "huerfana" (nunca se
--    linkeo de vuelta a PRDProduccion) -- comparar Elemento/Lote/LineaAncla del bulto de (1) contra esto
SELECT OrdenProduccion, Lote, Elemento, LineaAncla, Fecha, FechaCreacion, Estado
FROM PRDOrdenesProduccion
WHERE Fecha = (SELECT Fecha FROM PRDProduccion WHERE Detalle = '2026000916000134661')
ORDER BY FechaCreacion DESC;

-- 5) HIPOTESIS: race condition (dos bultos del mismo grupo Sellado-en-paralelo, misma ancla,
--    llamando obtenerOCrearOrdenProduccion casi al mismo tiempo -- SELECT-luego-INSERT sin lock
--    entre medio). Si esto devuelve una restriccion UNIQUE/PK sobre OrdenProduccion o sobre
--    (Lote,Destino,Consecutivo), confirma que un INSERT concurrente pudo chocar contra el otro.
SELECT i.name AS NombreIndice, i.is_unique, i.is_primary_key,
       STUFF((
           SELECT ', ' + c2.name
           FROM sys.index_columns ic2
           INNER JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
           ORDER BY ic2.key_ordinal
           FOR XML PATH('')
       ), 1, 2, '') AS Columnas
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID('PRDOrdenesProduccion') AND (i.is_unique = 1 OR i.is_primary_key = 1);

-- 6) Otros bultos del MISMO grupo (misma ancla Elemento+LineaAncla+Lote) creados casi al mismo
--    segundo -- si hay otro con OrdenProduccion SI lleno y HoraInicio muy cercano, refuerza la
--    hipotesis de carrera (el otro bulto "gano" la carrera y se quedo con la OT).
SELECT Detalle, Elemento, Linea, OrdenProduccion, HoraInicio, Maquina
FROM PRDProduccion
WHERE Fecha = (SELECT Fecha FROM PRDProduccion WHERE Detalle = '2026000916000134661')
  AND ABS(DATEDIFF(SECOND, HoraInicio, (SELECT HoraInicio FROM PRDProduccion WHERE Detalle = '2026000916000134661'))) < 10
ORDER BY HoraInicio;
