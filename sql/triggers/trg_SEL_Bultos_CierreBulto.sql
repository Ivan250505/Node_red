-- VERSION CANONICA -- CONVENCION (17/09/2026): este archivo SIEMPRE debe reflejar el ultimo estado
-- realmente desplegado del trigger. Cada vez que se aplique un cambio, se actualiza ESTE archivo (no
-- se crea un "agregar_X_trigger.sql" ni "fix_X_trigger.sql" suelto en "nueva produccion/") -- el
-- historial de git ya funciona como versionamiento. Antes de confiar en este archivo para escribir
-- un cambio nuevo, correr de nuevo:
--   SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_CierreBulto'));
-- y confirmar que coincide -- si no coincide, alguien aplico algo que no quedo aqui, hay que
-- investigar antes de seguir.
--
-- ACTUALIZADO 22/09/2026 -- incluye (sobre la version verificada el 20/09/2026, que ya traia el
-- copiar-hacia-adelante de TipoPedido/IdBitacora):
--   1) GeneradoPor ("digitador") ya no queda fijo en 0 para bultos 2+. FIX v1 (mismo dia): se copiaba
--      del PRIMER bulto de la ejecucion -- funcionaba pero quedaba CONGELADO en el usuario que abrio
--      la ejecucion, sin reflejar un relevo de tablet a mitad de camino. FIX v2 (mismo dia, a pedido
--      del usuario -- "que use el mismo mecanismo del operario actual por maquina"): ahora se resuelve
--      EN VIVO via SEL_OperarioActualMaquina -> SISUsuarios.CodigoOperarioPRD -> SISUsuarios.Tercero
--      (mismo valor que espera PRDProduccion.GeneradoPor); si no resuelve nada, cae al mecanismo v1
--      (copiar del primer bulto) como respaldo.
--   2) HoraFinal ya no se inserta en NULL para el bulto nuevo -- queda en @HoraFin (mismo valor que
--      HoraInicio) como PLACEHOLDER mientras el bulto sigue abierto, igual que Node ya hace para el
--      primer bulto (crearBultoInicial) -- el reporte de produccion no esta blindado contra
--      HoraFinal NULL y se caia con eso.
-- AUN NO CONFIRMADO como aplicado contra produccion -- correr y verificar con OBJECT_DEFINITION.
--
-- ACTUALIZADO 23/09/2026 (a pedido del usuario -- caso real: bulto 20 de la ejecucion 19, maquina 7,
-- HoraInicio 2026-09-23 10:01 pero serial 2026000922..., fechado el 22):
--   3) El bulto nuevo ya NO hereda agno/mes/dia del bulto que se cierra (eso dejaba TODA la
--      ejecucion con la fecha del primer bulto aunque pasaran dias). Ahora toma la fecha REAL del
--      momento en que abre (HoraFin del bulto cerrado, o GETDATE() si viniera NULL), y num_bulto se
--      calcula como MAX+1 de ESE dia/Lote -- mismo criterio que Produccion.vb:GuardarNuevoRollo
--      ("Anadir Registro" de etiquetas parciales, rediseno 17/09/2026: Linea se reinicia por Lote
--      fisico). Serial, PRDProduccion.Fecha/Lote/Linea, PRDExtrusionRollos y PRDProduccionOperarios
--      quedan todos con el dia real.
--   4) La conexion con el proceso se preserva igual que en GuardarNuevoRollo: PRDProduccion.
--      LoteOriginal/FechaOriginal = Lote/Fecha del ANCLA (el primer bulto de la orden, por id -- no
--      el de menor num_bulto, que ya se reinicia por dia). La materia prima, la OT y
--      PRDExtrusionControl siguen colgando del ancla, sin cambios.
--   Complemento obligatorio: trg_SEL_Bultos_GenerarEntradaInventario (misma fecha) busca la bodega
--   por el Lote del ancla -- sin ese cambio, un bulto de un dia nuevo no encontraria bodega.
--   Requiere PRDProduccion.LoteOriginal/FechaOriginal (agregar_lotefechaoriginal_prdproduccion.sql)
--   en la base donde se aplique -- si faltan, el INSERT de PRDProduccion falla DENTRO del TRY de
--   abajo y el bulto queda sin fila en PRDProduccion sin avisar.
--
-- ACTUALIZADO 24/09/2026 (a pedido del usuario) -- PENDIENTE de aplicar:
--   5) IdBitacora ya NO se copia del bulto anterior. Cada bulto va a la bitacora del TURNO en que
--      abre (maquina + Turno + FechaTurno), la que abre Node cuando el operario toma control. Si
--      todavia no existe, queda NULL y se completa al cerrar el bulto. Tambien se guarda en
--      SEL_Bultos.IdBitacora (antes solo el primer bulto la tenia ahi).

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
    -- desde su creacion) con la cantidad real recien calculada arriba.
    -- FIX 13/09/2026: se agrega Unidades -- antes NUNCA se escribia al cerrar (se quedaba en el 0
    -- de la reserva). Mismo criterio que Cantidad/CantidadTotal: se suma
    -- SEL_PesajeElemento.UnidadesPaquete (DEFAULT 100 por paquete, corregible por el operario con
    -- "Modificar cantidad de bolsas" en la pagina de Bultos).
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
        -- se queda en 0 para algun bulto que ya esta Cerrado en SEL_Bultos
    END CATCH

    -- Bitacora del bulto que se cierra (FIX 24/09/2026): si abrio antes de que el operario del turno
    -- tomara control, quedo sin bitacora (ver cursor de abajo). Al cerrar se busca otra vez la
    -- bitacora de SU turno (Turno + FechaTurno de su HoraInicio) -- para entonces ya deberia existir.
    -- Solo llena los que estan en NULL, nunca cambia una bitacora ya asignada.
    BEGIN TRY
        UPDATE p
        SET p.IdBitacora = bt.IdBitacora
        FROM PRDProduccion p
        JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        CROSS APPLY (
            SELECT TOP 1
                CASE WHEN CAST(th.HoraInicio AS time) > CAST(th.HoraFin AS time)
                          AND CAST(p.HoraInicio AS time) < CAST(th.HoraFin AS time)
                     THEN DATEADD(DAY, -1, CAST(p.HoraInicio AS date))
                     ELSE CAST(p.HoraInicio AS date) END AS FechaTurno
            FROM TURHorariosMaquinas th
            WHERE th.CodigoMaquina = p.Maquina AND th.CodigoTurno = p.Turno AND th.Activo = 1
        ) ft
        CROSS APPLY (
            SELECT TOP 1 bt0.IdBitacora
            FROM SEL_BitacoraTurno bt0
            WHERE bt0.Maquina = p.Maquina AND bt0.Turno = p.Turno AND bt0.FechaTurno = ft.FechaTurno
            ORDER BY bt0.IdBitacora DESC
        ) bt
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado' AND p.IdBitacora IS NULL;

        UPDATE b
        SET b.IdBitacora = p.IdBitacora
        FROM SEL_Bultos b
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        JOIN PRDProduccion p ON p.Detalle = b.serialPadre
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado'
          AND b.IdBitacora IS NULL AND p.IdBitacora IS NOT NULL;
    END TRY
    BEGIN CATCH
        -- no bloquear el cierre del bulto por esto -- el bulto queda sin bitacora
    END CATCH

    -- Completa el peso real en PRDExtrusionRollos del bulto que se acaba de cerrar (reservada en
    -- PesoBrutoKg=0 desde su creacion) -- Buscar()/Editar en Produccion.vb dependen de esta fila.
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
        -- en 0 para algun bulto ya Cerrado
    END CATCH

    -- @NuevosBultos captura, via OUTPUT, exactamente lo que el INSERT de abajo realmente escribio
    -- en SEL_Bultos (num_bulto, serialPadre ya armado) -- el cursor de reserva de PRDProduccion
    -- reutiliza estos valores en vez de recalcularlos (bug historico corregido).
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
        fn.agno, fn.mes, fn.dia,
        0,
        sig.NuevoNumBulto,
        i.refsalida,
        'Temporal',
        CAST(fn.agno AS varchar(4))
            + RIGHT('000000' + CAST(fn.mes*100 + fn.dia AS varchar(6)), 6)
            + RIGHT('0000'   + CAST(sig.NuevoNumBulto AS varchar(4)), 4)
            + RIGHT('00000'  + CAST(i.refsalida AS varchar(5)), 5)      AS serialArmado_calc,
        CAST(fn.agno AS varchar(4))
            + RIGHT('000000' + CAST(fn.mes*100 + fn.dia AS varchar(6)), 6)
            + RIGHT('0000'   + CAST(sig.NuevoNumBulto AS varchar(4)), 4)
            + RIGHT('00000'  + CAST(i.refsalida AS varchar(5)), 5)      AS serialPadre_calc,
        i.id_maquina, i.id_ejecucion,
        fn.HoraApertura,
        i.NumeroPedido
    FROM inserted i
    JOIN deleted d ON d.id = i.id
    -- FIX 23/09/2026: fecha REAL de apertura del bulto nuevo (= cierre del anterior), no la heredada
    -- del bulto que se cierra -- ver punto 3 del encabezado.
    CROSS APPLY (
        SELECT ISNULL(i.HoraFin, GETDATE()) AS HoraApertura
    ) h
    CROSS APPLY (
        SELECT h.HoraApertura,
               YEAR(h.HoraApertura)  AS agno,
               MONTH(h.HoraApertura) AS mes,
               DAY(h.HoraApertura)   AS dia
    ) fn
    CROSS APPLY (
        SELECT ISNULL(MAX(x.Linea), 0) + 1 AS NuevoNumBulto
        FROM (
            SELECT Linea FROM PRDProduccion
            WHERE Year(Fecha) = fn.agno
              AND Lote = RIGHT('0' + CAST(fn.mes AS varchar(2)), 2) + RIGHT('0' + CAST(fn.dia AS varchar(2)), 2)
              AND Elemento = i.refsalida
              AND Linea < 1000
            UNION ALL
            SELECT num_bulto FROM SEL_Bultos
            WHERE agno = fn.agno AND mes = fn.mes AND dia = fn.dia AND refsalida = i.refsalida
        ) x
    ) sig
    WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';

    -- Reserva la fila PRDProduccion (Cantidad=0) de cada bulto recien insertado arriba,
    -- reutilizando su num_bulto/serialPadre -- cursor porque Turno se resuelve fila por fila.
    BEGIN TRY
        DECLARE @agno int, @mes int, @dia int, @refsalida int, @id_maquina int, @id_ejecucion int,
                @HoraFin datetime, @NumeroPedido varchar(20), @NuevoNumBulto int, @BolsasxGolpe int,
                @SerialNuevo varchar(40), @Lote varchar(6), @Turno int, @CodCliente int, @CodDestino int,
                @IdExtrusionControl int, @NumeroSecuencial int, @OrdenProduccion varchar(20), @Operario int,
                @TipoPedido int, @IdBitacora int, @FechaTurno date, @GeneradoPor int,
                @LoteOriginal varchar(20), @FechaOriginal date;

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

            -- FIX 17/09/2026: TipoPedido se copia del bulto anterior de esta misma ejecucion,
            -- exactamente igual que OrdenProduccion arriba -- ya no se recalcula (el CASE AR/BR
            -- nunca se llego a implementar aqui, quedaba fijo en 4). El Node ya calcula bien el
            -- TipoPedido real para el primer bulto de la ejecucion (crearBultoInicial), asi que
            -- siempre deberia haber un valor previo que copiar.
            SET @TipoPedido = NULL;
            SELECT TOP 1 @TipoPedido = p5.TipoPedido
            FROM PRDProduccion p5
            INNER JOIN SEL_Bultos b5 ON b5.serialPadre = p5.Detalle
            WHERE b5.id_ejecucion = @id_ejecucion AND p5.TipoPedido IS NOT NULL;

            -- FIX 24/09/2026 (a pedido del usuario): IdBitacora ya NO se copia del bulto anterior
            -- (FIX 20/09) -- eso dejaba todos los bultos de la ejecucion en la bitacora del PRIMER
            -- bulto aunque pasaran turnos. Ahora es la bitacora del TURNO en que abre este bulto:
            -- misma maquina + mismo Turno (@Turno, arriba) + misma FechaTurno (el pedazo despues de
            -- medianoche de un turno nocturno es del dia anterior -- mismo criterio que
            -- resolverTurnoMaquina en Node). Esa bitacora la abre Node al tomar control / Iniciar.
            -- Si el operario del turno todavia no ha tomado control, queda NULL y se completa al
            -- CERRAR el bulto (bloque "Bitacora del bulto que se cierra", arriba).
            SET @FechaTurno = NULL;
            SELECT TOP 1 @FechaTurno =
                CASE WHEN CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                          AND CAST(@HoraFin AS time) < CAST(HoraFin AS time)
                     THEN DATEADD(DAY, -1, CAST(@HoraFin AS date))
                     ELSE CAST(@HoraFin AS date) END
            FROM TURHorariosMaquinas
            WHERE CodigoMaquina = @id_maquina AND CodigoTurno = @Turno AND Activo = 1;

            SET @IdBitacora = NULL;
            SELECT TOP 1 @IdBitacora = IdBitacora
            FROM SEL_BitacoraTurno
            WHERE Maquina = @id_maquina AND Turno = @Turno AND FechaTurno = @FechaTurno
            ORDER BY IdBitacora DESC;

            IF @IdBitacora IS NOT NULL
                UPDATE SEL_Bultos SET IdBitacora = @IdBitacora WHERE serialPadre = @SerialNuevo;

            -- FIX 22/09/2026 (v2, a pedido del usuario -- "que use el mismo mecanismo del operario
            -- actual por maquina"): GeneradoPor ("digitador") ya NO se copia fijo del primer bulto
            -- (v1, mismo dia -- quedaba congelado en el usuario que abrio la ejecucion, sin
            -- reflejar un relevo de quien esta logueado en la tablet a mitad de la ejecucion).
            -- Ahora se resuelve en VIVO via el mismo mecanismo que ya existe para Operario:
            --   SEL_OperarioActualMaquina.Operario (operario actual de esta maquina)
            --   -> SISUsuarios.CodigoOperarioPRD (vinculo agregado 24/08/2026, Node/sql/aplicados/
            --      20260824_agregar_codigooperarioprd_sisusuarios.sql) -> SISUsuarios.Tercero, que
            --      es exactamente lo que CODIGO DG. espera en PRDProduccion.GeneradoPor (ver
            --      SEL_ImpresionEtiquetas.vb:241, "SELECT Codigo FROM SISUsuarios WHERE Tercero = ").
            -- Si no resuelve nada (nadie en SEL_OperarioActualMaquina para esta maquina, o el
            -- usuario logueado no tiene CodigoOperarioPRD configurado), cae al mecanismo v1 (copiar
            -- del primer bulto) como respaldo -- nunca se deja de intentar.
            SET @GeneradoPor = NULL;
            SELECT TOP 1 @GeneradoPor = su.Tercero
            FROM SEL_OperarioActualMaquina oam
            INNER JOIN SISUsuarios su ON su.CodigoOperarioPRD = oam.Operario
            WHERE oam.Maquina = @id_maquina;

            IF @GeneradoPor IS NULL
            BEGIN
                SELECT TOP 1 @GeneradoPor = p7.GeneradoPor
                FROM PRDProduccion p7
                INNER JOIN SEL_Bultos b7 ON b7.serialPadre = p7.Detalle
                WHERE b7.id_ejecucion = @id_ejecucion AND p7.GeneradoPor IS NOT NULL AND p7.GeneradoPor <> 0
                ORDER BY p7.Linea ASC;
            END

            -- FIX 23/09/2026: ancla del proceso para LoteOriginal/FechaOriginal -- el PRIMER bulto de
            -- la orden (por id, no por num_bulto, que ya se reinicia por dia). Mismo criterio que
            -- Produccion.vb:GuardarNuevoRollo: se llena SIEMPRE en las filas que no son el ancla,
            -- aunque el dia coincida (este trigger nunca crea el ancla -- esa la crea el Node en
            -- crearBultoInicial). Las consultas que necesiten "todo el proceso" usan
            -- ISNULL(LoteOriginal, Lote) / ISNULL(FechaOriginal, Fecha).
            SET @LoteOriginal = NULL;
            SET @FechaOriginal = NULL;
            SELECT TOP 1
                @FechaOriginal = DATEFROMPARTS(b0.agno, b0.mes, b0.dia),
                @LoteOriginal  = RIGHT('0' + CAST(b0.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b0.dia AS varchar(2)), 2)
            FROM SEL_Bultos b0
            INNER JOIN SEL_EjecucionOrden e0 ON e0.IdEjecucion = b0.id_ejecucion
            WHERE e0.IdOrden = (SELECT TOP 1 IdOrden FROM SEL_EjecucionOrden WHERE IdEjecucion = @id_ejecucion)
            ORDER BY b0.id ASC;

            IF @Turno IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM PRDProduccion WHERE Detalle = @SerialNuevo
            )
            BEGIN
                INSERT INTO PRDProduccion
                    (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
                     ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor,
                     FechaModificado, HoraInicio, HoraFinal, Torta, BolsasxGolpe, TipoPedido, NumeroPedido, OrdenProduccion, IdBitacora,
                     LoteOriginal, FechaOriginal)
                VALUES
                    (DATEFROMPARTS(@agno, @mes, @dia), @id_maquina, @Turno, 0, @Lote, @refsalida, @NuevoNumBulto,
                     0, 0, 0, @SerialNuevo, @CodCliente, @CodDestino, 0, 0, 0, 0, ISNULL(@GeneradoPor, 0), GETDATE(), @HoraFin, @HoraFin, 0,
                     @BolsasxGolpe, ISNULL(@TipoPedido, 4),
                     CASE WHEN ISNULL(@NumeroPedido, '') <> '' THEN @NumeroPedido ELSE NULL END,
                     @OrdenProduccion, @IdBitacora,
                     @LoteOriginal, @FechaOriginal);

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
