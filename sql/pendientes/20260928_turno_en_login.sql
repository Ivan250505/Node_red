-- =====================================================================================================
-- Turno escogido en el LOGIN de la tableta (reunión 28/09/2026).
-- Agrega a SISAccesos el turno que el operario escogió al entrar y la máquina de la tableta fija:
--   Turno   SMALLINT NULL  -> NOMTurnos.Codigo escogido en el desplegable del login
--   Maquina INT      NULL  -> PRDMaquinas.Codigo de la tableta fija (SEL_TabletsFijas)
-- Para qué: auditoría (quién declaró qué turno y cuándo, incluso cuando se equivocó y volvió a entrar)
-- y para abrir sola la bitácora del operario que entró ANTES de su turno (hasta 30 min), apenas se
-- cierre la del turno anterior (Node: abrirBitacorasPendientes).
-- Las filas viejas quedan en NULL. Mirane no usa estas columnas. Node funciona sin ellas (registra
-- como antes y no abre bitácoras anticipadas) hasta que se corra este script.
-- Idempotente. DBeaver: seleccionar todo + Ctrl+Enter (un solo lote).
-- =====================================================================================================
IF COL_LENGTH('dbo.SISAccesos', 'Turno') IS NULL
    EXEC('ALTER TABLE dbo.SISAccesos ADD Turno SMALLINT NULL');

IF COL_LENGTH('dbo.SISAccesos', 'Maquina') IS NULL
    EXEC('ALTER TABLE dbo.SISAccesos ADD Maquina INT NULL');

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SISAccesos_Maquina_Fecha' AND object_id = OBJECT_ID('dbo.SISAccesos'))
    EXEC('CREATE INDEX IX_SISAccesos_Maquina_Fecha ON dbo.SISAccesos (Maquina, FechaHora) WHERE Maquina IS NOT NULL');

-- Verificación
SELECT c.name AS Columna, TYPE_NAME(c.user_type_id) AS Tipo, c.is_nullable
FROM sys.columns c WHERE c.object_id = OBJECT_ID('dbo.SISAccesos') ORDER BY c.column_id;
