-- 14/10/2026 (a pedido del usuario): cerrar el bulto 371 del pedido 030826 (orden 48, ejecucion 45,
-- maquina 7) SIN retomar el pedido.
--
-- Historia: el 371 se lleno con 23 paquetes (ultimo pesaje 06:47), el Finalizar lo cerro, y a las
-- 09:33 un script deshizo el Finalizar ("Falta sacar material") y lo dejo 'Suspendido' con el
-- inventario en 0. Fisicamente ese bulto YA se cerro con 23 paquetes -- aqui se cierra igual en el
-- sistema.
--
-- El UPDATE a 'Cerrado' dispara los mismos triggers que el boton "Cierre bulto" de Node-RED:
--   * trg_SEL_Bultos_CierreBulto: llena PRDProduccion (fila reservada en Cantidad 0), peso, cliente,
--     bitacora... y ABRE el bulto siguiente 'Temporal' de la ejecucion 45.
--   * trg_SEL_Bultos_GenerarEntradaInventario: entrada a inventario (INVExistencias, Unidades 23 ya).
-- Dos efectos NO deseados porque la maquina 7 esta trabajando OTRO pedido (10090):
--   1) El bulto 'Temporal' nuevo quedaria abierto en la maquina 7: el pesaje de Node-RED le meteria
--      paquetes del 10090 y el boton de cierre lo cerraria junto con el del 10090. Ademas nace con
--      HoraInicio = HoraFin del 371 (hoy) y la orden puede retomarse otro dia. Se BORRA con todo lo que
--      el trigger le reservo (PRDProduccion, PRDProduccionOperarios, PRDExtrusionRollos,
--      INVExistencias en 0). Al reanudar el pedido, retomarOrdenSuspendida no encuentra bulto
--      suspendido y crearBultoReanudacion reserva uno 'Temporal' nuevo, con la fecha de ese momento.
--   2) El trigger agrega a PRDProduccionOperarios del 371 al operario que hoy controla la maquina 7
--      (182, el del 10090). Se quita si no estaba antes.
--
-- HoraFin: se fija a mano (si no, quedaria la hora en que se corre esto). 07:11 = la del primer
-- cierre (la que tenia PRDProduccion.HoraFinal). Alternativa: '2026-10-14 06:47:37' (ultimo paquete).
--
-- Corre en una transaccion que termina en ROLLBACK: revisar los SELECT del final y, si todo cuadra,
-- cambiar ROLLBACK por COMMIT y correr de nuevo.

SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @IdBulto INT = 371, @IdEjecucion INT = 45, @IdOrden INT = 48;
DECLARE @HoraFin DATETIME = '2026-10-14 07:11:00';

IF NOT EXISTS (SELECT 1 FROM SEL_Bultos WHERE id = @IdBulto AND estado = 'Suspendido' AND id_ejecucion = @IdEjecucion)
    THROW 50001, 'El bulto 371 ya no esta Suspendido en la ejecucion 45 -- revisar antes de seguir.', 1;
IF NOT EXISTS (SELECT 1 FROM SEL_Bultos WHERE id = @IdBulto AND HoraInicio < @HoraFin)
    THROW 50002, 'La HoraFin no es posterior a la HoraInicio del bulto.', 1;
IF EXISTS (SELECT 1 FROM SEL_Bultos WHERE id_ejecucion = @IdEjecucion AND estado IN ('Activo', 'Temporal', 'EnEspera'))
    THROW 50003, 'La ejecucion 45 ya tiene un bulto abierto -- el pedido se retomo? revisar antes de seguir.', 1;

DECLARE @Serial VARCHAR(40) = (SELECT serialPadre FROM SEL_Bultos WHERE id = @IdBulto);
DECLARE @MaxIdAntes INT = (SELECT MAX(id) FROM SEL_Bultos);

-- Operarios que ya tenia el 371 (para quitar solo el que agregue el trigger).
DECLARE @OperariosAntes TABLE (Operario INT);
INSERT INTO @OperariosAntes (Operario)
SELECT po.Operario
FROM PRDProduccionOperarios po
JOIN PRDProduccion p ON p.Fecha = po.Fecha AND p.Lote = po.Lote AND p.Elemento = po.Elemento AND p.Linea = po.Linea
WHERE p.Detalle = @Serial;

-- Cierre: mismo UPDATE que el nodo de Node-RED (02_cierre_bulto.sql), con HoraFin fija y por id.
UPDATE b
SET b.estado   = 'Cerrado',
    b.HoraFin  = @HoraFin,
    b.Golpes   = agg.GolpesTotal,
    b.Potencia = agg.PotenciaPromedio
