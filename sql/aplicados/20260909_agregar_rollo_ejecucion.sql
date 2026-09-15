-- Bitacora de rollos de entrada: que tiquete se monto en la maquina, a que hora y sobre que bulto.
--
-- Por que hace falta: hoy NINGUNA tabla ata un tiquete de rollo a un momento.
--   - PRDProduccionMateriaPrima tiene el serial (Detalle) pero su unica fecha es la del ancla del
--     proceso, sin hora, y ademas todos los rollos quedan bajo la misma linea ancla.
--   - PRDExtrusionRollos si tiene FechaHoraCreacion, pero no guarda el serial.
--   - SEL_EjecucionOrden.SerialRolloEntrada se SOBREESCRIBE en cada "Añadir Rollo": de la orden 13,
--     que consumio 4 rollos, ahi solo quedo el ultimo.
-- Sin este registro es imposible decir de que rollo salio cada paquete, que es lo que necesita el
-- reporte de produccion (bitacora) para poner el rollo al lado de los paquetes que produjo.
--
-- Se llena desde scan-rollo.js:confirmarRollo, tanto al Iniciar como al Añadir Rollo. No reemplaza
-- a PRDProduccionMateriaPrima (esa sigue siendo la fuente para inventario y para Mirane): esto es
-- solo la linea de tiempo del proceso.
--
-- Las ordenes anteriores a este cambio no tienen estas filas: para ellas el reporte enumera los
-- rollos igual (los saca de PRDProduccionMateriaPrima) pero deja la columna "Rollo" de cada paquete
-- en blanco, porque ese dato no existe hacia atras y no se puede inventar.
--
-- Ejecutar una sola vez contra la base de Mirane.

CREATE TABLE SEL_RolloEjecucion (
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

CREATE INDEX IX_SEL_RolloEjecucion_Ejecucion
  ON SEL_RolloEjecucion (id_ejecucion, FechaHora);
