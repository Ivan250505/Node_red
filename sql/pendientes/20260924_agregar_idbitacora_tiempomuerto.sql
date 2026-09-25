-- Agrega SEL_TiempoMuerto.IdBitacora (24/09/2026, a pedido del usuario) -- para que cada tiempo
-- muerto (limpieza/alistamiento/descanso/mantenimiento/pausa) quede asociado a la bitacora de turno
-- (SEL_BitacoraTurno) de la maquina, igual que los bultos (PRDProduccion.IdBitacora /
-- SEL_Bultos.IdBitacora).
--
-- Solo estructura: la columna queda en NULL para lo que ya existe. Llenarla en los tiempos muertos
-- nuevos requiere el cambio en Node (server.js, donde se inserta SEL_TiempoMuerto) -- pendiente.
--
-- DBeaver: seleccionar todo + Ctrl+Enter (un solo lote, sin GO). El indice va por EXEC() porque la
-- columna todavia no existe cuando SQL Server compila el lote.
-- Ejecutar contra la base de datos de PRODUCCION.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_TiempoMuerto') AND name = 'IdBitacora')
    ALTER TABLE dbo.SEL_TiempoMuerto ADD IdBitacora INT NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.SEL_TiempoMuerto') AND name = 'IX_SEL_TiempoMuerto_IdBitacora')
    EXEC('CREATE INDEX IX_SEL_TiempoMuerto_IdBitacora ON dbo.SEL_TiempoMuerto (IdBitacora)');

-- Verificar
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'SEL_TiempoMuerto' AND COLUMN_NAME = 'IdBitacora';
