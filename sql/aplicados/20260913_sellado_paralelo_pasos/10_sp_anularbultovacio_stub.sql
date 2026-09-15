-- Guarda: crea el procedimiento vacío SOLO si todavía no existe. Correr ANTES del archivo 11.

IF OBJECT_ID('dbo.sp_SEL_AnularBultoVacio', 'P') IS NULL
    EXEC('CREATE PROCEDURE dbo.sp_SEL_AnularBultoVacio @IdBulto INT AS BEGIN SET NOCOUNT ON; END');
