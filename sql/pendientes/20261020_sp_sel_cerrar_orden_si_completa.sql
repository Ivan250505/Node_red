-- sp_SEL_CerrarOrdenSiCompleta (20/10/2026, a pedido del usuario).
-- Cierra una orden de Selladora (o su grupo de Sellado completo) cuando el operario ya dio Finalizar y
-- TODOS los bultos Cerrado ya están validados e impresos (los retales no cuentan). Es la misma regla
-- que Mirane SEL_InventarioMP.IntentarCerrarGrupoSelladoSiCompleto -> RecalcularMermaSellado +
-- CerrarProcesoSellado + SincronizarEstadoOT, para que la tableta (Node) la use al terminar
-- "Finalizar": si el digitador validó el último bulto ANTES de que el operario finalizara, el cierre
-- automático de Validación Selladora nunca se volvía a intentar y la orden quedaba en
-- 'PendienteValidacion' (pedido 110926, OT-20261014S005M01).
--   1. Miembros: la orden sola, o todas las del grupo SELLADORA (líneas del pedido + PedidosExtra, por
--      pedido + línea, misma máquina y misma OT -- 1 entrada -> N salidas de pedidos distintos incluido).
--   2. Si algún miembro está Activa/Suspendida/... -> no cierra. Pendiente/SinTableta se saltan.
--   3. Si algún bulto Cerrado de los que se cierran está sin validar/imprimir -> no cierra.
--   4. Merma combinada (MP - salida de rollos) en el ÚLTIMO bulto de la ancla (menor IdOrden); los
--      demás miembros quedan con Retal = 0. Primero/último bulto por b.id (no num_bulto: en una orden
--      de varios días num_bulto vuelve a 1 cada día).
--   5. Control del proceso -> 'Cerrado'; OT -> 'Finalizada' si no le queda control abierto;
--      SEL_OrdenProduccion -> 'Finalizada' (deja de salir en la tableta); rastro FINALIZAR en SISMovimientos.
-- Devuelve una fila: Cerrada (1/0) y Motivo. Nunca lanza error por "todavía no se puede cerrar".
-- Un solo lote, sin GO. Correr primero en carlixplastPrueba.

