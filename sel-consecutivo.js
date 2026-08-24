// Puerto MINIMO de GetConsecutivo (Source/Librerias/General.vb:588) -- esa funcion es un motor
// generico de numeracion (por subempresa/dependencia/concepto/periodo, enlaces CNT). Aca solo se
// porta el camino que en verdad toma el Tipo=24 "Salida a Produccion" (el unico que usa
// SEL_InventarioMP.GenerarSalidaRollo), verificado contra la fila real de SISNumeracion:
//   TipoMovimiento=24, Concepto=NULL, Dependencia=NULL, Periodo=false, FormatoNumero='0000',
//   Prefijo=NULL, Final=NULL, FechaDesde/FechaHasta=NULL, Subempresa=0.
// Si esa configuracion cambia (aparece Dependencia/Concepto/Periodo/Prefijo), esta funcion debe
// revisarse antes de confiar en el resultado -- por eso valida y lanza error en vez de adivinar.

const SUBEMPRESA = 0; // gnSubEmpresa en el escritorio -- unico valor visto en INVMovimientos.SubEmpresa

function formatearConsecutivo(nConsecutivo, formatoNumero) {
  const fmt = (formatoNumero || '').trim();
  if (fmt === '') return String(nConsecutivo);
  if (!/^0+$/.test(fmt)) {
    throw new Error(`FormatoNumero de SISNumeracion (Tipo=24) cambio a '${fmt}' -- este puerto solo soporta un formato de solo ceros (relleno con ceros a la izquierda). Revisar sel-consecutivo.js antes de continuar.`);
  }
  return String(nConsecutivo).padStart(fmt.length, '0');
}

// db: pool o transaction de mssql (debe exponer .request()). Debe llamarse dentro de la MISMA
// transaccion que el resto de GenerarSalidaRollo, para no repetir consecutivo ante escaneos
// concurrentes (el UPDATE ... SET Consecutivo = Consecutivo + 1 queda protegido por los locks de
// la transaccion igual que BD.IniciarTransaccion en el escritorio).
async function obtenerConsecutivoSalidaProduccion(db) {
  const dt = await db.request().query(`
    SELECT Linea, Consecutivo, Prefijo, FormatoNumero, Final, Dependencia, Concepto, Periodo
    FROM SISNumeracion
    WHERE TipoMovimiento = 24
      AND (SubEmpresa IS NULL OR SubEmpresa = ${SUBEMPRESA})
      AND Estado = 'Activo'
      AND Concepto IS NULL
      AND Dependencia IS NULL
    ORDER BY SubEmpresa DESC, FechaDesde
  `);

  if (dt.recordset.length === 0) {
    throw new Error("No se encontro numeracion activa para 'Salida a Producción' (SISNumeracion, TipoMovimiento=24). Configure la numeracion antes de continuar.");
  }

  const fila = dt.recordset[0];
  if (fila.Periodo) {
    throw new Error('SISNumeracion (Tipo=24) ahora usa Periodo -- este puerto no lo soporta, revisar sel-consecutivo.js.');
  }

  const tConsecutivo = formatearConsecutivo(fila.Consecutivo, fila.FormatoNumero);

  await db.request()
    .input('linea', fila.Linea)
    .query(`UPDATE SISNumeracion SET Consecutivo = Consecutivo + 1 WHERE TipoMovimiento = 24 AND Linea = @linea`);

  if (fila.Final !== null && fila.Final === fila.Consecutivo) {
    await db.request()
      .input('linea', fila.Linea)
      .query(`UPDATE SISNumeracion SET Estado = 'Inactivo' WHERE TipoMovimiento = 24 AND Linea = @linea`);
  }

  return tConsecutivo;
}

module.exports = { obtenerConsecutivoSalidaProduccion, SUBEMPRESA };
