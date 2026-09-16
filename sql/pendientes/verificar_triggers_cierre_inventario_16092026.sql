-- Verifica si los triggers de cierre de bulto/inventario que están en el repo (Node) ya quedaron
-- aplicados de verdad en la base -- git no aplica triggers solo, hay que correrlos a mano contra
-- SQL Server. SOLO LECTURA, no modifica nada.
--
-- Chequea 2 fixes puntuales:
--   1) trg_SEL_Bultos_CierreBulto -- debía empezar a escribir PRDProduccion.Unidades al cerrar
--      (antes se quedaba en 0). Marcador: "p.Unidades = u.Total" en el texto del trigger.
--      (ver corregir_trigger_cierrebulto_unidades.sql)
--   2) trg_SEL_Bultos_GenerarEntradaInventario -- fallback de referencias "hermanas" (grupo
--      Sellado en Paralelo) por LINEA en vez de por Elemento (Pedido 11243). Marcador:
--      "LineaOrden" en el texto del trigger. (ver corregir_trigger_hermanas_por_linea.sql)
--
-- Ejecutar contra la base de PRODUCCIÓN (y de paso contra carlixplastPrueba si quieres comparar).

SELECT
    o.name AS Trigger_,
    o.modify_date AS UltimaModificacion,
    CASE
        WHEN o.name = 'trg_SEL_Bultos_CierreBulto'
             THEN CASE WHEN OBJECT_DEFINITION(o.object_id) LIKE '%p.Unidades = u.Total%'
                       THEN 'OK -- ya escribe Unidades al cerrar'
                       ELSE 'DESACTUALIZADO -- falta correr corregir_trigger_cierrebulto_unidades.sql' END
        WHEN o.name = 'trg_SEL_Bultos_GenerarEntradaInventario'
             THEN CASE WHEN OBJECT_DEFINITION(o.object_id) LIKE '%LineaOrden%'
                       THEN 'OK -- fallback de hermanas ya es por Linea'
                       ELSE 'DESACTUALIZADO -- falta correr corregir_trigger_hermanas_por_linea.sql' END
    END AS Estado
FROM sys.triggers o
WHERE o.name IN ('trg_SEL_Bultos_CierreBulto', 'trg_SEL_Bultos_GenerarEntradaInventario');

-- Si alguna de las dos filas no aparece, el trigger ni siquiera existe todavía en esta base --
-- también hay que correr el script correspondiente completo (CREATE OR ALTER / el IF OBJECT_ID
-- ... CREATE + ALTER del segundo).
