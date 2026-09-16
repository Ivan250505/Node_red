-- Corrección: trg_SEL_Bultos_CierreBulto nunca escribía PRDProduccion.Unidades al cerrar un bulto
-- (13/09/2026, a raíz de "Modificar cantidad de bolsas").
--
-- QUÉ ENCONTRÉ (con el texto real de la trigger, pegado por el usuario): el bloque que sí
-- actualiza PRDProduccion al cerrar (Cantidad/Duracion/HoraFinal/FechaModificado) NUNCA tocaba
-- Unidades -- esa columna solo se llenaba con 0 al RESERVAR la fila (cuando se creaba el bulto
-- Temporal) y se quedaba así. No es que estuviera mal calculada (paquetes x 100): simplemente
-- nunca se calculaba en este trigger.
--
-- QUÉ CAMBIA: se agrega Unidades al mismo UPDATE que ya pone Cantidad, sumando
-- SEL_PesajeElemento.UnidadesPaquete de todos los paquetes del bulto -- mismo patrón EXACTO
-- (mismo CROSS APPLY) que ya usa esa consulta para sumar PesoPaqueGr -> CantidadTotal. Por
-- defecto UnidadesPaquete es 100 (ver agregar_unidadespaquete_pesajeelemento.sql -- CORRA ESE
-- SCRIPT PRIMERO, si no la columna no existe y este trigger fallaría), así que el comportamiento
-- para todo bulto que nadie corrigió a mano es exactamente paquetes x 100 -- ningún cambio de
-- fondo para el caso normal, solo empieza a escribirse un valor real en vez de quedar en 0.
--
-- NO SE TOCA nada más de la trigger -- ni la reserva del bulto Temporal siguiente (Unidades=0 ahí
-- sigue siendo el placeholder correcto, se llena recién cuando ESE bulto cierre), ni
-- PRDExtrusionRollos, ni el cursor de abajo.
--
-- Pruebe primero contra carlixplastPrueba: cierre un bulto de prueba (o use el Simulador de PLC
-- del panel admin) y confirme que PRDProduccion.Unidades queda en 100 x (número de paquetes),
-- salvo que haya usado "Modificar cantidad de bolsas" en alguno.

