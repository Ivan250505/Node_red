/* ============================================================================
   CORRECCION: trg_SEL_Bultos_GenerarEntradaInventario -- referencias "hermanas"
   por LINEA, no por Elemento (13/09/2026).

   Por que hace falta: subir_a_produccion_sellado_paralelo.sql trajo el trigger
   con el mismo bug de raiz que ya se corrigio esta semana en frmLiberacionProduccion.vb,
   Programacion.vb y server.js (ver Pedido 11243): el fallback de Bodega para
   "referencias hermanas" de un grupo SELLADORA buscaba por
     gl_mp.Elemento = mp.Elemento ... gl_self.Elemento = @refsalida
   Si el MISMO pedido tiene DOS lineas distintas vendiendo la MISMA referencia
   (ya paso de verdad, pedido 11243), ese join no puede distinguir cual de las
   dos es la linea real del bulto que se esta cerrando -- puede traer la Bodega
   equivocada (o ninguna) sin avisar.

   Que cambia: el fallback ahora arma @LineaOrden -- la Linea real del pedido a la
   que pertenece ESTE bulto (via SEL_Bultos.id_ejecucion -> SEL_EjecucionOrden ->
   SEL_OrdenProduccion.Linea) -- y compara por Linea en vez de por Elemento. El
   resto del trigger (apertura de INVExistencias en 0, cierre con cantidad real,
   movimiento Tipo=35) queda IGUAL, solo cambia como se resuelve @Bodega cuando
   la referencia no tiene su propia materia prima registrada.

   NO TOCA la llave de PRDGrupoEtapasCompartidasLineas (eso es aparte, sigue
   pendiente de decidir con Carlos -- ver el resto de subir_a_produccion_sellado_paralelo.sql,
   PASO 1, que este script NO ejecuta ni necesita).

   Requisito: SEL_OrdenProduccion.Linea y SEL_Bultos.id_ejecucion ya existen en
   produccion (confirmado -- Programacion.vb los usa hace tiempo).

   Idempotente: se puede ejecutar varias veces sin hacer daño. ANTES de correrlo
   contra producción real, probarlo contra carlixplastPrueba con un caso real de
   dos líneas-misma-referencia (ej. recrear el escenario del pedido 11243).
   ============================================================================ */

SET NOCOUNT ON;
GO

IF OBJECT_ID('dbo.trg_SEL_Bultos_GenerarEntradaInventario', 'TR') IS NULL
    EXEC('CREATE TRIGGER dbo.trg_SEL_Bultos_GenerarEntradaInventario ON dbo.SEL_Bultos AFTER INSERT AS BEGIN SET NOCOUNT ON; END');
GO

ALTER TRIGGER trg_SEL_Bultos_GenerarEntradaInventario
ON SEL_Bultos
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @refsalida int, @serialPadre varchar(40), @NumeroPedido varchar(20), @number_paqu int,
            @Lote varchar(6), @Cantidad decimal(12,3), @Bodega varchar(20), @Linea int,
            @LineaOrden int;

    -- ── Apertura: crea la fila en INVExistencias en Cantidad=0, lista para actualizarse al cierre. ──
    IF EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted)
    BEGIN
        DECLARE @Apertura TABLE (
            refsalida int, serialPadre varchar(40), NumeroPedido varchar(20), number_paqu int,
            Lote varchar(6),
            -- FIX 13/09/2026: Linea REAL de SEL_OrdenProduccion para este bulto puntual -- no se
            -- deriva del Elemento (ambiguo si el pedido repite referencia entre lineas), se trae
            -- directo de la cadena SEL_Bultos.id_ejecucion -> SEL_EjecucionOrden -> SEL_OrdenProduccion.
            LineaOrden int
        );

        INSERT INTO @Apertura (refsalida, serialPadre, NumeroPedido, number_paqu, Lote, LineaOrden)
        SELECT i.refsalida, i.serialPadre, i.NumeroPedido, i.number_paqu,
               RIGHT('0' + CAST(i.mes AS varchar(2)), 2) + RIGHT('0' + CAST(i.dia AS varchar(2)), 2),
               ord.Linea
        FROM inserted i
        LEFT JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = i.id_ejecucion
        LEFT JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden;

        DECLARE curApertura CURSOR LOCAL FAST_FORWARD FOR
            SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote, LineaOrden FROM @Apertura;

        OPEN curApertura;
        FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @LineaOrden;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            SET @Bodega = NULL;

            SELECT TOP 1 @Bodega = Bodega
            FROM PRDProduccionMateriaPrima
            WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
            ORDER BY Linea DESC;

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

            FETCH NEXT FROM curApertura INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @LineaOrden;
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
            LineaOrden    int
        );

        INSERT INTO @Cierres (refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad, LineaOrden)
        SELECT b.refsalida, b.serialPadre, b.NumeroPedido, b.number_paqu,
               RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2),
               ISNULL(p.Total, 0),
               ord.Linea
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
                SELECT refsalida, serialPadre, NumeroPedido, number_paqu, Lote, Cantidad, LineaOrden FROM @Cierres;

            OPEN curCierre;
            FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad, @LineaOrden;

            WHILE @@FETCH_STATUS = 0
            BEGIN
                SET @Bodega = NULL;

                SELECT TOP 1 @Bodega = Bodega
                FROM PRDProduccionMateriaPrima
                WHERE Lote = @Lote AND Elemento = @refsalida AND Bodega IS NOT NULL
                ORDER BY Linea DESC;

                -- FIX 13/09/2026: mismo fallback por Linea que en la apertura, ver comentario arriba.
                IF @Bodega IS NULL AND @LineaOrden IS NOT NULL
                BEGIN
                    SELECT TOP 1 @Bodega = mp.Bodega
                    FROM PRDProduccionMateriaPrima mp
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_mp ON gl_mp.Linea = mp.Linea
                    INNER JOIN PRDGrupoEtapasCompartidas g_mp ON g_mp.IdGrupo = gl_mp.IdGrupo AND g_mp.CategoriaMaquina = 'SELLADORA'
                        AND g_mp.Numero = @NumeroPedido
                    INNER JOIN PRDGrupoEtapasCompartidasLineas gl_self ON gl_self.IdGrupo = g_mp.IdGrupo AND gl_self.Linea = @LineaOrden
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

                FETCH NEXT FROM curCierre INTO @refsalida, @serialPadre, @NumeroPedido, @number_paqu, @Lote, @Cantidad, @LineaOrden;
            END

            CLOSE curCierre;
            DEALLOCATE curCierre;
        END
    END
END
GO

PRINT 'trg_SEL_Bultos_GenerarEntradaInventario corregido -- fallback de referencias hermanas ahora por Linea.';
GO
