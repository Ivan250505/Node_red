/* ============================================================================
   VOLVER ATRAS subir_a_produccion_sellado_paralelo.sql en Carlixplast.
   Generado el 11/09/2026 con el estado que tenia produccion JUSTO ANTES de
   aplicar aquel script. Solo hace falta si algo sale mal: deja la base como
   estaba y, con eso, el sellado en paralelo deja de funcionar.

   El trigger de mas abajo es el texto ORIGINAL de produccion, tal cual estaba
   (sin el respaldo de Bodega por grupo). Ojo: este texto SI trae los cambios
   propios de produccion que Prueba no tenia -- por eso se conserva aqui.
   ============================================================================ */

SET NOCOUNT ON;
GO

-- 1) Quitar Elemento y devolver la llave a (IdGrupo, Linea).
--    Solo corre si la tabla esta vacia: con filas, borrar Elemento seria perder datos.
IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND name = 'Elemento')
BEGIN
    IF EXISTS (SELECT 1 FROM dbo.PRDGrupoEtapasCompartidasLineas)
        THROW 51200, 'PRDGrupoEtapasCompartidasLineas tiene filas: revise a mano antes de revertir.', 1;

    DECLARE @pk SYSNAME = (SELECT name FROM sys.key_constraints
                           WHERE parent_object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND type = 'PK');
    IF @pk IS NOT NULL
        EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas DROP CONSTRAINT ' + @pk);

    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas DROP COLUMN Elemento');
    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ALTER COLUMN Linea INT NOT NULL');
    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas
          ADD CONSTRAINT PK_PRDGrupoEtapasCompartidasLineas PRIMARY KEY (IdGrupo, Linea)');
    PRINT 'Revertido: PRDGrupoEtapasCompartidasLineas vuelve a (IdGrupo, Linea).';
END
GO

-- 2) SEL_RolloEjecucion: se borra solo si quedo vacia. Si ya tiene bitacora de rollos, se deja
--    (no estorba a nada viejo y perderla seria perder historia).
IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.SEL_RolloEjecucion)
BEGIN
    DROP TABLE dbo.SEL_RolloEjecucion;
    PRINT 'Revertido: SEL_RolloEjecucion eliminada (estaba vacia).';
END
ELSE IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NOT NULL
    PRINT 'SEL_RolloEjecucion tiene filas -- se deja como esta.';
GO

-- 3) Trigger de entrada a inventario: texto original de produccion.
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
GO

PRINT 'Reversion completa.';
GO
