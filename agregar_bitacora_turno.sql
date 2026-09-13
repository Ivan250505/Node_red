-- Bitacora de turno del operario en una selladora (pedido del usuario, 12/09/2026).
--
-- QUE ES: "un registro unico" por (maquina, operario, turno) que reemplaza a la planilla por orden
-- que se elimino el 11/09/2026. Un operario en un turno puede pasar por VARIAS ordenes; la bitacora
-- las atraviesa a todas y lista los bultos que salieron mientras el estuvo al frente de la maquina.
--
-- QUE GUARDA ESTA TABLA Y QUE NO: solo la CABECERA -- quien, en que maquina, en que turno, desde
-- cuando y hasta cuando. Los renglones (bulto, hora de inicio y fin, serial del rollo, hora a la
-- que se registro cada paquete, unidades) NO se copian aca: ya viven en SEL_Bultos,
-- SEL_RolloEjecucion y SEL_PesajeElemento, y se leen con un JOIN cada vez que se abre la bitacora
-- (decision del usuario, 12/09/2026: "en vivo, con JOIN"). Asi no hay dos versiones del mismo dato
-- ni nada que se desincronice -- por ejemplo, un peso corregido despues con SEL_RepesajePaquete se
-- ve reflejado solo.
--
-- COMO SE SABE QUE BULTOS SON DE UNA BITACORA: no hace falta marcarlos. Un bulto pertenece a la
-- bitacora de SU maquina cuya ventana de tiempo contiene la hora en que ese bulto empezo. Esto es a
-- proposito: los bultos NO los crea esta aplicacion sino la maquina (Node-RED / el trigger
-- trg_SEL_Bultos_CierreBulto), asi que no hay donde escribirles un IdBitacora sin meterle mano al
-- camino de insercion del PLC. La consulta de los renglones esta en obtenerBitacora() en server.js.
--
-- CUANDO SE ABRE Y SE CIERRA (decision del usuario, 12/09/2026):
--   - Se ABRE cuando el operario toma control de la maquina (el mismo punto donde ya se escribe
--     SEL_OperarioActualMaquina).
--   - Si el MISMO operario vuelve a tomar control en el MISMO turno, NO se abre otra: se reusa la
--     que ya esta abierta. El usuario lo pidio explicitamente -- "puede pasar que se vaya el
--     internet o retome la orden", y eso no puede partir la bitacora en dos.
--   - NO se cierra al cerrar sesion, justamente por lo anterior.
--   - Se cierra por RELEVO (otro operario toma esa maquina) o por CAMBIO DE TURNO (el bulto nuevo
--     ya cae fuera de la franja del turno con que se abrio).
--
-- Ejecutar contra la base de Mirane. Es IDEMPOTENTE: se puede correr varias veces y sobre las dos
-- bases (Carlixplast / CarlixplastPrueba) sin romper nada.

