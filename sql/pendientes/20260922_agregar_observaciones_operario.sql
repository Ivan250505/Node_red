-- Observaciones libres del operario, atadas a la orden de trabajo, al operario y a la fecha
-- (pedido del usuario, 22/09/2026).
--
-- POR QUE UNA TABLA PROPIA Y NO UNA COLUMNA EN SEL_ChequeoCalidadDetalle: se evaluaron las dos.
-- La columna se descarto por tres razones:
--   1. Una observacion no siempre nace de una pregunta del chequeo. "El rollo venia ovalado" o "la
--      selladora calienta desparejo" no tienen casilla donde caber, y son justo las que interesan.
--   2. SEL_ChequeoCalidad solo se escribe cuando hay un bulto Activo -- por eso su id_bulto es
--      nullable. Colgar de ahi dejaria sin registrar lo que pasa entre bulto y bulto.
--   3. El chequeo cuelga de id_ejecucion; lo que se pidio es que cuelgue de la ORDEN.
--
-- QUE NO HACE: no clasifica. Es texto libre a proposito (decision del usuario, 22/09/2026) -- no
-- hay Tipo/Categoria. Si algun dia hace falta filtrar por tema, se agrega la columna con su CHECK
-- y las filas viejas quedan en NULL; no hay nada que migrar.
--
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE: se puede correr varias veces y sobre las dos
-- bases (Carlixplast / CarlixplastPrueba) sin romper nada.

IF OBJECT_ID('SEL_ObservacionOperario', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_ObservacionOperario (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    -- La OT que el operario tenia en pantalla cuando escribio.
    IdOrden INT NOT NULL,
    -- Sellado paralelo: las 3 referencias comparten maquina y rollo, asi que una observacion de
    -- material o de maquina aplica a las 3 aunque se haya escrito desde una sola. Guardar el ancla
    -- deja que el reporte las junte sin reconstruir el grupo (mismo criterio que
    -- SEL_AjusteConsumoRollo.IdOrdenAncla). NULL = la orden no pertenece a ningun grupo.
    IdOrdenAncla INT NULL,
    -- La misma ejecucion que usan SEL_ProtocoloArranque y SEL_ChequeoCalidad, para poder cruzar las
    -- tres tablas en un reporte de turno.
    id_ejecucion INT NULL,
    -- PRDOperarios.Codigo (el CodigoOperarioPRD del usuario logueado). Nullable por la misma razon
    -- que en las demas tablas: un usuario de oficina sin codigo de operario puede llegar a escribir.
    Operario INT NULL,
    -- PRDMaquinas.Codigo. Denormalizado A PROPOSITO aunque la orden ya lo tenga: la pregunta que se
    -- le va a hacer a esta tabla es "que paso en la Selladora 05 anoche", no "que paso en la OT
    -- 4471". Sin esta columna todo reporte arranca con un JOIN contra SEL_OrdenProduccion.
    Maquina INT NULL,
    -- El turno al que pertenece la observacion. ES LO QUE HACE UTIL A FechaHora: en un turno
    -- 22:00-06:00 lo escrito a las 2 a.m. pertenece al turno de la noche ANTERIOR, y ordenar por
    -- FechaHora parte esa noche en dos. SEL_BitacoraTurno.FechaTurno ya resuelve eso -- ver el
    -- comentario de 20260913_agregar_bitacora_turno.sql. NULL si la maquina no tenia bitacora
    -- abierta (pasa: hay selladoras sin horarios cargados en TURHorariosMaquinas).
    IdBitacora INT NULL,
    -- 500 y no 255 como las demas Observaciones del esquema: aquellas son el complemento de un dato
    -- ya estructurado (el motivo de un tiempo muerto "otro", el motivo de un ajuste). Esta ES el
    -- dato, y es lo unico que va a quedar de lo que el operario vio.
    Observacion VARCHAR(500) NOT NULL,
    -- 'Manual'       -> el operario apreto el boton de Observacion por su cuenta.
    -- 'CierreSesion' -> la escribio porque el sistema se la pidio al cerrar sesion con una orden
    --                   Activa a su nombre.
    -- No es una categoria del CONTENIDO (eso se descarto arriba), es de donde salio: una observacion
    -- que nadie pidio pesa distinto a una que se escribio para poder salir de la pantalla.
    Origen VARCHAR(20) NOT NULL DEFAULT 'Manual',
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );

  -- "Que se observo en esta orden", que es la consulta de la pantalla de la OT.
  CREATE INDEX IX_SEL_ObservacionOperario_Orden
    ON SEL_ObservacionOperario (IdOrden, FechaHora);

  -- "Que observo este operario en tal rango", para el seguimiento por persona.
  CREATE INDEX IX_SEL_ObservacionOperario_Operario
    ON SEL_ObservacionOperario (Operario, FechaHora);

  -- "Que paso en esta maquina en este turno" -- el reporte que motivo la tabla.
  CREATE INDEX IX_SEL_ObservacionOperario_Maquina
    ON SEL_ObservacionOperario (Maquina, FechaHora);
END;
GO

PRINT 'SEL_ObservacionOperario lista.';
GO
