-- La autorizacion del lider pasa de ser POR PEDIDO a ser POR ORDEN DE TRABAJO (pedido del usuario,
-- 25/09/2026: "esa autorizacion debe quedar por orden de trabajo").
--
-- QUE CAMBIA: SEL_AutorizacionPedido gana la columna OrdenProduccion (= PRDOrdenesProduccion.OrdenProduccion,
-- la OT). La comprobacion de Finalizar / Cerrar sesion ahora busca una firma de la OT ACTUAL de la
-- orden (la del bulto mas reciente), no del NumeroPedido. NumeroPedido se sigue llenando como rastro.
--
-- Reglas que definio el usuario el 25/09/2026:
--   - Si la orden tuvo varias OT (se retomo otro dia y nacio una OT nueva), solo se exige la firma
--     de la OT actual; las de dias anteriores no bloquean.
--   - Mientras la OT no existe (orden Pendiente, limpieza, alistamiento) no se exige firma.
--   - Las firmas que ya existian por pedido se asignan a su OT (backfill de abajo).
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

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SEL_AutorizacionPedido_OT'
               AND object_id = OBJECT_ID('SEL_AutorizacionPedido'))
BEGIN
  -- La consulta que se hace en cada Finalizar y en cada cierre de sesion.
  CREATE INDEX IX_SEL_AutorizacionPedido_OT
    ON SEL_AutorizacionPedido (OrdenProduccion, FechaHora);
END;
GO

-- Backfill: a cada firma vieja se le pone la OT que tenia la orden desde la que se firmo EN ESE
-- MOMENTO = la del bulto mas reciente creado hasta la hora de la firma. Si se firmo antes del
-- primer bulto (durante el alistamiento, que antes se permitia), se toma la PRIMERA OT que tuvo
-- la orden despues: es la que esa firma estaba respaldando. Las que no tienen IdOrden o cuya orden
-- nunca llego a tener OT quedan en NULL -- se conservan como historia pero ya no desbloquean nada.
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

PRINT 'SEL_AutorizacionPedido ya tiene OrdenProduccion (autorizacion por OT).';
SELECT COUNT(*) AS FirmasSinOT FROM SEL_AutorizacionPedido WHERE OrdenProduccion IS NULL;
GO
