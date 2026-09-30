-- ===== NODO NODE-RED: INSERTAR RESIDUO (retal / troquelado / no conforme, con cantidad) =====
-- Copia canónica 27/09/2026 de insertar_residuo_hijo_nodered.sql (versión 23/09, bodega por serial del padre).
-- Los DECLARE de arriba son de ejemplo: Node-RED reemplaza @IdBulto, @TipoResiduo, @Cantidad. Ver LEEME.md.
-- 30/09/2026: @GeneradoPor y el operario ya NO llegan de Node-RED: se resuelven aqui con el OPERARIO ACTIVO
-- de la maquina (SEL_OperarioActualMaquina -> SISUsuarios.CodigoOperarioPRD -> SISUsuarios.Tercero), el mismo
-- mecanismo de trg_SEL_Bultos_CierreBulto para el bulto padre. Antes quedaba fijo en 0.

-- Generado 01/09/2026 -- referencia para Node-RED (el mecatrónico): al presionar Retal/Troquelado/
-- No Conforme y digitar la cantidad, esto es lo que hay que insertar/actualizar -- migrado 1:1
-- desde SEL_InventarioMP.vb:GenerarResiduoHijoSellado + GenerarEntradaSellado.
--
-- Parámetros que llegan desde la tablet/PLC:
--   @IdBulto      -- SEL_Bultos.id del bulto padre
--   @TipoResiduo  -- 1=Retal, 3=Troquelado, 4=No Conforme (2=Refilado NO aplica a Selladora)
--   @Cantidad     -- valor digitado (kg)
--   (@GeneradoPor se calcula en el PASO 1b: usuario del operario activo de la maquina)
--
-- CONFIRMADO: esto NO toca PRDExtrusionControl ni calcula Merma -- esa lógica vive SOLO en
-- "Cerrar Definitivo" (frmValidacionSelladora.vb:HandleCerrar -> RecalcularMermaSellado/
-- CerrarProcesoSellado), separado a propósito. Este script deja el residuo guardado y el
-- inventario correcto -- ninguna otra implicación para el cierre del proceso.
--
-- NOTA sobre la numeración del movimiento Tipo=35: GenerarEntradaSellado (VB) usa GetConsecutivo(),
-- una función genérica de numeración compartida por todo Mirane que no es viable portar completa
-- acá. Se usa en su lugar el MISMO mecanismo SISNumeracion que ya se portó (y quedó confirmado
-- funcionando) en trg_SEL_Bultos_GenerarEntradaInventario -- resultado funcional equivalente (un
-- movimiento INVMovimientos por Subempresa+Fecha+Tipo=35, con sus líneas de detalle).
--
-- NO cubre el caso "anular" (cantidad=0 después de haber tenido un valor > 0, con borrado del
-- hijo) -- si Node-RED también necesita eso, avisar y se agrega aparte.

DECLARE @IdBulto INT = /* llega de la tablet */ 1;
DECLARE @TipoResiduo INT = /* 1=Retal, 3=Troquelado, 4=No Conforme */ 1;
DECLARE @Cantidad DECIMAL(12,4) = /* llega de la tablet */ 0;
DECLARE @GeneradoPor INT = NULL;   -- se resuelve en el PASO 1b (ya no queda fijo en 0)

SET XACT_ABORT ON;   -- si algo falla dentro de la transaccion, se deshace todo y no queda abierta en Node-RED

-- ── PASO 1: contexto del bulto padre (igual que ResolverContextoBultoParaHijo) ──────────────────
DECLARE @Elemento INT, @Fecha DATE, @Lote VARCHAR(6), @LineaPadre INT, @Maquina INT, @IdOrden INT;
DECLARE @HoraInicio DATETIME, @HoraFinal DATETIME = GETDATE(), @Operario INT, @SerialPadre VARCHAR(40);

SELECT TOP 1
    @SerialPadre = b.serialPadre,
    @Elemento = b.refsalida,
    @Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia),
    @Lote = RIGHT('0'+CAST(b.mes AS VARCHAR(2)),2) + RIGHT('0'+CAST(b.dia AS VARCHAR(2)),2),
    @LineaPadre = b.num_bulto,
    @Maquina = b.id_maquina,
    @IdOrden = ej.IdOrden,
    @HoraInicio = ISNULL(b.HoraInicio, DATEFROMPARTS(b.agno, b.mes, b.dia)),
    @Operario = ej.Operario
