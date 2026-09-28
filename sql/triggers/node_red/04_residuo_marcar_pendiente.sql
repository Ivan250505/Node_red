-- ===== NODO NODE-RED: MARCAR RESIDUO PENDIENTE (sin cantidad, la confirma el digitador) =====
-- Copia canónica 27/09/2026 de marcar_residuo_hijo_pendiente_nodered.sql (versión 01/09).
-- Se quitó la línea 'USE carlixplastPrueba;' del original: la base la define la conexión del nodo.
-- Parámetros que pone Node-RED: @maquina, @tipoResiduo. Ver LEEME.md.

-- Generado 01/09/2026 -- referencia para Node-RED (el mecatrónico): al presionar Retal/Troquelado/
-- No Conforme SIN digitar cantidad todavía (marca el hijo como pendiente, Cantidad=0 placeholder,
-- para que el digitador lo confirme después en Registro de Residuos). Migrado 1:1 desde
-- SEL_InventarioMP.vb:MarcarResiduoHijoPendiente. Correcciones sobre el script que ya tenías
-- (3 bugs reales, ver detalle en cada punto abajo) -- el resto (idempotencia, duplicar Turno/
-- Cliente/HoraInicio del padre en vez de re-derivar) ya estaba bien, se dejó igual.
--
-- Parámetros de entrada (los sustituye Node-RED, NO son valores de prueba):
--   @maquina      -- PRDMaquinas.Codigo de la máquina que dispara el evento
--   @tipoResiduo  -- 1=Retal, 3=Troquelado, 4=No Conforme (2=Refilado NO aplica a Selladora)


DECLARE @IdBulto INT, @Agno INT, @Mes INT, @Dia INT, @Elemento INT;
DECLARE @Fecha DATE, @Lote CHAR(4), @LineaPadre INT, @LineaHijo INT, @IdOrdenEj INT;
-- FIX 1: faltaba la longitud -- VARCHAR a secas es VARCHAR(1), truncaba cualquier pedido real.
DECLARE @NumeroPedido VARCHAR(20), @Operario INT, @Turno VARCHAR(10), @ClienteProduccion INT;
DECLARE @HoraInicio DATETIME, @HoraFinal DATETIME, @generadoPor INT;

-- 1. Bulto activo por maquina, bloqueado -- mismo criterio que SEL_PesajeElemento
SELECT TOP 1
    @IdBulto = b.id, @Agno = b.agno, @Mes = b.mes, @Dia = b.dia,
    @Elemento = b.refsalida, @LineaPadre = b.num_bulto,
    @NumeroPedido = b.NumeroPedido, @IdOrdenEj = ej.IdOrden, @Operario = ej.Operario
FROM dbo.SEL_Bultos b WITH (UPDLOCK, ROWLOCK)
INNER JOIN dbo.SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
WHERE b.id_maquina = @maquina AND b.estado IN ('Activo', 'Temporal')
ORDER BY b.id DESC;

IF @IdBulto IS NULL
BEGIN
    RAISERROR('No hay bulto activo para la maquina', 16, 1);
    RETURN;
END

-- 1b. Operario actual de la maquina (SEL_OperarioActualMaquina, misma tabla que usa el aviso de
--     relevo en la pagina de Informacion) -> @generadoPor. Si la maquina no tiene operario
--     asignado todavia, se deja en 0 -- no bloquea el resto del flujo.
SELECT TOP 1 @generadoPor = Operario
FROM SEL_OperarioActualMaquina
WHERE Maquina = CAST(@maquina AS VARCHAR(20));

IF @generadoPor IS NULL SET @generadoPor = 0;

SET @Fecha = DATEFROMPARTS(@Agno, @Mes, @Dia);
SET @Lote  = RIGHT('0' + CAST(@Mes AS VARCHAR(2)), 2) + RIGHT('0' + CAST(@Dia AS VARCHAR(2)), 2);
-- @tipoResiduo=1 -> Retal (ej. 1001), 3 -> Troquelado (3001), 4 -> No conforme (4001)
SET @LineaHijo = @LineaPadre + 1000 * @tipoResiduo;

-- 2. Idempotente: si el hijo ya existe, devolver su Serial (no solo un texto) y salir
IF EXISTS (SELECT 1 FROM PRDProduccion WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaHijo)
BEGIN
    SELECT Detalle AS SerialHijo, Linea AS LineaHijo, Observaciones AS Tipo, 'YaMarcado' AS Resultado
    FROM PRDProduccion
    WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaHijo;
    RETURN;
END

-- 3. Duplicar del PADRE lo que ya esta resuelto en PRDProduccion (Turno/Cliente/HoraInicio) --
--    evita re-derivar con ResolverTurnoPorHora/ResolverClienteDestino (fuente de los bugs anteriores).
--    FIX 3: HoraFinal ya NO se duplica del padre -- se fija abajo con el instante de creacion del
--    hijo (a pedido del usuario, 31/08/2026 -- mismo criterio ya aplicado en Mirane).
SELECT TOP 1 @Turno = Turno, @ClienteProduccion = ClienteProduccion, @HoraInicio = HoraInicio
FROM PRDProduccion
WHERE Fecha=@Fecha AND Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;

IF @Turno IS NULL
BEGIN
    RAISERROR('No se encontro la fila padre en PRDProduccion para este bulto -- no se puede duplicar su informacion.', 16, 1);
    RETURN;
END

SET @HoraFinal = GETDATE();

-- 4. Bodega del hijo: PRDProduccionMateriaPrima, anclada a LineaOriginal (primer bulto de la
--    ejecucion), sin filtro de Fecha (Lote+Elemento+Linea alcanza -- fix del 26/08).
DECLARE @LineaOriginal INT, @DetalleMP VARCHAR(50), @BodegaHijo VARCHAR(10);

