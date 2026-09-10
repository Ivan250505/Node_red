/* ============================================================================
   FIX 10/09/2026 -- Traslado de paquetes: un bulto EN CONSTRUCCION que queda
   vacio NO se anula.

   El caso: al operario le trasladaron TODOS los paquetes de su bulto Activo a
   un bulto ya Cerrado. sp_SEL_TrasladarPaquete ve el origen sin paquetes y
   llama a sp_SEL_AnularBultoVacio, que lo marcaba 'Anulado' pasara lo que
   pasara. Resultado: la maquina se queda SIN bulto donde meter el siguiente
   paquete (el PLC resuelve por id_maquina + estado IN ('Activo','Temporal'),
   ver insert_pesaje_elemento.sql) y la pagina de bultos deja de mostrarlo
   (obtenerBultosYPesajes excluye 'Anulado').

   Lo correcto es que vuelva a 'Temporal': un bulto abierto sin paquetes
   pesados, que es exactamente lo que quedo. 'Anulado' se reserva para el bulto
   que ya estaba 'Cerrado' -- ese si hay que deshacerlo (produccion,
   existencias y movimientos), y de eso se sigue encargando el mismo
   procedimiento tal como estaba.

   'EnEspera' se respeta tal cual: es el bulto parqueado de otra referencia del
   mismo pedido (sellado en paralelo). Volverlo 'Temporal' dejaria DOS bultos
   Activo/Temporal en la misma maquina y el PLC podria escoger el equivocado.

   Cambia UN SOLO procedimiento: dbo.sp_SEL_AnularBultoVacio. Su unico llamador
   es dbo.sp_SEL_TrasladarPaquete (verificado en sys.sql_modules).

   Idempotente: se puede ejecutar las veces que sea, en las dos bases.
   ============================================================================ */

IF OBJECT_ID('dbo.sp_SEL_AnularBultoVacio', 'P') IS NULL
    EXEC('CREATE PROCEDURE dbo.sp_SEL_AnularBultoVacio @IdBulto INT AS BEGIN SET NOCOUNT ON; END');
GO

