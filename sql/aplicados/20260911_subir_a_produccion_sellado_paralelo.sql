/* ============================================================================
   SUBIR A PRODUCCION (Carlixplast) lo que hace falta para el SELLADO EN
   PARALELO -- un pedido con varias referencias de salida en la misma selladora.
   Comparado contra CarlixplastPrueba el 11/09/2026.

   Son SOLO las diferencias que la aplicacion necesita. NO se traen las tablas
   de depuracion y respaldo que existen en Prueba (SEL_Heartbeat,
   SEL_TriggerDebugLog, SEL_PesajeElemento_bkp_20260829, AUD_INVExistencias,
   TestTriggerPermisos), ni las columnas que solo usa Mirane de escritorio
   (SEL_OrdenProduccion.Linea, INVElementos.Perforaciones/UnidadesPorPaquete,
   SISUsuarios.PermisoEliminarProduccion): ninguna la toca este servicio.

   OJO, dos cosas que este script NO hace a proposito:

   1) trg_SEL_Bultos_CierreBulto quedo distinto en las dos bases y NO se toca.
      Produccion tiene el FIX del 03/09/2026 (Unidades = paquetes x 100 al
      cerrar el bulto) que Prueba no tiene; Prueba tiene otro cambio (deja
      HoraFinal en NULL al reservar la fila del bulto nuevo, en vez de copiar
      HoraInicio) que produccion no tiene. Pisar uno con el otro perderia
      trabajo. Hay que fusionarlos a mano, aparte de esto.

   2) El arreglo de sp_SEL_AnularBultoVacio (un bulto en construccion que queda
      vacio tras un traslado vuelve a 'Temporal' en vez de anularse) vive en su
      propio archivo: arreglar_traslado_bulto_vacio.sql, que sirve para las dos
      bases. HAY QUE EJECUTARLO TAMBIEN. Al final de este script se revisa si ya
      esta aplicado y se avisa si falta.

   ANTES DE EJECUTAR -- requisito que no es de base de datos:
   los grupos (PRDGrupoEtapasCompartidas / ...Lineas) los crea Mirane de
   escritorio. Este script cambia la llave de la tabla de lineas de
   (IdGrupo, Linea) a (IdGrupo, Elemento), asi que la version de Mirane que este
   corriendo en produccion tiene que ser la que llena Elemento. Si se sube esto
   con un Mirane viejo, crear un grupo va a fallar (Elemento es NOT NULL).

   Idempotente: se puede ejecutar varias veces sin hacer dano.
   ============================================================================ */

SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------
   PASO 1 -- PRDGrupoEtapasCompartidasLineas.Elemento
   La llave real de un grupo de sellado es la REFERENCIA de salida, no el numero
   de linea: es por Elemento que se unen SEL_OrdenProduccion y el grupo (ver
   obtenerMiembrosGrupoSellado en server.js). Sin esta columna, un pedido con
   varias referencias no se arma y la pagina del pedido agrupado no existe.

   En produccion esta tabla estaba VACIA al momento de comparar, asi que no hay
   datos que convertir. Si llegara a tener filas, el script se detiene: no se
   puede adivinar que referencia corresponde a cada linea.
   --------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND name = 'Elemento')
