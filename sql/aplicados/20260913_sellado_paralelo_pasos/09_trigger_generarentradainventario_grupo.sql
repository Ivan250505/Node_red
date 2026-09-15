-- Cuerpo real del trigger. Correr DESPUES del archivo 08 (necesita que el trigger ya exista para
-- poder hacer ALTER). Texto tomado tal cual de CarlixplastPrueba (ver header original en
-- subir_a_produccion_sellado_paralelo.sql, Paso 3). Frente a la versión sin este fix, agrega el
-- fallback de Bodega para referencias "hermanas" de un grupo SELLADORA: si la referencia de
-- salida no tiene materia prima propia registrada (porque el rollo se escaneó bajo OTRA
-- referencia del mismo pedido), la busca a través del grupo (PRDGrupoEtapasCompartidas/...Lineas
-- por Elemento, exigiendo también el mismo NumeroPedido). Sin esto, los bultos de las referencias
-- hermanas no generan entrada de inventario.

ALTER TRIGGER trg_SEL_Bultos_GenerarEntradaInventario
ON SEL_Bultos
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @refsalida int, @serialPadre varchar(40), @NumeroPedido varchar(20), @number_paqu int,
            @Lote varchar(6), @Cantidad decimal(12,3), @Bodega varchar(20), @Linea int;

    -- ── Apertura: crea la fila en INVExistencias en Cantidad=0, lista para actualizarse al cierre. ──
    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Apertura TABLE (
            refsalida int, serialPadre varchar(40), NumeroPedido varchar(20), number_paqu int, Lote varchar(6)
        );

        INSERT INTO @Apertura (refsalida, serialPadre, NumeroPedido, number_paqu, Lote)
        SELECT i.refsalida, i.serialPadre, i.NumeroPedido, i.number_paqu,
               RIGHT('0' + CAST(i.mes AS varchar(2)), 2) + RIGHT('0' + CAST(i.dia AS varchar(2)), 2)
        FROM inserted i;

        DECLARE curApertura CURSOR LOCAL FAST_FORWARD FOR
            SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote FROM @Apertura;

        OPEN curApertura;
        FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @Bodega = NULL;

            SELECT TOP 1 @Bodega = Bodega
            FROM PRDProduccionMateriaPrima
            WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
            ORDER BY Linea DESC;

            -- Fallback para referencias "hermanas" de un grupo SELLADORA: busca la Bodega
            -- registrada bajo cualquier otro Elemento del MISMO grupo, mismo Lote (típicamente la
            -- ancla), exigiendo también el mismo NumeroPedido (el Elemento por sí solo puede
            -- repetirse entre pedidos DISTINTOS).
            IF @Bodega IS NULL
            BEGIN
                SELECT TOP 1 @Bodega = mp.Bodega
                FROM PRDProduccionMateriaPrima mp
                INNER JOIN PRDGrupoEtapasCompartidasLineas gl_mp ON gl_mp.Elemento = mp.Elemento
                INNER JOIN PRDGrupoEtapasCompartidas g_mp ON g_mp.IdGrupo = gl_mp.IdGrupo AND g_mp.CategoriaMaquina = 'SELLADORA'
                    AND g_mp.Numero = @NumeroPedido
                INNER JOIN PRDGrupoEtapasCompartidasLineas gl_self ON gl_self.IdGrupo = g_mp.IdGrupo AND gl_self.Elemento = @refsalida
                WHERE mp.Lote = @Lote AND mp.Bodega IS NOT NULL
                ORDER BY mp.Linea DESC;
            END

            IF @Bodega IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM INVExistencias
                WHERE Bodega = @Bodega AND Elemento = @refsalida AND Detalle = @serialPadre
            )
            BEGIN
                SELECT @Linea = ISNULL(MAX(Linea), 0) + 1
                FROM INVExistencias
                WHERE Bodega = @Bodega AND Elemento = @refsalida;

                INSERT INTO INVExistencias
                    (Bodega, Elemento, Linea, Cantidad, Unidades, Valor, Detalle, Serie)
                VALUES
                    (@Bodega, @refsalida, @Linea, 0, ISNULL(@number_paqu, 0), 0,
                     @serialPadre, @NumeroPedido);
            END

            FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote;
        END

        CLOSE curApertura;
        DEALLOCATE curApertura;
    END

    -- ── Cierre: actualiza la fila con la cantidad real y registra el movimiento Tipo=35. ──
    IF UPDATE(estado)
    BEGIN
        DECLARE @Cierres TABLE (
            refsalida     int,
            serialPadre   varchar(40),
            NumeroPedido  varchar(20),
            number_paqu   int,
            Lote          varchar(6),
            Cantidad      decimal(12,3)
        );

        INSERT INTO @Cierres (refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad)
        SELECT b.refsalida, b.serialPadre, b.NumeroPedido, b.number_paqu,
               RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2),
               ISNULL(p.Total, 0)
        FROM SEL_Bultos b
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        CROSS APPLY (
            SELECT SUM(PesoPaqueGr) AS Total
            FROM SEL_PesajeElemento
            WHERE id_bulto = b.id
        ) p
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';

        IF EXISTS (SELECT 1 FROM @Cierres)
        BEGIN
            DECLARE @NumeroMov35 varchar(20) = NULL;

            BEGIN TRY
                SELECT @NumeroMov35 = Numero
                FROM INVMovimientos
                WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35;

                IF @NumeroMov35 IS NULL
                BEGIN
                    DECLARE @Consecutivo int, @FormatoNumero varchar(50), @LineaNum int, @Concepto varchar(100);

                    SELECT TOP 1 @Consecutivo = Consecutivo, @FormatoNumero = FormatoNumero, @LineaNum = Linea
                    FROM SISNumeracion
                    WHERE TipoMovimiento = 35
                      AND (Subempresa IS NULL OR Subempresa = 0)
                      AND Estado = 'Activo'
                      AND Concepto IS NULL
                      AND Dependencia IS NULL
                    ORDER BY Subempresa DESC, FechaDesde;

                    IF @Consecutivo IS NULL
                        RAISERROR('No se encontró numeración activa (simple) para TipoMovimiento=35.', 16, 1);

                    IF @FormatoNumero IS NULL OR @FormatoNumero = ''
                        SET @NumeroMov35 = CAST(@Consecutivo AS varchar(20));
                    ELSE
                    BEGIN
                        DECLARE @PosCero int = PATINDEX('%0%', @FormatoNumero);
                        DECLARE @FmtFecha varchar(20) = CASE WHEN @PosCero > 1 THEN LEFT(@FormatoNumero, @PosCero - 1) ELSE '' END;
                        DECLARE @FmtNum varchar(20) = CASE WHEN @PosCero > 0 THEN SUBSTRING(@FormatoNumero, @PosCero, LEN(@FormatoNumero)) ELSE @FormatoNumero END;

                        SET @NumeroMov35 = CASE WHEN @FmtFecha <> '' THEN FORMAT(GETDATE(), @FmtFecha) ELSE '' END
                                          + RIGHT(REPLICATE('0', LEN(@FmtNum)) + CAST(@Consecutivo AS varchar(20)), LEN(@FmtNum));
                    END

                    UPDATE SISNumeracion
                    SET Consecutivo = Consecutivo + 1
                    WHERE TipoMovimiento = 35 AND Linea = @LineaNum;

                    SELECT @Concepto = Concepto FROM SISTiposMovimiento WHERE Codigo = 35;

                    INSERT INTO INVMovimientos
                        (SubEmpresa, Fecha, Tipo, Numero, Concepto, Tercero, Sucursal, GeneradoPor, Observaciones, FechaModificado, Estado)
                    VALUES
                        (0, CAST(GETDATE() AS date), 35, @NumeroMov35, @Concepto, 0, 0, 0,
                         'Generado Automáticamente (Selladora)', GETDATE(), 'Registrado');
                END
            END TRY
            BEGIN CATCH
                SET @NumeroMov35 = NULL;
            END CATCH

            DECLARE curCierre CURSOR LOCAL FAST_FORWARD FOR
                SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad FROM @Cierres;

            OPEN curCierre;
            FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad;

            WHILE @@FETCH_STATUS = 0
            BEGIN
                SET @Bodega = NULL;

                SELECT TOP 1 @Bodega = Bodega
                FROM PRDProduccionMateriaPrima
                WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
                ORDER BY Linea DESC;

                IF @Bodega IS NULL
                BEGIN
                    SELECT TOP 1 @Bodega = mp.Bodega
                    FROM PRDProduccionMateriaPrima mp
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_mp ON gl_mp.Elemento = mp.Elemento
                    INNER JOIN PRDGrupoEtapasCompartidas g_mp ON g_mp.IdGrupo = gl_mp.IdGrupo AND g_mp.CategoriaMaquina = 'SELLADORA'
                        AND g_mp.Numero = @NumeroPedido
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_self ON gl_self.IdGrupo = g_mp.IdGrupo AND gl_self.Elemento = @refsalida
                    WHERE mp.Lote = @Lote AND mp.Bodega IS NOT NULL
                    ORDER BY mp.Linea DESC;
                END

                IF @Bodega IS NOT NULL
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM INVExistencias
                        WHERE Bodega = @Bodega AND Elemento = @refsalida AND Detalle = @serialPadre
                    )
                    BEGIN
                        UPDATE INVExistencias
                        SET Cantidad = @Cantidad,
                            Unidades = @number_paqu,
                            Serie = CASE WHEN @NumeroPedido IS NOT NULL THEN @NumeroPedido ELSE Serie END
                        WHERE Bodega = @Bodega AND Elemento = @refsalida AND Detalle = @serialPadre;
                    END
                    ELSE
                    BEGIN
                        SELECT @Linea = ISNULL(MAX(Linea), 0) + 1
                        FROM INVExistencias
                        WHERE Bodega = @Bodega AND Elemento = @refsalida;

                        INSERT INTO INVExistencias
                            (Bodega, Elemento, Linea, Cantidad, Unidades, Valor, Detalle, Serie)
                        VALUES
                            (@Bodega, @refsalida, @Linea, @Cantidad, @number_paqu, 0,
                             @serialPadre, @NumeroPedido);
                    END

                    IF @NumeroMov35 IS NOT NULL
                    BEGIN
                        BEGIN TRY
                            DELETE FROM INVMovimientosElementos
                            WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35
                              AND Numero = @NumeroMov35 AND Detalle = @serialPadre;

                            DECLARE @LineaMov int;
                            SELECT @LineaMov = ISNULL(MAX(Linea), 0) + 1
                            FROM INVMovimientosElementos
                            WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35 AND Numero = @NumeroMov35;

                            INSERT INTO INVMovimientosElementos
                                (SubEmpresa, Fecha, Tipo, Numero, Linea, Bodega, Elemento, UnidadMedida, Costo, Cantidad, Unidades, Detalle)
                            SELECT 0, CAST(GETDATE() AS date), 35, @NumeroMov35, @LineaMov, @Bodega, @refsalida,
                                   ie.UnidadMedida, ISNULL(ie.Costo, 0), @Cantidad, ISNULL(@number_paqu, 0), @serialPadre
                            FROM INVElementos ie WHERE ie.Codigo = @refsalida;
                        END TRY
                        BEGIN CATCH
                            -- no bloquear el cierre del bulto ni el saldo de INVExistencias por esto
                        END CATCH
                    END
                END

                FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad;
            END

            CLOSE curCierre;
            DEALLOCATE curCierre;
        END
    END
END
