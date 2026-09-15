-- Amperaje consumido por el ferroniquel, digitado por el operario desde la tableta
-- (pedido del usuario, 15/09/2026).
--
-- QUE REEMPLAZA: el ultimo paso del protocolo de arranque pedia el "% de la perilla de
-- temperatura" y lo guardaba en SEL_TemperaturaPerilla.Porcentaje. Ese valor se cambia por el
-- amperaje que consume el ferroniquel.
--
-- POR QUE UNA TABLA NUEVA Y NO REUSAR LA QUE YA EXISTE: la tabla se llama literalmente
-- SEL_TemperaturaPerilla y su columna, Porcentaje. Meter amperios ahi dejaria dos magnitudes
-- distintas (un % de 0 a 100 y una corriente en amperios) bajo unos nombres que mienten, sin nada
-- que permita saber despues cual es cual -- y el que lea esa tabla dentro de un ano no tiene forma
-- de adivinarlo. Ademas SEL_TemperaturaPerilla la puede estar leyendo el escritorio de Mirane, que
-- no se toca desde este repositorio.
--
-- QUE PASA CON LA VIEJA: se deja EXACTAMENTE como esta. Tiene una sola fila en produccion (55 %,
-- comprobado el 15/09/2026), asi que no hay nada que migrar ni que convertir: un porcentaje de
-- perilla y unos amperios no son la misma magnitud y no se pueden transformar uno en otro. La
-- aplicacion deja de escribirle; su fila historica sigue ahi y sigue significando lo que significa.
--
-- Se guarda un HISTORICO con hora, con el mismo criterio que tenia la de temperatura: el consumo
-- cambia a lo largo de la orden, y una sola columna que se sobreescribe dejaria a todos los
-- paquetes con el ultimo valor del turno en vez del que de verdad estaba cuando se sello.
--
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE: se puede correr varias veces y sobre las dos
-- bases (Carlixplast / CarlixplastPrueba) sin romper nada.

IF OBJECT_ID('SEL_AmperajeFerroniquel', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_AmperajeFerroniquel (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    id_ejecucion INT NOT NULL,
    Operario INT NULL,
    -- Amperios. DECIMAL(6,2) admite hasta 9999.99 A: de sobra para cualquier ferroniquel, y con
    -- dos decimales por si el equipo de planta reporta fracciones.
    Amperaje DECIMAL(6,2) NOT NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );

  CREATE INDEX IX_SEL_AmperajeFerroniquel_Ejecucion
    ON SEL_AmperajeFerroniquel (id_ejecucion, FechaHora);
END;
GO

-- NOTA SOBRE EL RANGO VALIDO (leer antes de tocar la validacion en server.js)
--
-- El paso viejo validaba 0 a 100 porque era un porcentaje. Para el amperaje NO se definio un rango
-- de planta, asi que la validacion quedo PERMISIVA a proposito: mayor que 0 y hasta 999 A.
--
-- Es deliberado que sea holgada y no estrecha: este paso es OBLIGATORIO para poder empezar a
-- producir, asi que un rango demasiado apretado deja la maquina parada porque el operario no puede
-- registrar un valor legitimo. Una validacion holgada, en cambio, solo deja pasar un error de
-- digitacion -- mucho menos grave.
--
-- Cuando se sepa el rango real del ferroniquel, se ajusta en un solo sitio: AMPERAJE_MIN /
-- AMPERAJE_MAX en server.js.
