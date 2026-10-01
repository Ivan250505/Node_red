-- VERSION CANONICA -- 01/10/2026: agrega el umbral de inicio del bulto (antes solo pasaba Temporal -> Activo,
-- copiada de producción el 28/09/2026). Script para aplicar: orden_trabajo/1_estructura/
-- reabrir_trasladar_umbral_01102026/06_trigger_pesaje_umbral.sql (este archivo es el mismo contenido).
-- NO suma number_paqu: ese conteo lo hace node_red/01_pesaje_paquete.sql antes del INSERT.
-- Para comparar: SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_PesajeElemento_ActualizarBulto'));
--
-- trg_SEL_PesajeElemento_ActualizarBulto (01/10/2026) -- umbral de inicio del bulto (regla 3).
-- Antes: con cada paquete solo pasaba el bulto de 'Temporal' a 'Activo'. Sigue haciéndolo.
-- NUEVO: con el PRIMER paquete de un bulto Temporal, si llega más tarde que el umbral
-- (SISParametros 'SEL_UMBRAL_INICIO_BULTO_MIN', 60 por defecto; 0 = apagado) después de la hora de inicio
-- del bulto (la noche, un corte de luz, un relevo...), el bulto se RE-ESTAMPA con el momento de ese paquete:
--   * siempre: HoraInicio, Turno, IdBitacora del turno real, operario/GeneradoPor actuales (PRDProduccion,
--     PRDProduccionOperarios y SEL_Bultos);
--   * si además cambió de día: fecha, lote, número de bulto y serial (SEL_Bultos, PRDProduccion,
--     PRDProduccionOperarios, PRDExtrusionRollos, INVExistencias y el serial del primer paquete).
--     Un bulto en 0 todavía no tiene etiqueta impresa ni inventario con cantidad.
--   * EXCEPCIÓN: el PRIMER bulto de la orden (ancla) nunca cambia de serial (de su lote/línea cuelgan la
--     materia prima, el control y la OT): solo se le corrigen horas, turno, bitácora y operario.
-- Mismas fórmulas que trg_SEL_Bultos_CierreBulto (número de bulto, turno, FechaTurno, bitácora, operario).
-- OJO: un error aquí revierte también el pesaje (así funcionan los triggers); por eso todo es UPDATE simple.
-- REQUISITO: 05_parametro_umbral.sql. Pegar además la versión nueva de triggers/node_red/01_pesaje_paquete.sql
-- (lee el serial del paquete ya re-estampado para imprimir la etiqueta). Un solo lote, sin GO.

