-- Marcacion de entrada/salida por QR (bultos-web).
-- CodigoQR es un token unico por operario (no es su contrasena ni su Codigo de login):
-- se genera una vez, se imprime como QR y se guarda aqui para poder identificar al
-- operario con solo escanearlo, sin que tenga que escribir usuario/contrasena en la
-- tablet de planta.

ALTER TABLE SISUsuarios ADD CodigoQR varchar(50) NULL
GO

CREATE TABLE SISAccesos (
    IdAcceso      int IDENTITY(1,1) PRIMARY KEY,
    Codigo        varchar(20)  NOT NULL,   -- FK logico a SISUsuarios.Codigo (mismo tipo/largo, sin FK fisica)
    FechaHora     datetime     NOT NULL DEFAULT (GETDATE()),
    TipoEvento    varchar(10)  NOT NULL,   -- 'Entrada' / 'Salida'
    Origen        varchar(20)  NULL        -- 'QR', 'Manual', etc.
)
GO

CREATE INDEX IX_SISAccesos_Codigo_Fecha ON SISAccesos (Codigo, FechaHora)
GO
