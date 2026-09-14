-- Solo aplica si PRDGrupoEtapasCompartidasLineas YA EXISTIA antes de hoy con la PK vieja sobre
-- Linea. Si el paso 03 la acaba de crear de cero, esto no hace nada (la columna ya está).
-- Paso 1 de 3. Origen: agregar_elemento_grupoetapascompartidaslineas.sql.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND name = 'Elemento')
    ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ADD Elemento INT NULL;