BEGIN
    IF EXISTS (SELECT 1 FROM dbo.PRDGrupoEtapasCompartidasLineas)
        THROW 51100, 'PRDGrupoEtapasCompartidasLineas tiene filas: hay que decidir a mano el Elemento de cada una antes de cambiar la llave.', 1;

    -- Los EXEC() son para que el ALTER que nombra la columna nueva no se compile
    -- antes de que exista (resolucion diferida de nombres).
    DECLARE @pk SYSNAME = (SELECT name FROM sys.key_constraints
                           WHERE parent_object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND type = 'PK');
    IF @pk IS NOT NULL
        EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas DROP CONSTRAINT ' + @pk);

    -- Linea deja de ser parte de la llave y pasa a ser informativa (en Prueba es NULL-able).
    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ALTER COLUMN Linea INT NULL');
    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas ADD Elemento INT NOT NULL');
    EXEC('ALTER TABLE dbo.PRDGrupoEtapasCompartidasLineas
          ADD CONSTRAINT PK_PRDGrupoEtapasCompartidasLineas PRIMARY KEY (IdGrupo, Elemento)');

    PRINT 'PASO 1: agregada PRDGrupoEtapasCompartidasLineas.Elemento y llave cambiada a (IdGrupo, Elemento).';
END
ELSE
    PRINT 'PASO 1: PRDGrupoEtapasCompartidasLineas.Elemento ya existia -- nada que hacer.';
GO

/* ---------------------------------------------------------------------------
   PASO 2 -- SEL_RolloEjecucion
   Bitacora de rollos de entrada (que tiquete se monto, a que hora y sobre que
   bulto). La llena scan-rollo.js:confirmarRollo y la lee el reporte de
   produccion para poner el rollo al lado de los paquetes que produjo. Sin ella
   el servicio no se cae -- lo atrapa y lo avisa en consola -- pero la columna
   "Rollo" del reporte sale siempre en blanco.
   Mismo contenido que agregar_rollo_ejecucion.sql, aqui en version idempotente.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SEL_RolloEjecucion (
        Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        id_ejecucion INT NOT NULL,
        id_bulto INT NULL,
        Serial VARCHAR(30) NOT NULL,
        Cantidad DECIMAL(18,3) NULL,
        LoteMP VARCHAR(20) NULL,
        Bodega VARCHAR(20) NULL,
        Operario INT NULL,
        EsInicio BIT NOT NULL DEFAULT 0,
        FechaHora DATETIME NOT NULL DEFAULT GETDATE()
    );
    PRINT 'PASO 2: creada SEL_RolloEjecucion.';
END
ELSE
    PRINT 'PASO 2: SEL_RolloEjecucion ya existia -- nada que hacer.';
GO

IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID('dbo.SEL_RolloEjecucion') AND name = 'IX_SEL_RolloEjecucion_Ejecucion')
BEGIN
    CREATE INDEX IX_SEL_RolloEjecucion_Ejecucion ON dbo.SEL_RolloEjecucion (id_ejecucion, FechaHora);
    PRINT 'PASO 2: creado IX_SEL_RolloEjecucion_Ejecucion.';
END
GO

/* ---------------------------------------------------------------------------
   PASO 3 -- trg_SEL_Bultos_GenerarEntradaInventario
   Texto tomado tal cual de CarlixplastPrueba. Lo que agrega frente al de
   produccion es como resuelve la BODEGA del bulto: si la referencia de salida no
   tiene materia prima propia -- que es justo lo que pasa en sellado en paralelo,
   donde el rollo se registro bajo OTRA referencia del mismo pedido -- la busca a
   traves del grupo (PRDGrupoEtapasCompartidas/...Lineas). Sin eso, los bultos de
   las referencias hermanas no generan entrada de inventario.
   Todo lo que nombra el trigger existe ya en produccion (verificado).
   --------------------------------------------------------------------------- */
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

            -- FIX 09/09/2026: fallback para referencias "hermanas" de un grupo SELLADORA -- ver
            -- comentario de cabecera. Busca la Bodega registrada bajo cualquier otro Elemento del
            -- MISMO grupo, mismo Lote (típicamente la ancla).
            -- FIX 09/09/2026 (segunda vuelta, a pedido del usuario -- "¿el trigger controla la
            -- condición de las referencias hermanas?"): faltaba exigir el mismo NumeroPedido
            -- (g_mp.Numero = @NumeroPedido) -- el Elemento por sí solo puede repetirse entre
            -- pedidos DISTINTOS (mismo bug ya corregido en Node/VB, ver Pedido 11085 colado en el
            -- grupo del 11408). Sin esto, el fallback podría traer la Bodega de un grupo de OTRO
            -- pedido que por casualidad compartiera esa referencia.
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

                -- FIX 09/09/2026: mismo fallback que en la apertura, ver comentario de cabecera --
                -- incluye la misma exigencia de NumeroPedido (g_mp.Numero = @NumeroPedido).
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
GO

PRINT 'PASO 3: trg_SEL_Bultos_GenerarEntradaInventario actualizado.';
GO

/* ---------------------------------------------------------------------------
   COMPROBACION FINAL -- no cambia nada, solo avisa.
   --------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('dbo.PRDGrupoEtapasCompartidasLineas') AND name = 'Elemento')
    PRINT '*** FALTA: PRDGrupoEtapasCompartidasLineas.Elemento ***';

IF OBJECT_ID('dbo.SEL_RolloEjecucion', 'U') IS NULL
    PRINT '*** FALTA: SEL_RolloEjecucion ***';

IF OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_GenerarEntradaInventario')) NOT LIKE '%PRDGrupoEtapasCompartidasLineas%'
    PRINT '*** FALTA: el trigger de entrada a inventario sin el respaldo de Bodega por grupo ***';

-- El arreglo del traslado vive en arreglar_traslado_bulto_vacio.sql, que es un archivo aparte y
-- sirve para las dos bases. Aca solo se revisa si ya se ejecuto.
IF OBJECT_DEFINITION(OBJECT_ID('dbo.sp_SEL_AnularBultoVacio')) NOT LIKE '%''Activo'', ''Temporal'', ''EnEspera''%'
    PRINT '*** PENDIENTE: ejecute tambien arreglar_traslado_bulto_vacio.sql (sp_SEL_AnularBultoVacio todavia anula el bulto que se esta llenando) ***';
ELSE
    PRINT 'OK: sp_SEL_AnularBultoVacio ya tiene el arreglo del traslado.';

PRINT 'Listo. Recuerde que trg_SEL_Bultos_CierreBulto quedo divergente a proposito -- ver la nota del encabezado.';
GO