FROM SEL_Bultos b
INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
WHERE b.id = @IdBulto;

IF @Elemento IS NULL
BEGIN
    RAISERROR('No se encontró el bulto.', 16, 1);
    RETURN;
END

-- ── PASO 1b: operario activo de la maquina y su usuario (GeneradoPor) ─────────────────────────
-- 30/09/2026: igual que trg_SEL_Bultos_CierreBulto -- SEL_OperarioActualMaquina.Operario (codigo PRDOperarios)
-- -> SISUsuarios.CodigoOperarioPRD -> SISUsuarios.Tercero (lo que espera PRDProduccion.GeneradoPor).
-- Respaldo: el GeneradoPor del bulto padre; si tampoco hay, 0. El operario del hijo tambien es el
-- activo de la maquina; si no hay, el de la ejecucion (como antes).
DECLARE @OperarioActivo INT;
SELECT TOP 1 @OperarioActivo = Operario FROM SEL_OperarioActualMaquina WHERE Maquina = @Maquina;
IF ISNULL(@OperarioActivo, 0) > 0 SET @Operario = @OperarioActivo;

IF ISNULL(@OperarioActivo, 0) > 0
    SELECT TOP 1 @GeneradoPor = su.Tercero FROM SISUsuarios su WHERE su.CodigoOperarioPRD = @OperarioActivo;
IF ISNULL(@GeneradoPor, 0) = 0
    SELECT TOP 1 @GeneradoPor = GeneradoPor FROM PRDProduccion WHERE Detalle = @SerialPadre AND ISNULL(GeneradoPor, 0) <> 0;
SET @GeneradoPor = ISNULL(@GeneradoPor, 0);

-- NumeroPedido: de SEL_OrdenProduccion (texto, confiable), NO de SEL_Bultos.NumeroPedido.
DECLARE @NumeroPedido VARCHAR(20) = '';
SELECT TOP 1 @NumeroPedido = NumeroPedido FROM SEL_OrdenProduccion WHERE IdOrden = @IdOrden AND NumeroPedido IS NOT NULL;

-- Cliente: mismo pivote que ResolverClienteDestino (VENMovimientos/VISTerceros).
DECLARE @CodCliente INT = NULL;
IF @NumeroPedido <> ''
BEGIN
    SELECT TOP 1 @CodCliente = t.Codigo
    FROM VENMovimientos vm
    INNER JOIN VISTerceros t ON t.Codigo = vm.Tercero AND t.Sucursal = 0
    WHERE vm.Tipo = 16 AND vm.Numero = @NumeroPedido
    ORDER BY vm.Fecha DESC;
END

-- Bodega del hijo.
-- FIX 23/09/2026: desde los bultos con fecha real (trg_SEL_Bultos_CierreBulto 23/09) un bulto de un
-- dia distinto al primero de la orden tiene OTRO Lote, y num_bulto se reinicia por dia -- el viejo
-- criterio (MP con el Lote DEL BULTO y Linea = MIN(num_bulto)) ya no encontraba la MP y fallaba con
-- "No se pudo determinar la bodega". Ahora, en orden:
--   1) la bodega del propio bulto PADRE: su fila en INVExistencias (la crea
--      trg_SEL_Bultos_GenerarEntradaInventario al abrir el bulto, ya con la bodega correcta) o su
--      linea Tipo 35;
--   2) la MP del ANCLA de la orden (primer bulto por id: su Lote y su num_bulto).
DECLARE @BodegaHijo VARCHAR(10);
SELECT TOP 1 @BodegaHijo = Bodega FROM INVExistencias WHERE Elemento = @Elemento AND Detalle = @SerialPadre;
IF @BodegaHijo IS NULL
    SELECT TOP 1 @BodegaHijo = Bodega FROM INVMovimientosElementos WHERE Tipo = 35 AND Detalle = @SerialPadre;