CREATE OR ALTER PROCEDURE dbo.sp_SEL_CerrarOrdenSiCompleta
    @IdOrden INT,
    @Origen VARCHAR(30) = 'Tableta'
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Linea INT, @NumPed VARCHAR(20), @Maquina INT, @IdGrupo INT = NULL, @OTBase VARCHAR(20);
    SELECT @Linea = Linea, @NumPed = NumeroPedido, @Maquina = Maquina FROM dbo.SEL_OrdenProduccion WHERE IdOrden = @IdOrden;
    IF @NumPed IS NULL
    BEGIN
        SELECT CAST(0 AS bit) AS Cerrada, 'No existe la orden ' + CAST(@IdOrden AS varchar(10)) AS Motivo;
        RETURN;
    END

    -- 1. Miembros (misma regla que Node idsGrupoSelladoDeOrden y Mirane ObtenerMiembrosGrupoSelladoDeOrden):
    --    pedido + LÍNEA, misma máquina, y misma OT (las de otras corridas del pedido, con otra OT, no entran;
    --    las que aún no tienen bultos con OT cuentan si no están Finalizadas).
    SELECT TOP 1 @IdGrupo = g.IdGrupo
    FROM dbo.PRDGrupoEtapasCompartidasLineas gl
    INNER JOIN dbo.PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo AND g.CategoriaMaquina = 'SELLADORA' AND g.Numero = @NumPed
    WHERE gl.Linea = @Linea;
    IF @IdGrupo IS NULL
        SELECT TOP 1 @IdGrupo = pe.IdGrupo
        FROM dbo.PRDGrupoEtapasPedidosExtra pe
        INNER JOIN dbo.PRDGrupoEtapasCompartidas g ON g.IdGrupo = pe.IdGrupo AND g.CategoriaMaquina = 'SELLADORA'
        WHERE pe.Linea = @Linea AND pe.Numero = @NumPed;

    -- OT de cada orden: la de su bulto Cerrado más reciente que ya la tenga en PRDProduccion
    SELECT TOP 1 @OTBase = p.OrdenProduccion FROM dbo.SEL_Bultos b
    INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    INNER JOIN dbo.PRDProduccion p ON p.Detalle = b.serialPadre
    WHERE ej.IdOrden = @IdOrden AND p.OrdenProduccion IS NOT NULL ORDER BY b.id DESC;

    DECLARE @Miembros TABLE (IdOrden INT PRIMARY KEY, Estado VARCHAR(30));
    IF @IdGrupo IS NULL
        INSERT @Miembros (IdOrden) VALUES (@IdOrden);
    ELSE
        INSERT @Miembros (IdOrden)
        SELECT c.IdOrden
        FROM (SELECT ord.IdOrden, ord.Estado, ord.Maquina FROM dbo.PRDGrupoEtapasCompartidas g
              INNER JOIN dbo.PRDGrupoEtapasCompartidasLineas gl ON gl.IdGrupo = g.IdGrupo
              INNER JOIN dbo.SEL_OrdenProduccion ord ON ord.Linea = gl.Linea AND ord.NumeroPedido = g.Numero
              WHERE g.IdGrupo = @IdGrupo
              UNION
              SELECT ord.IdOrden, ord.Estado, ord.Maquina FROM dbo.PRDGrupoEtapasPedidosExtra pe
              INNER JOIN dbo.SEL_OrdenProduccion ord ON ord.Linea = pe.Linea AND ord.NumeroPedido = pe.Numero
              WHERE pe.IdGrupo = @IdGrupo) c
        OUTER APPLY (SELECT TOP 1 p.OrdenProduccion AS OT FROM dbo.SEL_Bultos b
                     INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
                     INNER JOIN dbo.PRDProduccion p ON p.Detalle = b.serialPadre
                     WHERE ej.IdOrden = c.IdOrden AND p.OrdenProduccion IS NOT NULL ORDER BY b.id DESC) o
        WHERE (@Maquina IS NULL OR c.Maquina = @Maquina)
          AND (@OTBase IS NULL OR o.OT = @OTBase OR (o.OT IS NULL AND c.Estado <> 'Finalizada'));
    IF NOT EXISTS (SELECT 1 FROM @Miembros WHERE IdOrden = @IdOrden)
        INSERT @Miembros (IdOrden) VALUES (@IdOrden);
    UPDATE m SET m.Estado = op.Estado FROM @Miembros m INNER JOIN dbo.SEL_OrdenProduccion op ON op.IdOrden = m.IdOrden;

    -- 2. Estados
    IF EXISTS (SELECT 1 FROM @Miembros WHERE ISNULL(Estado, '') NOT IN ('PendienteValidacion', 'Finalizada', 'Pendiente', 'SinTableta'))
    BEGIN
        SELECT CAST(0 AS bit) AS Cerrada, 'Otra referencia del grupo de Sellado todavía no ha terminado' AS Motivo;
        RETURN;
    END
    DECLARE @ACerrar TABLE (IdOrden INT PRIMARY KEY);
    INSERT @ACerrar SELECT IdOrden FROM @Miembros WHERE Estado IN ('PendienteValidacion', 'Finalizada');
    IF NOT EXISTS (SELECT 1 FROM @ACerrar)
    BEGIN
        SELECT CAST(0 AS bit) AS Cerrada, 'Ninguna orden ha pasado por Finalizar' AS Motivo;
        RETURN;
    END

    -- 3. Bultos sin validar / sin imprimir
    IF EXISTS (
        SELECT 1 FROM dbo.SEL_Bultos b
        INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        INNER JOIN @ACerrar a ON a.IdOrden = ej.IdOrden
        LEFT JOIN dbo.PRDProduccion p ON p.Detalle = b.serialPadre
        WHERE b.estado = 'Cerrado' AND (p.Validado IS NULL OR p.Validado = 0 OR p.Impreso IS NULL OR p.Impreso = 0))
    BEGIN
        SELECT CAST(0 AS bit) AS Cerrada, 'Faltan bultos por validar o imprimir' AS Motivo;
        RETURN;
    END

    -- Ancla (primer bulto Cerrado por id) y control de cada miembro
    DECLARE @Datos TABLE (IdOrden INT PRIMARY KEY, AnclaElem INT, AnclaFecha DATE, AnclaLote VARCHAR(4), AnclaLinea INT,
                          IdCtrl INT NULL, EstadoCtrl VARCHAR(30) NULL, MP DECIMAL(18,4) NULL, Salida DECIMAL(18,4) NULL,
                          UltSerial VARCHAR(40) NULL);
    INSERT @Datos (IdOrden, AnclaElem, AnclaFecha, AnclaLote, AnclaLinea, UltSerial)
    SELECT m.IdOrden, f.refsalida, DATEFROMPARTS(f.agno, f.mes, f.dia),
           RIGHT('0' + CAST(f.mes AS varchar(2)), 2) + RIGHT('0' + CAST(f.dia AS varchar(2)), 2), f.num_bulto, u.serialPadre
    FROM @Miembros m
    CROSS APPLY (SELECT TOP 1 b.refsalida, b.agno, b.mes, b.dia, b.num_bulto FROM dbo.SEL_Bultos b
                 INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
                 WHERE ej.IdOrden = m.IdOrden AND b.estado = 'Cerrado' ORDER BY b.id ASC) f
    CROSS APPLY (SELECT TOP 1 b.serialPadre FROM dbo.SEL_Bultos b
                 INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
                 WHERE ej.IdOrden = m.IdOrden AND b.estado = 'Cerrado' ORDER BY b.id DESC) u;

    UPDATE d SET IdCtrl = c.IdExtrusionControl, EstadoCtrl = c.Estado
    FROM @Datos d
    CROSS APPLY (SELECT TOP 1 ec.IdExtrusionControl, ec.Estado FROM dbo.PRDExtrusionControl ec
                 WHERE ec.ElementoOriginal = d.AnclaElem AND ec.FechaOriginal = d.AnclaFecha
                   AND ec.LoteOriginal = d.AnclaLote AND ec.LineaOriginal = d.AnclaLinea
                   AND ec.TipoProceso IN ('Sellado', 'SELLADORA')) c;

    -- 4. Merma (misma fórmula que ObtenerDatosMermaOrden)
    UPDATE d SET
        MP = (SELECT ISNULL(SUM(mp.Cantidad), 0) FROM dbo.PRDProduccionMateriaPrima mp
              WHERE mp.Elemento = d.AnclaElem AND YEAR(mp.Fecha) = YEAR(d.AnclaFecha) AND mp.Lote = d.AnclaLote AND mp.Linea = d.AnclaLinea),
        Salida = (SELECT ISNULL(SUM((p.Cantidad - ISNULL(p.PesoCono, 0)) + ISNULL(p.Torta, 0) + ISNULL(p.NuevoRetal, 0)
                         + ISNULL(p.ResiduoTroquelado, 0) + ISNULL(p.ResiduoRefilado, 0) + ISNULL(p.ResiduoNoConforme, 0)), 0)
                  FROM dbo.PRDExtrusionRollos er
                  INNER JOIN dbo.PRDProduccion p ON p.Elemento = er.Elemento AND p.Fecha = er.Fecha AND p.Lote = er.Lote AND p.Linea = er.Linea
                  WHERE er.IdExtrusionControl = d.IdCtrl)
    FROM @Datos d
    WHERE d.IdCtrl IS NOT NULL;

    DECLARE @Ancla INT = (SELECT MIN(IdOrden) FROM @Miembros);
    DECLARE @HayMerma bit = CASE WHEN EXISTS (SELECT 1 FROM @Datos WHERE IdCtrl IS NOT NULL) THEN 1 ELSE 0 END;
    DECLARE @Merma DECIMAL(18,4) = (SELECT ISNULL(SUM(MP), 0) - ISNULL(SUM(Salida), 0) FROM @Datos WHERE IdCtrl IS NOT NULL);
    IF @Merma < 0 SET @Merma = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        IF @HayMerma = 1
        BEGIN
            UPDATE p SET p.Retal = @Merma
            FROM dbo.PRDProduccion p INNER JOIN @Datos d ON d.UltSerial = p.Detalle
            WHERE d.IdOrden = @Ancla;
            UPDATE p SET p.Retal = 0
            FROM dbo.PRDProduccion p INNER JOIN @Datos d ON d.UltSerial = p.Detalle
            WHERE d.IdOrden <> @Ancla;
        END

        -- 5. Cerrar el control de cada orden que se cierra
        UPDATE ec SET ec.Estado = 'Cerrado', ec.FechaUltimaModificacion = GETDATE()
        FROM dbo.PRDExtrusionControl ec
        INNER JOIN @Datos d ON d.IdCtrl = ec.IdExtrusionControl
        INNER JOIN @ACerrar a ON a.IdOrden = d.IdOrden;

        -- OT de cada orden cerrada (por su ancla; si no, la de la etiqueta ancla -- SincronizarEstadoOT)
        DECLARE @OTs TABLE (IdOrden INT, OT VARCHAR(20), EstadoCtrlAntes VARCHAR(30));
        INSERT @OTs (IdOrden, OT, EstadoCtrlAntes)
        SELECT d.IdOrden,
               ISNULL((SELECT TOP 1 o.OrdenProduccion FROM dbo.PRDOrdenesProduccion o
                       WHERE o.Fecha = d.AnclaFecha AND o.Lote = d.AnclaLote AND o.Elemento = d.AnclaElem AND o.LineaAncla = d.AnclaLinea),
                      (SELECT TOP 1 p.OrdenProduccion FROM dbo.PRDProduccion p
                       WHERE p.Elemento = d.AnclaElem AND p.Fecha = d.AnclaFecha AND p.Lote = d.AnclaLote AND p.Linea = d.AnclaLinea
                         AND p.OrdenProduccion IS NOT NULL)),
               d.EstadoCtrl
        FROM @Datos d INNER JOIN @ACerrar a ON a.IdOrden = d.IdOrden
        WHERE d.IdCtrl IS NOT NULL;

        UPDATE o SET o.Estado = 'Finalizada',
               o.HoraFinReal = ISNULL(o.HoraFinReal, ISNULL((SELECT MAX(p.HoraFinal) FROM dbo.PRDProduccion p
                                                             WHERE p.OrdenProduccion = o.OrdenProduccion AND p.Linea < 1000), GETDATE()))
        FROM dbo.PRDOrdenesProduccion o
        WHERE o.OrdenProduccion IN (SELECT OT FROM @OTs WHERE OT IS NOT NULL)
          AND o.Estado <> 'Finalizada'
          AND NOT EXISTS (SELECT 1 FROM dbo.PRDExtrusionControl ec
                          INNER JOIN dbo.PRDProduccion p ON p.Elemento = ec.ElementoOriginal AND p.Fecha = ec.FechaOriginal
                            AND p.Lote = ec.LoteOriginal AND p.Linea = ec.LineaOriginal
                          WHERE p.OrdenProduccion = o.OrdenProduccion AND ISNULL(ec.Estado, '') <> 'Cerrado');

        UPDATE op SET op.Estado = 'Finalizada'
        FROM dbo.SEL_OrdenProduccion op INNER JOIN @ACerrar a ON a.IdOrden = op.IdOrden
        WHERE op.Estado <> 'Finalizada';

        -- Rastro FINALIZAR por orden (como RegistrarMovimientoOT de CerrarProcesoSellado)
        IF OBJECT_ID('dbo.SISMovimientos', 'U') IS NOT NULL
        BEGIN
            DECLARE @Mov TABLE (IdMovimiento INT, EstadoCtrlAntes VARCHAR(30));
            MERGE dbo.SISMovimientos AS t
            USING (SELECT x.OT, x.IdOrden, x.EstadoCtrlAntes, o.IdOrdenProduccion
                   FROM @OTs x INNER JOIN dbo.PRDOrdenesProduccion o ON o.OrdenProduccion = x.OT) AS s
            ON 1 = 0
            WHEN NOT MATCHED THEN
                INSERT (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
                VALUES ('ORDEN_TRABAJO', 'FINALIZAR', s.IdOrdenProduccion, s.OT, GETDATE(), NULL, @Origen,
                        'Cierre automático: todos los bultos ya estaban validados',
                        'Proceso de Sellado cerrado (orden ' + CAST(s.IdOrden AS varchar(10)) + ')' +
                        CASE WHEN s.IdOrden = @Ancla AND @HayMerma = 1 THEN '. Merma ' + CAST(@Merma AS varchar(20)) + ' kg' ELSE '' END)
            OUTPUT INSERTED.IdMovimiento, s.EstadoCtrlAntes INTO @Mov;
            INSERT INTO dbo.SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
            SELECT IdMovimiento, 'PRDExtrusionControl', 'Estado', EstadoCtrlAntes, 'Cerrado' FROM @Mov;
        END

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH

    SELECT CAST(1 AS bit) AS Cerrada,
           'Cerrada(s) ' + CAST((SELECT COUNT(*) FROM @ACerrar) AS varchar(10)) + ' orden(es)' +
           CASE WHEN @HayMerma = 1 THEN '; merma ' + CAST(@Merma AS varchar(20)) + ' kg' ELSE '; sin datos de merma' END AS Motivo;
END
