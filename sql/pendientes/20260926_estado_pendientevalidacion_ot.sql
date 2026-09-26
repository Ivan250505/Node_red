-- La OT (PRDOrdenesProduccion) tiene que poder quedar en 'PendienteValidacion' (26/09/2026).
--
-- POR QUE: desde el commit d2fd35d (24/09/2026) el Finalizar de la tableta deja la OT en
-- 'PendienteValidacion' (finalizarControlParcialSellado en sel-inventario-mp.js) y el digitador la
-- pasa a 'Finalizada' desde Validacion Selladora (Mirane: SincronizarEstadoOT). Pero la columna
-- nunca se preparo para ese valor:
--   - Estado es VARCHAR(15) y 'PendienteValidacion' tiene 19 caracteres, y
--   - CK_PRDOrdenesProduccion_Estado solo acepta 'Finalizada', 'Suspendida' y 'Activa'.
-- Resultado: TODO Finalizar de la tableta revienta con "String or binary data would be truncated"
-- (bug real: pedido 11731, 26/09/2026). La transaccion se revierte entera, asi que no queda nada a
-- medias -- la orden simplemente sigue Activa.
--
-- QUE HACE: amplia Estado a VARCHAR(20) (mismo largo que SEL_OrdenProduccion.Estado y
-- PRDExtrusionControl.Estado) y rehace el CHECK sumando 'PendienteValidacion'. Respeta la
-- nulabilidad que ya tenga la columna. El DEFAULT ('Activa') no se toca: SQL Server deja cambiar el
-- largo de una columna con DEFAULT sin quitarlo.
--
-- Ejecutar contra la base de Mirane (carlixplast y carlixplastPrueba). Es IDEMPOTENTE.

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_PRDOrdenesProduccion_Estado'
           AND parent_object_id = OBJECT_ID('PRDOrdenesProduccion'))
  ALTER TABLE PRDOrdenesProduccion DROP CONSTRAINT CK_PRDOrdenesProduccion_Estado;
GO

IF (SELECT max_length FROM sys.columns
    WHERE object_id = OBJECT_ID('PRDOrdenesProduccion') AND name = 'Estado') < 20
BEGIN
  DECLARE @nulo BIT = (SELECT is_nullable FROM sys.columns
                       WHERE object_id = OBJECT_ID('PRDOrdenesProduccion') AND name = 'Estado');
  DECLARE @sql NVARCHAR(200) = N'ALTER TABLE PRDOrdenesProduccion ALTER COLUMN Estado VARCHAR(20) '
    + CASE WHEN @nulo = 1 THEN N'NULL' ELSE N'NOT NULL' END;
  EXEC (@sql);
END;
GO

ALTER TABLE PRDOrdenesProduccion WITH CHECK ADD CONSTRAINT CK_PRDOrdenesProduccion_Estado
  CHECK (Estado IN ('Activa', 'Suspendida', 'PendienteValidacion', 'Finalizada'));
GO

PRINT 'PRDOrdenesProduccion.Estado ya acepta PendienteValidacion.';
SELECT c.max_length AS LargoEstado, c.is_nullable,
       (SELECT definition FROM sys.check_constraints WHERE name = 'CK_PRDOrdenesProduccion_Estado') AS CheckEstado
FROM sys.columns c WHERE c.object_id = OBJECT_ID('PRDOrdenesProduccion') AND c.name = 'Estado';
GO
