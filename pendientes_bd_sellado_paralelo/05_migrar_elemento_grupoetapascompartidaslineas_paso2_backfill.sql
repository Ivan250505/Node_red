-- Paso 2 de 3 -- corré esto DESPUES del 04 (necesita que la columna Elemento ya exista, por eso
-- va en archivo aparte). Rellena Elemento en las filas viejas vía el pedido de la cabecera del
-- grupo + la Linea guardada. Después revisá la consulta de verificación: si devuelve filas, hay
-- que resolverlas A MANO antes de seguir al paso 3 (no se puede volver Elemento NOT NULL con huecos).

UPDATE gl
SET gl.Elemento = vme.Elemento
FROM dbo.PRDGrupoEtapasCompartidasLineas gl
INNER JOIN dbo.PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo
INNER JOIN dbo.VENMovimientos vm
    ON vm.Numero = g.Numero AND vm.Tipo = g.Tipo AND vm.Fecha = g.Fecha AND vm.SubEmpresa = g.SubEmpresa
INNER JOIN dbo.VENMovimientosElementos vme
    ON vme.Numero = vm.Numero AND vme.Tipo = vm.Tipo AND vme.Fecha = vm.Fecha AND vme.SubEmpresa = vm.SubEmpresa
    AND vme.Linea = gl.Linea
WHERE gl.Elemento IS NULL;

-- Verificación -- si esto devuelve filas, resolvelas a mano antes de correr el paso 3.
SELECT * FROM dbo.PRDGrupoEtapasCompartidasLineas WHERE Elemento IS NULL;
