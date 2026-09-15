-- SEL_TiempoMuerto.DuracionMinutos: dejarla calculada tambien en carlixplast (15/09/2026).
--
-- Las dos bases NO tenian la misma definicion de esta columna:
--   carlixplastPrueba -> CALCULADA: AS (datediff(minute,[HoraInicio],[HoraFin])) PERSISTED
--   carlixplast       -> columna INT normal, que no la escribe nadie
--
-- Como se llego a eso: el POST /reanudar la llenaba a mano (SET HoraFin = GETDATE(),
-- DuracionMinutos = DATEDIFF(...)), pero eso reventaba en carlixplastPrueba con "cannot be modified
-- because it is either a computed column or is the result of a UNION operator" -- ahi si es
-- calculada. Se quito la asignacion de server.js y desde entonces, en carlixplast, la columna no la
-- llena nadie: al 15/09/2026 estaba en NULL en las 77 filas que habia, TODAS con HoraFin guardado.
--
-- No se perdio nada (HoraInicio/HoraFin estan completos y la duracion siempre se puede derivar con
-- DATEDIFF), pero la columna queda de trampa: quien haga SUM(DuracionMinutos) desde un Excel o un
-- Power BI recibe NULL y lo lee como "cero tiempo muerto", o sea eficiencia perfecta. Este script la
-- iguala a la de carlixplastPrueba: SQL Server la resuelve sola en cuanto se guarda HoraFin, y de
-- paso las filas viejas quedan con su valor sin tener que rellenarlas.
--
-- IDEMPOTENTE y valido en las DOS bases: si ya es calculada (carlixplastPrueba) no hace nada. Una
-- columna normal no se puede convertir en calculada en sitio, toca soltarla y volverla a crear --
-- por eso el script se NIEGA a seguir si alguien ya le escribio valores, en vez de borrarlos.
--
-- Dos efectos que no rompen nada hoy pero conviene saber:
--   - Al recrearla, la columna pasa al ultimo lugar del orden fisico de la tabla. Solo importaria
--     para un SELECT * leido por posicion o un INSERT sin lista de columnas; server.js siempre
--     nombra las columnas, y no hay vistas ni procedimientos que toquen esta tabla (comprobado).
--   - Queda fijada la unidad en MINUTOS. Ojo que DATEDIFF(MINUTE, ...) cuenta cruces de frontera,
--     no duracion real: de 10:00:59 a 10:01:01 da 1 minuto y de 10:00:00 a 10:00:59 da 0 (hoy 9 de
--     las 77 filas dan 0). Si algun dia esto alimenta un OEE que necesite segundos, hay que volver
--     a soltar y recrear la columna en las dos bases.
--
-- Ejecutar una sola vez contra la base.

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID('SEL_TiempoMuerto', 'U') IS NULL
    THROW 50001, 'No existe la tabla SEL_TiempoMuerto en esta base.', 1;

  IF NOT EXISTS (SELECT 1 FROM sys.columns
                 WHERE object_id = OBJECT_ID('SEL_TiempoMuerto') AND name = 'DuracionMinutos')
  BEGIN
    EXEC('ALTER TABLE SEL_TiempoMuerto
            ADD DuracionMinutos AS (DATEDIFF(MINUTE, HoraInicio, HoraFin)) PERSISTED');
    PRINT 'DuracionMinutos no existia: creada como columna calculada PERSISTED.';
  END
  ELSE IF EXISTS (SELECT 1 FROM sys.columns
                  WHERE object_id = OBJECT_ID('SEL_TiempoMuerto')
                    AND name = 'DuracionMinutos' AND is_computed = 1)
  BEGIN
    PRINT 'DuracionMinutos ya es una columna calculada: no hay nada que hacer en esta base.';
  END
  ELSE
  BEGIN
    -- Freno de mano. Si alguien relleno la columna a mano (un UPDATE suelto, un backfill), soltarla
    -- borraria ese trabajo: mejor abortar y que lo revise una persona. Va por sp_executesql porque
    -- en la rama de arriba la columna puede no existir y el batch no compilaria.
    DECLARE @conValores INT;
    EXEC sp_executesql
      N'SELECT @n = COUNT(*) FROM SEL_TiempoMuerto WHERE DuracionMinutos IS NOT NULL',
      N'@n INT OUTPUT', @n = @conValores OUTPUT;

    IF @conValores > 0
      THROW 50002, 'Abortado: DuracionMinutos ya tiene valores escritos. Soltar la columna los borraria -- revisar a mano antes de correr este script.', 1;

    -- Un DEFAULT sobre la columna impediria el DROP COLUMN. En carlixplast no hay ninguno, pero se
    -- suelta por si la base donde se corra si lo tiene.
    DECLARE @default SYSNAME = (
      SELECT dc.name
      FROM sys.default_constraints dc
      INNER JOIN sys.columns c ON c.object_id = dc.parent_object_id
                              AND c.column_id = dc.parent_column_id
      WHERE dc.parent_object_id = OBJECT_ID('SEL_TiempoMuerto') AND c.name = 'DuracionMinutos');
    IF @default IS NOT NULL
      EXEC('ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT [' + @default + ']');

    ALTER TABLE SEL_TiempoMuerto DROP COLUMN DuracionMinutos;
    EXEC('ALTER TABLE SEL_TiempoMuerto
            ADD DuracionMinutos AS (DATEDIFF(MINUTE, HoraInicio, HoraFin)) PERSISTED');
    PRINT 'DuracionMinutos recreada como columna calculada PERSISTED.';
  END

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  -- El DROP y el ADD van en la misma transaccion a proposito: si el ADD fallara, un rollback deja la
  -- columna como estaba en vez de dejar la tabla sin ella.
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH
GO

-- Comprobacion: deberia salir is_computed = 1, la definicion con datediff y ninguna fila cerrada
-- sin duracion.
SELECT c.name AS Columna, c.is_computed, cc.definition, cc.is_persisted,
       (SELECT COUNT(*) FROM SEL_TiempoMuerto) AS Filas,
       (SELECT COUNT(*) FROM SEL_TiempoMuerto
        WHERE HoraFin IS NOT NULL AND DuracionMinutos IS NULL) AS CerradasSinDuracion
FROM sys.columns c
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
WHERE c.object_id = OBJECT_ID('SEL_TiempoMuerto') AND c.name = 'DuracionMinutos';
GO
