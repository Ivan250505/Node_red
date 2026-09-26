-- La autorizacion del lider pasa de ser POR PEDIDO a ser POR BITACORA DE TURNO (pedido del usuario,
-- 25/09/2026: "para que en la base de datos no se quede esa bitacora sin firmar"). Por unas horas del
-- mismo dia fue por Orden de Trabajo; se descarto antes de llegar a produccion.
--
-- QUE CAMBIA: la comprobacion de Finalizar / Cerrar sesion ahora busca una firma con el IdBitacora
-- de la bitacora MAS RECIENTE de la maquina (SEL_BitacoraTurno, abierta o ya cerrada por fin de
-- turno), no del NumeroPedido. La columna IdBitacora ya existia (20260922_agregar_autorizacion_pedido.sql);
-- este script le agrega su indice y completa las firmas viejas que quedaron sin ella.
--
-- Tambien agrega OrdenProduccion (la OT de la orden al momento de firmar). Es SOLO rastro: nada
-- bloquea por ella, pero sirve para saber que OT estaba corriendo cuando el lider firmo.
--
-- El nombre de la tabla NO se cambia: renombrarla rompe cualquier consulta de Mirane/reportes que
-- ya la lea, y el nombre viejo sigue siendo entendible.
--
-- Requiere haber corrido antes sql/pendientes/20260922_agregar_autorizacion_pedido.sql.
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE.

IF COL_LENGTH('SEL_AutorizacionPedido', 'OrdenProduccion') IS NULL
BEGIN
  -- Mismo tipo que usa SQL_OT_DE_ORDEN en sel-inventario-mp.js para la OT.
  ALTER TABLE SEL_AutorizacionPedido ADD OrdenProduccion VARCHAR(20) NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SEL_AutorizacionPedido_Bitacora'
               AND object_id = OBJECT_ID('SEL_AutorizacionPedido'))
BEGIN
  -- La consulta que se hace en cada Finalizar, en cada cierre de sesion y en el aviso de fin de
  -- turno de la tableta (cada minuto por tableta).
  CREATE INDEX IX_SEL_AutorizacionPedido_Bitacora
    ON SEL_AutorizacionPedido (IdBitacora, FechaHora);
END;
GO

-- Backfill 1: firmas viejas sin IdBitacora (se firmaron sin bitacora ABIERTA en la maquina, por
-- ejemplo justo despues de un cierre por fin de turno). Se les pone la bitacora mas reciente de su
-- maquina que ya estaba abierta a la hora de la firma -- el mismo criterio con el que hoy se exige.
UPDATE a SET a.IdBitacora = bi.IdBitacora
FROM SEL_AutorizacionPedido a
CROSS APPLY (
  SELECT TOP 1 b.IdBitacora
  FROM SEL_BitacoraTurno b
  WHERE b.Maquina = a.Maquina AND b.HoraApertura <= a.FechaHora
  ORDER BY b.IdBitacora DESC
) bi
WHERE a.IdBitacora IS NULL AND a.Maquina IS NOT NULL;
GO

-- Backfill 2 (rastro): la OT que tenia la orden desde la que se firmo EN ESE MOMENTO = la del bulto
-- mas reciente creado hasta la hora de la firma; si se firmo antes del primer bulto, la primera OT
-- que tuvo la orden despues.
UPDATE a SET a.OrdenProduccion = ISNULL(antes.OrdenProduccion, despues.OrdenProduccion)
FROM SEL_AutorizacionPedido a
OUTER APPLY (
  SELECT TOP 1 p.OrdenProduccion
  FROM SEL_Bultos b
  INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
  INNER JOIN PRDProduccion p ON p.Detalle = b.serialPadre
  WHERE ej.IdOrden = a.IdOrden AND p.OrdenProduccion IS NOT NULL
    AND b.HoraInicio <= a.FechaHora
  ORDER BY b.id DESC
) antes
OUTER APPLY (
  SELECT TOP 1 p.OrdenProduccion
  FROM SEL_Bultos b
  INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
  INNER JOIN PRDProduccion p ON p.Detalle = b.serialPadre
  WHERE ej.IdOrden = a.IdOrden AND p.OrdenProduccion IS NOT NULL
  ORDER BY b.id ASC
) despues
WHERE a.OrdenProduccion IS NULL AND a.IdOrden IS NOT NULL;
GO

PRINT 'SEL_AutorizacionPedido lista para la autorizacion por bitacora.';
SELECT COUNT(*) AS FirmasSinBitacora FROM SEL_AutorizacionPedido WHERE IdBitacora IS NULL;
-- Bitacoras ya cerradas que quedaron sin firma (las de antes de este cambio): para revisarlas a mano.
SELECT bi.IdBitacora, bi.Maquina, CONVERT(varchar(10), bi.FechaTurno, 23) AS FechaTurno, bi.Turno,
       bi.HoraApertura, bi.HoraCierre, bi.MotivoCierre
FROM SEL_BitacoraTurno bi
WHERE bi.HoraCierre IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM SEL_AutorizacionPedido a WHERE a.IdBitacora = bi.IdBitacora)
ORDER BY bi.HoraApertura DESC;
GO
