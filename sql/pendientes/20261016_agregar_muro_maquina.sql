-- Pizarra / muro de observaciones de cada selladora (pedido del usuario, 16/10/2026).
--
-- QUE ES: notas que se dejan "pegadas" en la pantalla de la maquina (/selladora/:codigo), a la
-- vista de todos los turnos -- "la perilla 3 esta floja", "no usar el rollo del estante B". No
-- cuelgan de ninguna orden: la maquina sigue siendo la misma cuando cambia el pedido.
--
-- POR QUE NO SEL_ObservacionOperario: esa tabla es el registro de lo que paso en una ORDEN (IdOrden
-- NOT NULL) y no se clasifica a proposito. El muro es lo contrario: vive en la maquina, se
-- clasifica por color (Tipo) y una nota se puede fijar arriba.
--
-- No se borran notas desde la tableta (decision del usuario, 16/10/2026): solo publicar, fijar y
-- desfijar.
--
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE: se puede correr varias veces y sobre las dos
-- bases (Carlixplast / CarlixplastPrueba) sin romper nada.

IF OBJECT_ID('SEL_MuroMaquina', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_MuroMaquina (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    -- PRDMaquinas.Codigo.
    Maquina INT NOT NULL,
    Texto VARCHAR(500) NOT NULL,
    -- El color del post-it. Lista cerrada con CHECK, igual que las demas columnas de estado SEL_.
    Tipo VARCHAR(20) NOT NULL DEFAULT 'Nota'
      CONSTRAINT CK_SEL_MuroMaquina_Tipo CHECK (Tipo IN ('Nota', 'Aviso', 'Mantenimiento', 'Calidad')),
    Fijada BIT NOT NULL DEFAULT 0,
    -- SISUsuarios.Codigo / Nombre de quien la escribio. El nombre se guarda tal cual para no tener
    -- que hacer JOIN al pintar el muro (mismo criterio que SEL_AjusteConsumoRollo.Usuario).
    Usuario VARCHAR(20) NULL,
    NombreUsuario VARCHAR(100) NULL,
    -- PRDOperarios.Codigo si quien escribio es operario de planta.
    Operario INT NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE(),
    -- Quien la fijo o desfijo por ultima vez, y cuando.
    FijadaPor VARCHAR(100) NULL,
    FechaFijada DATETIME NULL
  );

  -- El muro de una maquina: fijadas primero, luego las mas recientes.
  CREATE INDEX IX_SEL_MuroMaquina_Maquina
    ON SEL_MuroMaquina (Maquina, Fijada, FechaHora);
END;
GO

PRINT 'SEL_MuroMaquina lista.';
GO
