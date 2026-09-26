-- =====================================================================================================
-- DIAGNOSTICO_TURNOS.md punto 3 (26/09/2026): huecos de 5 y 15 minutos en los turnos de 12 horas.
-- En TURHorariosMaquinas, Pleno Día (10) está 06:00-17:55 y Pleno Noche (9) 18:00-05:45. En una
-- jornada D o V, lo que cierra entre 17:55-18:00 y 05:45-06:00 no tiene turno activo, el trigger
-- trg_SEL_Bultos_CierreBulto deja @Turno = NULL y el bulto NO se inserta en PRDProduccion.
-- Se dejan en 06:00-18:00 y 18:00-06:00 (no se cruzan entre sí: siguen pudiendo estar activos juntos).
--
-- Solo toca TURHorariosMaquinas (lo que leen Node y el trigger). NOMTurnos NO se toca: es el
-- catálogo de nómina; si también se quiere igualar, ver el bloque comentado al final.
-- Idempotente. DBeaver: seleccionar todo + Ctrl+Enter (un solo lote, sin GO).
-- =====================================================================================================

-- 1) Antes
SELECT th.CodigoMaquina, th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, th.Activo
FROM TURHorariosMaquinas th
INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
WHERE th.CodigoTurno IN (9, 10)
ORDER BY th.CodigoMaquina, th.CodigoTurno;

-- 2) Corrección
UPDATE TURHorariosMaquinas SET HoraFin = '18:00'
WHERE CodigoTurno = 10 AND CAST(HoraInicio AS time) = '06:00' AND CAST(HoraFin AS time) = '17:55';

UPDATE TURHorariosMaquinas SET HoraFin = '06:00'
WHERE CodigoTurno = 9 AND CAST(HoraInicio AS time) = '18:00' AND CAST(HoraFin AS time) = '05:45';

-- 3) Después (debe salir 06:00-18:00 y 18:00-06:00)
SELECT th.CodigoMaquina, th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, th.Activo
FROM TURHorariosMaquinas th
INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
WHERE th.CodigoTurno IN (9, 10)
ORDER BY th.CodigoMaquina, th.CodigoTurno;

-- Opcional (solo si nómina está de acuerdo):
-- UPDATE NOMTurnos SET HoraFinal = '18:00' WHERE Codigo = 10;
-- UPDATE NOMTurnos SET HoraFinal = '06:00' WHERE Codigo = 9;
