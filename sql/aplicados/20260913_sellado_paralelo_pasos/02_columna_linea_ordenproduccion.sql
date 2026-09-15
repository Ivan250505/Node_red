-- Columna Linea en SEL_OrdenProduccion (necesaria para relacionar una orden con su grupo de
-- Sellado en Paralelo). Idempotente. Origen: agregar_linea_ordenproduccion.sql.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_OrdenProduccion') AND name = 'Linea')
    ALTER TABLE dbo.SEL_OrdenProduccion ADD Linea INT NULL;
