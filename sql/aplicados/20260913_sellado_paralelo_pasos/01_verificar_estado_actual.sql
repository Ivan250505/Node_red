-- SOLO LECTURA -- no modifica nada. Corré esto primero (y de nuevo después de cada paso) para ver
-- qué de lo pendiente ya existe en la base a la que estés conectado ahora mismo.

SELECT DB_NAME() AS BaseConectada;

-- Sellado en Paralelo -----------------------------------------------------------------------
SELECT
    CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_OrdenProduccion') AND name = 'Linea')
         THEN 'OK' ELSE 'FALTA' END AS SEL_OrdenProduccion_Linea,
    CASE WHEN EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRDGrupoEtapasCompartidas')
         THEN 'OK' ELSE 'FALTA' END AS Tabla_PRDGrupoEtapasCompartidas,
    CASE WHEN EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRDGrupoEtapasCompartidasLineas')
         THEN 'OK' ELSE 'FALTA' END AS Tabla_PRDGrupoEtapasCompartidasLineas,
    CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND name = 'Elemento')
         THEN 'OK' ELSE 'FALTA' END AS PRDGrupoEtapasCompartidasLineas_Elemento,
    ISNULL((SELECT kc.name FROM sys.key_constraints kc
            WHERE kc.parent_object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND kc.type = 'PK'), '(sin PK)') AS PK_Actual,
    (SELECT STRING_AGG(c.name, ', ') FROM sys.index_columns ic
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        JOIN sys.key_constraints kc ON kc.unique_index_id = ic.index_id AND kc.parent_object_id = ic.object_id
        WHERE ic.object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND kc.type = 'PK'
    ) AS Columnas_PK,
    CASE WHEN OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END AS Tabla_SEL_RolloEjecucion,
    CASE WHEN OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_GenerarEntradaInventario')) LIKE '%PRDGrupoEtapasCompartidasLineas%'
         THEN 'OK (ya tiene el fallback de grupo)' ELSE 'FALTA (sin fallback de referencias hermanas)' END AS Trigger_GenerarEntradaInventario,
    CASE WHEN OBJECT_DEFINITION(OBJECT_ID('dbo.sp_SEL_AnularBultoVacio')) LIKE '%''Activo'', ''Temporal'', ''EnEspera''%'
         THEN 'OK (ya tiene el fix del traslado)' ELSE 'FALTA' END AS SP_AnularBultoVacio;

-- Modificar cantidad de bolsas ---------------------------------------------------------------
SELECT
    CASE WHEN COL_LENGTH('SEL_PesajeElemento', 'UnidadesPaquete') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END AS SEL_PesajeElemento_UnidadesPaquete;

-- trg_SEL_Bultos_CierreBulto -- SOLO PARA MIRAR A OJO, no se puede automatizar el chequeo (el
-- texto entero cambia entre bases). Buscá a mano si tiene "Unidades = ", "HoraFinal = @HoraFin"
-- o "HoraFinal = NULL", y "@TipoPedido" (dinámico) vs ", 4," (fijo) cerca del INSERT INTO PRDProduccion.
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_CierreBulto')) AS Trigger_CierreBulto_TextoCompleto;

-- Consulta "Producción y Seguimiento" (Mirane) ------------------------------------------------
SELECT
    CASE WHEN EXISTS (SELECT 1 FROM SISModulosConsultas WHERE Formulario = 'ConsProduccionSeguimiento')
         THEN 'OK' ELSE 'FALTA' END AS Menu_ConsProduccionSeguimiento;