IF OBJECT_ID('SEL_BitacoraTurno', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_BitacoraTurno (
    IdBitacora INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    -- PRDMaquinas.Codigo. La bitacora es de la MAQUINA, no de la orden: por eso sobrevive a que el
    -- operario termine una orden y arranque otra dentro del mismo turno.
    Maquina INT NOT NULL,
    -- PRDOperarios.Codigo (el CodigoOperarioPRD del usuario logueado).
    Operario INT NOT NULL,
    -- NOMTurnos.Codigo. NULLABLE a proposito: se deduce del horario de la maquina
    -- (TURHorariosMaquinas) y hay selladoras sin horarios cargados -- ver el comentario de abajo.
    -- Una bitacora sin turno resuelto sigue siendo valida: tiene operario, maquina y horas.
    Turno SMALLINT NULL,
    -- Fecha a la que se le imputa el turno. En un turno que cruza medianoche (22:00-06:00) es la
    -- fecha en que EMPEZO, no la del reloj: los bultos de las 2 a.m. pertenecen al turno de la
    -- noche anterior, que es como lo cuenta la planta.
    FechaTurno DATE NOT NULL,
    HoraApertura DATETIME NOT NULL DEFAULT GETDATE(),
    -- NULL = bitacora abierta. Solo puede haber UNA abierta por maquina (ver el indice de abajo).
    HoraCierre DATETIME NULL,
    -- 'relevo' (otro operario tomo la maquina) | 'cambio_turno' | 'manual'. NULL mientras este abierta.
    MotivoCierre VARCHAR(20) NULL
  );

  -- Una sola bitacora ABIERTA por maquina. Es la regla de negocio entera metida en un indice: si
  -- dos tabletas tomaran control a la vez, la segunda falla en vez de dejar dos bitacoras abiertas
  -- compitiendo por los mismos bultos. El filtro WHERE HoraCierre IS NULL es lo que permite que
  -- convivan muchas bitacoras YA CERRADAS de la misma maquina.
  CREATE UNIQUE INDEX UX_SEL_BitacoraTurno_AbiertaPorMaquina
    ON SEL_BitacoraTurno (Maquina) WHERE HoraCierre IS NULL;

  -- Para listar las bitacoras de un operario o de un turno sin recorrer la tabla entera.
  CREATE INDEX IX_SEL_BitacoraTurno_Operario ON SEL_BitacoraTurno (Operario, FechaTurno);
  CREATE INDEX IX_SEL_BitacoraTurno_Maquina ON SEL_BitacoraTurno (Maquina, HoraApertura);
END;
GO

-- NOTA SOBRE EL TURNO (importante, leer antes de tocar resolverTurnoMaquina en server.js)
--
-- El usuario decidio (12/09/2026) que el turno se DEDUCE del horario de la maquina en vez de
-- pedirselo al operario. Los datos hacen que eso no sea directo, y por eso el codigo aplica dos
-- reglas que NO salen de ninguna tabla:
--
--   1) LOS HORARIOS SE SOLAPAN. Cada selladora con horario tiene estas CINCO franjas a la vez
--      (identicas en las 12, leido en produccion el 12/09/2026):
--        Manana 06:00-14:00 · Pleno Dia 06:00-17:55 · Tarde 14:00-22:00
--        Pleno Noche 18:00-05:45 · Noche 22:00-06:00
--      A las 08:00 encajan Manana y Pleno Dia; a las 20:00, Tarde y Pleno Noche. Regla de desempate: GANA LA FRANJA MAS
--      CORTA. Los turnos "Pleno" son jornadas extendidas de 11-12 horas que se montan encima de los
--      tres turnos normales de 8; al elegir el mas corto se escoge siempre el turno ordinario, que
--      es el que la planta usa por defecto.
--
--   2) HAY SELLADORAS SIN HORARIO. En Carlixplast (produccion, leido el 12/09/2026) son CUATRO las
--      que no tienen ninguna fila en TURHorariosMaquinas: SELLADORA 03, 08, 09 y 12. Para esas se
--      usan los tres turnos base de 8 horas:
--        NOMTurnos 6 Manana 06:00-14:00 · 7 Tarde 14:00-22:00 · 8 Noche 22:00-06:00
--      Las otras 12 tienen las MISMAS cinco franjas cada una (Manana, Pleno Dia, Tarde, Pleno
--      Noche, Noche), asi que la regla del desempate se comporta igual en todas.
--      OJO: en CarlixplastPrueba son SEIS (ademas la 21 y la 22) y la SELLADORA 04 tiene 4 franjas
--      en vez de 5 -- esa base es una copia mas vieja. La referencia es produccion.
--
-- Si alguna de las dos reglas no es la que quiere la planta, lo correcto es arreglar los DATOS
-- (cargar TURHorariosMaquinas de esas cuatro maquinas, o quitar los turnos "Pleno" de las que no
-- los trabajan) antes que cambiar el codigo: la tabla es la que deberia mandar.
--
-- CONSECUENCIA QUE HAY QUE TENER PRESENTE: con la regla de la franja mas corta, los turnos "Pleno"
-- NUNCA se eligen solos -- siempre hay un turno ordinario de 8 horas que los tapa. Una jornada
-- extendida real quedara rotulada con el turno ordinario en que arranco.
