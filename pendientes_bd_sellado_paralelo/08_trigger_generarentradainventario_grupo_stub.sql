-- Guarda: crea el trigger vacío SOLO si todavía no existe, para que el ALTER TRIGGER del
-- siguiente archivo (09) siempre encuentre algo que alterar. Si el trigger ya existe (caso
-- normal), esto no hace nada. Correr ANTES del archivo 09.

IF OBJECT_ID('dbo.trg_SEL_Bultos_GenerarEntradaInventario', 'TR') IS NULL
    EXEC('CREATE TRIGGER dbo.trg_SEL_Bultos_GenerarEntradaInventario ON dbo.SEL_Bultos AFTER INSERT AS BEGIN SET NOCOUNT ON; END');
