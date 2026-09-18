-- Ajuste de la cantidad realmente consumida de un rollo (ver
-- AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md, secciones 5 punto 9 y 5 punto 5).
--
-- Hoy el sistema asume que TODO el rollo montado se consumio: consultarSerial (scan-rollo.js) toma
-- INVExistencias.Cantidad completa y generarSalidaRollo la descuenta entera, dejando la fila en 0
-- para que el DELETE final la borre. Si el operario solo gasto una parte, no hay forma de corregirlo.
--
-- Este script agrega las dos cosas que le faltan a la base para soportar la correccion:
--
--   1. SEL_RolloEjecucion.CantidadOriginal -- que se escaneo de verdad. Sin esto, despues del primer
--      ajuste se pierde R (la cantidad original) y los ajustes se encadenarian uno sobre otro:
--      ajustar 50 -> 40 y despues 40 -> 35 terminaria devolviendo al inventario mas de lo que salio.
--      Se rellena con Cantidad para las filas que ya existen -- para ellas R y C valen lo mismo,
--      que es exactamente la situacion de hoy (nadie ha ajustado nada todavia).
--
--   2. SEL_AjusteConsumoRollo -- la bitacora de cada correccion. No es un lujo: es lo que hace que
--      el ajuste sea idempotente y reversible. R se lee de aca (del PRIMER ajuste de ese rollo)
--      antes que de ninguna otra parte, porque es el unico sitio donde queda el valor de antes de
--      tocar nada, incluso para rollos de ordenes viejas que nunca tuvieron fila en
--      SEL_RolloEjecucion (esa tabla existe recien desde el 09/09/2026).
--
-- Ejecutar contra la base de PRODUCCION. Idempotente: se puede correr dos veces sin dano.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'SEL_RolloEjecucion' AND COLUMN_NAME = 'CantidadOriginal'
)
BEGIN
  ALTER TABLE SEL_RolloEjecucion ADD CantidadOriginal DECIMAL(18,3) NULL;
END
GO

-- Relleno de las filas que ya existen: nunca se ha ajustado ningun rollo, asi que lo que hay en
-- Cantidad ES la cantidad original. Solo toca las que estan en NULL, para que re-ejecutar el script
-- despues de un ajuste real no pise el original con el valor ya corregido.
UPDATE SEL_RolloEjecucion
SET CantidadOriginal = Cantidad
WHERE CantidadOriginal IS NULL AND Cantidad IS NOT NULL;
GO

IF OBJECT_ID('SEL_AjusteConsumoRollo', 'U') IS NULL
BEGIN
  CREATE TABLE SEL_AjusteConsumoRollo (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    -- La orden desde la que se pidio el ajuste y la ancla bajo la que vive de verdad la materia
    -- prima. En sellado en paralelo son DISTINTAS: los hermanos del grupo se crean con
    -- sinMateriaPrima=true, asi que toda la MP (y por lo tanto todo el ajuste) cuelga de la ancla.
    IdOrden INT NOT NULL,
    IdOrdenAncla INT NOT NULL,
    Serial VARCHAR(50) NOT NULL,
    -- R / C anterior / C nueva / D. Diferencia se guarda calculada y no como columna computada a
    -- proposito: es lo que de verdad se movio en INVExistencias en ESTE ajuste
    -- (CantidadAnterior - CantidadNueva), que no es lo mismo que R - C cuando se ajusta dos veces.
    CantidadOriginal DECIMAL(18,3) NOT NULL,
    CantidadAnterior DECIMAL(18,3) NOT NULL,
    CantidadNueva DECIMAL(18,3) NOT NULL,
    Diferencia DECIMAL(18,3) NOT NULL,
    -- S (salida real acumulada) al momento del ajuste -- el tope inferior que se valido. Se guarda
    -- para poder reconstruir despues por que se acepto un ajuste que hoy ya no pasaria.
    SalidaRealKg DECIMAL(18,3) NULL,
    Motivo VARCHAR(255) NULL,
    GeneradoPor INT NULL,
    Usuario VARCHAR(100) NULL,
    FechaHora DATETIME NOT NULL DEFAULT GETDATE()
  );

  -- Busqueda de R: siempre por Serial + ancla, ordenando por Id para quedarse con el PRIMER ajuste.
  CREATE INDEX IX_SEL_AjusteConsumoRollo_Serial
    ON SEL_AjusteConsumoRollo (Serial, IdOrdenAncla, Id);
END
GO

-- Verificar
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'SEL_AjusteConsumoRollo'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS RollosConOriginalRelleno
FROM SEL_RolloEjecucion WHERE CantidadOriginal IS NOT NULL;
GO