CREATE OR ALTER TRIGGER dbo.trg_SEL_PesajeElemento_ActualizarBulto
ON dbo.SEL_PesajeElemento
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Umbral INT = 60;
    SELECT TOP 1 @Umbral = ISNULL(TRY_CAST(Valor AS INT), 60) FROM SISParametros WHERE Parametro = 'SEL_UMBRAL_INICIO_BULTO_MIN';

    -- Bultos Temporal que reciben aquí su PRIMER paquete y llegan tarde.
    DECLARE @Restampar TABLE (IdBulto INT PRIMARY KEY, Nueva DATETIME);
    IF @Umbral > 0
        INSERT INTO @Restampar (IdBulto, Nueva)
        SELECT b.id, x.Primera
        FROM (SELECT id_bulto, MIN(FechaHora) AS Primera, COUNT(*) AS Nuevos FROM inserted GROUP BY id_bulto) x
        INNER JOIN SEL_Bultos b ON b.id = x.id_bulto
        WHERE b.estado = 'Temporal' AND b.HoraInicio IS NOT NULL
          AND DATEDIFF(MINUTE, b.HoraInicio, x.Primera) > @Umbral
          AND (SELECT COUNT(*) FROM SEL_PesajeElemento pe WHERE pe.id_bulto = b.id) = x.Nuevos;

    IF EXISTS (SELECT 1 FROM @Restampar)
    BEGIN
        BEGIN
            DECLARE @IdBulto INT, @Nueva DATETIME, @Ref INT, @Maq INT, @IdEj INT, @SerialViejo VARCHAR(40),
                    @AgnoV INT, @MesV INT, @DiaV INT, @NumV INT, @EsAncla BIT,
                    @Agno INT, @Mes INT, @Dia INT, @Num INT, @Lote VARCHAR(6), @LoteV VARCHAR(6), @SerialNuevo VARCHAR(40),
                    @Turno INT, @FechaTurno DATE, @IdBitacora INT, @Operario INT, @GeneradoPor INT;

            DECLARE curR CURSOR LOCAL FAST_FORWARD FOR SELECT IdBulto, Nueva FROM @Restampar;
            OPEN curR;
            FETCH NEXT FROM curR INTO @IdBulto, @Nueva;
            WHILE @@FETCH_STATUS = 0
            BEGIN
                SELECT @Ref = b.refsalida, @Maq = b.id_maquina, @IdEj = b.id_ejecucion, @SerialViejo = b.serialPadre,
                       @AgnoV = b.agno, @MesV = b.mes, @DiaV = b.dia, @NumV = b.num_bulto,
                       @EsAncla = CASE WHEN b.id = (SELECT MIN(b2.id) FROM SEL_Bultos b2
                                                    INNER JOIN SEL_EjecucionOrden e2 ON e2.IdEjecucion = b2.id_ejecucion
                                                    WHERE e2.IdOrden = ej.IdOrden) THEN 1 ELSE 0 END
                FROM SEL_Bultos b INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
                WHERE b.id = @IdBulto;
                SET @LoteV = RIGHT('0' + CAST(@MesV AS VARCHAR(2)), 2) + RIGHT('0' + CAST(@DiaV AS VARCHAR(2)), 2);

                -- Turno / FechaTurno / bitácora / operario del momento real (igual que trg_SEL_Bultos_CierreBulto).
                SET @Turno = NULL;
                SELECT TOP 1 @Turno = CodigoTurno FROM TURHorariosMaquinas
                WHERE CodigoMaquina = @Maq AND Activo = 1
                  AND ((CAST(HoraInicio AS time) <= CAST(HoraFin AS time)
                        AND CAST(@Nueva AS time) >= CAST(HoraInicio AS time) AND CAST(@Nueva AS time) < CAST(HoraFin AS time))
                    OR (CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                        AND (CAST(@Nueva AS time) >= CAST(HoraInicio AS time) OR CAST(@Nueva AS time) < CAST(HoraFin AS time))));
                SET @FechaTurno = NULL;
                SELECT TOP 1 @FechaTurno = CASE WHEN CAST(HoraInicio AS time) > CAST(HoraFin AS time)
                                                     AND CAST(@Nueva AS time) < CAST(HoraFin AS time)
                                                THEN DATEADD(DAY, -1, CAST(@Nueva AS date)) ELSE CAST(@Nueva AS date) END
                FROM TURHorariosMaquinas WHERE CodigoMaquina = @Maq AND CodigoTurno = @Turno AND Activo = 1;
                SET @IdBitacora = NULL;
                SELECT TOP 1 @IdBitacora = IdBitacora FROM SEL_BitacoraTurno
                WHERE Maquina = @Maq AND Turno = @Turno AND FechaTurno = @FechaTurno ORDER BY IdBitacora DESC;
                SET @Operario = NULL;
                SELECT TOP 1 @Operario = ISNULL(oam.Operario, ej.Operario)
                FROM SEL_EjecucionOrden ej LEFT JOIN SEL_OperarioActualMaquina oam ON oam.Maquina = @Maq
                WHERE ej.IdEjecucion = @IdEj;
                SET @GeneradoPor = NULL;
                SELECT TOP 1 @GeneradoPor = su.Tercero FROM SEL_OperarioActualMaquina oam
                INNER JOIN SISUsuarios su ON su.CodigoOperarioPRD = oam.Operario WHERE oam.Maquina = @Maq;

                -- ¿Cambia de día? (nunca para la ancla)
                SET @Agno = YEAR(@Nueva); SET @Mes = MONTH(@Nueva); SET @Dia = DAY(@Nueva);
                IF @EsAncla = 1 OR (@Agno = @AgnoV AND @Mes = @MesV AND @Dia = @DiaV)
                BEGIN
                    SELECT @Agno = @AgnoV, @Mes = @MesV, @Dia = @DiaV, @Num = @NumV, @SerialNuevo = @SerialViejo;
                END
                ELSE
                BEGIN
                    SELECT @Num = ISNULL(MAX(x.Linea), 0) + 1
                    FROM (SELECT Linea FROM PRDProduccion
                          WHERE YEAR(Fecha) = @Agno AND Lote = RIGHT('0' + CAST(@Mes AS varchar(2)), 2) + RIGHT('0' + CAST(@Dia AS varchar(2)), 2)
                            AND Elemento = @Ref AND Linea < 1000
                          UNION ALL
                          SELECT num_bulto FROM SEL_Bultos
                          WHERE agno = @Agno AND mes = @Mes AND dia = @Dia AND refsalida = @Ref AND id <> @IdBulto) x;
                    SET @SerialNuevo = CAST(@Agno AS varchar(4))
                        + RIGHT('000000' + CAST(@Mes * 100 + @Dia AS varchar(6)), 6)
                        + RIGHT('0000' + CAST(@Num AS varchar(4)), 4)
                        + RIGHT('00000' + CAST(@Ref AS varchar(5)), 5);
                END
                SET @Lote = RIGHT('0' + CAST(@Mes AS varchar(2)), 2) + RIGHT('0' + CAST(@Dia AS varchar(2)), 2);

                -- Reserva de Producción del bulto.
                UPDATE PRDProduccion
                SET Fecha = DATEFROMPARTS(@Agno, @Mes, @Dia), Lote = @Lote, Linea = @Num, Detalle = @SerialNuevo,
                    HoraInicio = @Nueva, HoraFinal = @Nueva, Duracion = 0,
                    Turno = ISNULL(@Turno, Turno), IdBitacora = ISNULL(@IdBitacora, IdBitacora),
                    GeneradoPor = ISNULL(@GeneradoPor, GeneradoPor), FechaModificado = GETDATE()
                WHERE Detalle = @SerialViejo;

                -- Operario actual solo si la reserva tiene un único operario (no duplicar la llave).
                UPDATE PRDProduccionOperarios
                SET Fecha = DATEFROMPARTS(@Agno, @Mes, @Dia), Lote = @Lote, Linea = @Num,
                    Operario = CASE WHEN @Operario IS NOT NULL
                                     AND (SELECT COUNT(*) FROM PRDProduccionOperarios o2
                                          WHERE o2.Fecha = DATEFROMPARTS(@AgnoV, @MesV, @DiaV) AND o2.Lote = @LoteV
                                            AND o2.Elemento = @Ref AND o2.Linea = @NumV) = 1
                                    THEN @Operario ELSE Operario END
                WHERE Fecha = DATEFROMPARTS(@AgnoV, @MesV, @DiaV) AND Lote = @LoteV AND Elemento = @Ref AND Linea = @NumV;

                IF @SerialNuevo <> @SerialViejo
                BEGIN
                    UPDATE PRDExtrusionRollos SET Fecha = DATEFROMPARTS(@Agno, @Mes, @Dia), Lote = @Lote, Linea = @Num
                    WHERE Fecha = DATEFROMPARTS(@AgnoV, @MesV, @DiaV) AND Lote = @LoteV AND Elemento = @Ref AND Linea = @NumV;
                    UPDATE INVExistencias SET Detalle = @SerialNuevo WHERE Detalle = @SerialViejo AND Elemento = @Ref;
                    UPDATE pe SET pe.Detalle = STUFF(@SerialNuevo, 5, 2, RIGHT('00' + CAST(pe.ConsecutivoPaquete AS VARCHAR(2)), 2))
                    FROM SEL_PesajeElemento pe WHERE pe.id_bulto = @IdBulto;
                END

                UPDATE SEL_Bultos
                SET agno = @Agno, mes = @Mes, dia = @Dia, num_bulto = @Num,
                    serialArmado = @SerialNuevo, serialPadre = @SerialNuevo,
                    HoraInicio = @Nueva, IdBitacora = ISNULL(@IdBitacora, IdBitacora)
                WHERE id = @IdBulto;

                IF OBJECT_ID('dbo.SISMovimientos', 'U') IS NOT NULL
                    INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
                    VALUES ('SELLADORA', 'REESTAMPAR_BULTO', @IdBulto, @SerialNuevo, GETDATE(), @GeneradoPor, 'Trigger pesaje',
                            'Primer paquete después del umbral (' + CAST(@Umbral AS VARCHAR(10)) + ' min)',
                            LEFT('Inicio -> ' + CONVERT(VARCHAR(19), @Nueva, 120)
                                 + CASE WHEN @SerialNuevo <> @SerialViejo THEN '. Serial ' + @SerialViejo + ' -> ' + @SerialNuevo ELSE '. Serial sin cambio.' END, 500));

                FETCH NEXT FROM curR INTO @IdBulto, @Nueva;
            END
            CLOSE curR;
            DEALLOCATE curR;
        END
    END

    -- Lo de siempre: el bulto pasa de 'Temporal' a 'Activo'.
    UPDATE b
    SET b.estado = CASE WHEN b.estado = 'Temporal' THEN 'Activo' ELSE b.estado END
    FROM SEL_Bultos b
    JOIN inserted i ON i.id_bulto = b.id;
END
