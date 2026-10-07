-- Nuevo tiempo muerto "Pausas activas" (a pedido del usuario, 05/10/2026). El boton de Pausa
-- (server.js, MOTIVOS_PAUSA / MOTIVOS_PAUSA_INICIAL / MOTIVOS_PAUSA_VALIDOS) ahora ofrece
-- 'pausa_activa'; sin este ALTER el INSERT en SEL_TiempoMuerto falla con "The INSERT statement
-- conflicted with the CHECK constraint 'CK_SEL_TiempoMuerto_Tipo'", igual que paso con
-- Limpieza/Otro (ver aplicados/20260831_agregar_tipos_tiempomuerto.sql).
-- 'PAUSA_ACTIVA' tiene 12 caracteres, lo mismo que 'ALISTAMIENTO', asi que cabe en la columna.
-- Ejecutar una sola vez en cada base (CarlixplastPrueba y produccion), ANTES de subir el codigo.
ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT CK_SEL_TiempoMuerto_Tipo;

ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Tipo
  CHECK (Tipo IN ('ALISTAMIENTO','MANTENIMIENTO','DESCANSO','ORDEN_ASEO','LIMPIEZA','PAUSA_ACTIVA','OTRO'));