ALTER PROCEDURE dbo.sp_SEL_AnularBultoVacio
    @IdBulto INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Refsalida INT, @SerialPadre VARCHAR(40), @Estado VARCHAR(20), @Mes INT, @Dia INT;
    SELECT @Refsalida = refsalida, @SerialPadre = serialPadre, @Estado = estado, @Mes = mes, @Dia = dia
    FROM dbo.SEL_Bultos WHERE id = @IdBulto;

    /* ----- NUEVO (10/09/2026): el bulto sigue en construccion -----------------
       No se anula ni se borra su fila reservada en PRDProduccion (Cantidad=0,
       la crea trg_SEL_Bultos_CierreBulto al abrirlo): el bulto va a seguir
       recibiendo paquetes. Un 'Activo' vaciado vuelve a 'Temporal'; un
       'EnEspera' (referencia parqueada del sellado en paralelo) se queda como
       esta, para no dejar dos bultos Activo/Temporal en la misma maquina. */
    IF @Estado IN ('Activo', 'Temporal', 'EnEspera')
    BEGIN
        IF @Estado = 'Activo'
            UPDATE dbo.SEL_Bultos SET estado = 'Temporal' WHERE id = @IdBulto;
        RETURN;
    END
    /* ------------------------------------------------------------------------ */

    IF @Estado = 'Cerrado'
    BEGIN
        DECLARE @Lote VARCHAR(6) = RIGHT('0' + CAST(@Mes AS VARCHAR(2)), 2) + RIGHT('0' + CAST(@Dia AS VARCHAR(2)), 2);
        DECLARE @Bodega VARCHAR(20);
        SELECT TOP 1 @Bodega = Bodega
        FROM dbo.PRDProduccionMateriaPrima
        WHERE Lote = @Lote AND Elemento = @Refsalida AND Bodega IS NOT NULL
        ORDER BY Linea DESC;

        IF @Bodega IS NOT NULL
        BEGIN
            DECLARE @NumeroMov35 VARCHAR(20);
            SELECT @NumeroMov35 = Numero FROM dbo.INVMovimientos
            WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35;

            IF @NumeroMov35 IS NOT NULL
            BEGIN
                DELETE FROM dbo.INVMovimientosLotes
                WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35
                  AND Numero = @NumeroMov35 AND Lote = @SerialPadre;

                DELETE FROM dbo.INVMovimientosElementos
                WHERE Subempresa = 0 AND Fecha = CAST(GETDATE() AS date) AND Tipo = 35
                  AND Numero = @NumeroMov35 AND Detalle = @SerialPadre;
            END

            DELETE FROM dbo.INVExistencias
            WHERE Bodega = @Bodega AND Elemento = @Refsalida AND Detalle = @SerialPadre;
        END

        -- Preservar Retal (Merma calculada por SEL_InventarioMP.vb:RecalcularMermaSellado) si el
        -- bulto anulado lo tenía: esa rutina escribe la merma en PRDProduccion.Retal del "último
        -- bulto Cerrado" de TODA la orden (todas sus ejecuciones, no solo esta) -- si ese resulta
        -- ser justo el bulto que este traslado vació, borrar su fila de PRDProduccion sin más
        -- perdería ese valor ya calculado sin ningún rastro. Se traslada al que pasa a ser el nuevo
        -- "último bulto Cerrado" en su lugar (mismo criterio ORDER BY num_bulto que usa esa rutina).
        DECLARE @RetalPerdido NUMERIC(12,4);
        SELECT @RetalPerdido = Retal FROM dbo.PRDProduccion WHERE Detalle = @SerialPadre;

        IF @RetalPerdido IS NOT NULL AND @RetalPerdido <> 0
        BEGIN
            DECLARE @IdOrdenAnulado INT;
            SELECT @IdOrdenAnulado = eo.IdOrden
            FROM dbo.SEL_Bultos b
            INNER JOIN dbo.SEL_EjecucionOrden eo ON eo.IdEjecucion = b.id_ejecucion
            WHERE b.id = @IdBulto;

            DECLARE @SerialPadreNuevoUltimo VARCHAR(40);
            SELECT TOP 1 @SerialPadreNuevoUltimo = b2.serialPadre
            FROM dbo.SEL_Bultos b2
            INNER JOIN dbo.SEL_EjecucionOrden eo2 ON eo2.IdEjecucion = b2.id_ejecucion
            WHERE eo2.IdOrden = @IdOrdenAnulado AND b2.estado = 'Cerrado' AND b2.id <> @IdBulto
            ORDER BY b2.num_bulto DESC;

            IF @SerialPadreNuevoUltimo IS NOT NULL
                UPDATE dbo.PRDProduccion SET Retal = ISNULL(Retal, 0) + @RetalPerdido
                WHERE Detalle = @SerialPadreNuevoUltimo;
            -- Si no queda ningún otro bulto Cerrado en la orden, no hay dónde migrarlo -- se pierde
            -- (caso extremo: el único bulto Cerrado de toda la orden se vació por completo).
        END

        DELETE FROM dbo.PRDProduccion WHERE Detalle = @SerialPadre;
    END
    ELSE
    BEGIN
        -- Cualquier otro estado que no sea de construccion ni 'Cerrado' (hoy: 'Suspendido').
        -- La única huella es la fila reservada en PRDProduccion en Cantidad=0 (ver
        -- trg_SEL_Bultos_CierreBulto, reserva de PRDProduccion al abrir el bulto).
        DELETE FROM dbo.PRDProduccion WHERE Detalle = @SerialPadre;
    END

    UPDATE dbo.SEL_Bultos SET estado = 'Anulado' WHERE id = @IdBulto;
END
GO
