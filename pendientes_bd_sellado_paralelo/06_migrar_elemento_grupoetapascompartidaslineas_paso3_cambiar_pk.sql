-- Paso 3 de 3 -- solo corré esto si el paso 2 no devolvió ninguna fila. Reemplaza la PK vieja
-- (IdGrupo, Linea) por la nueva (IdGrupo, Elemento). Si la PK vieja ya no existe (bases nuevas,
-- creadas ya con el esquema correcto por el paso 03), no hace nada.

IF EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE name = 'PK_PRDGrupoEtapasCompartidasLineas' AND parent_object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas')
)
BEGIN
    ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas DROP CONSTRAINT PK_PRDGrupoEtapasCompartidasLineas;
    ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ALTER COLUMN Elemento INT NOT NULL;
    ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ALTER COLUMN Linea INT NULL;
    ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ADD CONSTRAINT PK_PRDGrupoEtapasCompartidasLineas PRIMARY KEY (IdGrupo, Elemento);
END

-- Verificación final
SELECT * FROM dbo.PRDGrupoEtapasCompartidasLineas ORDER BY IdGrupo;