CREATE OR ALTER TRIGGER trg_SEL_Bultos_CierreBulto
ON SEL_Bultos
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT UPDATE(estado) RETURN;

    UPDATE b
    SET b.CantidadTotal = p.Total
    FROM SEL_Bultos b
    JOIN inserted i ON i.id = b.id
    JOIN deleted d ON d.id = b.id
    -- SUM(PesoPaqueGr) sobre un bulto sin paquetes pesados (0 filas) da NULL, no 0 -- eso rompia
    -- PRDExtrusionRollos.PesoBrutoKg (NOT NULL), de ahi el ISNULL.
    CROSS APPLY (
        SELECT ISNULL(SUM(PesoPaqueGr), 0) AS Total
        FROM SEL_PesajeElemento
        WHERE id_bulto = b.id
    ) p
    WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';

    -- Actualiza la fila PRDProduccion del bulto que se acaba de cerrar (reservada en Cantidad=0
    -- desde su creación) con la cantidad real recién calculada arriba.
    -- FIX 13/09/2026: se agrega Unidades -- antes NUNCA se escribía al cerrar (se quedaba en el 0
    -- de la reserva). Mismo criterio que Cantidad/CantidadTotal: se suma
    -- SEL_PesajeElemento.UnidadesPaquete (DEFAULT 100 por paquete, corregible por el operario con
    -- "Modificar cantidad de bolsas" en la página de Bultos).
    BEGIN TRY
        UPDATE p
        SET p.Cantidad = b.CantidadTotal,
            p.Unidades = u.Total,
            p.Duracion = DATEDIFF(MINUTE, b.HoraInicio, b.HoraFin),
            p.HoraFinal = b.HoraFin,
            p.FechaModificado = GETDATE()
        FROM PRDProduccion p
        JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        CROSS APPLY (
            SELECT ISNULL(SUM(ISNULL(UnidadesPaquete, 100)), 0) AS Total
            FROM SEL_PesajeElemento
            WHERE id_bulto = b.id
        ) u
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';
    END TRY
    BEGIN CATCH
        -- no bloquear el cierre del bulto por esto -- revisar manualmente si PRDProduccion.Cantidad
        -- se queda en 0 para algún bulto que ya está Cerrado en SEL_Bultos
    END CATCH

    -- Completa el peso real en PRDExtrusionRollos del bulto que se acaba de cerrar (reservada en
    -- PesoBrutoKg=0 desde su creación) -- Buscar()/Editar en Produccion.vb dependen de esta fila.
    BEGIN TRY
        UPDATE er
        SET er.PesoBrutoKg = b.CantidadTotal
        FROM PRDExtrusionRollos er
        JOIN SEL_Bultos b ON b.refsalida = er.Elemento AND b.num_bulto = er.Linea
            AND er.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
            AND er.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';
    END TRY
    BEGIN CATCH
        -- no bloquear el cierre del bulto por esto -- revisar manualmente si PesoBrutoKg se queda
        -- en 0 para algún bulto ya Cerrado
    END CATCH

    -- @NuevosBultos captura, vía OUTPUT, exactamente lo que el INSERT de abajo realmente escribió
    -- en SEL_Bultos (num_bulto, serialPadre ya armado) -- el cursor de reserva de PRDProduccion
    -- reutiliza estos valores en vez de recalcularlos (bug histórico corregido).
    DECLARE @NuevosBultos TABLE (
        agno int, mes int, dia int, refsalida int, id_maquina int, id_ejecucion int,
        HoraInicioNuevo datetime, NumeroPedido varchar(20), num_bulto int, serialPadre varchar(40)
    );

    INSERT INTO SEL_Bultos
        (agno, mes, dia, number_paqu, num_bulto, refsalida, estado, serialArmado, serialPadre,
         id_maquina, id_ejecucion, HoraInicio, NumeroPedido)
    OUTPUT inserted.agno, inserted.mes, inserted.dia, inserted.refsalida, inserted.id_maquina,
           inserted.id_ejecucion, inserted.HoraInicio, inserted.NumeroPedido, inserted.num_bulto,
           inserted.serialPadre
    INTO @NuevosBultos
    SELECT
        i.agno, i.mes, i.dia,
        0,
        sig.NuevoNumBulto,
        i.refsalida,
        'Temporal',
        CAST(i.agno AS varchar(4))
            + RIGHT('000000' + CAST(i.mes*100 + i.dia AS varchar(6)), 6)
            + RIGHT('0000'   + CAST(sig.NuevoNumBulto AS varchar(4)), 4)
            + RIGHT('00000'  + CAST(i.refsalida AS varchar(5)), 5)      AS serialArmado_calc,
        CAST(i.agno AS varchar(4))
            + RIGHT('000000' + CAST(i.mes*100 + i.dia AS varchar(6)), 6)
            + RIGHT('0000'   + CAST(sig.NuevoNumBulto AS varchar(4)), 4)
            + RIGHT('00000'  + CAST(i.refsalida AS varchar(5)), 5)      AS serialPadre_calc,
        i.id_maquina, i.id_ejecucion,
        i.HoraFin,
        i.NumeroPedido
    FROM inserted i
    JOIN deleted d ON d.id = i.id
    CROSS APPLY (
        SELECT ISNULL(MAX(x.Linea), 0) + 1 AS NuevoNumBulto
        FROM (
            SELECT Linea FROM PRDProduccion
            WHERE Year(Fecha) = i.agno
              AND Lote = RIGHT('0' + CAST(i.mes AS varchar(2)), 2) + RIGHT('0' + CAST(i.dia AS varchar(2)), 2)
              AND Elemento = i.refsalida
              AND Linea < 1000
            UNION ALL
            SELECT num_bulto FROM SEL_Bultos
            WHERE agno = i.agno AND mes = i.mes AND dia = i.dia AND refsalida = i.refsalida
        ) x
    ) sig
    WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';

    -- Reserva la fila PRDProduccion (Cantidad=0) de cada bulto recién insertado arriba,
    -- reutilizando su num_bulto/serialPadre -- cursor porque Turno se resuelve fila por fila.
    BEGIN TRY
        DECLARE @agno int, @mes int, @dia int, @refsalida int, @id_maquina int, @id_ejecucion int,
                @HoraFin datetime, @NumeroPedido varchar(20), @NuevoNumBulto int, @BolsasxGolpe int,
                @SerialNuevo varchar(40), @Lote varchar(6), @Turno int, @CodCliente int, @CodDestino int,
                @IdExtrusionControl int, @NumeroSecuencial int, @OrdenProduccion varchar(20), @Operario int;

        DECLARE curNuevoBulto CURSOR LOCAL FAST_FORWARD FOR
            SELECT nb.agno, nb.mes, nb.dia, nb.refsalida, nb.id_maquina, nb.id_ejecucion,
                   nb.HoraInicioNuevo, nb.NumeroPedido, nb.num_bulto, nb.serialPadre,
                   ISNULL(ej.BolsasxGolpe, 0), ISNULL(oam.Operario, ej.Operario)
            FROM @NuevosBultos nb
            JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = nb.id_ejecucion
            LEFT JOIN SEL_OperarioActualMaquina oam ON oam.Maquina = nb.id_maquina;

        OPEN curNuevoBulto;
        FETCH NEXT FROM curNuevoBulto INTO @agno, @mes, @dia, @refsalida, @id_maquina, @id_ejecucion,
            @HoraFin, @NumeroPedido, @NuevoNumBulto, @SerialNuevo, @BolsasxGolpe, @Operario;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @Lote = RIGHT('0' + CAST(@mes AS varchar(2)), 2) + RIGHT('0' + CAST(@dia AS varchar(2)), 2);

            SET @Turno = NULL;
            SELECT TOP 1 @Turno = CodigoTurno
            FROM TURHorariosMaquinas
            WHERE CodigoMaquina = @id_maquina AND Activo = 1
              AND (
                    (CAST(HoraInicio AS time) <= CAST(HoraFin AS time)
                     AND CAST(@HoraFin AS time) >= CAST(HoraInicio AS time)
                     AND CAST(@HoraFin AS time) <  CAST(HoraFin AS time))
                 OR (CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                     AND (CAST(@HoraFin AS time) >= CAST(HoraInicio AS time)
                          OR CAST(@HoraFin AS time) < CAST(HoraFin AS time)))
                  );

            SET @CodCliente = NULL;
            SET @CodDestino = NULL;
            SELECT TOP 1 @CodCliente = op.Cliente, @CodDestino = op.Destino
            FROM SEL_EjecucionOrden ej4
            INNER JOIN SEL_OrdenProduccion op ON op.IdOrden = ej4.IdOrden
            WHERE ej4.IdEjecucion = @id_ejecucion;

            SET @OrdenProduccion = NULL;
            SELECT TOP 1 @OrdenProduccion = p3.OrdenProduccion
            FROM PRDProduccion p3
            INNER JOIN SEL_Bultos b4 ON b4.serialPadre = p3.Detalle
            WHERE b4.id_ejecucion = @id_ejecucion AND p3.OrdenProduccion IS NOT NULL;

            IF @Turno IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM PRDProduccion WHERE Detalle = @SerialNuevo
            )
            BEGIN
                INSERT INTO PRDProduccion
                    (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
                     ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor,
                     FechaModificado, HoraInicio, HoraFinal, Torta, BolsasxGolpe, TipoPedido, NumeroPedido, OrdenProduccion)
                VALUES
                    (DATEFROMPARTS(@agno, @mes, @dia), @id_maquina, @Turno, 0, @Lote, @refsalida, @NuevoNumBulto,
                     0, 0, 0, @SerialNuevo, @CodCliente, @CodDestino, 0, 0, 0, 0, 0, GETDATE(), @HoraFin, NULL, 0,
                     @BolsasxGolpe, 4,
                     CASE WHEN ISNULL(@NumeroPedido, '') <> '' THEN @NumeroPedido ELSE NULL END,
                     @OrdenProduccion);

                IF @Operario IS NOT NULL AND @Operario > 0 AND NOT EXISTS (
                    SELECT 1 FROM PRDProduccionOperarios
                    WHERE Fecha = DATEFROMPARTS(@agno, @mes, @dia) AND Lote = @Lote
                      AND Elemento = @refsalida AND Linea = @NuevoNumBulto
                )
                BEGIN
                    INSERT INTO PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario)
                    VALUES (DATEFROMPARTS(@agno, @mes, @dia), @Lote, @refsalida, @NuevoNumBulto, @Operario);
                END

                SET @IdExtrusionControl = NULL;
                SELECT TOP 1 @IdExtrusionControl = er.IdExtrusionControl
                FROM PRDExtrusionRollos er
                INNER JOIN PRDProduccion p2
                    ON p2.Elemento = er.Elemento AND p2.Fecha = er.Fecha AND p2.Lote = er.Lote AND p2.Linea = er.Linea
                INNER JOIN SEL_Bultos b3 ON b3.serialPadre = p2.Detalle
                WHERE b3.id_ejecucion = @id_ejecucion;

                IF @IdExtrusionControl IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM PRDExtrusionRollos
                    WHERE IdExtrusionControl = @IdExtrusionControl AND Elemento = @refsalida
                      AND Fecha = DATEFROMPARTS(@agno, @mes, @dia) AND Linea = @NuevoNumBulto AND Lote = @Lote
                )
                BEGIN
                    SELECT @NumeroSecuencial = ISNULL(MAX(NumeroSecuencial), 0) + 1
                    FROM PRDExtrusionRollos WHERE IdExtrusionControl = @IdExtrusionControl;

                    INSERT INTO PRDExtrusionRollos
                        (IdExtrusionControl, Elemento, Fecha, Linea, Lote, NumeroSecuencial, PesoBrutoKg, PesoConoKg, ResiduosKg, BolsasxGolpe, UsuarioCreacion, FechaHoraCreacion)
                    VALUES
                        (@IdExtrusionControl, @refsalida, DATEFROMPARTS(@agno, @mes, @dia), @NuevoNumBulto, @Lote, @NumeroSecuencial, 0, 0, 0, @BolsasxGolpe, 0, GETDATE());
                END
            END

            FETCH NEXT FROM curNuevoBulto INTO @agno, @mes, @dia, @refsalida, @id_maquina, @id_ejecucion,
                @HoraFin, @NumeroPedido, @NuevoNumBulto, @SerialNuevo, @BolsasxGolpe, @Operario;
        END

        CLOSE curNuevoBulto;
        DEALLOCATE curNuevoBulto;
    END TRY
    BEGIN CATCH
        IF CURSOR_STATUS('local', 'curNuevoBulto') >= -1
        BEGIN
            IF CURSOR_STATUS('local', 'curNuevoBulto') > -1 CLOSE curNuevoBulto;
            DEALLOCATE curNuevoBulto;
        END
        -- no bloquear la apertura del bulto siguiente por esto -- revisar manualmente si un bulto
        -- Temporal se queda sin fila en PRDProduccion
    END CATCH
END
GO
