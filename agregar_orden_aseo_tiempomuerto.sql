-- CK_SEL_TiempoMuerto_Tipo (ver agregar_tipos_tiempomuerto.sql) quedo con 'ORDEN_ASEO' agregado por
-- fuera de esta app, pero sin 'OTRO' -- la definicion encontrada era:
--   ([Tipo]='ORDEN_ASEO' OR [Tipo]='LIMPIEZA' OR [Tipo]='DESCANSO' OR [Tipo]='MANTENIMIENTO' OR [Tipo]='ALISTAMIENTO')
-- El boton de Pausa (server.js, MOTIVOS_PAUSA) sigue ofreciendo "Otro" como motivo -- sin este ALTER
-- vuelve a fallar igual que paso antes con Limpieza/Otro ("The INSERT statement conflicted with the
-- CHECK constraint..."). Ejecutar una sola vez contra la base (CarlixplastPrueba).
ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT CK_SEL_TiempoMuerto_Tipo;

ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Tipo
  CHECK ([Tipo]='ALISTAMIENTO' OR [Tipo]='MANTENIMIENTO' OR [Tipo]='DESCANSO' OR [Tipo]='ORDEN_ASEO' OR [Tipo]='LIMPIEZA' OR [Tipo]='OTRO');
