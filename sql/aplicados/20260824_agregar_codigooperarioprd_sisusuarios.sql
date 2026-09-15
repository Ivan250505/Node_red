-- Vincula el login web (SISUsuarios) con el catalogo de operarios de planta (PRDOperarios),
-- que hoy son catalogos sin relacion. Necesario para que Iniciar/Anadir Rollo en la pagina de
-- Selladora sepan que Operario (PRDOperarios.Codigo) grabar en SEL_EjecucionOrden/
-- PRDProduccionOperarios -- en el escritorio (frmScanRollo.vb) no hay selector, se hereda de la
-- ultima ejecucion o queda en 0; en la web se usa el usuario que inicio sesion.
-- Ejecutar una sola vez contra la base de Mirane.

ALTER TABLE SISUsuarios ADD CodigoOperarioPRD INT NULL;

-- Despues de correr esto, un administrador debe asignar el operario correspondiente a cada
-- usuario que vaya a operar Selladora desde el celular, por ejemplo:
--   UPDATE SISUsuarios SET CodigoOperarioPRD = 7 WHERE Codigo = 'J.CALIXTO';
-- (7 = PRDOperarios.Codigo del operario real -- ver PRDOperarios para la lista completa).
-- Si un usuario no tiene este valor configurado, la pagina bloquea Iniciar/Anadir Rollo con un
-- mensaje explicito en vez de asumir un operario por defecto.
