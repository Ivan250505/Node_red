-- SOLO LECTURA. Confirma si el grupo de SELLADORA del pedido 11037 ya existe -- si esto sigue
-- vacío, el problema es que Mirane no se recompiló/reabrió el pedido (SincronizarGruposSelladora
-- nunca corrió). Si esto YA tiene filas pero el Node sigue mostrando tarjetas sueltas, el problema
-- es que el proceso Node no se reinició con el código nuevo.

SELECT g.IdGrupo, g.Numero, gl.Linea, gl.Elemento, ie.Referencia
FROM PRDGrupoEtapasCompartidas g
INNER JOIN PRDGrupoEtapasCompartidasLineas gl ON gl.IdGrupo = g.IdGrupo
INNER JOIN INVElementos ie ON ie.Codigo = gl.Elemento
WHERE g.Numero = '11037' AND g.CategoriaMaquina = 'SELLADORA'
ORDER BY gl.Linea;
