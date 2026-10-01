-- ===== NODO NODE-RED: PESAJE DE PAQUETE =====
-- Copia canónica 27/09/2026 de agregar_unidadespaquete_referencia_pesaje_21092026.sql (última versión).
-- Parámetros que pone Node-RED: @maquina, @peso, @golpes, @potencia. Ver LEEME.md.

-- Corrección del script que registra el pesaje de un paquete (Node-RED/PLC, no vive en este repo --
-- se entrega aquí como script para copiarlo a donde esté corriendo hoy, mismo criterio que
-- fix_serial_hijo_pesaje_elemento.sql).
--
-- PROBLEMA: el INSERT no menciona UnidadesPaquete -- se queda con el DEFAULT 100 fijo de la
-- columna, sin importar la referencia real que se está empacando.
-- FIX: "Unidades por Paquete" ya existe como campo de la referencia en el Administrador de
-- Elementos (Referencia.vb, txtUnidadesPorPaquete, Tag=18) -- se guarda en
-- INVElementosReferencia (Elemento, Categoria=18, Valor), mismo modelo genérico que ya usan
-- Troquelado (4), Tipo Impresión (13) y Perforaciones (17). Se resuelve ANTES del INSERT (igual
-- que ya se hace con @Detalle) y se manda explícito -- si la referencia no tiene ese campo
-- diligenciado, cae al 100 de siempre (no se pierde el comportamiento actual).
--
-- Ejecutar manualmente donde corresponda (reemplaza la versión anterior de este mismo script).

DECLARE @Resultado TABLE (
    id_paquete INT,
    id_bulto INT,
    PesoPaqueGr NUMERIC(10,3),
    FechaHora DATETIME,
    ConsecutivoPaquete INT,
    Golpes INT,
    Potencia DECIMAL(10,3),
    Detalle VARCHAR(40),
    UnidadesPaquete INT
);
DECLARE @IdBulto INT, @NuevoConsecutivo INT;
DECLARE @SerialPadre VARCHAR(40);
DECLARE @Elemento INT;

SELECT TOP 1 @IdBulto = b.id, @NuevoConsecutivo = b.number_paqu + 1, @SerialPadre = b.SerialPadre,
       @Elemento = b.refsalida
FROM SEL_Bultos b WITH (UPDLOCK, ROWLOCK)
WHERE b.id_maquina = @maquina AND b.estado IN ('Activo', 'Temporal')
ORDER BY b.id DESC;

IF @IdBulto IS NULL
BEGIN
    RAISERROR('No hay bulto activo para la maquina', 16, 1);
    RETURN;
END

-- LIMITE DE PAQUETES (01/10/2026): el consecutivo del paquete va en las posiciones 5-6 del serial
-- (STUFF de abajo), así que el máximo es 99. Con el 100, CAST(100 AS VARCHAR(2)) da '*' y el serial
-- salía dañado (20260*...). Ahora NO se guarda el paquete ni sube el contador: se devuelve la misma
-- fila de siempre con Resultado = 'LIMITE_PAQUETES', SerialHijo NULL y el Mensaje para el operario.
-- Node-RED: si Resultado <> 'OK' NO imprime la etiqueta y avisa al Node
-- (POST /api/selladora/aviso-pesaje, ver LEEME.md de esta carpeta).
IF @NuevoConsecutivo > 99
BEGIN
    SELECT
        b.SerialPadre,
        @NuevoConsecutivo - 1 AS number_paqu,
        CAST(NULL AS VARCHAR(40)) AS SerialHijo,
        i.referencia,
        b.numeroPedido,
        @peso      AS PesoPesaje,
        GETDATE()  AS HoraPesaje,
        @golpes    AS Golpes,
        @potencia  AS Potencia,
        CAST(NULL AS INT) AS UnidadesPaquete,
        'LIMITE_PAQUETES' AS Resultado,
        'El bulto ' + ISNULL(b.SerialPadre, '') + ' llegó al límite de 99 paquetes. Cierre el bulto y vuelva a pesar este paquete.' AS Mensaje
    FROM SEL_Bultos AS b
    INNER JOIN invelementos AS i ON i.codigo = b.refsalida
    WHERE b.id = @IdBulto;
    RETURN;
END

UPDATE SEL_Bultos
SET number_paqu = @NuevoConsecutivo
WHERE id = @IdBulto;

-- Mismo cálculo que ya usaba el SELECT de referencia (SerialHijo) -- ahora se hace ANTES del
-- INSERT para poder guardarlo, en vez de recalcularlo después vía JOIN.
DECLARE @Detalle VARCHAR(40) = STUFF(@SerialPadre, 5, 2, RIGHT('00' + CAST(@NuevoConsecutivo AS VARCHAR(2)), 2));

-- "Unidades por Paquete" de la referencia (Administrador de Elementos, Categoria 18) -- 100 si no
-- está diligenciado o no es numérico, mismo respaldo que ya usa PesajeElemento por defecto.
DECLARE @UnidadesPaquete INT = 100;
SELECT TOP 1 @UnidadesPaquete = CAST(Valor AS INT)
FROM INVElementosReferencia
WHERE Elemento = @Elemento AND Categoria = 18 AND ISNUMERIC(Valor) = 1;

INSERT INTO SEL_PesajeElemento
    (PesoPaqueGr, id_bulto, ConsecutivoPaquete, FechaHora, Golpes, Potencia, Detalle, UnidadesPaquete)
OUTPUT INSERTED.id_paquete, INSERTED.id_bulto, INSERTED.PesoPaqueGr,
       INSERTED.FechaHora, INSERTED.ConsecutivoPaquete, INSERTED.Golpes, INSERTED.Potencia,
       INSERTED.Detalle, INSERTED.UnidadesPaquete
INTO @Resultado
VALUES (@peso, @IdBulto, @NuevoConsecutivo, GETDATE(), @golpes, @potencia, @Detalle, @UnidadesPaquete);

-- SELECT final -- igual que antes, con UnidadesPaquete agregado por si el PLC/Node-RED lo quiere
-- mostrar o loguear.
-- 01/10/2026: SerialHijo se lee de SEL_PesajeElemento (no de @Resultado): si el primer paquete llegó
-- después del umbral, trg_SEL_PesajeElemento_ActualizarBulto re-estampó el bulto y su serial, y
-- @Resultado trae el serial de antes del trigger.
SELECT
    b.SerialPadre,
    r.ConsecutivoPaquete AS number_paqu,
    pe.Detalle AS SerialHijo,
    i.referencia,
    b.numeroPedido,
    r.PesoPaqueGr AS PesoPesaje,
    r.FechaHora   AS HoraPesaje,
    r.Golpes,
    r.Potencia,
    r.UnidadesPaquete,
    'OK' AS Resultado,                 -- 01/10/2026: ver LIMITE DE PAQUETES arriba
    CAST(NULL AS VARCHAR(200)) AS Mensaje
FROM @Resultado r
INNER JOIN SEL_PesajeElemento AS pe ON pe.id_paquete = r.id_paquete
INNER JOIN SEL_Bultos AS b ON b.id = r.id_bulto
INNER JOIN invelementos AS i ON i.codigo = b.refsalida;
