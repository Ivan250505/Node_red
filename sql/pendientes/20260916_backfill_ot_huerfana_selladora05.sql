-- Backfill puntual del bulto Detalle=2026000916000134661 (SELLADORA 05), que quedo con
-- OrdenProduccion NULL por la carrera confirmada en obtenerOCrearOrdenProduccion (ya corregida
-- en sel-inventario-mp.js el 16/09/2026 -- esto es solo para reparar el dato historico).

-- PASO 1: candidatas -- OTs creadas el mismo dia (Lote=0916) para ver cual es la del grupo
-- Sellado en Paralelo al que pertenece este bulto. Revisar cual Elemento/LineaAncla encaja con
-- el grupo (mismo pedido/orden que el bulto huerfano).
SELECT po.OrdenProduccion, po.Lote, po.Elemento, po.LineaAncla, po.Fecha, po.FechaCreacion, po.Estado,
       inv.Referencia
FROM PRDOrdenesProduccion po
LEFT JOIN INVElementos inv ON inv.Codigo = po.Elemento
WHERE po.Lote = '0916' AND po.TipoProceso = 'SELLADORA'
ORDER BY po.FechaCreacion DESC;

-- PASO 2: una vez identificado el codigo correcto arriba, completar @OrdenProduccionCorrecta abajo
-- y correr el UPDATE (deja comentado a proposito -- no se ejecuta solo).
/*
DECLARE @OrdenProduccionCorrecta VARCHAR(30) = 'OT......';

UPDATE PRDProduccion
SET OrdenProduccion = @OrdenProduccionCorrecta
WHERE Detalle = '2026000916000134661' AND OrdenProduccion IS NULL;

-- Verificacion
SELECT Detalle, Elemento, OrdenProduccion FROM PRDProduccion WHERE Detalle = '2026000916000134661';
*/
