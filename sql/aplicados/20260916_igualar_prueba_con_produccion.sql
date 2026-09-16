-- Dejar CarlixplastPrueba igual que Carlixplast en las tablas SEL_ (pedido del usuario, 16/09/2026).
--
-- SOLO PARA CarlixplastPrueba. El script se niega a correr contra cualquier otra base: no hay
-- ninguna sentencia aca que deba tocar produccion, y una ejecucion por equivocacion contra
-- Carlixplast estrecharia columnas que alli tienen datos.
--
-- QUE ARREGLA: se comparo columna por columna el esquema de las dos bases (16/09/2026) y salieron
-- 11 diferencias, de tres origenes distintos:
--
--   A) LO QUE FALTABA DE LOS CAMBIOS RECIENTES
--      - SEL_AmperajeFerroniquel no existe en Prueba: solo se creo en produccion el 15/09/2026.
--        Sin ella, el ultimo paso del protocolo de arranque no deja empezar a producir.
--
--   B) UN ERROR MIO, DEL 11/09/2026
--      SEL_ChequeoCalidad y SEL_ChequeoCalidadDetalle no existian en Prueba y las cree "a ojo",
--      antes de leer el esquema real de produccion. Quedaron distintas: sin la columna Origen, con
--      Operario aceptando NULL y con las tres columnas de texto mas anchas de lo que son en planta.
--      Eso es lo peor que puede pasarle a una base de pruebas -- un INSERT que funciona probando y
--      falla en produccion. Las dos tablas estan VACIAS (comprobado: 0 filas), asi que estrechar
--      las columnas no puede truncar nada.
--
--   C) DIVERGENCIAS VIEJAS, ANTERIORES A TODO ESTO
--      - SEL_EjecucionOrden.SuspendidaEn y .SuspensionDecision no existen en Prueba. Las usa el
--        aviso de "Programacion pidio suspender esta orden" (ver scriptAvisoSuspension en
--        server.js): sin ellas esa funcion no se puede probar.
--      - SEL_OrdenProduccion.UsoPrevisto, SEL_TiempoMuerto.Observaciones y .Subtipo son mas cortas
--        en Prueba; .Operario es NOT NULL en Prueba y nullable en produccion.
--      - Prueba NO TIENE NINGUNA restriccion CHECK en las tablas SEL_, y produccion tiene tres. Se
--        comprobo que los 20 registros de SEL_TiempoMuerto las cumplen antes de agregarlas.
--
-- Es IDEMPOTENTE: se puede correr varias veces sin romper nada.

-- RAISERROR solo admite constantes o variables como argumento, no una llamada a funcion: por eso
-- DB_NAME() pasa antes por una variable.
DECLARE @base SYSNAME = DB_NAME();
IF @base <> 'CarlixplastPrueba'
BEGIN
  RAISERROR('ALTO: este script es solo para CarlixplastPrueba. Base actual: %s', 16, 1, @base);
  RETURN;
END;
GO

-- A) La tabla del amperaje -------------------------------------------------------------------
IF OBJECT_ID('SEL_AmperajeFerroniquel', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_AmperajeFerroniquel (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    id_ejecucion INT NOT NULL,
    Operario INT NULL,
    Amperaje DECIMAL(6,2) NOT NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );
  CREATE INDEX IX_SEL_AmperajeFerroniquel_Ejecucion ON SEL_AmperajeFerroniquel (id_ejecucion, FechaHora);
  PRINT 'Creada SEL_AmperajeFerroniquel.';
END;
GO

-- B) Las dos tablas del chequeo de Calidad, al esquema real de produccion ---------------------
--
-- Se aborta si alguna tuviera filas: estrechar una columna con datos los truncaria en silencio.
IF EXISTS (SELECT 1 FROM SEL_ChequeoCalidadDetalle) OR EXISTS (SELECT 1 FROM SEL_ChequeoCalidad)
BEGIN
  RAISERROR('ALTO: SEL_ChequeoCalidad* tiene filas. Revise a mano antes de estrechar columnas.', 16, 1);
  RETURN;
END;
GO

IF COL_LENGTH('SEL_ChequeoCalidad', 'Origen') IS NULL
BEGIN
  ALTER TABLE SEL_ChequeoCalidad ADD Origen VARCHAR(20) NOT NULL
    CONSTRAINT DF_SEL_ChequeoCalidad_Origen DEFAULT 'Automatico';
  PRINT 'Agregada SEL_ChequeoCalidad.Origen.';
END;
GO

-- Operario: nullable en Prueba, NOT NULL en produccion. La tabla esta vacia, no hay que rellenar.
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('SEL_ChequeoCalidad')
           AND name = 'Operario' AND is_nullable = 1)
BEGIN
  ALTER TABLE SEL_ChequeoCalidad ALTER COLUMN Operario INT NOT NULL;
  PRINT 'SEL_ChequeoCalidad.Operario -> NOT NULL.';
END;
GO