IF @BodegaHijo IS NULL
BEGIN
    DECLARE @LoteAncla VARCHAR(6), @LineaAncla INT;
    SELECT TOP 1
        @LoteAncla  = RIGHT('0'+CAST(b0.mes AS VARCHAR(2)),2) + RIGHT('0'+CAST(b0.dia AS VARCHAR(2)),2),
        @LineaAncla = b0.num_bulto
    FROM SEL_Bultos b0 INNER JOIN SEL_EjecucionOrden e0 ON e0.IdEjecucion = b0.id_ejecucion
    WHERE e0.IdOrden = @IdOrden
    ORDER BY b0.id ASC;

    DECLARE @DetalleMP VARCHAR(50);
    SELECT TOP 1 @DetalleMP = Detalle FROM PRDProduccionMateriaPrima
    WHERE Lote = ISNULL(@LoteAncla, @Lote) AND Elemento = @Elemento AND Linea = ISNULL(@LineaAncla, @LineaPadre);
    IF @DetalleMP IS NOT NULL
    BEGIN
        SELECT TOP 1 @BodegaHijo = Bodega FROM INVExistencias WHERE Detalle = @DetalleMP;
        IF @BodegaHijo IS NULL
            SELECT TOP 1 @BodegaHijo = Bodega FROM INVMovimientosElementos WHERE Tipo = 24 AND Detalle = @DetalleMP;
    END
END
IF @BodegaHijo IS NULL
BEGIN
    RAISERROR('No se pudo determinar la bodega para el residuo -- verifique que el proceso tenga materia prima registrada.', 16, 1);
    RETURN;
END

-- Turno: el mismo que ya quedó asignado al padre.
DECLARE @TurnoHijo INT;
SELECT TOP 1 @TurnoHijo = Turno FROM PRDProduccion WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;

-- OrdenProduccion (código OP...): del propio padre, si ya la tiene.
DECLARE @OrdenProduccion VARCHAR(20);
SELECT TOP 1 @OrdenProduccion = OrdenProduccion FROM PRDProduccion WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre AND OrdenProduccion IS NOT NULL;

-- FIX 23/09/2026: LoteOriginal/FechaOriginal del padre (los llena trg_SEL_Bultos_CierreBulto en los
-- bultos que no son el ancla) -- el hijo los hereda para que las consultas del proceso completo
-- (ISNULL(LoteOriginal, Lote)) lo encuentren aunque el bulto sea de otro dia.
DECLARE @LoteOriginal VARCHAR(20), @FechaOriginal DATE;
SELECT TOP 1 @LoteOriginal = LoteOriginal, @FechaOriginal = FechaOriginal
FROM PRDProduccion WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;

-- ── PASO 2: línea/serial del hijo + columna espejo en el padre ──────────────────────────────────
DECLARE @LineaHijo INT = @LineaPadre + 1000 * @TipoResiduo;
DECLARE @Serial VARCHAR(19) =
    CAST(YEAR(@Fecha) AS VARCHAR(4)) +
    RIGHT('000000' + CAST(CAST(@Lote AS INT) AS VARCHAR(6)), 6) +
    RIGHT('0000' + CAST(@LineaHijo AS VARCHAR(4)), 4) +
    RIGHT('00000' + CAST(@Elemento AS VARCHAR(5)), 5);

DECLARE @TipoTexto VARCHAR(20) = CASE @TipoResiduo
    WHEN 1 THEN 'RETAL' WHEN 3 THEN 'TROQUELADO' WHEN 4 THEN 'NO CONFORME' ELSE NULL END;

