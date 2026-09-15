-- Correr DESPUES del archivo 10. Un bulto EN CONSTRUCCION (Activo/Temporal/EnEspera) que queda
-- vacío tras un traslado de paquetes vuelve a 'Temporal' en vez de anularse -- antes se anulaba
-- pasara lo que pasara, y la máquina se quedaba sin bulto donde meter el siguiente paquete.
-- Único llamador: dbo.sp_SEL_TrasladarPaquete. Origen: arreglar_traslado_bulto_vacio.sql.

ALTER PROCEDURE dbo.sp_SEL_AnularBultoVacio
    @IdBulto INT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Refsalida INT, @SerialPadre VARCHAR(40), @Estado VARCHAR(20), @Mes INT, @Dia INT;
    SELECT @Refsalida = refsalida, @SerialPadre = serialPadre, @Estado = estado, @Mes = mes, @Dia = dia
    FROM dbo.SEL_Bultos WHERE id = @IdBulto;

    -- El bulto sigue en construcción: no se anula ni se borra su fila reservada en PRDProduccion.
    -- Un 'Activo' vaciado vuelve a 'Temporal'; un 'EnEspera' (referencia parqueada del sellado en
    -- paralelo) se queda como está, para no dejar dos bultos Activo/Temporal en la misma máquina.
    IF @Estado IN ('Activo', 'Temporal', 'EnEspera')
    BEGIN
        IF @Estado = 'Activo'
            UPDATE dbo.SEL_Bultos SET estado = 'Temporal' WHERE id = @IdBulto;
        RETURN;
    END

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
        -- bulto anulado lo tenía: se traslada al que pasa a ser el nuevo "último bulto Cerrado".
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
        END

        DELETE FROM dbo.PRDProduccion WHERE Detalle = @SerialPadre;
    END
    ELSE
    BEGIN
        DELETE FROM dbo.PRDProduccion WHERE Detalle = @SerialPadre;
    END

    UPDATE dbo.SEL_Bultos SET estado = 'Anulado' WHERE id = @IdBulto;
END
