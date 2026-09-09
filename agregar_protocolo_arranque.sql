-- Protocolo de arranque de una orden de produccion (pedido del usuario, 09/09/2026).
--
-- Al dar "Iniciar" una orden ya no se abre directo el escaneo del rollo: se entra a una secuencia
-- fija de 5 pasos que la tableta va guiando (ver scriptProtocoloArranque en server.js):
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
-- Este script hace las DOS cosas que el protocolo necesita en la base. Ejecutar una sola vez.

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

-- 2. Subtipo 'ARRANQUE' para el alistamiento del paso 5 --------------------------------------
--
-- CK_SEL_TiempoMuerto_Subtipo obliga a que TODO alistamiento traiga uno de sus 3 submotivos:
--   ([Tipo]='ALISTAMIENTO' AND ([Subtipo]='MATERIALES' OR [Subtipo]='MECANICO' OR
--    [Subtipo]='ESPACIO_TRABAJO') OR [Tipo]<>'ALISTAMIENTO' AND [Subtipo] IS NULL)
-- El alistamiento del protocolo no es ninguno de esos tres (no se le pregunta al operario, arranca
-- solo despues de aceptar el rollo), asi que se agrega 'ARRANQUE' como cuarto submotivo valido.
-- Sin este ALTER, el paso 5 falla con "The INSERT statement conflicted with the CHECK constraint
-- 'CK_SEL_TiempoMuerto_Subtipo'" y el protocolo se queda trancado ahi.

ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT CK_SEL_TiempoMuerto_Subtipo;

ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Subtipo
  CHECK (
    ([Tipo] = 'ALISTAMIENTO' AND ([Subtipo] = 'MATERIALES' OR [Subtipo] = 'MECANICO'
                                  OR [Subtipo] = 'ESPACIO_TRABAJO' OR [Subtipo] = 'ARRANQUE'))
    OR ([Tipo] <> 'ALISTAMIENTO' AND [Subtipo] IS NULL)
  );
