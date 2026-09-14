-- Cantidad de bolsas/unidades que representa CADA paquete pesado individualmente ("Modificar
-- cantidad de bolsas"). NULLABLE a propósito -- el código en todos lados usa
-- ISNULL(UnidadesPaquete, 100). El PLC/Node-RED no necesita saber nada de esto, su INSERT no
-- menciona esta columna y cae en el DEFAULT. Idempotente. Origen: agregar_unidadespaquete_pesajeelemento.sql.

IF COL_LENGTH('SEL_PesajeElemento', 'UnidadesPaquete') IS NULL
BEGIN
    ALTER TABLE SEL_PesajeElemento
        ADD UnidadesPaquete INT NULL
        CONSTRAINT DF_SEL_PesajeElemento_UnidadesPaquete DEFAULT (100);

    PRINT 'SEL_PesajeElemento.UnidadesPaquete agregada (DEFAULT 100).';
END
ELSE
BEGIN
    PRINT 'SEL_PesajeElemento.UnidadesPaquete ya existía -- nada que hacer.';
END
