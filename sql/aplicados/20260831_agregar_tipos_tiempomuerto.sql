-- CK_SEL_TiempoMuerto_Tipo solo permitia 'ALISTAMIENTO'/'MANTENIMIENTO'/'DESCANSO', pero el boton
-- de Pausa de la app (server.js, MOTIVOS_PAUSA) siempre ofrecio tambien "Limpieza y desinfeccion" y
-- "Otro" -- faltaban en la restriccion desde que se creo la tabla. Se nota apenas alguien elige uno
-- de esos dos motivos: "The INSERT statement conflicted with the CHECK constraint
-- 'CK_SEL_TiempoMuerto_Tipo'". Ejecutar una sola vez contra la base (CarlixplastPrueba).
ALTER TABLE SEL_TiempoMuerto DROP CONSTRAINT CK_SEL_TiempoMuerto_Tipo;

ALTER TABLE SEL_TiempoMuerto ADD CONSTRAINT CK_SEL_TiempoMuerto_Tipo
  CHECK ([Tipo]='ALISTAMIENTO' OR [Tipo]='MANTENIMIENTO' OR [Tipo]='DESCANSO' OR [Tipo]='LIMPIEZA' OR [Tipo]='OTRO');
