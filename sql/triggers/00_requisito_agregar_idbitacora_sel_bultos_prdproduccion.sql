-- Agrega IdBitacora a SEL_Bultos y PRDProduccion -- a pedido del usuario (20/09/2026): guardar la
-- identidad de la bitacora (Orden de Trabajo nueva: Maquina+Turno+Fecha) directo en el bulto en vez
-- de calcularla por join de ventana de tiempo cada vez que se consulta. Mismo criterio ya usado
-- para OrdenProduccion/TipoPedido: se resuelve UNA vez (para el primer bulto, del lado Node -- ver
-- materializarInicioOrden/crearBultoInicial) y de ahi en adelante el trigger de cierre solo lo
-- COPIA del bulto anterior de la misma ejecucion (no se recalcula).
--
-- Queda NULL para todo bulto del flujo CLASICO (sin bitacora) -- asi responde solo por los casos
-- que sí existen en bitacora, sin necesitar una columna/CASE aparte.
--
-- Ejecutar contra la base de Mirane (Prueba primero, luego produccion). Es IDEMPOTENTE.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_Bultos') AND name = 'IdBitacora')
BEGIN
    ALTER TABLE dbo.SEL_Bultos ADD IdBitacora INT NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PRDProduccion') AND name = 'IdBitacora')
BEGIN
    ALTER TABLE dbo.PRDProduccion ADD IdBitacora INT NULL;
END;
GO
