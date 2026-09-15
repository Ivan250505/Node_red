-- Protocolo de arranque de una orden de produccion (pedido del usuario, 09/09/2026).
--
-- Al dar "Iniciar" una orden ya no se abre directo el escaneo del rollo: se entra a una secuencia
-- fija de pasos que la tableta va guiando (ver scriptProtocoloArranque en server.js):
--   1) Limpieza y desinfeccion  -> se registra como actividad (SEL_TiempoMuerto, Tipo='limpieza')
--                                  y arranca a contar el tiempo.
--   2) Al terminar: "¿Detecta algun peligro quimico (aceites y lubricantes)?"
--                                  Si -> "comuniquese con el jefe de planta", no se puede seguir.
--   3) Escaneo del rollo.
--   4) "¿El rollo esta en buen estado?" + "¿Identifica algun peligro fisico?"
--                                  Rollo malo o peligro fisico -> hay que escanear otro rollo.
--   5) Alistamiento             -> SEL_TiempoMuerto, Tipo='alistamiento', Subtipo='arranque'.
--   6) Al terminar el alistamiento se pide la temperatura de la perilla (SEL_TemperaturaPerilla).
--
-- Este script hace las DOS cosas que el protocolo necesita en la base. Es IDEMPOTENTE: se puede
-- correr varias veces y sobre bases distintas (carlixplast / carlixplastPrueba) sin romper nada.

-- 1. Bitacora de las respuestas del protocolo -----------------------------------------------
--
-- Por que una tabla propia y no SEL_ChequeoCalidad: ese chequeo es el que sale cada 20-30 min
-- durante la produccion, sus preguntas salen de construirApartadosCalidad() (dependen del
-- elemento) y siempre van atadas a un bulto. El protocolo de arranque es anterior a que exista
-- ningun bulto -- y sus respuestas deciden si se puede producir o no, no si un bulto salio
-- conforme.
--
-- Ademas de dejar el rastro para el reporte, esta tabla es la que permite RETOMAR el protocolo si
-- la tableta se recarga/apaga a mitad: el servidor deduce en que paso iba mirando que respuestas
-- ya estan guardadas (ver obtenerProtocoloPendiente en server.js).

IF OBJECT_ID('SEL_ProtocoloArranque', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_ProtocoloArranque (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    id_ejecucion INT NOT NULL,
    IdOrden INT NOT NULL,
    Operario INT NULL,
    -- 'limpieza' | 'peligro_quimico' | 'rollo_estado' | 'peligro_fisico' | 'alistamiento' | 'temperatura'
    Paso VARCHAR(30) NOT NULL,
    -- 'Si' / 'No' en las preguntas; el porcentaje en 'temperatura'; 'Iniciada' en las actividades.
    Respuesta VARCHAR(20) NULL,
    -- Serial del rollo evaluado, solo en 'rollo_estado' / 'peligro_fisico'.
    Serial VARCHAR(30) NULL,
    Observaciones VARCHAR(255) NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );

  CREATE INDEX IX_SEL_ProtocoloArranque_Ejecucion
    ON SEL_ProtocoloArranque (id_ejecucion, FechaHora);
END
GO

-- 2. Subtipo 'ARRANQUE' para el alistamiento del paso 5 --------------------------------------
--
-- CK_SEL_TiempoMuerto_Subtipo obliga a que TODO alistamiento traiga uno de sus submotivos. El
-- alistamiento del protocolo no es ninguno de los que ya existian (no se le pregunta al operario,
-- arranca solo despues de aceptar el rollo), asi que se agrega 'ARRANQUE'. Sin este ALTER, el paso
-- 5 falla con "The INSERT statement conflicted with the CHECK constraint
-- 'CK_SEL_TiempoMuerto_Subtipo'" y el protocolo se queda trancado ahi.
--
-- OJO (09/09/2026): las dos bases NO tenian la misma lista. La definicion encontrada era
--   carlixplast       -> MATERIALES / MECANICO / ESPACIO_TRABAJO
--   carlixplastPrueba -> MATERIALES / MECANICO / ESPACIO_TRABAJO / LIMPIEZA_DESINFECCION
-- La lista de abajo es la UNION de las dos mas 'ARRANQUE', a proposito: asi este script deja las
-- dos bases iguales y no le quita a carlixplastPrueba un submotivo que ya tenia declarado (ninguna
-- fila lo usa hoy, pero quitarlo seria una regresion silenciosa para lo que sea que lo declaro).

IF EXISTS (SELECT 1 FROM sys.check_constraints
           WHERE name = 'CK_SEL_TiempoMuerto_Subtipo'
             AND parent_object_id = OBJECT_ID('SEL_TiempoMuerto'))
  ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT CK_SEL_TiempoMuerto_Subtipo;
GO

ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Subtipo
  CHECK (
    ([Tipo] = 'ALISTAMIENTO' AND ([Subtipo] = 'MATERIALES' OR [Subtipo] = 'MECANICO'
                                  OR [Subtipo] = 'ESPACIO_TRABAJO' OR [Subtipo] = 'LIMPIEZA_DESINFECCION'
                                  OR [Subtipo] = 'ARRANQUE'))
    OR ([Tipo] <> 'ALISTAMIENTO' AND [Subtipo] IS NULL)
  );
GO
