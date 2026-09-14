-- Tablas de agrupación de etapas compartidas (varias referencias de salida = mismo proceso
-- físico). CREATE TABLE no necesita ir solo en su lote, por eso las dos entran en un mismo
-- archivo sin GO. Idempotente. Origen: crear_grupoetapascompartidas.sql (ya con el esquema
-- correcto: PK de la tabla de líneas sobre Elemento, no sobre Linea).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRDGrupoEtapasCompartidas' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.PRDGrupoEtapasCompartidas (
        IdGrupo             INT           IDENTITY(1,1) PRIMARY KEY,
        SubEmpresa          INT           NOT NULL,
        Tipo                INT           NOT NULL,
        Fecha               DATETIME      NOT NULL,
        Numero              VARCHAR(20)   NOT NULL,
        CategoriaMaquina    VARCHAR(30)   NOT NULL,
        ElementoSalida      INT           NULL,
        FechaCreacion       DATETIME      NOT NULL CONSTRAINT DF_PRDGrupoEtapasCompartidas_FechaCreacion DEFAULT (GETDATE()),
        UsuarioCreacion     INT           NULL
    )
    PRINT 'Creada tabla PRDGrupoEtapasCompartidas'
END

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'PRDGrupoEtapasCompartidasLineas' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE dbo.PRDGrupoEtapasCompartidasLineas (
        IdGrupo  INT NOT NULL,
        Elemento INT NOT NULL,
        Linea    INT NULL,
        CONSTRAINT PK_PRDGrupoEtapasCompartidasLineas PRIMARY KEY (IdGrupo, Elemento),
        CONSTRAINT FK_PRDGrupoEtapasCompartidasLineas_Grupo FOREIGN KEY (IdGrupo)
            REFERENCES dbo.PRDGrupoEtapasCompartidas(IdGrupo)
    )
    PRINT 'Creada tabla PRDGrupoEtapasCompartidasLineas'
END
