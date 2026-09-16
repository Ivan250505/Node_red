-- Agrega SEL_TiempoMuerto.OrdenProduccion (15/09/2026, a pedido del usuario) -- para que los
-- tiempos muertos (limpieza/alistamiento/descanso/mantenimiento) queden asociados directamente a
-- la Orden de Trabajo (PRDOrdenesProduccion.OrdenProduccion), sin depender de un JOIN frágil por
-- SEL_Bultos/PRDProduccion al consultar (ese JOIN puede no resolver nada si la ejecución todavía
-- no tiene bultos -- caso real confirmado: alistamiento/limpieza de los pasos 1-2 del protocolo de
-- arranque, que corren ANTES de que exista la OT).
--
-- Quién la llena (ver cambios en sel-inventario-mp.js/obtenerOCrearOrdenProduccion y
-- server.js//pausar):
--   1) Al crear la OT (primer rollo confirmado): se hace backfill de TODOS los SEL_TiempoMuerto de
--      esa id_ejecucion que quedaron con OrdenProduccion NULL -- cubre limpieza/alistamiento
--      previos al arranque, que no tenían a qué OT asociarse todavía.
--   2) Para pausas registradas DESPUÉS de que la OT ya existe (durante producción activa), /pausar
--      la resuelve y la escribe de una vez, sin esperar al backfill.
--
-- Ejecutar contra la base de datos de PRODUCCIÓN.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_TiempoMuerto') AND name = 'OrdenProduccion')
    ALTER TABLE dbo.SEL_TiempoMuerto ADD OrdenProduccion VARCHAR(20) NULL;
GO

-- Verificar
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'SEL_TiempoMuerto' AND COLUMN_NAME = 'OrdenProduccion';
GO