IF @TipoTexto IS NULL
BEGIN
    RAISERROR('Tipo de residuo desconocido (solo 1=Retal, 3=Troquelado, 4=No Conforme).', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

-- ── PASO 3: existe o no el hijo -- UPDATE o INSERT ───────────────────────────────────────────────
IF EXISTS (SELECT 1 FROM PRDProduccion WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaHijo)
BEGIN
    UPDATE PRDProduccion SET
        Cantidad = @Cantidad,
        OrdenProduccion = ISNULL(@OrdenProduccion, OrdenProduccion), -- nunca pisa con NULL
        FechaModificado = GETDATE()
    WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaHijo;

    UPDATE INVExistencias SET
        Cantidad = @Cantidad,
        Serie = CASE WHEN @NumeroPedido <> '' THEN @NumeroPedido ELSE Serie END
    WHERE Bodega=@BodegaHijo AND Elemento=@Elemento AND Detalle=@Serial;
END
ELSE
BEGIN
    INSERT INTO PRDProduccion
        (Fecha,Maquina,Turno,Duracion,Lote,Elemento,Linea,
         Cantidad,PesoCono,Unidades,Detalle,ClienteProduccion,Destino,
         Grafilado,Abierto,Servicio,Observaciones,
         GeneradoPor,FechaModificado,HoraInicio,HoraFinal,
         TipoPedido,NumeroPedido,OrdenProduccion,LoteOriginal,FechaOriginal)
    VALUES
        (@Fecha,@Maquina,@TurnoHijo,0,@Lote,@Elemento,@LineaHijo,
         @Cantidad,0,NULL,@Serial,@CodCliente,16,
         0,0,0,@TipoTexto,
         @GeneradoPor,GETDATE(),@HoraInicio,@HoraFinal,
         4,NULLIF(@NumeroPedido,''),@OrdenProduccion,@LoteOriginal,@FechaOriginal);

    IF EXISTS (SELECT 1 FROM INVExistencias WHERE Bodega=@BodegaHijo AND Elemento=@Elemento AND Detalle=@Serial)
    BEGIN
        UPDATE INVExistencias SET
            Cantidad = @Cantidad,
            Serie = CASE WHEN @NumeroPedido <> '' THEN @NumeroPedido ELSE Serie END
        WHERE Bodega=@BodegaHijo AND Elemento=@Elemento AND Detalle=@Serial;
    END
    ELSE
    BEGIN
        DECLARE @NuevaLineaInv INT;
        SELECT @NuevaLineaInv = ISNULL(MAX(Linea),0)+1 FROM INVExistencias WHERE Bodega=@BodegaHijo AND Elemento=@Elemento;
        INSERT INTO INVExistencias (Bodega,Elemento,Linea,Cantidad,Unidades,Valor,Detalle,Serie)
        VALUES (@BodegaHijo,@Elemento,@NuevaLineaInv,@Cantidad,0,0,@Serial,NULLIF(@NumeroPedido,''));
    END

    IF @Operario > 0
        INSERT INTO PRDProduccionOperarios (Fecha,Lote,Elemento,Linea,Operario)
        VALUES (@Fecha,@Lote,@Elemento,@LineaHijo,@Operario);
END

-- Espejo en el padre -- SIEMPRE se actualiza, exista o no el hijo antes de este paso.
UPDATE PRDProduccion SET
    NuevoRetal = CASE WHEN @TipoResiduo=1 THEN @Cantidad ELSE NuevoRetal END,
    ResiduoTroquelado = CASE WHEN @TipoResiduo=3 THEN @Cantidad ELSE ResiduoTroquelado END,
    ResiduoNoConforme = CASE WHEN @TipoResiduo=4 THEN @Cantidad ELSE ResiduoNoConforme END
WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;

-- ── PASO 4: movimiento formal INVMovimientos Tipo=35 + INVMovimientosElementos ──────────────────
-- FIX 23/09/2026 (movimientos 24/35 por OT, a pedido del usuario -- mismo criterio que
-- trg_SEL_Bultos_GenerarEntradaInventario y Produccion.vb:ObtenerOCrearMovimientoOT): el hijo va al
-- Tipo 35 de la OT del padre (@OrdenProduccion), buscado por la columna INVMovimientos.OrdenProduccion
-- (sin anulados) y fechado en la línea original de la OT -- ya no al único Tipo 35 del día. Sin OT:
-- el genérico del día, solo entre los que tienen OrdenProduccion NULL. Requiere
-- agregar_ordenproduccion_invmovimientos_23092026.sql.
DECLARE @SubEmpresa INT = 0; -- ajustar si no es 0
DECLARE @NumeroMov35 VARCHAR(20), @FechaMov DATE, @ObsMov NVARCHAR(200);
DECLARE @LineaMov INT = 0;
DECLARE @OT VARCHAR(20) = NULLIF(LTRIM(RTRIM(@OrdenProduccion)), '');

IF @OT IS NOT NULL
BEGIN
    SELECT TOP 1 @NumeroMov35 = Numero, @FechaMov = Fecha
    FROM INVMovimientos
    WHERE Subempresa=@SubEmpresa AND Tipo=35 AND OrdenProduccion=@OT AND ISNULL(Estado,'')<>'Anulado'
    ORDER BY Fecha;
    IF @NumeroMov35 IS NULL
    BEGIN
        SET @FechaMov = @Fecha;
        SELECT TOP 1 @FechaMov = CAST(Fecha AS DATE) FROM PRDOrdenesProduccion WHERE OrdenProduccion=@OT AND Fecha IS NOT NULL;
        -- NCHAR(243) = 'o' con tilde (no depende de la codificación con que se abra el script)
        SET @ObsMov = N'Entrada Producci' + NCHAR(243) + N'n - OT ' + @OT;
    END
END
ELSE
BEGIN
    SET @FechaMov = @Fecha;
    SELECT TOP 1 @NumeroMov35 = Numero
    FROM INVMovimientos
    WHERE Subempresa=@SubEmpresa AND Fecha=@FechaMov AND Tipo=35 AND OrdenProduccion IS NULL;
    SET @ObsMov = N'Generado Autom' + NCHAR(225) + N'ticamente (Selladora)';
END

-- Si el hijo ya tenía línea (se volvió a digitar la cantidad), se quita de CUALQUIER Tipo 35.
DELETE FROM INVMovimientosElementos WHERE Subempresa=@SubEmpresa AND Tipo=35 AND Detalle=@Serial;

IF @NumeroMov35 IS NOT NULL
BEGIN
    SELECT @LineaMov = ISNULL(MAX(Linea),0) FROM INVMovimientosElementos WHERE Subempresa=@SubEmpresa AND Fecha=@FechaMov AND Tipo=35 AND Numero=@NumeroMov35;
END
ELSE
BEGIN
    DECLARE @Consecutivo INT, @FormatoNumero VARCHAR(50), @LineaNum INT, @Concepto VARCHAR(100);
    SELECT TOP 1 @Consecutivo=Consecutivo, @FormatoNumero=FormatoNumero, @LineaNum=Linea
    FROM SISNumeracion
    WHERE TipoMovimiento=35 AND (Subempresa IS NULL OR Subempresa=@SubEmpresa) AND Estado='Activo'
      AND Concepto IS NULL AND Dependencia IS NULL
    ORDER BY Subempresa DESC, FechaDesde;
    IF @Consecutivo IS NULL
    BEGIN
        RAISERROR('No se encontró numeración activa para TipoMovimiento=35.', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END
    IF @FormatoNumero IS NULL OR @FormatoNumero=''
        SET @NumeroMov35 = CAST(@Consecutivo AS VARCHAR(20));
    ELSE
    BEGIN
        DECLARE @PosCero INT = PATINDEX('%0%', @FormatoNumero);
        DECLARE @FmtFecha VARCHAR(20) = CASE WHEN @PosCero>1 THEN LEFT(@FormatoNumero,@PosCero-1) ELSE '' END;
        DECLARE @FmtNum VARCHAR(20) = CASE WHEN @PosCero>0 THEN SUBSTRING(@FormatoNumero,@PosCero,LEN(@FormatoNumero)) ELSE @FormatoNumero END;
        SET @NumeroMov35 = CASE WHEN @FmtFecha<>'' THEN FORMAT(GETDATE(),@FmtFecha) ELSE '' END
                          + RIGHT(REPLICATE('0',LEN(@FmtNum)) + CAST(@Consecutivo AS VARCHAR(20)), LEN(@FmtNum));
    END
    UPDATE SISNumeracion SET Consecutivo=Consecutivo+1 WHERE TipoMovimiento=35 AND Linea=@LineaNum;
    SELECT @Concepto = Concepto FROM SISTiposMovimiento WHERE Codigo=35;
    INSERT INTO INVMovimientos (SubEmpresa,Fecha,Tipo,Numero,Concepto,Tercero,Sucursal,GeneradoPor,Observaciones,FechaModificado,Estado,OrdenProduccion)
    VALUES (@SubEmpresa,@FechaMov,35,@NumeroMov35,@Concepto,0,0,@GeneradoPor,@ObsMov,GETDATE(),'Registrado',@OT);
END

INSERT INTO INVMovimientosElementos (SubEmpresa,Fecha,Tipo,Numero,Linea,Bodega,Elemento,UnidadMedida,Costo,Cantidad,Unidades,Detalle)
SELECT @SubEmpresa, @FechaMov, 35, @NumeroMov35, @LineaMov+1, @BodegaHijo, @Elemento, ie.UnidadMedida, ISNULL(ie.Costo,0), @Cantidad, 0, @Serial
FROM INVElementos ie WHERE ie.Codigo=@Elemento;

COMMIT TRANSACTION;

SELECT @Serial AS SerialHijo, @LineaHijo AS LineaHijo, @NumeroMov35 AS MovimientoTipo35;
