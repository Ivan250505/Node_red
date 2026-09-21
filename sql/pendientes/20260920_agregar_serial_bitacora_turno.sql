-- Agrega la columna del serial nuevo de "Orden de Trabajo" (bitacora por turno) -- a pedido del
-- usuario, reunion 18/09/2026 + confirmacion 20/09/2026. Formato: OT + Fecha(yyyyMMdd) + SE +
-- Maquina(2 digitos) + Letra de turno (D/V/M/T/N). Ejemplo: OT20260917SE05D.
--
-- Se guarda como columna NORMAL (no computada) porque se llena una sola vez al ABRIR la bitacora
-- (abrirOReanudarBitacora, sel-inventario-mp.js) y no debe cambiar aunque cambie el operario dentro
-- del mismo turno (ver FIX 20/09/2026 en esa funcion -- el operario ya no cierra la bitacora).
--
-- Puede quedar NULL: una maquina sin horario configurado en TURHorariosMaquinas no tiene Turno
-- resuelto, y sin turno no hay letra que ponerle al serial -- no se inventa.
--
-- Ejecutar contra la base de Mirane (Prueba y produccion). Es IDEMPOTENTE.

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.SEL_BitacoraTurno') AND name = 'Serial')
BEGIN
    ALTER TABLE dbo.SEL_BitacoraTurno ADD Serial VARCHAR(20) NULL;
END;
GO
