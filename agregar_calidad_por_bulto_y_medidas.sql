-- Chequeo de Calidad: por bulto y con las medidas de la bolsa (pedido del usuario, 11/09/2026).
--
-- Dos cambios que viven en la misma tabla, por eso van en un solo script:
--
--   A) YA NO SALE CADA MEDIA HORA. El chequeo aparece en el PRIMER PAQUETE de cada bulto y una
--      sola vez por bulto. Quien lo decide ahora es el servidor (GET /calidad-pendiente en
--      server.js): el bulto que esta recibiendo paquetes ya tiene alguno pesado y todavia no tiene
--      fila en SEL_ChequeoCalidad. O sea: la fila del chequeo ES la marca de "este bulto ya se
--      reviso". Consecuencia -> la columna SEL_EjecucionOrden.ProximaCalidad (que guardaba la hora
--      del proximo chequeo aleatorio, ver agregar_proximacalidad_ejecucionorden.sql) queda SIN USO.
--      No se borra en este script: dejarla vacia no molesta a nadie y borrar una columna de una
--      tabla que tambien usa el escritorio no vale la pena por ahorrar 8 bytes. Si algun dia se
--      quiere limpiar, es un simple:
--          ALTER TABLE SEL_EjecucionOrden DROP COLUMN ProximaCalidad;
--
--   B) PREGUNTAS DE MEDIDA. Al chequeo se le agrego un apartado "Medidas" con una pregunta por
--      cada medida que la referencia realmente tenga, redactada con su valor y su unidad:
--          "¿El ancho de la bolsa es de 10 pulgadas?"   -> Conforme / No conforme
--      Las medidas NO estan en SEL_OrdenProduccion: son filas de INVElementosReferencia
--      (Elemento + Categoria + Valor), con el catalogo de categorias en INVReferenciaCategoria:
--          5 Ancho · 6 Fuelle Izquierdo · 7 Fuelle Derecho · 8 Alto · 9 Fuelle Superior (la
--          "solapa") · 10 Fuelle Fondo · 16 Medida = la UNIDAD de todas ellas (PUL/CM/MT/KG).
--      Un valor en 0 ('00.00') significa que la bolsa no lleva ese fuelle/solapa y esa pregunta no
--      se hace -- por eso el apartado cambia de una referencia a otra. La consulta de apoyo es:
--          SELECT er.Categoria, rc.Nombre, er.Valor
--          FROM INVElementosReferencia er
--          INNER JOIN INVReferenciaCategoria rc ON rc.Codigo = er.Categoria
--          WHERE er.Elemento = <elemento> AND er.Categoria IN (5,6,7,8,9,10,16);
--
-- Es IDEMPOTENTE: se puede correr varias veces y sobre las dos bases (carlixplast /
-- carlixplastPrueba) sin romper nada.

-- 1. Las dos tablas del chequeo -------------------------------------------------------------
--
-- Existen desde antes en Carlixplast (produccion), pero NO en CarlixplastPrueba -- por eso alli el
-- chequeo se respondia y no quedaba guardado en ninguna parte, y ahora ademas el aviso no saldria
-- nunca (sin la tabla no hay forma de saber que bultos ya se revisaron, ver el catch de
-- /calidad-pendiente). Se crean solo si faltan; donde ya existan, este bloque no las toca.
--
-- El CREATE es CALCADO del esquema real de produccion (leido el 11/09/2026), no una aproximacion:
-- mismos tipos, mismos anchos, mismos NOT NULL y el mismo default de Origen. Si se escribiera "a
-- ojo", Prueba y produccion se irian separando y un INSERT que funciona probando fallaria en
-- planta -- justo lo que hay que evitar, porque el guardado del chequeo va dentro de un try/catch
-- que solo escribe en consola.

