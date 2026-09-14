-- Cantidad de bolsas/unidades que representa CADA paquete pesado individualmente (13/09/2026, a
-- pedido del usuario).
--
-- POR QUE: hoy "Unidades" siempre se calcula como (número de paquetes) x 100 -- una regla fija
-- (ver server.js:UNIDADES_POR_PAQUETE, y trg_SEL_Bultos_CierreBulto, que hace lo mismo al cerrar
-- el bulto). Hay casos reales donde un paquete puntual NO trae 100 bolsas (un resto, un ajuste),
-- y hoy no hay forma de corregir eso -- toda la cuenta asume 100 siempre.
--
-- QUE CAMBIA: cada fila de SEL_PesajeElemento (un paquete) guarda CUÁNTAS unidades representa ESE
-- paquete puntual. El PLC/Node-RED NO necesita saber nada de esto -- su INSERT no menciona esta
-- columna, así que cae en el DEFAULT (100), igual que hoy. Solo cuando el operario usa el botón
-- nuevo "Modificar cantidad de paquetes" (ver server.js) se guarda un valor distinto de 100 para
-- ESE paquete puntual.
--
-- NULLABLE a propósito (no NOT NULL): así el DEFAULT constraint alcanza para las filas nuevas sin
-- tocar el camino de inserción del PLC, y el código en todos lados usa ISNULL(UnidadesPaquete, 100)
-- -- nunca asume que la columna viene llena, ni en filas viejas ni en alguna inserción futura que
-- se le vuelva a olvidar.
--
-- PENDIENTE (fuera de este script, a propósito): trg_SEL_Bultos_CierreBulto todavía calcula
-- Unidades como (paquetes x 100) -- hay que cambiarlo para que sume SEL_PesajeElemento.UnidadesPaquete
-- en vez de multiplicar. NO se toca acá porque esa trigger ya está confirmado que diverge entre
-- carlixplast y carlixplastPrueba (ver subir_a_produccion_sellado_paralelo.sql, punto 1 de su
-- cabecera) y hace falta ver su texto real primero (sp_helptext 'trg_SEL_Bultos_CierreBulto') para
-- no pisar lógica que no se conoce completa.
--
-- Idempotente: se puede correr varias veces sin romper nada.

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
GO

-- Rellena las filas YA EXISTENTES (el DEFAULT constraint solo aplica a filas nuevas que omitan la
-- columna -- las que ya estaban en la tabla antes del ALTER quedan en NULL si no se hace esto).
UPDATE SEL_PesajeElemento SET UnidadesPaquete = 100 WHERE UnidadesPaquete IS NULL;
PRINT 'Filas existentes de SEL_PesajeElemento con UnidadesPaquete NULL -> 100: ' + CAST(@@ROWCOUNT AS VARCHAR);
GO
