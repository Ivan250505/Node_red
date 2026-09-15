-- Bitácora de rollos de entrada (qué rollo se montó, a qué hora, sobre qué bulto). Sin esta
-- tabla el servicio no se cae -- lo atrapa y avisa en consola -- pero la columna "Rollo" del
-- reporte de producción sale siempre en blanco. Idempotente. Origen: subir_a_produccion_sellado_paralelo.sql, Paso 2.

IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SEL_RolloEjecucion (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        id_ejecucion INT NOT NULL,
        id_bulto INT NULL,
        Serial VARCHAR(30) NOT NULL,
        Cantidad DECIMAL(18,3) NULL,
        LoteMP VARCHAR(20) NULL,
        Bodega VARCHAR(20) NULL,
        Operario INT NULL,
        EsInicio BIT NOT NULL DEFAULT 0,
        FechaHora DATETIME NOT NULL DEFAULT GETDATE()
    );
    PRINT 'Creada SEL_RolloEjecucion.';
END

IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID('dbo.SEL_RolloEjecucion') AND name = 'IX_SEL_RolloEjecucion_Ejecucion')
BEGIN
    CREATE INDEX IX_SEL_RolloEjecucion_Ejecucion ON dbo.SEL_RolloEjecucion (id_ejecucion, FechaHora);
    PRINT 'Creado IX_SEL_RolloEjecucion_Ejecucion.';
END
