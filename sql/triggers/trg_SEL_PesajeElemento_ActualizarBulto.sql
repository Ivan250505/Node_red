-- VERSION CANONICA -- copiada de la definición REAL en la base (carlixplast, producción), 28/09/2026.
-- Para comparar más adelante:
--   SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_PesajeElemento_ActualizarBulto'));
--
-- Qué hace: cada paquete que registra el PLC (node_red/01_pesaje_paquete.sql, INSERT en
-- SEL_PesajeElemento) pasa el bulto de 'Temporal' a 'Activo'. Nada más.
-- NO suma number_paqu (la versión de la documentación de agosto sí lo hacía): ese conteo lo hace el
-- propio 01_pesaje_paquete.sql con "UPDATE SEL_Bultos SET number_paqu = @NuevoConsecutivo" antes del
-- INSERT -- por eso no hay doble conteo. No cierra ni abre bultos (eso es trg_SEL_Bultos_CierreBulto).

CREATE TRIGGER trg_SEL_PesajeElemento_ActualizarBulto
ON carlixplast.dbo.SEL_PesajeElemento
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE b
    SET b.estado = CASE WHEN b.estado = 'Temporal' THEN 'Activo' ELSE b.estado END
    FROM carlixplast.dbo.SEL_Bultos b
    JOIN inserted i ON i.id_bulto = b.id;
END