IF COL_LENGTH('SEL_ChequeoCalidadDetalle', 'Apartado') <> 30
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ALTER COLUMN Apartado VARCHAR(30) NOT NULL;
  PRINT 'SEL_ChequeoCalidadDetalle.Apartado -> VARCHAR(30).';
END;
GO

IF COL_LENGTH('SEL_ChequeoCalidadDetalle', 'Pregunta') <> 40
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ALTER COLUMN Pregunta VARCHAR(40) NOT NULL;
  PRINT 'SEL_ChequeoCalidadDetalle.Pregunta -> VARCHAR(40).';
END;
GO

IF COL_LENGTH('SEL_ChequeoCalidadDetalle', 'Respuesta') <> 15
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ALTER COLUMN Respuesta VARCHAR(15) NOT NULL;
  PRINT 'SEL_ChequeoCalidadDetalle.Respuesta -> VARCHAR(15).';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('SEL_ChequeoCalidadDetalle')
                 AND name = 'CK_SEL_ChequeoCalidadDetalle_Respuesta')
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ADD CONSTRAINT CK_SEL_ChequeoCalidadDetalle_Respuesta
    CHECK (Respuesta IN ('Conforme', 'NoConforme'));
  PRINT 'Agregado CK_SEL_ChequeoCalidadDetalle_Respuesta.';
END;
GO

-- OJO: NO se agrega ningun CHECK sobre Pregunta. Produccion lo tuvo y se elimino el 11/09/2026
-- justamente porque el apartado "Medidas" es dinamico y sus claves no caben en una lista fija.

-- C) Divergencias viejas ---------------------------------------------------------------------
IF COL_LENGTH('SEL_EjecucionOrden', 'SuspendidaEn') IS NULL
BEGIN
  ALTER TABLE SEL_EjecucionOrden ADD SuspendidaEn DATETIME NULL;
  PRINT 'Agregada SEL_EjecucionOrden.SuspendidaEn.';
END;
GO

IF COL_LENGTH('SEL_EjecucionOrden', 'SuspensionDecision') IS NULL
BEGIN
  ALTER TABLE SEL_EjecucionOrden ADD SuspensionDecision VARCHAR(20) NULL;
  PRINT 'Agregada SEL_EjecucionOrden.SuspensionDecision.';
END;
GO

IF COL_LENGTH('SEL_OrdenProduccion', 'UsoPrevisto') < 150
BEGIN
  ALTER TABLE SEL_OrdenProduccion ALTER COLUMN UsoPrevisto VARCHAR(150) NULL;
  PRINT 'SEL_OrdenProduccion.UsoPrevisto -> VARCHAR(150).';
END;
GO

IF COL_LENGTH('SEL_TiempoMuerto', 'Observaciones') < 255
BEGIN
  ALTER TABLE SEL_TiempoMuerto ALTER COLUMN Observaciones VARCHAR(255) NULL;
  PRINT 'SEL_TiempoMuerto.Observaciones -> VARCHAR(255).';
END;
GO

-- Subtipo se ensancha ANTES de crear el CHECK que lo usa: 'LIMPIEZA_DESINFECCION' son 21
-- caracteres y no cabe en los VARCHAR(20) que tiene Prueba hoy.
IF COL_LENGTH('SEL_TiempoMuerto', 'Subtipo') < 30
BEGIN
  ALTER TABLE SEL_TiempoMuerto ALTER COLUMN Subtipo VARCHAR(30) NULL;
  PRINT 'SEL_TiempoMuerto.Subtipo -> VARCHAR(30).';
END;
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('SEL_TiempoMuerto')
           AND name = 'Operario' AND is_nullable = 0)
BEGIN
  ALTER TABLE SEL_TiempoMuerto ALTER COLUMN Operario INT NULL;
  PRINT 'SEL_TiempoMuerto.Operario -> NULL (como produccion).';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('SEL_TiempoMuerto') AND name = 'CK_SEL_TiempoMuerto_Tipo')
BEGIN
  ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Tipo
    CHECK (Tipo IN ('ALISTAMIENTO','MANTENIMIENTO','DESCANSO','ORDEN_ASEO','LIMPIEZA','OTRO'));
  PRINT 'Agregado CK_SEL_TiempoMuerto_Tipo.';
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE parent_object_id = OBJECT_ID('SEL_TiempoMuerto') AND name = 'CK_SEL_TiempoMuerto_Subtipo')
BEGIN
  ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Subtipo
    CHECK ((Tipo = 'ALISTAMIENTO' AND Subtipo IN ('MATERIALES','MECANICO','ESPACIO_TRABAJO','LIMPIEZA_DESINFECCION','ARRANQUE'))
        OR (Tipo <> 'ALISTAMIENTO' AND Subtipo IS NULL));
  PRINT 'Agregado CK_SEL_TiempoMuerto_Subtipo.';
END;
GO

PRINT 'Listo. Vuelva a comparar los esquemas para confirmar que no queda ninguna diferencia.';