FROM SEL_Bultos b
CROSS APPLY (
    SELECT ISNULL(AVG(pe.Golpes), 0)              AS GolpesTotal,
           CAST(AVG(pe.Potencia) AS DECIMAL(10,3)) AS PotenciaPromedio
    FROM SEL_PesajeElemento pe
    WHERE pe.id_bulto = b.id
) agg
WHERE b.id = @IdBulto;

-- 1) Borrar el bulto 'Temporal' que abrio el trigger y lo que le reservo.
DECLARE @Nuevos TABLE (id INT, serialPadre VARCHAR(40), refsalida INT, Fecha DATE, Lote VARCHAR(6), Linea INT);
INSERT INTO @Nuevos (id, serialPadre, refsalida, Fecha, Lote, Linea)
SELECT id, serialPadre, refsalida, DATEFROMPARTS(agno, mes, dia),
       RIGHT('0' + CAST(mes AS VARCHAR(2)), 2) + RIGHT('0' + CAST(dia AS VARCHAR(2)), 2), num_bulto
FROM SEL_Bultos
WHERE id > @MaxIdAntes AND id_ejecucion = @IdEjecucion AND estado = 'Temporal';

IF (SELECT COUNT(*) FROM @Nuevos) > 1
    THROW 50004, 'El trigger abrio mas de un bulto -- revisar.', 1;
IF EXISTS (SELECT 1 FROM SEL_PesajeElemento pe JOIN @Nuevos n ON n.id = pe.id_bulto)
    THROW 50005, 'El bulto nuevo ya tiene paquetes -- revisar.', 1;

DELETE er FROM PRDExtrusionRollos er
JOIN @Nuevos n ON er.Elemento = n.refsalida AND er.Fecha = n.Fecha AND er.Lote = n.Lote AND er.Linea = n.Linea
WHERE er.PesoBrutoKg = 0;

DELETE po FROM PRDProduccionOperarios po
JOIN @Nuevos n ON po.Elemento = n.refsalida AND po.Fecha = n.Fecha AND po.Lote = n.Lote AND po.Linea = n.Linea;

DELETE p FROM PRDProduccion p
JOIN @Nuevos n ON p.Detalle = n.serialPadre
WHERE p.Cantidad = 0;

DELETE ie FROM INVExistencias ie
JOIN @Nuevos n ON ie.Detalle = n.serialPadre AND ie.Elemento = n.refsalida
WHERE ie.Cantidad = 0;

DELETE b FROM SEL_Bultos b JOIN @Nuevos n ON n.id = b.id;

-- 2) Quitar del 371 el operario que agrego el trigger (el que controla hoy la maquina 7).
DELETE po FROM PRDProduccionOperarios po
JOIN PRDProduccion p ON p.Fecha = po.Fecha AND p.Lote = po.Lote AND p.Elemento = po.Elemento AND p.Linea = po.Linea
WHERE p.Detalle = @Serial
  AND po.Operario NOT IN (SELECT Operario FROM @OperariosAntes);

IF OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
    INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
    VALUES ('SELLADORA', 'CERRAR_BULTO_SUSPENDIDO', @IdOrden, 'Pedido 030826', GETDATE(), NULL, 'Script',
            'Bulto cerrado fisicamente con 23 paquetes',
            'Bulto 371 Suspendido -> Cerrado (HoraFin ' + CONVERT(VARCHAR(16), @HoraFin, 120) +
            '); bulto siguiente que abrio el trigger borrado; la orden sigue suspendida');

-- Revision
SELECT id, estado, number_paqu, HoraInicio, HoraFin, CantidadTotal, Golpes, Potencia
FROM SEL_Bultos WHERE id_ejecucion = @IdEjecucion AND id >= @IdBulto ORDER BY id;
SELECT Detalle, Cantidad, Unidades, HoraInicio, HoraFinal, Duracion, Estado
FROM PRDProduccion WHERE Detalle = @Serial;
SELECT po.* FROM PRDProduccionOperarios po
JOIN PRDProduccion p ON p.Fecha = po.Fecha AND p.Lote = po.Lote AND p.Elemento = po.Elemento AND p.Linea = po.Linea
WHERE p.Detalle = @Serial;
SELECT * FROM INVExistencias WHERE Detalle = @Serial;
SELECT o.Estado AS EstadoOrden, e.Estado AS EstadoEjecucion
FROM SEL_OrdenProduccion o JOIN SEL_EjecucionOrden e ON e.IdOrden = o.IdOrden WHERE o.IdOrden = @IdOrden;

ROLLBACK;   -- cambiar por COMMIT cuando la revision cuadre
