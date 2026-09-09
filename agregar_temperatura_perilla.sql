-- % de la perilla de temperatura de la selladora, digitado por el operario desde la tableta.
--
-- Por que una tabla y no una columna: el PLC NO manda ese valor. SEL_PesajeElemento.Temperatura
-- existe desde siempre pero llega en NULL en el 100% de los paquetes (632 de 632 al 09/09/2026),
-- mientras Potencia y Golpes si llegan en todos -- o sea, la columna esta lista y el flujo de
-- Node-RED nunca la llena. Hasta que la mande el PLC, el dato lo pone el operario.
--
-- Se guarda un HISTORICO con hora, no una sola columna que se sobreescribe, porque el operario
-- cambia la perilla a mitad de la orden: el reporte de produccion le asigna a cada paquete el
-- ULTIMO valor registrado ANTES de la hora de ese paquete, que es el que de verdad estaba puesto
-- cuando se sello. Con una sola columna, todos los paquetes de la orden quedarian con el ultimo
-- valor del turno.
--
-- Ejecutar una sola vez contra la base de Mirane. El reporte funciona sin esta tabla (muestra la
-- columna vacia), asi que se puede correr despues de desplegar el codigo sin romper nada.

CREATE TABLE SEL_TemperaturaPerilla (
  Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  id_ejecucion INT NOT NULL,
  Operario INT NULL,
  Porcentaje DECIMAL(5,2) NOT NULL,
  FechaHora DATETIME NOT NULL DEFAULT GETDATE()
);

CREATE INDEX IX_SEL_TemperaturaPerilla_Ejecucion
  ON SEL_TemperaturaPerilla (id_ejecucion, FechaHora);