SELECT @LineaOriginal = MIN(b2.num_bulto)
FROM SEL_Bultos b2 INNER JOIN SEL_EjecucionOrden ej2 ON ej2.IdEjecucion = b2.id_ejecucion
WHERE ej2.IdOrden = @IdOrdenEj;
IF @LineaOriginal IS NULL SET @LineaOriginal = @LineaPadre;

SELECT TOP 1 @DetalleMP = Detalle FROM PRDProduccionMateriaPrima
WHERE Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaOriginal;

IF @DetalleMP IS NOT NULL
BEGIN
    SELECT TOP 1 @BodegaHijo = Bodega FROM INVExistencias WHERE Detalle = @DetalleMP;
    IF @BodegaHijo IS NULL
        SELECT TOP 1 @BodegaHijo = Bodega FROM INVMovimientosElementos WHERE Tipo = 24 AND Detalle = @DetalleMP;
END

IF @BodegaHijo IS NULL
BEGIN
    RAISERROR('No se pudo determinar la bodega para el registro hijo -- verifique que el proceso tenga materia prima registrada.', 16, 1);
    RETURN;
END

-- 5. Serial del hijo -- mismo formato que Node/VB: Agno(4)+Lote(6)+Linea(4)+Elemento(5)
DECLARE @Serial VARCHAR(19) =
    CAST(YEAR(@Fecha) AS VARCHAR(4)) +
    RIGHT('000000' + CAST(CAST(@Lote AS INT) AS VARCHAR(6)), 6) +
    RIGHT('0000' + CAST(@LineaHijo AS VARCHAR(4)), 4) +
    RIGHT('00000' + CAST(@Elemento AS VARCHAR(5)), 5);

DECLARE @TipoTexto VARCHAR(20) = CASE @tipoResiduo
    WHEN 1 THEN 'RETAL'
    WHEN 2 THEN 'REFILADO'
    WHEN 3 THEN 'TROQUELADO'
    WHEN 4 THEN 'NO_CONFORME'
    ELSE 'DESCONOCIDO'
END;

BEGIN TRANSACTION;

-- 6. INSERT hijo -- Cantidad=0 (placeholder, el digitador la corrige despues en Mirane)
-- FIX 2: @NumeroPedido ya es texto (SEL_Bultos.NumeroPedido es VARCHAR(20) desde el ALTER de
-- esta semana) -- comparar contra "> 0" revienta con un pedido alfanumerico como "A0003"
-- ("Conversion failed converting the varchar value 'A0003' to int"). Se compara contra vacio/NULL.
INSERT INTO PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea,
    Cantidad, PesoCono, Unidades, Detalle, ClienteProduccion, Destino,
    Grafilado, Abierto, Servicio, Observaciones,
    GeneradoPor, FechaModificado, HoraInicio, HoraFinal,
    TipoPedido, NumeroPedido)
VALUES (@Fecha, @maquina, @Turno, 0, @Lote, @Elemento, @LineaHijo,
    0, 0, NULL, @Serial, @ClienteProduccion, 16,
    0, 0, 0, @TipoTexto,
    @generadoPor, GETDATE(), @HoraInicio, @HoraFinal,
    4, CASE WHEN @NumeroPedido IS NOT NULL AND @NumeroPedido <> '' THEN @NumeroPedido ELSE NULL END);

-- 7. Existencia placeholder del hijo, Cantidad=0
DECLARE @NuevaLineaInv INT;
SELECT @NuevaLineaInv = ISNULL(MAX(Linea),0)+1 FROM INVExistencias WHERE Bodega=@BodegaHijo AND Elemento=@Elemento;
INSERT INTO INVExistencias (Bodega, Elemento, Linea, Cantidad, Unidades, Valor, Detalle, Serie)
VALUES (@BodegaHijo, @Elemento, @NuevaLineaInv, 0, 0, 0, @Serial,
    CASE WHEN @NumeroPedido IS NOT NULL AND @NumeroPedido <> '' THEN @NumeroPedido ELSE NULL END);

-- 8. Espejo en el PADRE en 0 -- nota: en VB (MarcarResiduoHijoPendiente) esto NO se toca todavia
-- (el espejo real se escribe solo cuando el digitador confirma el valor, GenerarResiduoHijoSellado)
-- -- pero como acá siempre queda en 0 en este punto, es inofensivo dejarlo (incluido tal cual
-- ya lo tenías). NoConforme (4) ya tiene columna propia (ResiduoNoConforme, agregada este mes).
IF @tipoResiduo = 1
    UPDATE PRDProduccion SET NuevoRetal = 0
    WHERE Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;
ELSE IF @tipoResiduo = 2
    UPDATE PRDProduccion SET ResiduoRefilado = 0
    WHERE Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;
ELSE IF @tipoResiduo = 3
    UPDATE PRDProduccion SET ResiduoTroquelado = 0
    WHERE Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;
ELSE IF @tipoResiduo = 4
    UPDATE PRDProduccion SET ResiduoNoConforme = 0
    WHERE Lote=@Lote AND Elemento=@Elemento AND Linea=@LineaPadre;

-- 9. Operario del hijo
IF @Operario > 0
    INSERT INTO PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario)
    VALUES (@Fecha, @Lote, @Elemento, @LineaHijo, @Operario);

COMMIT TRANSACTION;

SELECT @Serial AS SerialHijo, @LineaHijo AS LineaHijo, @BodegaHijo AS Bodega, @TipoTexto AS Tipo;
