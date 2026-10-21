/* ============================================================================
   21/10/2026 -- Pedido 10089: devolver la hora de inicio del bulto 445 (HIGADOS).

   El 21/10 a las 09:47 se traslado un paquete de HIGADOS a MIXTA
   (SISMovimientos 1034). sp_SEL_TrasladarPaquete obligaba a mover el PRIMERO
   del bulto (#1, id 9913) y despues le ponia al origen como HoraInicio la de su
   primer paquete restante (#2, 20/10 17:40:04). Su fila de PRDProduccion se
   arrastro a 17:40 igual.

   La hora original no quedo guardada. Se usa 20/10 17:22:29, confirmada con
   el usuario: es cuando arranco el sellado en paralelo (MIXTA 446 empieza
   17:22:29, MOLLEJAS 447 17:22:30) y el rollo de arranque del bulto 445 se
   registro a las 17:22:32 (SEL_RolloEjecucion 144). PRDProduccion queda a
   17:22:00, en minutos como las filas de 446 y 447.

   La causa queda corregida en 20261021_traslado_entre_referencias_ultimo_paquete.sql.

   Solo toca el bulto 445 y solo si sigue con la hora que dejo el traslado:
   correrlo dos veces no hace nada la segunda.
   ============================================================================ */

SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @Serial VARCHAR(40) = '2026001020000136913';
DECLARE @HoraBulto DATETIME = '2026-10-20T17:22:29';
DECLARE @HoraProd DATETIME = '2026-10-20T17:22:00';

UPDATE dbo.SEL_Bultos
SET HoraInicio = @HoraBulto
WHERE id = 445 AND serialPadre = @Serial AND HoraInicio = '2026-10-20T17:40:04.850';

IF @@ROWCOUNT = 1
BEGIN
    UPDATE dbo.PRDProduccion
    SET HoraInicio = @HoraProd, HoraFinal = @HoraProd, FechaModificado = GETDATE()
    WHERE Detalle = @Serial;

    INSERT INTO dbo.SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
    VALUES ('SELLADORA', 'CORRECCION_HORA_BULTO', 445, @Serial, GETDATE(), NULL, 'Script',
            'Hora de inicio movida por traslado entre referencias (SISMovimientos 1034)',
            'HoraInicio 2026-10-20 17:40:04.850 -> 2026-10-20 17:22:29 (PRDProduccion 17:40 -> 17:22).');
END

SELECT id, estado, HoraInicio, HoraFin FROM dbo.SEL_Bultos WHERE id = 445;
SELECT Detalle, HoraInicio, HoraFinal FROM dbo.PRDProduccion WHERE Detalle = @Serial;

COMMIT TRANSACTION;
