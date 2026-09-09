-- "Volver a pesar" un paquete ya registrado (pedido del usuario, 09/09/2026).
--
-- En la pagina de Bultos, al tocar un paquete ya no se reimprime de una: sale un menu con
-- "Reimprimir etiqueta" y "Volver a pesar". El segundo abre una ventana con el peso EN VIVO de la
-- bascula (el mismo /ws/peso de la pagina de Informacion); el operario vuelve a poner el paquete,
-- guarda, y la etiqueta se reimprime sola con el peso corregido.
--
-- Que se toca al guardar el peso nuevo (ver POST /api/selladora/paquete/repesar en server.js):
--   1. SEL_PesajeElemento.PesoPaqueGr  -> el peso del paquete queda corregido.
--   2. SEL_Bultos.CantidadTotal        -> SOLO si ese bulto ya la tenia calculada (o sea, ya estaba
--      cerrado). Se recalcula con la misma formula que usa trg_SEL_Bultos_CierreBulto
--      (SUM(PesoPaqueGr) de sus paquetes), para que el total que muestra la pagina no contradiga a
--      los paquetes que estan listados justo debajo. En un bulto todavia abierto no hay nada que
--      recalcular: CantidadTotal la escribe el trigger recien cuando el bulto cierra, y para ese
--      momento ya suma el valor corregido.
--   3. SEL_RepesajePaquete             -> esta tabla: el rastro de la correccion.
--
-- LO QUE **NO** SE TOCA TODAVIA: PRDProduccion.Cantidad/Unidades, PRDExtrusionRollos.PesoBrutoKg e
-- INVExistencias.Cantidad. Esas tres las llena trg_SEL_Bultos_CierreBulto /
-- trg_SEL_Bultos_GenerarEntradaInventario en el momento exacto en que el bulto pasa a 'Cerrado', y
-- corregirlas despues es una decision de negocio que el usuario todavia no ha definido (09/09/2026:
-- "te debo la aclaracion para actualizar el valor del peso en PRDProduccion"). Mientras tanto, al
-- repesar un paquete de un bulto YA CERRADO la ventana avisa al operario de que esos totales de
-- produccion no se ajustan solos.
--
-- Justamente por eso existe esta tabla: cuando se defina la regla, aca esta la lista exacta de que
-- paquete se corrigio, cuando, de cuanto a cuanto y con el bulto en que estado -- que es lo unico
-- que permite reconstruir/ajustar PRDProduccion hacia atras sin adivinar.
--
-- Ejecutar una sola vez contra la base de Mirane.

CREATE TABLE SEL_RepesajePaquete (
  Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  id_paquete INT NOT NULL,
  id_bulto INT NULL,
  -- Estado del bulto EN EL MOMENTO de repesar: en 'Cerrado' es donde quedan pendientes los totales
  -- de produccion (ver arriba); en 'Activo'/'Temporal' no queda nada pendiente.
  EstadoBulto VARCHAR(20) NULL,
  PesoAnterior DECIMAL(18,3) NOT NULL,
  PesoNuevo DECIMAL(18,3) NOT NULL,
  Operario INT NULL,
  FechaHora DATETIME NOT NULL DEFAULT GETDATE()
);

CREATE INDEX IX_SEL_RepesajePaquete_Paquete
  ON SEL_RepesajePaquete (id_paquete, FechaHora);
