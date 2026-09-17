-- Rediseno del "Iniciar" (a pedido del usuario, 16/09/2026): al escanear/confirmar el rollo YA NO
-- se crea de una vez la OT/bulto/PRDProduccion -- eso se pospone hasta que el operario termina el
-- Alistamiento (paso 5 del protocolo de arranque, Subtipo='ARRANQUE'). Esta tabla es el "puente":
-- guarda los datos ya validados del rollo confirmado mientras el Alistamiento sigue corriendo, y
-- solo cuando este termina (POST /reanudar) se materializa TODO junto en una sola transaccion.
--
-- Por que: hoy la creacion del bulto pasa ANTES del Alistamiento -- si se cae la conexion o la
-- tableta a mitad del Alistamiento, "PRDProduccion" ya existe con datos a medias, fechado antes de
-- que el Alistamiento siquiera pasara. Con esta tabla, si algo se cae entre el escaneo y el fin del
-- Alistamiento, el rollo ya validado sigue aqui (Procesado=0) y no se pierde nada -- al retomar la
-- orden, el operario simplemente termina el Alistamiento que quedo pendiente y ahi se materializa.
--
-- Aplica SOLO al Iniciar (primer rollo, Subtipo='ARRANQUE'). "Añadir Rollo" (rollo adicional a
-- mitad de produccion) no toca esta tabla -- no crea bulto/PRDProduccion nuevo, nunca tuvo este
-- problema (confirmado con el usuario 16/09/2026).
--
-- Ejecutar contra la base de PRODUCCION. Idempotente.

IF OBJECT_ID('SEL_RolloPendienteInicio', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_RolloPendienteInicio (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    IdOrden INT NOT NULL,
    IdEjecucion INT NOT NULL,
    CodOperario INT NULL,
    Serial VARCHAR(30) NOT NULL,
    Cantidad DECIMAL(18,3) NULL,
    Lote VARCHAR(20) NULL,
    BolsasXGolpe INT NULL,
    GeneradoPor INT NULL,
    FechaHoraEscaneo DATETIME NOT NULL DEFAULT GETDATE(),
    Procesado BIT NOT NULL DEFAULT 0,
    FechaHoraProcesado DATETIME NULL
  );

  CREATE INDEX IX_SEL_RolloPendienteInicio_Ejecucion
    ON SEL_RolloPendienteInicio (IdEjecucion, Procesado);
END
GO

-- Verificar
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'SEL_RolloPendienteInicio'
ORDER BY ORDINAL_POSITION;
GO
