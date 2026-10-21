/* ============================================================================
   21/10/2026 -- Traslado de paquete ENTRE REFERENCIAS: el ULTIMO hacia el ultimo.

   El caso (pedido 10089, sellado en paralelo HIGADOS/MIXTA/MOLLEJAS): el
   operario traslado un paquete de HIGADOS a MIXTA y el sistema movio el #1
   (el mas viejo del bulto) en vez del ultimo. La regla 51011 obligaba a mover
   siempre el PRIMERO entre referencias. Lo que pasa en la planta es que los
   ultimos paquetes sellados son los que resultan ser de la otra referencia, asi
   que el que sale es el ULTIMO del origen y entra como ultimo del destino
   (siguiente consecutivo, igual que antes).

   Cambia DOS procedimientos:
   - dbo.sp_SEL_TrasladarPaquete
       * Entre referencias (@Direccion NULL) solo acepta el ULTIMO del origen.
       * Parametro nuevo @BultoCompleto BIT = 0: con 1 acepta el PRIMERO, para
         que "Trasladar bulto completo" siga moviendo en orden de llegada.
       * Entre referencias NO se toca la HoraInicio de ningun bulto (ni en
         SEL_Bultos ni en su fila de PRDProduccion) -- esa es la razon de que
         solo salga el ultimo. Antes el origen tomaba la hora de su primer
         paquete restante: en el 10089 la HoraInicio del bulto 445 paso a ser
         la del paquete #2 (17:40:04). Eso se corrige en
         20261021_corregir_horainicio_bulto_445.sql.
       * El destino Cerrado alarga su HoraFin si el paquete es mas nuevo (antes
         solo hacia el bulto ANTERIOR; ahora tambien entre referencias).
   - dbo.sp_SEL_TrasladarBulto: le pasa @BultoCompleto = 1 al de arriba.
     Hacia un bulto de la misma referencia no cambia nada (ahi @Direccion no
     es NULL y el parametro no se mira).

   La tableta (server.js, renderSeccionTraslado) ofrece el ultimo paquete en
   "Otra referencia" a partir del mismo commit.

   Idempotente: se puede ejecutar las veces que sea, en las dos bases.
   ============================================================================ */

IF OBJECT_ID('dbo.sp_SEL_TrasladarPaquete', 'P') IS NULL
    EXEC('CREATE PROCEDURE dbo.sp_SEL_TrasladarPaquete AS BEGIN SET NOCOUNT ON; END');
GO