IF OBJECT_ID('SEL_ChequeoCalidad', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_ChequeoCalidad (
    IdChequeo INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    id_ejecucion INT NOT NULL,
    -- El bulto que se estaba llenando cuando se respondio. Es la marca de "este bulto ya se
    -- reviso": /calidad-pendiente no vuelve a pedir el chequeo de un bulto que ya tenga fila aca.
    id_bulto INT NULL,
    Operario INT NOT NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE(),
    -- server.js NO escribe esta columna: se apoya en el default. Existe en produccion desde el
    -- diseno original del chequeo y hoy todas sus filas dicen 'Automatico'.
    Origen VARCHAR(20) NOT NULL DEFAULT 'Automatico'
  );

  CREATE INDEX IX_SEL_ChequeoCalidad_Bulto ON SEL_ChequeoCalidad (id_bulto);
  CREATE INDEX IX_SEL_ChequeoCalidad_Ejecucion ON SEL_ChequeoCalidad (id_ejecucion, FechaHora);
END;
GO

IF OBJECT_ID('SEL_ChequeoCalidadDetalle', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_ChequeoCalidadDetalle (
    IdDetalle INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    IdChequeo INT NOT NULL,
    -- Apartado del modal: 'Medidas', 'Película', 'Deslizamiento', 'Impresión', 'Sellado',
    -- 'Accesorios', 'Troquelado/Perforaciones' (ver construirApartadosCalidad en server.js).
    Apartado VARCHAR(30) NOT NULL,
    -- La CLAVE de la pregunta, no su texto ('color_pelicula', 'sellado_fisuras', 'medida_ancho'…).
    Pregunta VARCHAR(40) NOT NULL,
    Respuesta VARCHAR(15) NOT NULL,
    -- Solo en las preguntas de medida: contra que se comparo ("10 pulgadas"). Ver el bloque 3.
    ValorEsperado VARCHAR(60) NULL,
    CONSTRAINT CK_SEL_ChequeoCalidadDetalle_Respuesta CHECK (Respuesta IN ('Conforme', 'NoConforme')),
    CONSTRAINT FK_SEL_ChequeoCalidadDetalle_Chequeo FOREIGN KEY (IdChequeo)
      REFERENCES SEL_ChequeoCalidad (IdChequeo)
  );

  CREATE INDEX IX_SEL_ChequeoCalidadDetalle_Chequeo ON SEL_ChequeoCalidadDetalle (IdChequeo);
END;
GO

-- 2. Fuera el CHECK que enumeraba las preguntas ---------------------------------------------
--
-- En produccion existe CK_SEL_ChequeoCalidadDetalle_Pregunta, con la lista fija de las 11 preguntas
-- de entonces (color_pelicula, deslizamiento, impresion_*, sellado_*, accesorios_*, troquelado_*,
-- perforaciones_cantidad). El cursor lo busca por su DEFINICION y no por su nombre, para que sirva
-- igual si en alguna base se llamara distinto o hubiera tambien uno sobre Apartado. Las claves de medida ('medida_ancho', 'medida_solapa', …) no estan en
-- esa lista, asi que el INSERT del detalle fallaria -- y encima en silencio, porque en
-- POST /api/comando el guardado del chequeo va dentro de un try/catch que solo escribe en consola.
-- Ese CHECK ya no puede seguir existiendo: el apartado "Medidas" es dinamico y su juego de
-- preguntas depende de la referencia, no hay lista fija que enumerar. La validacion de que se
-- respondio todo sigue estando donde importa: el modal no deja guardar con preguntas en blanco
-- (preConfirm en abrirCalidad) y el servidor descarta cualquier clave que no corresponda a esa
-- orden (claveApartado en registrarChequeoCalidad). El CHECK de Respuesta se queda como esta.
DECLARE @constraint SYSNAME, @sql NVARCHAR(500);
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT cc.name
  FROM sys.check_constraints cc
  WHERE cc.parent_object_id = OBJECT_ID('SEL_ChequeoCalidadDetalle')
    AND (cc.definition LIKE '%[[]Pregunta]%' OR cc.definition LIKE '%[[]Apartado]%');
OPEN cur;
FETCH NEXT FROM cur INTO @constraint;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @sql = 'ALTER TABLE SEL_ChequeoCalidadDetalle DROP CONSTRAINT ' + QUOTENAME(@constraint);
  PRINT @sql;
  EXEC sp_executesql @sql;
  FETCH NEXT FROM cur INTO @constraint;
END;
CLOSE cur;
DEALLOCATE cur;
GO

-- 3. ValorEsperado --------------------------------------------------------------------------
--
-- Guarda contra que se comparo la medida ese dia ("10 pulgadas"). Sin el, dentro de unos meses la
-- fila 'medida_ancho | Conforme' no diria nada: la referencia pudo haber cambiado de medida en
-- INVElementosReferencia desde entonces y el registro tiene que sostenerse solo. Queda NULL en las
-- preguntas que no son de medida.
IF COL_LENGTH('SEL_ChequeoCalidadDetalle', 'ValorEsperado') IS NULL
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ADD ValorEsperado VARCHAR(60) NULL;
END;
GO

-- 4. Por si la columna Pregunta quedo corta -------------------------------------------------
--
-- La clave mas larga de las nuevas es 'medida_fuelle_izquierdo' (23 caracteres). En produccion la
-- columna es VARCHAR(40), asi que alcanza de sobra y este bloque no hace nada alli: solo cubre el
-- caso de una base donde la columna se hubiera creado mas corta. No se ensancha por ensanchar --
-- cambiarle el tipo a una columna de produccion sin necesidad es riesgo regalado.
IF COL_LENGTH('SEL_ChequeoCalidadDetalle', 'Pregunta') < 40
BEGIN
  ALTER TABLE SEL_ChequeoCalidadDetalle ALTER COLUMN Pregunta VARCHAR(40) NOT NULL;
END;
