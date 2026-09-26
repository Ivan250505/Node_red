-- VERSION CANONICA -- verificada con SELECT OBJECT_DEFINITION contra produccion (carlixplast) el
-- 17/09/2026. Confirma que el fallback de bodega para referencias "hermanas" de un grupo SELLADORA
-- ya quedo resuelto por LINEA (no por Elemento, que era ambiguo -- FIX 13/09/2026, mismo bug de
-- fondo que Pedido 11243). Tambien es el trigger que genera el movimiento Tipo=35 en INVMovimientos/
-- INVMovimientosElementos al cerrar un bulto -- por eso el 35 se excluye de
-- ConsProduccion.vb:SQL_TIPOS_MOVIMIENTO_SERIAL (es la entrada del serial a si mismo, no una salida
-- real).
-- CONVENCION (nueva, 17/09/2026): este archivo SIEMPRE debe reflejar el ultimo estado realmente
-- desplegado del trigger. Cada vez que se aplique un cambio, se actualiza ESTE archivo en vez de
-- crear un script suelto mas -- el historial de git hace de versionamiento. Antes de escribir un
-- cambio nuevo sobre este trigger, correr de nuevo:
--   SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_GenerarEntradaInventario'));
-- y confirmar que coincide.
--
-- ACTUALIZADO 23/09/2026 (complemento obligatorio del mismo cambio en trg_SEL_Bultos_CierreBulto --
-- el bulto nuevo ahora toma la fecha REAL del dia en que abre): la bodega se buscaba en
-- PRDProduccionMateriaPrima por el Lote DEL BULTO, pero la materia prima siempre se registra bajo el
-- Lote del ANCLA del proceso (primer bulto de la orden -- ver obtenerFechaLoteOriginalControlSellado
-- en el Node / Produccion.vb). Un bulto de otro dia no encontraba bodega: ni INVExistencias ni
-- movimiento Tipo=35. Ahora se busca primero por el Lote del ancla (primer bulto de la orden, por
-- id) y, si no aparece, por el Lote del bulto (comportamiento anterior, por compatibilidad). El
-- fallback de grupo SELLADORA acepta cualquiera de los dos Lotes.
-- AUN NO APLICADO contra produccion -- aplicar junto con trg_SEL_Bultos_CierreBulto.
--
-- ACTUALIZADO 23/09/2026 (tarde) -- movimientos 24/35 por OT: el Tipo 35 de cada bulto es el de SU OT
-- (INVMovimientos.OrdenProduccion, fechado en la linea original de la OT), ya no uno solo por dia para
-- todo. Requiere antes nueva produccion/agregar_ordenproduccion_invmovimientos_23092026.sql.