ALTER PROCEDURE dbo.sp_SEL_TrasladarPaquete
    @IdPaquete INT,
    @IdBultoDestino INT,
    @Usuario INT = NULL,
    -- 21/10/2026: 1 solo cuando lo llama sp_SEL_TrasladarBulto (mueve el bulto entero en orden
    -- de llegada, empezando por el primero). La tableta no lo manda.
    @BultoCompleto BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @IdBultoOrigen INT, @PesoPaqueGr NUMERIC(10,3), @FechaPaq DATETIME, @ConsecOrigen INT;
        SELECT @IdBultoOrigen = id_bulto, @PesoPaqueGr = PesoPaqueGr, @FechaPaq = FechaHora, @ConsecOrigen = ConsecutivoPaquete
        FROM dbo.SEL_PesajeElemento WITH (UPDLOCK) WHERE id_paquete = @IdPaquete;

        IF @IdBultoOrigen IS NULL THROW 51000, 'Paquete no encontrado.', 1;
        IF @IdBultoOrigen = @IdBultoDestino THROW 51001, 'El bulto destino es el mismo que el origen.', 1;

        DECLARE @RefO INT, @SerialO VARCHAR(40), @EstadoO VARCHAR(20), @OrdenO INT,
                @RefD INT, @SerialD VARCHAR(40), @EstadoD VARCHAR(20), @OrdenD INT;
        SELECT @RefO = b.refsalida, @SerialO = b.serialPadre, @EstadoO = b.estado, @OrdenO = ej.IdOrden
        FROM dbo.SEL_Bultos b WITH (UPDLOCK) INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        WHERE b.id = @IdBultoOrigen;
        SELECT @RefD = b.refsalida, @SerialD = b.serialPadre, @EstadoD = b.estado, @OrdenD = ej.IdOrden
        FROM dbo.SEL_Bultos b WITH (UPDLOCK) INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        WHERE b.id = @IdBultoDestino;

        IF @SerialD IS NULL THROW 51002, 'Bulto destino no encontrado.', 1;
        IF @EstadoD = 'Anulado' THROW 51003, 'El bulto destino está anulado.', 1;

        -- Tarjeta #10: la llave es la OT, no la referencia/orden. Misma OT = mismo grupo
        -- (mono o multi-pedido). Sin OT en alguno, no hay grupo que los ampare: se bloquea.
        DECLARE @OTO VARCHAR(20), @OTD VARCHAR(20);
        SELECT TOP 1 @OTO = OrdenProduccion FROM dbo.PRDProduccion WHERE Detalle = @SerialO AND OrdenProduccion IS NOT NULL;
        SELECT TOP 1 @OTD = OrdenProduccion FROM dbo.PRDProduccion WHERE Detalle = @SerialD AND OrdenProduccion IS NOT NULL;
        IF @OTO IS NULL OR @OTD IS NULL
            THROW 51004, 'Alguno de los bultos no tiene Orden de Trabajo -- no se puede trasladar.', 1;
        IF @OTO <> @OTD
            THROW 51005, 'Los bultos son de distinta Orden de Trabajo -- no se puede trasladar.', 1;

        IF EXISTS (SELECT 1 FROM dbo.PRDProduccion WHERE Detalle IN (@SerialO, @SerialD) AND ISNULL(Validado, 0) = 1)
            THROW 51006, 'Uno de los bultos ya fue validado por el digitador. No se pueden trasladar paquetes.', 1;

        -- Vecinos solo intra-orden (misma secuencia numérica). Cross-orden misma OT: cualquier
        -- bulto destino vale; la disciplina primero/último de abajo se mantiene siempre.
        DECLARE @IdAnterior INT, @IdSiguiente INT, @Direccion VARCHAR(10) = NULL;
        IF @OrdenO = @OrdenD
        BEGIN
            SELECT @IdAnterior = MAX(b.id) FROM dbo.SEL_Bultos b
            INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = @OrdenO AND b.refsalida = @RefO AND b.estado <> 'Anulado' AND b.id < @IdBultoOrigen;
            SELECT @IdSiguiente = MIN(b.id) FROM dbo.SEL_Bultos b
            INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = @OrdenO AND b.refsalida = @RefO AND b.estado <> 'Anulado' AND b.id > @IdBultoOrigen;
            SET @Direccion = CASE WHEN @IdBultoDestino = @IdAnterior THEN 'ANTERIOR'
                                  WHEN @IdBultoDestino = @IdSiguiente THEN 'SIGUIENTE' END;
            IF @Direccion IS NULL
                THROW 51007, 'Solo se puede trasladar al bulto vecino (el anterior o el siguiente de la misma orden).', 1;
        END

        DECLARE @IdPrimero INT, @IdUltimo INT, @ConsecPrimero INT, @ConsecUltimo INT;
        SELECT TOP 1 @IdPrimero = id_paquete, @ConsecPrimero = ConsecutivoPaquete FROM dbo.SEL_PesajeElemento
        WHERE id_bulto = @IdBultoOrigen ORDER BY FechaHora, ConsecutivoPaquete, id_paquete;
        SELECT TOP 1 @IdUltimo = id_paquete, @ConsecUltimo = ConsecutivoPaquete FROM dbo.SEL_PesajeElemento
        WHERE id_bulto = @IdBultoOrigen ORDER BY FechaHora DESC, ConsecutivoPaquete DESC, id_paquete DESC;

        IF @Direccion = 'ANTERIOR' AND @IdPaquete <> @IdPrimero
        BEGIN
            DECLARE @MsgA NVARCHAR(300) = N'Hacia el bulto anterior solo se puede trasladar el PRIMER paquete del bulto (el #'
                + CAST(@ConsecPrimero AS NVARCHAR(10)) + N'). Trasládelos en orden.';
            THROW 51008, @MsgA, 1;
        END
        IF @Direccion = 'SIGUIENTE' AND @IdPaquete <> @IdUltimo
        BEGIN
            DECLARE @MsgS NVARCHAR(300) = N'Hacia el bulto siguiente solo se puede trasladar el ÚLTIMO paquete del bulto (el #'
                + CAST(@ConsecUltimo AS NVARCHAR(10)) + N'). Trasládelos en orden.';
            THROW 51009, @MsgS, 1;
        END
        -- Cross-orden misma OT (@Direccion NULL): el ÚLTIMO del origen pasa a ser el último del
        -- destino (21/10/2026, a pedido del usuario -- antes era el PRIMERO y en el pedido 10089 se
        -- movió el #1 de HIGADOS cuando lo que se había sellado de más era el último). El bulto
        -- completo (@BultoCompleto = 1) sigue entrando por el primero para conservar el orden.
        IF @Direccion IS NULL AND @IdPaquete <> CASE WHEN @BultoCompleto = 1 THEN @IdPrimero ELSE @IdUltimo END
        BEGIN
            DECLARE @MsgC NVARCHAR(300) = N'Entre referencias solo se puede trasladar el ÚLTIMO paquete del bulto (el #'
                + CAST(@ConsecUltimo AS NVARCHAR(10)) + N'). Trasládelos en orden.';
            THROW 51011, @MsgC, 1;
        END

        -- Mover el paquete: siguiente número del destino y nuevo serial.
        DECLARE @NuevoConsecutivo INT;
        SELECT @NuevoConsecutivo = ISNULL(MAX(ConsecutivoPaquete), 0) + 1
        FROM dbo.SEL_PesajeElemento WHERE id_bulto = @IdBultoDestino;
        -- Límite de paquetes (01/10/2026): el consecutivo va en las posiciones 5-6 del serial, máximo 99.
        IF @NuevoConsecutivo > 99
            THROW 51010, 'LIMITE_PAQUETES: el bulto destino ya llegó al paquete #99. No se puede trasladar a ese bulto.', 1;
        DECLARE @NuevoDetalle VARCHAR(40) = STUFF(@SerialD, 5, 2, RIGHT('00' + CAST(@NuevoConsecutivo AS VARCHAR(2)), 2));

        UPDATE dbo.SEL_PesajeElemento
        SET id_bulto = @IdBultoDestino, ConsecutivoPaquete = @NuevoConsecutivo, Detalle = @NuevoDetalle
        WHERE id_paquete = @IdPaquete;

        -- El repesaje sigue a su paquete (si no, queda huérfano apuntando al bulto viejo).
        UPDATE dbo.SEL_RepesajePaquete SET id_bulto = @IdBultoDestino WHERE id_paquete = @IdPaquete;

        -- 21/10/2026: entre referencias (paquete suelto) NO se toca la hora de inicio de ningún
        -- bulto -- por eso solo sale el último. Solo el bulto completo (@BultoCompleto) la mueve,
        -- p. ej. un Temporal recién creado que recibe paquetes más viejos que él.
        DECLARE @AjustaInicio BIT = CASE WHEN @Direccion IS NOT NULL OR @BultoCompleto = 1 THEN 1 ELSE 0 END;

        -- Destino: conteo y horas. Si era un Temporal en 0, pasa a Activo (ya tiene paquetes).
        UPDATE dbo.SEL_Bultos
        SET number_paqu = CASE WHEN ISNULL(number_paqu, 0) < @NuevoConsecutivo THEN @NuevoConsecutivo ELSE number_paqu END,
            estado = CASE WHEN estado = 'Temporal' THEN 'Activo' ELSE estado END,
            HoraFin = CASE WHEN (@Direccion = 'ANTERIOR' OR @Direccion IS NULL) AND estado = 'Cerrado' AND (HoraFin IS NULL OR HoraFin < @FechaPaq)
                           THEN @FechaPaq ELSE HoraFin END,
            HoraInicio = CASE WHEN (@Direccion = 'SIGUIENTE' OR (@Direccion IS NULL AND @BultoCompleto = 1))
                                   AND (HoraInicio IS NULL OR HoraInicio > @FechaPaq)
                           THEN @FechaPaq ELSE HoraInicio END
        WHERE id = @IdBultoDestino;

        -- Origen: si le quedan paquetes, sus horas salen de ellos. El conteo NO baja (no se renumera).
        DECLARE @MinRestante DATETIME, @MaxRestante DATETIME, @Restantes INT;
        SELECT @MinRestante = MIN(FechaHora), @MaxRestante = MAX(FechaHora), @Restantes = COUNT(*)
        FROM dbo.SEL_PesajeElemento WHERE id_bulto = @IdBultoOrigen;

        IF @Restantes > 0
            UPDATE dbo.SEL_Bultos
            SET HoraInicio = CASE WHEN @Direccion = 'ANTERIOR' OR (@Direccion IS NULL AND @BultoCompleto = 1) THEN @MinRestante ELSE HoraInicio END,
                HoraFin = CASE WHEN (@Direccion = 'SIGUIENTE' OR @Direccion IS NULL) AND estado = 'Cerrado' THEN @MaxRestante ELSE HoraFin END
            WHERE id = @IdBultoOrigen;

        -- Bultos abiertos: su fila de Producción (reserva) toma la hora de inicio nueva.
        IF @AjustaInicio = 1
        UPDATE p
        SET p.HoraInicio = b.HoraInicio,
            p.FechaModificado = GETDATE(),
            p.HoraFinal = CASE WHEN p.HoraFinal IS NULL OR p.HoraFinal < b.HoraInicio THEN b.HoraInicio ELSE p.HoraFinal END
        FROM dbo.PRDProduccion p INNER JOIN dbo.SEL_Bultos b ON b.serialPadre = p.Detalle
        WHERE b.id IN (@IdBultoOrigen, @IdBultoDestino) AND b.estado <> 'Cerrado' AND b.HoraInicio IS NOT NULL;

        -- Bultos cerrados: recalcular peso, unidades, golpes, horas/duración, existencias y Tipo 35.
        EXEC dbo.sp_SEL_RecalcularBultoTrasPaquete @IdBulto = @IdBultoDestino;
        IF @Restantes > 0 EXEC dbo.sp_SEL_RecalcularBultoTrasPaquete @IdBulto = @IdBultoOrigen;

        -- Origen en 0.
        IF @Restantes = 0
        BEGIN
            IF @EstadoO = 'Cerrado'
                EXEC dbo.sp_SEL_EliminarBulto @IdBulto = @IdBultoOrigen;
            ELSE
                UPDATE dbo.SEL_Bultos SET estado = 'Temporal', number_paqu = 0 WHERE id = @IdBultoOrigen;
        END

        IF OBJECT_ID('dbo.SISMovimientos', 'U') IS NOT NULL
            INSERT INTO dbo.SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
            VALUES ('SELLADORA', 'TRASLADO_PAQUETE', @IdBultoDestino, @NuevoDetalle, GETDATE(), @Usuario, 'Tableta',
                    'Traslado de paquete al bulto ' + LOWER(ISNULL(@Direccion, 'otra referencia')) + ' (OT ' + @OTD + ')',
                    LEFT('Paquete #' + CAST(@ConsecOrigen AS VARCHAR(10)) + ' de ' + @SerialO + ' -> #' + CAST(@NuevoConsecutivo AS VARCHAR(10))
                         + ' de ' + @SerialD + CASE WHEN @Restantes = 0 THEN
                             CASE WHEN @EstadoO = 'Cerrado' THEN '. Origen sin paquetes: eliminado.' ELSE '. Origen sin paquetes: queda Temporal en 0.' END
                           ELSE '' END, 500));

        COMMIT TRANSACTION;

        SELECT @NuevoDetalle AS DetalleNuevo, @IdBultoDestino AS IdBultoDestino, @SerialD AS SerialPadreDestino,
               @NuevoConsecutivo AS ConsecutivoNuevo, @PesoPaqueGr AS PesoGr, @IdBultoOrigen AS IdBultoOrigen;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

IF OBJECT_ID('dbo.sp_SEL_TrasladarBulto', 'P') IS NULL
    EXEC('CREATE PROCEDURE dbo.sp_SEL_TrasladarBulto AS BEGIN SET NOCOUNT ON; END');
GO

ALTER PROCEDURE dbo.sp_SEL_TrasladarBulto
    @IdBultoOrigen INT,
    @IdBultoDestino INT = NULL,
    @IdOrdenDestino INT = NULL,
    @Usuario INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @RefO INT, @SerialO VARCHAR(40), @EstadoO VARCHAR(20), @EjO INT, @OrdO INT, @OTO VARCHAR(20);
        SELECT @RefO = b.refsalida, @SerialO = b.serialPadre, @EstadoO = b.estado, @EjO = b.id_ejecucion, @OrdO = ej.IdOrden
        FROM dbo.SEL_Bultos b WITH (UPDLOCK) INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        WHERE b.id = @IdBultoOrigen;
        IF @SerialO IS NULL THROW 52000, 'Bulto origen no encontrado.', 1;
        IF @EstadoO = 'Anulado' THROW 52001, 'El bulto origen está anulado.', 1;
        SELECT TOP 1 @OTO = OrdenProduccion FROM dbo.PRDProduccion WHERE Detalle = @SerialO AND OrdenProduccion IS NOT NULL;
        IF @OTO IS NULL THROW 52002, 'El bulto origen no tiene Orden de Trabajo.', 1;

        -- Bloqueos de contenido: hijas, calidad, validado (lo resuelve el digitador).
        DECLARE @FechaO DATE, @LoteO VARCHAR(6), @LineaO INT;
        SELECT TOP 1 @FechaO = Fecha, @LoteO = Lote, @LineaO = Linea FROM dbo.PRDProduccion WHERE Detalle = @SerialO;
        IF EXISTS (SELECT 1 FROM dbo.PRDProduccion
                   WHERE Fecha = @FechaO AND Lote = @LoteO AND Elemento = @RefO AND Linea IN (@LineaO + 1000, @LineaO + 3000, @LineaO + 4000))
            THROW 52003, 'El bulto origen tiene residuos (retal/troquelado/no conforme): lo ajusta el digitador.', 1;
        IF EXISTS (SELECT 1 FROM dbo.SEL_ChequeoCalidad WHERE id_bulto = @IdBultoOrigen)
            THROW 52004, 'El bulto origen tiene chequeo de calidad registrado: lo revisa el digitador.', 1;
        IF EXISTS (SELECT 1 FROM dbo.PRDProduccion WHERE Detalle = @SerialO AND ISNULL(Validado, 0) = 1)
            THROW 52005, 'El bulto origen ya fue validado por el digitador.', 1;

        -- Destino: dado, o el abierto de la orden destino, o se crea Temporal vacío.
        -- Tarjeta #10 (fix 07/10/2026, revisión Iván): el Temporal nuevo usa el MISMO mecanismo
        -- del trigger de cierre (base MAX + 1, formato de serial, turno/bitácora actuales) y NO
        -- inserta INVExistencias a mano: la crea trg_SEL_Bultos_GenerarEntradaInventario al INSERT.
        DECLARE @RefD INT, @SerialD VARCHAR(40), @OrdD INT;
        IF @IdBultoDestino IS NULL
        BEGIN
            IF @IdOrdenDestino IS NULL THROW 52006, 'Indique el bulto destino o la orden destino.', 1;
            SELECT TOP 1 @RefD = Elemento FROM dbo.SEL_OrdenProduccion WHERE IdOrden = @IdOrdenDestino;
            IF @RefD IS NULL THROW 52007, 'Orden destino no encontrada.', 1;
            SELECT TOP 1 @IdBultoDestino = b.id, @SerialD = b.serialPadre
            FROM dbo.SEL_Bultos b INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = @IdOrdenDestino AND b.estado IN ('Activo', 'Temporal') ORDER BY b.id DESC;
            SET @OrdD = @IdOrdenDestino;
            IF @IdBultoDestino IS NULL
            BEGIN
                -- Crear Temporal vacío con el mecanismo del trigger de cierre (mismo serial,
                -- mismo turno/bitácora actuales, misma OT; la existencia la crea el trigger
                -- de inventario al INSERT).
                DECLARE @EjD INT, @MaqD INT, @NumPedD VARCHAR(20);
                SELECT TOP 1 @EjD = ej.IdEjecucion, @MaqD = o.Maquina, @NumPedD = o.NumeroPedido
                FROM dbo.SEL_EjecucionOrden ej INNER JOIN dbo.SEL_OrdenProduccion o ON o.IdOrden = ej.IdOrden
                WHERE ej.IdOrden = @IdOrdenDestino AND ej.HoraFinReal IS NULL ORDER BY ej.IdEjecucion DESC;
                IF @EjD IS NULL THROW 52009, 'La orden destino no tiene ejecución en curso.', 1;
                DECLARE @FA DATETIME = GETDATE();
                DECLARE @AgnoD INT = YEAR(@FA), @MesD INT = MONTH(@FA), @DiaD INT = DAY(@FA);
                DECLARE @LoteD VARCHAR(6) = RIGHT('0' + CAST(@MesD AS VARCHAR(2)), 2) + RIGHT('0' + CAST(@DiaD AS VARCHAR(2)), 2);
                DECLARE @NumD INT;
                SELECT @NumD = ISNULL(MAX(x.Linea), 0) + 1 FROM (
                    SELECT Linea FROM dbo.PRDProduccion
                    WHERE Year(Fecha) = @AgnoD AND Lote = @LoteD AND Elemento = @RefD AND Linea < 1000
                    UNION ALL
                    SELECT num_bulto FROM dbo.SEL_Bultos
                    WHERE agno = @AgnoD AND mes = @MesD AND dia = @DiaD AND refsalida = @RefD) x;
                DECLARE @SerialN VARCHAR(40) =
                    CAST(@AgnoD AS VARCHAR(4))
                    + RIGHT('000000' + CAST(@MesD * 100 + @DiaD AS VARCHAR(6)), 6)
                    + RIGHT('0000' + CAST(@NumD AS VARCHAR(4)), 4)
                    + RIGHT('00000' + CAST(@RefD AS VARCHAR(5)), 5);
                DECLARE @TurnoD INT = NULL;
                SELECT TOP 1 @TurnoD = CodigoTurno
                FROM dbo.TURHorariosMaquinas
                WHERE CodigoMaquina = @MaqD AND Activo = 1
                  AND ((CAST(HoraInicio AS time) <= CAST(HoraFin AS time)
                        AND CAST(@FA AS time) >= CAST(HoraInicio AS time)
                        AND CAST(@FA AS time) <  CAST(HoraFin AS time))
                    OR (CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                        AND (CAST(@FA AS time) >= CAST(HoraInicio AS time)
                             OR CAST(@FA AS time) < CAST(HoraFin AS time))));
                DECLARE @FechaTurnoD DATE = NULL, @IdBitacoraD INT = NULL;
                SELECT TOP 1 @FechaTurnoD =
                    CASE WHEN CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                              AND CAST(@FA AS time) < CAST(HoraFin AS time)
                         THEN DATEADD(DAY, -1, CAST(@FA AS date))
                         ELSE CAST(@FA AS date) END
                FROM dbo.TURHorariosMaquinas
                WHERE CodigoMaquina = @MaqD AND CodigoTurno = @TurnoD AND Activo = 1;
                SELECT TOP 1 @IdBitacoraD = IdBitacora
                FROM dbo.SEL_BitacoraTurno
                WHERE Maquina = @MaqD AND Turno = @TurnoD AND FechaTurno = @FechaTurnoD
                ORDER BY IdBitacora DESC;
                DECLARE @CliD INT, @DestD INT, @GenD INT, @OpD INT, @TipoPedD INT, @BolsasD INT, @LoteOrigD VARCHAR(20), @FechaOrigD DATE;
                SELECT TOP 1 @CliD = o.Cliente, @DestD = o.Destino
                FROM dbo.SEL_OrdenProduccion o WHERE o.IdOrden = @IdOrdenDestino;
                SELECT TOP 1 @GenD = GeneradoPor, @TipoPedD = TipoPedido FROM dbo.PRDProduccion WHERE Detalle = @SerialO;
                SELECT TOP 1 @OpD = Operario FROM dbo.SEL_EjecucionOrden WHERE IdEjecucion = @EjO;
                SELECT TOP 1 @BolsasD = BolsasxGolpe FROM dbo.SEL_EjecucionOrden WHERE IdEjecucion = @EjD;
                SELECT TOP 1
                    @FechaOrigD = DATEFROMPARTS(b0.agno, b0.mes, b0.dia),
                    @LoteOrigD  = RIGHT('0' + CAST(b0.mes AS VARCHAR(2)), 2) + RIGHT('0' + CAST(b0.dia AS VARCHAR(2)), 2)
                FROM dbo.SEL_Bultos b0
                INNER JOIN dbo.SEL_EjecucionOrden e0 ON e0.IdEjecucion = b0.id_ejecucion
                WHERE e0.IdOrden = @IdOrdenDestino
                ORDER BY b0.id ASC;
                INSERT INTO dbo.SEL_Bultos (agno, mes, dia, number_paqu, num_bulto, refsalida, estado, serialArmado, serialPadre,
                                            id_maquina, id_ejecucion, NumeroPedido, HoraInicio, HoraFin, IdBitacora)
                VALUES (@AgnoD, @MesD, @DiaD, 0, @NumD, @RefD, 'Temporal', @SerialN, @SerialN,
                        @MaqD, @EjD, @NumPedD, @FA, @FA, @IdBitacoraD);
                SET @IdBultoDestino = SCOPE_IDENTITY();
                IF @TurnoD IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.PRDProduccion WHERE Detalle = @SerialN)
                BEGIN
                    INSERT INTO dbo.PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
                        ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor,
                        FechaModificado, HoraInicio, HoraFinal, Torta, BolsasxGolpe, TipoPedido, NumeroPedido, OrdenProduccion, IdBitacora,
                        LoteOriginal, FechaOriginal)
                    VALUES (DATEFROMPARTS(@AgnoD, @MesD, @DiaD), @MaqD, @TurnoD, 0, @LoteD, @RefD, @NumD, 0, 0, 0, @SerialN,
                        @CliD, @DestD, 0, 0, 0, 0, ISNULL(@GenD, 0),
                        GETDATE(), @FA, @FA, 0, ISNULL(@BolsasD, 0), ISNULL(@TipoPedD, 4), @NumPedD, @OTO, @IdBitacoraD,
                        @LoteOrigD, @FechaOrigD);
                END
                -- La fila en INVExistencias (Cantidad=0) la crea trg_SEL_Bultos_GenerarEntradaInventario
                -- al INSERT de arriba, con su fallback de bodega por lote-ancla/grupo.
                IF @OpD IS NOT NULL AND @OpD > 0 AND NOT EXISTS (
                    SELECT 1 FROM dbo.PRDProduccionOperarios
                    WHERE Fecha = DATEFROMPARTS(@AgnoD, @MesD, @DiaD) AND Lote = @LoteD AND Elemento = @RefD AND Linea = @NumD)
                    INSERT INTO dbo.PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario)
                    VALUES (DATEFROMPARTS(@AgnoD, @MesD, @DiaD), @LoteD, @RefD, @NumD, @OpD);
                SET @SerialD = @SerialN;
            END
        END
        ELSE
        BEGIN
            SELECT @SerialD = b.serialPadre, @RefD = b.refsalida, @OrdD = ej.IdOrden
            FROM dbo.SEL_Bultos b INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE b.id = @IdBultoDestino;
            IF @SerialD IS NULL THROW 52010, 'Bulto destino no encontrado.', 1;
        END

        -- Dirección del traslado (misma regla de vecinos que sp_SEL_TrasladarPaquete):
        -- ANTERIOR/SIGUIENTE solo intra-orden e intra-referencia; cross => primero (orden llegada).
        -- FIX 07/10/2026 (revisión Iván): antes el loop siempre tomaba el PRIMERO, así que hacia
        -- el bulto SIGUIENTE fallaba siempre (51009). Ahora se toma el ÚLTIMO si va al siguiente.
        DECLARE @DirB VARCHAR(10) = NULL, @IdAntB INT = NULL, @IdSigB INT = NULL;
        IF @OrdO = @OrdD
        BEGIN
            SELECT @IdAntB = MAX(b.id) FROM dbo.SEL_Bultos b
            INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = @OrdO AND b.refsalida = @RefO AND b.estado <> 'Anulado' AND b.id < @IdBultoOrigen;
            SELECT @IdSigB = MIN(b.id) FROM dbo.SEL_Bultos b
            INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = @OrdO AND b.refsalida = @RefO AND b.estado <> 'Anulado' AND b.id > @IdBultoOrigen;
            SET @DirB = CASE WHEN @IdBultoDestino = @IdAntB THEN 'ANTERIOR'
                              WHEN @IdBultoDestino = @IdSigB THEN 'SIGUIENTE' END;
        END

        -- Mover todos, en el orden que pide la dirección (el SP valida OT, primero/último y 99).
        DECLARE @Movidos INT = 0, @IdPaq INT;
        WHILE 1 = 1
        BEGIN
            IF @DirB = 'SIGUIENTE'
                SELECT TOP 1 @IdPaq = id_paquete FROM dbo.SEL_PesajeElemento
                WHERE id_bulto = @IdBultoOrigen ORDER BY FechaHora DESC, ConsecutivoPaquete DESC, id_paquete DESC;
            ELSE
                SELECT TOP 1 @IdPaq = id_paquete FROM dbo.SEL_PesajeElemento
                WHERE id_bulto = @IdBultoOrigen ORDER BY FechaHora, ConsecutivoPaquete, id_paquete;
            IF @IdPaq IS NULL BREAK;
            -- @BultoCompleto (21/10/2026): entre referencias el paquete suelto ahora sale por el
            -- ÚLTIMO; el bulto entero sigue entrando por el primero para no invertir el orden.
            EXEC dbo.sp_SEL_TrasladarPaquete @IdPaquete = @IdPaq, @IdBultoDestino = @IdBultoDestino, @Usuario = @Usuario,
                 @BultoCompleto = 1;
            SET @Movidos = @Movidos + 1;
            SET @IdPaq = NULL;
        END

        IF OBJECT_ID('dbo.SISMovimientos', 'U') IS NOT NULL
            INSERT INTO dbo.SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
            VALUES ('SELLADORA', 'TRASLADO_BULTO', @IdBultoDestino, @SerialD, GETDATE(), @Usuario, 'Tableta',
                    'Traslado de bulto completo (OT ' + @OTO + '): ' + CAST(@Movidos AS VARCHAR(10)) + ' paquetes',
                    LEFT('Bulto ' + CAST(@IdBultoOrigen AS VARCHAR(10)) + ' (' + @SerialO + ') -> bulto '
                         + CAST(@IdBultoDestino AS VARCHAR(10)) + ' (' + @SerialD + '): ' + CAST(@Movidos AS VARCHAR(10)) + ' paquetes.', 500));

        COMMIT TRANSACTION;

        SELECT @Movidos AS Movidos, @IdBultoDestino AS IdBultoDestino, @SerialD AS SerialPadreDestino;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO
