-- Autorizacion de un lider para poder cerrar un pedido (pedido del usuario, 22/09/2026).
--
-- QUE ES: la firma de una persona con mando que respalda lo producido en un pedido. El operario
-- trabaja normal y sin login; lo que queda bloqueado sin esta firma es FINALIZAR la orden y CERRAR
-- SESION con un pedido activo.
--
-- QUIEN PUEDE FIRMAR: unos pocos cargos de SISCargos, por IdCargo y NO por el texto del cargo:
--     16  Director de Calidad e Inocuidad   (base Carlixplast)
--     27  Jefe de Planta                    (base Carlixplast)
--     31  Lider de Sellado                  (base Carlixplast)
--      6  Lider de Sellado                  (base carlixplastPrueba -- alla SISCargos solo llega
--                                            hasta 6; agregado 24/09/2026)
-- Se filtra por IdCargo porque el texto de SISUsuarios.Cargo no es de fiar para comparar: conviven
-- 'Lider de Sellado' con tilde y 'Lider de Impresion' sin ella, y basta una tilde para que un
-- LIKE deje a un lider por fuera. La lista vive en auth.js (CARGOS_AUTORIZAN_PEDIDO).
--
-- EL ALCANCE ES EL PEDIDO, NO LA ORDEN: en sellado paralelo un mismo NumeroPedido tiene hasta 3
-- ordenes (una por referencia de salida) que se sellan juntas y se finalizan juntas. Pedir tres
-- firmas para el mismo trabajo fisico seria ruido. Por eso la clave es NumeroPedido -- decision
-- del usuario, 22/09/2026: "el registro de autorizacion debe ser uno por pedido".
--
-- NO LLEVA INDICE UNICO a proposito: si un lider vuelve a firmar (porque se reviso otra vez, o
-- porque firmo el jefe de planta despues), esa segunda firma se guarda como historia en vez de
-- reventar con una violacion de clave. La comprobacion es EXISTS, no "hay exactamente una".
--
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE.

IF OBJECT_ID('SEL_AutorizacionPedido', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_AutorizacionPedido (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    -- SEL_OrdenProduccion.NumeroPedido es VARCHAR(50), no un entero: se copia igual para que el
    -- JOIN no tenga que convertir tipos (un CONVERT aqui tumbaria el uso del indice).
    NumeroPedido VARCHAR(50) NOT NULL,
    -- Desde que orden se firmo. Es rastro, no alcance: la firma vale para todo el pedido.
    IdOrden INT NULL,
    -- SEL_OrdenProduccion.Maquina es SMALLINT; se respeta el tipo.
    Maquina SMALLINT NULL,
    -- Turno en el que se firmo, con el mismo criterio que SEL_ObservacionOperario.
    IdBitacora INT NULL,
    -- QUIEN FIRMA. Se guarda SISUsuarios.Codigo y no CodigoOperarioPRD a proposito: de los seis
    -- usuarios que hoy tienen los tres cargos, TRES no tienen CodigoOperarioPRD (el Jefe de Planta,
    -- el Director de Calidad y un Lider de Sellado). Guardar el codigo de operario dejaria esas
    -- firmas en NULL -- o sea, sin saber quien autorizo, que es justo el dato que da valor a esto.
    UsuarioAutoriza VARCHAR(20) NOT NULL,
    -- Copia del nombre al momento de firmar. Denormalizado a proposito: si manana esa persona
    -- cambia de nombre o se inactiva, la firma tiene que seguir diciendo quien fue.
    NombreAutoriza VARCHAR(60) NULL,
    -- Con que cargo firmo. Tambien congelado: un lider que manana sea otra cosa no puede cambiar
    -- retroactivamente con que autoridad firmo este pedido.
    IdCargoAutoriza INT NOT NULL,
    CargoAutoriza VARCHAR(100) NULL,
    -- PRDOperarios.Codigo del operario que estaba en la tableta cuando se pidio la firma.
    OperarioEnTurno INT NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );

  -- La consulta que se hace en cada Finalizar y en cada cierre de sesion.
  CREATE INDEX IX_SEL_AutorizacionPedido_Pedido
    ON SEL_AutorizacionPedido (NumeroPedido, FechaHora);

  -- "Que firmo esta persona", para auditoria.
  CREATE INDEX IX_SEL_AutorizacionPedido_Usuario
    ON SEL_AutorizacionPedido (UsuarioAutoriza, FechaHora);
END;
GO

PRINT 'SEL_AutorizacionPedido lista.';
GO