CREATE OR ALTER TRIGGER trg_SEL_Bultos_GenerarEntradaInventario
ON SEL_Bultos
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @refsalida int, @serialPadre varchar(40), @NumeroPedido varchar(20), @number_paqu int,
            @Lote varchar(6), @Cantidad decimal(12,3), @Bodega varchar(20), @Linea int,
            @LineaOrden int, @LoteAncla varchar(6);

    -- ── Apertura: crea la fila en INVExistencias en Cantidad=0, lista para actualizarse al cierre. ──
    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Apertura TABLE (
            refsalida int, serialPadre varchar(40), NumeroPedido varchar(20), number_paqu int,
            Lote varchar(6),
            -- FIX 13/09/2026: Linea REAL de SEL_OrdenProduccion para este bulto puntual -- no se
            -- deriva del Elemento (ambiguo si el pedido repite referencia entre lineas), se trae
            -- directo de la cadena SEL_Bultos.id_ejecucion -> SEL_EjecucionOrden -> SEL_OrdenProduccion.
            LineaOrden int,
            -- FIX 23/09/2026: Lote del ancla (primer bulto de la orden, por id) -- ahi vive la MP.
            LoteAncla varchar(6)
        );

        INSERT INTO @Apertura (refsalida, serialPadre, NumeroPedido, number_paqu, Lote, LineaOrden, LoteAncla)
        SELECT i.refsalida, i.serialPadre, i.NumeroPedido, i.number_paqu,
               RIGHT('0' + CAST(i.mes AS varchar(2)), 2) + RIGHT('0' + CAST(i.dia AS varchar(2)), 2),
               ord.Linea,
               anc.LoteAncla
        FROM inserted i
        LEFT JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = i.id_ejecucion
        LEFT JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
        OUTER APPLY (
            SELECT TOP 1 RIGHT('0' + CAST(b0.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b0.dia AS varchar(2)), 2) AS LoteAncla
            FROM SEL_Bultos b0
            INNER JOIN SEL_EjecucionOrden e0 ON e0.IdEjecucion = b0.id_ejecucion
            WHERE e0.IdOrden = ej.IdOrden
            ORDER BY b0.id ASC
        ) anc;

        DECLARE curApertura CURSOR LOCAL FAST_FORWARD FOR
            SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote, LineaOrden, LoteAncla FROM @Apertura;

        OPEN curApertura;
        FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @LineaOrden, @LoteAncla;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @Bodega = NULL;

            -- FIX 23/09/2026: primero por el Lote del ancla (donde se registra la MP), luego por el
            -- Lote del propio bulto (comportamiento anterior).
            SELECT TOP 1 @Bodega = Bodega
            FROM PRDProduccionMateriaPrima
            WHERE Lote = ISNULL(@LoteAncla, @Lote) AND Elemento = @refsalida AND Bodega IS NOT NULL
            ORDER BY Linea DESC;

            IF @Bodega IS NULL AND @LoteAncla IS NOT NULL AND @LoteAncla <> @Lote
            BEGIN
                SELECT TOP 1 @Bodega = Bodega
                FROM PRDProduccionMateriaPrima
                WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
                ORDER BY Linea DESC;
            END

            -- FIX 13/09/2026 (REVIERTE el criterio de gl.Elemento -- mismo bug de fondo que Pedido
            -- 11243): fallback para referencias "hermanas" de un grupo SELLADORA, ahora por LINEA.
            -- Si @LineaOrden es NULL (orden vieja sin Linea guardada), el fallback simplemente no
            -- encuentra nada -- igual que antes cuando el grupo no aplicaba.
            IF @Bodega IS NULL AND @LineaOrden IS NOT NULL
            BEGIN
                SELECT TOP 1 @Bodega = mp.Bodega
                FROM PRDProduccionMateriaPrima mp
                INNER JOIN PRDGrupoEtapasCompartidasLineas gl_mp ON gl_mp.Linea = mp.Linea
                INNER JOIN PRDGrupoEtapasCompartidas g_mp ON g_mp.IdGrupo = gl_mp.IdGrupo AND g_mp.CategoriaMaquina = 'SELLADORA'
                    AND g_mp.Numero = @NumeroPedido
                INNER JOIN PRDGrupoEtapasCompartidasLineas gl_self ON gl_self.IdGrupo = g_mp.IdGrupo AND gl_self.Linea = @LineaOrden
                WHERE mp.Lote IN (ISNULL(@LoteAncla, @Lote), @Lote) AND mp.Bodega IS NOT NULL
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

            FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @LineaOrden, @LoteAncla;
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
            Cantidad      decimal(12,3),
            -- FIX 13/09/2026: mismo criterio que @Apertura arriba.
            LineaOrden    int,
            -- FIX 23/09/2026: mismo criterio que @Apertura arriba.
            LoteAncla     varchar(6)
        );

        INSERT INTO @Cierres (refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad, LineaOrden, LoteAncla)
        SELECT b.refsalida, b.serialPadre, b.NumeroPedido, b.number_paqu,
               RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2),
               ISNULL(p.Total, 0),
               ord.Linea,
               anc.LoteAncla
        FROM SEL_Bultos b
        JOIN inserted i ON i.id = b.id
        JOIN deleted d ON d.id = b.id
        CROSS APPLY (
            SELECT SUM(PesoPaqueGr) AS Total
            FROM SEL_PesajeElemento
            WHERE id_bulto = b.id
        ) p
        LEFT JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        LEFT JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
        OUTER APPLY (
            SELECT TOP 1 RIGHT('0' + CAST(b0.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b0.dia AS varchar(2)), 2) AS LoteAncla
            FROM SEL_Bultos b0
            INNER JOIN SEL_EjecucionOrden e0 ON e0.IdEjecucion = b0.id_ejecucion
            WHERE e0.IdOrden = ej.IdOrden
            ORDER BY b0.id ASC
        ) anc
        WHERE i.estado = 'Cerrado' AND d.estado <> 'Cerrado';

        IF EXISTS (SELECT 1 FROM @Cierres)
        BEGIN
            -- FIX 23/09/2026 (movimientos 24/35 por OT, a pedido del usuario -- mismo criterio que
            -- Produccion.vb:ObtenerOCrearMovimientoOT): cada bulto va al Tipo 35 de SU OT (en Selladora
            -- siempre hay OT: se crea en Iniciar y cada bulto la hereda en PRDProduccion.OrdenProduccion),
            -- buscado por la columna INVMovimientos.OrdenProduccion (sin anulados) y fechado en la linea
            -- original de la OT (PRDOrdenesProduccion.Fecha). Antes: un unico Tipo 35 por DIA para todo
            -- (cualquier movimiento Tipo 35 de hoy, incluso de otra OT). Sin OT: el generico del dia,
            -- ahora solo entre los que tienen OrdenProduccion NULL. El movimiento se resuelve por bulto
            -- (ya no uno solo antes del cursor) y solo si de verdad se va a escribir la linea.
            -- Requiere nueva produccion/agregar_ordenproduccion_invmovimientos_23092026.sql.
            DECLARE @NumeroMov35 varchar(20), @FechaMov35 date, @OT varchar(20), @ObsMov35 nvarchar(200);
            DECLARE @Consecutivo int, @FormatoNumero varchar(50), @LineaNum int, @Concepto varchar(100);
            DECLARE @PosCero int, @FmtFecha varchar(20), @FmtNum varchar(20), @LineaMov int;
            DECLARE @MovsSerial TABLE (Fecha date, Numero varchar(20));

            DECLARE curCierre CURSOR LOCAL FAST_FORWARD FOR
                SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad, LineaOrden, LoteAncla FROM @Cierres;

            OPEN curCierre;
            FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad, @LineaOrden, @LoteAncla;

            WHILE @@FETCH_STATUS = 0
            BEGIN
                SET @Bodega = NULL;

                -- FIX 23/09/2026: mismo orden de busqueda que en la apertura (Lote del ancla primero).
                SELECT TOP 1 @Bodega = Bodega
                FROM PRDProduccionMateriaPrima
                WHERE Lote = ISNULL(@LoteAncla, @Lote) AND Elemento = @refsalida AND Bodega IS NOT NULL
                ORDER BY Linea DESC;

                IF @Bodega IS NULL AND @LoteAncla IS NOT NULL AND @LoteAncla <> @Lote
                BEGIN
                    SELECT TOP 1 @Bodega = Bodega
                    FROM PRDProduccionMateriaPrima
                    WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
                    ORDER BY Linea DESC;
                END

                -- FIX 13/09/2026: mismo fallback por Linea que en la apertura, ver comentario arriba.
                IF @Bodega IS NULL AND @LineaOrden IS NOT NULL
                BEGIN
                    SELECT TOP 1 @Bodega = mp.Bodega
                    FROM PRDProduccionMateriaPrima mp
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_mp ON gl_mp.Linea = mp.Linea
                    INNER JOIN PRDGrupoEtapasCompartidas g_mp ON g_mp.IdGrupo = gl_mp.IdGrupo AND g_mp.CategoriaMaquina = 'SELLADORA'
                        AND g_mp.Numero = @NumeroPedido
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_self ON gl_self.IdGrupo = g_mp.IdGrupo AND gl_self.Linea = @LineaOrden
                    WHERE mp.Lote IN (ISNULL(@LoteAncla, @Lote), @Lote) AND mp.Bodega IS NOT NULL
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

                    BEGIN TRY
                        -- ── Movimiento Tipo 35 de este bulto: el de su OT, o el generico del dia ──
                        SET @NumeroMov35 = NULL;
                        SET @OT = NULL;
                        SELECT TOP 1 @OT = NULLIF(LTRIM(RTRIM(OrdenProduccion)), '')
                        FROM PRDProduccion WHERE Detalle = @serialPadre AND OrdenProduccion IS NOT NULL;

                        IF @OT IS NOT NULL
                        BEGIN
                            SELECT TOP 1 @NumeroMov35 = Numero, @FechaMov35 = Fecha
                            FROM INVMovimientos
                            WHERE Subempresa = 0 AND Tipo = 35 AND OrdenProduccion = @OT AND ISNULL(Estado, '') <> 'Anulado'
                            ORDER BY Fecha;
                            IF @NumeroMov35 IS NULL
                            BEGIN
                                SET @FechaMov35 = CAST(GETDATE() AS date);
                                SELECT TOP 1 @FechaMov35 = CAST(Fecha AS date) FROM PRDOrdenesProduccion WHERE OrdenProduccion = @OT AND Fecha IS NOT NULL;
                                -- NCHAR(243) = 'o' con tilde (no depende de la codificacion con que se abra el script)
                                SET @ObsMov35 = N'Entrada Producci' + NCHAR(243) + N'n - OT ' + @OT;
                            END
                        END
                        ELSE
                        BEGIN
                            SET @FechaMov35 = CAST(GETDATE() AS date);
                            SELECT TOP 1 @NumeroMov35 = Numero
                            FROM INVMovimientos
                            WHERE Subempresa = 0 AND Fecha = @FechaMov35 AND Tipo = 35 AND OrdenProduccion IS NULL;
                            IF @NumeroMov35 IS NULL
                                SET @ObsMov35 = N'Generado Autom' + NCHAR(225) + N'ticamente (Selladora)';
                        END

                        IF @NumeroMov35 IS NULL
                        BEGIN
                            SET @Consecutivo = NULL;
                            SELECT TOP 1 @Consecutivo = Consecutivo, @FormatoNumero = FormatoNumero, @LineaNum = Linea
                            FROM SISNumeracion
                            WHERE TipoMovimiento = 35
                              AND (Subempresa IS NULL OR Subempresa = 0)
                              AND Estado = 'Activo'
                              AND Concepto IS NULL
                              AND Dependencia IS NULL
                            ORDER BY Subempresa DESC, FechaDesde;

                            IF @Consecutivo IS NULL
                                RAISERROR('No se encontro numeracion activa (simple) para TipoMovimiento=35.', 16, 1);

                            IF @FormatoNumero IS NULL OR @FormatoNumero = ''
                                SET @NumeroMov35 = CAST(@Consecutivo AS varchar(20));
                            ELSE
                            BEGIN
                                SET @PosCero = PATINDEX('%0%', @FormatoNumero);
                                SET @FmtFecha = CASE WHEN @PosCero > 1 THEN LEFT(@FormatoNumero, @PosCero - 1) ELSE '' END;
                                SET @FmtNum = CASE WHEN @PosCero > 0 THEN SUBSTRING(@FormatoNumero, @PosCero, LEN(@FormatoNumero)) ELSE @FormatoNumero END;

                                SET @NumeroMov35 = CASE WHEN @FmtFecha <> '' THEN FORMAT(GETDATE(), @FmtFecha) ELSE '' END
                                                  + RIGHT(REPLICATE('0', LEN(@FmtNum)) + CAST(@Consecutivo AS varchar(20)), LEN(@FmtNum));
                            END

                            UPDATE SISNumeracion
                            SET Consecutivo = Consecutivo + 1
                            WHERE TipoMovimiento = 35 AND Linea = @LineaNum;

                            SELECT @Concepto = Concepto FROM SISTiposMovimiento WHERE Codigo = 35;

                            INSERT INTO INVMovimientos
                                (SubEmpresa, Fecha, Tipo, Numero, Concepto, Tercero, Sucursal, GeneradoPor, Observaciones, FechaModificado, Estado, OrdenProduccion)
                            VALUES
                                (0, @FechaMov35, 35, @NumeroMov35, @Concepto, 0, 0, 0,
                                 @ObsMov35, GETDATE(), 'Registrado', @OT);
                        END

                        -- El serial se quita de CUALQUIER Tipo 35 donde ya estuviera (antes: solo del
                        -- movimiento de hoy) -- si el movimiento viejo queda sin lineas, se borra su encabezado.
                        DELETE FROM @MovsSerial;
                        INSERT INTO @MovsSerial (Fecha, Numero)
                        SELECT DISTINCT Fecha, Numero FROM INVMovimientosElementos
                        WHERE Subempresa = 0 AND Tipo = 35 AND Detalle = @serialPadre;

                        DELETE FROM INVMovimientosElementos
                        WHERE Subempresa = 0 AND Tipo = 35 AND Detalle = @serialPadre;

                        DELETE m
                        FROM INVMovimientos m
                        INNER JOIN @MovsSerial ms ON ms.Fecha = m.Fecha AND ms.Numero = m.Numero
                        WHERE m.Subempresa = 0 AND m.Tipo = 35
                          AND NOT (m.Fecha = @FechaMov35 AND m.Numero = @NumeroMov35)
                          AND NOT EXISTS (SELECT 1 FROM INVMovimientosElementos me
                                          WHERE me.Subempresa = 0 AND me.Tipo = 35 AND me.Fecha = m.Fecha AND me.Numero = m.Numero);

                        SELECT @LineaMov = ISNULL(MAX(Linea), 0) + 1
                        FROM INVMovimientosElementos
                        WHERE Subempresa = 0 AND Fecha = @FechaMov35 AND Tipo = 35 AND Numero = @NumeroMov35;

                        INSERT INTO INVMovimientosElementos
                            (SubEmpresa, Fecha, Tipo, Numero, Linea, Bodega, Elemento, UnidadMedida, Costo, Cantidad, Unidades, Detalle)
                        SELECT 0, @FechaMov35, 35, @NumeroMov35, @LineaMov, @Bodega, @refsalida,
                               ie.UnidadMedida, ISNULL(ie.Costo, 0), @Cantidad, ISNULL(@number_paqu, 0), @serialPadre
                        FROM INVElementos ie WHERE ie.Codigo = @refsalida;
                    END TRY
                    BEGIN CATCH
                        -- no bloquear el cierre del bulto ni el saldo de INVExistencias por esto
                    END CATCH
                END

                FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad, @LineaOrden, @LoteAncla;
            END

            CLOSE curCierre;
            DEALLOCATE curCierre;
        END
    END
END
