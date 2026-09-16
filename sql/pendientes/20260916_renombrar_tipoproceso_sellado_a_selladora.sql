-- Alinea TipoProceso='Sellado' (valor escrito a mano en sel-inventario-mp.js, inconsistente con
-- el resto del sistema) a 'SELLADORA' -- mismo valor que PRDMaquinas.Tipo usa para esta máquina en
-- TODO el sistema clásico (ConsReporteSelladoraPLC.vb, EjecucionSelladora.vb,
-- frmLiberacionProduccion.vb, etc.). Ejecutar DESPUÉS de desplegar el cambio de código
-- (sel-inventario-mp.js ya escribe 'SELLADORA' en INSERTs nuevos desde el 16/09/2026).
--
-- Ejecutar contra la base de PRODUCCIÓN. Seguro de re-ejecutar.

UPDATE PRDOrdenesProduccion SET TipoProceso = 'SELLADORA' WHERE TipoProceso = 'Sellado';
UPDATE PRDExtrusionControl SET TipoProceso = 'SELLADORA' WHERE TipoProceso = 'Sellado';

-- Verificar -- no debe quedar ninguna fila con 'Sellado'
SELECT 'PRDOrdenesProduccion' AS Tabla, COUNT(*) AS ConSelladoMinuscula FROM PRDOrdenesProduccion WHERE TipoProceso = 'Sellado'
UNION ALL
SELECT 'PRDExtrusionControl', COUNT(*) FROM PRDExtrusionControl WHERE TipoProceso = 'Sellado';
