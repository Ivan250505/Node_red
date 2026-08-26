// Puerto deliberado (no una llamada) de Source/Produccion/SEL_InventarioMP.vb -- las funciones que
// usan Iniciar/Añadir Rollo/Finalizar de EjecucionSelladora.vb, mas (25/08/2026) marcar el bulto
// Activo con Retal/Troquelado (botones "Retal"/"Troquelado" en server.js). Verificar/Cerrar
// Definitivo y la digitacion de la cantidad real del residuo siguen solo en el escritorio (Mirane).
// Cada funcion referencia la linea original de SEL_InventarioMP.vb de la que viene.
//
// Todas reciben `db` como primer parametro: un pool o una transaction de `mssql`, lo que sea
// que tenga en ese momento el caller (deben exponer `.request()`) -- así las mismas funciones
// sirven tanto para lecturas sueltas como dentro de una transaccion.

const sql = require('mssql');
const { obtenerConsecutivoSalidaProduccion, SUBEMPRESA } = require('./sel-consecutivo');

function dateDiffMinutos(fIni, fFin) {
  if (!fIni || !fFin) return 0;
  const iniMin = Math.floor(new Date(fIni).getTime() / 60000);
  const finMin = Math.floor(new Date(fFin).getTime() / 60000);
  return finMin - iniMin;
}

function valNumerico(texto) {
  const n = parseInt(String(texto ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// SEL_InventarioMP.vb:21-30
async function obtenerBodegaDeRollo(db, detalle) {
  if (!detalle) return '';
  let r = await db.request().input('detalle', detalle)
    .query(`SELECT TOP 1 Bodega FROM INVExistencias WHERE Detalle = @detalle`);
  if (r.recordset.length > 0) return (r.recordset[0].Bodega || '').trim();

  r = await db.request().input('detalle', detalle)
    .query(`SELECT TOP 1 Bodega FROM INVMovimientosElementos WHERE Tipo = 24 AND Detalle = @detalle`);
  if (r.recordset.length > 0) return (r.recordset[0].Bodega || '').trim();

  return '';
}

// SEL_InventarioMP.vb:38-93
async function obtenerLoteRollo(db, detalleIngresado) {
  if (!detalleIngresado || detalleIngresado.length < 5) return '';
  const ultimos5 = detalleIngresado.slice(-5);
  if (!/^\d+$/.test(ultimos5)) return '';
  const nCodigo = parseInt(ultimos5, 10);

  let dt = await db.request().input('cod', nCodigo).input('det', detalleIngresado)
    .query(`SELECT Serie FROM INVExistencias WHERE Elemento = @cod AND Detalle = @det`);
  if (dt.recordset.length > 0 && dt.recordset[0].Serie != null) return String(dt.recordset[0].Serie).trim();

  dt = await db.request().input('cod', nCodigo).input('det', detalleIngresado)
    .query(`SELECT NumeroPedido FROM PRDProduccion WHERE Elemento = @cod AND Detalle = @det`);
  if (dt.recordset.length > 0 && dt.recordset[0].NumeroPedido != null && String(dt.recordset[0].NumeroPedido).trim() !== '') {
    return String(dt.recordset[0].NumeroPedido).trim();
  }

  dt = await db.request().input('cod', nCodigo).input('det', detalleIngresado)
    .query(`SELECT Lote FROM PRDProduccion WHERE Elemento = @cod AND Detalle = @det`);
  if (dt.recordset.length > 0 && dt.recordset[0].Lote != null) return String(dt.recordset[0].Lote).trim();

  dt = await db.request().input('det', detalleIngresado)
    .query(`SELECT Numero, Tipo FROM INVMovimientosLotes WHERE Subempresa = ${SUBEMPRESA} AND Lote = @det`);
  if (dt.recordset.length === 0) return '';
  const { Numero: tNumero, Tipo: nTipo } = dt.recordset[0];

  dt = await db.request().input('numero', tNumero).input('tipo', nTipo).input('cod', nCodigo)
    .query(`SELECT Detalle FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Numero = @numero AND Tipo = @tipo AND Elemento = @cod`);
  if (dt.recordset.length > 0 && dt.recordset[0].Detalle != null) return String(dt.recordset[0].Detalle).trim();

  return '';
}

// SEL_InventarioMP.vb:894-908
async function getInicialTipoProductoMP(db, elemento) {
  const dt = await db.request().input('elemento', elemento).query(`
    SELECT TOP 1 r.Codigo
    FROM INVElementosReferencia er
    INNER JOIN INVReferencia r ON r.Categoria = er.Categoria AND r.Codigo = er.Valor
    WHERE er.Elemento = @elemento AND er.Categoria = 1
  `);
  if (dt.recordset.length === 0 || dt.recordset[0].Codigo == null) return null;
  const tCod = String(dt.recordset[0].Codigo).trim();
  if (tCod.length === 0) return null;
  return tCod[0].toUpperCase();
}

// SEL_InventarioMP.vb:910-925
async function esMateriaPrimaProhibidaSellado(db, elemento) {
  const prohibidas = new Set(['M', 'B', 'A', 'Q', 'S', 'X', 'P']);
  const inicial = await getInicialTipoProductoMP(db, elemento);
  if (inicial === null) return { prohibida: false, mensaje: '' };
  if (prohibidas.has(inicial)) {
    return {
      prohibida: true,
      mensaje: `El elemento (Tipo de Producto inicial ${inicial}) no puede ser utilizado como materia prima en Selladora.`
    };
  }
  return { prohibida: false, mensaje: '' };
}

// SEL_InventarioMP.vb:101-126
async function registrarMateriaPrimaRollo(db, { fecha, lote, elementoProducto, linea, detalleRollo, cantidad, loteMP, bodega, ordenProduccion }) {
  if (!detalleRollo || cantidad <= 0 || detalleRollo.length < 5) return;
  const nCodigo = parseInt(detalleRollo.slice(-5), 10);
  if (!Number.isFinite(nCodigo) || nCodigo <= 0) return;

  await db.request()
    .input('fecha', fecha).input('lote', lote).input('elementoProducto', elementoProducto).input('linea', linea)
    .input('materiaPrima', nCodigo).input('detalle', detalleRollo).input('cantidad', cantidad)
    .input('loteMP', loteMP || null).input('bodega', bodega || null)
    .input('ordenProduccion', ordenProduccion || null)
    .query(`
      INSERT INTO PRDProduccionMateriaPrima (Fecha, Lote, Elemento, Linea, MateriaPrima, Detalle, Cantidad, LoteMP, Bodega, OrdenProduccion)
      VALUES (@fecha, @lote, @elementoProducto, @linea, @materiaPrima, @detalle, @cantidad, @loteMP, @bodega, @ordenProduccion)
    `);
}

// Rama unica de INVModulo.SalidaInventario (linea 2804) que en verdad se ejecuta desde
// GenerarSalidaRollo: siempre se llama con un Detalle especifico (el serial unico del rollo,
// ya localizado antes por ConsultarSerial/consultarSerial) y una cantidad tomada de esa MISMA
// fila -- por construccion cae siempre en la rama de "coincidencia exacta por Detalle"
// (INVModulo.vb:2825-2887), nunca en la generica de PEPS/Promedio multi-linea. Replica el
// mismo calculo condicional de Cantidad/Unidades del original (no lo "corrige"): Cantidad
// siempre queda en 0 (o el remanente si cantidad < existencia), pero Unidades solo se pone en
// 0 si la Unidades solicitada (siempre 0 aqui) alcanza para cubrir la fila -- igual que hoy.
async function descontarExistenciaPorDetalle(db, { bodega, elemento, detalle, cantidad, generadoPor }) {
  const dt = await db.request().input('bodega', bodega).input('elemento', elemento).input('detalle', detalle)
    .query(`SELECT Linea, Cantidad, Unidades, Valor FROM INVExistencias WHERE Bodega = @bodega AND Elemento = @elemento AND Cantidad > 0 AND Detalle = @detalle`);

  if (dt.recordset.length === 0) {
    throw new Error(`No se encontraron existencias para descontar (Bodega ${bodega}, Elemento ${elemento}, Detalle ${detalle}).`);
  }
  const fila = dt.recordset[0];
  const nCant = Number(cantidad);
  const filaCant = Number(fila.Cantidad);
  if (nCant > filaCant) {
    throw new Error(`Existencia insuficiente para el Detalle '${detalle}' (solicitado ${nCant}, disponible ${filaCant}). Verifique que nadie más haya afectado este rollo desde que se escaneó.`);
  }

  await db.request()
    .input('generadoPor', generadoPor).input('bodega', bodega).input('elemento', elemento).input('linea', fila.Linea)
    .query(`
      INSERT INTO AUD_INVExi_Borradas
        (FechaHora, GeneradoPor, Origen, Bodega, Elemento, Linea, Cantidad, Unidades, Valor, FechaIngreso, Serie, Lote, Detalle, Operacion)
      SELECT GETDATE(), @generadoPor, 'NodeSelladora.generarSalidaRollo', Bodega, Elemento, Linea, Cantidad, Unidades, Valor, FechaIngreso, Serie, Lote, Detalle, 'SALIDA'
      FROM INVExistencias
      WHERE Bodega = @bodega AND Elemento = @elemento AND Linea = @linea
    `);

  const nUnidadesSalida = 0; // GenerarSalidaRollo siempre pasa Unidades=0, igual que GenerarSalidaMateriaPrima
  const nuevaCantidad = (nCant >= filaCant) ? 0 : (filaCant - nCant);
  const nuevasUnidades = (nUnidadesSalida >= Number(fila.Unidades)) ? 0 : fila.Unidades;

  await db.request()
    .input('bodega', bodega).input('elemento', elemento).input('linea', fila.Linea)
    .input('cantidad', nuevaCantidad).input('unidades', nuevasUnidades)
    .query(`UPDATE INVExistencias SET Cantidad = @cantidad, Unidades = @unidades WHERE Bodega = @bodega AND Elemento = @elemento AND Linea = @linea`);
}

// SEL_InventarioMP.vb:137-236
async function generarSalidaRollo(db, { idOrden, fecha, lote, elementoProducto, linea, detalleRollo, cantidad, generadoPor }) {
  if (!detalleRollo || cantidad <= 0 || detalleRollo.length < 5) return;
  const nElementoRollo = parseInt(detalleRollo.slice(-5), 10);
  if (!Number.isFinite(nElementoRollo) || nElementoRollo <= 0) return;

  const TIPO = 24;
  const tObsMovimiento = `Salida Materia Prima Selladora - ${lote} - ${elementoProducto} - ${linea}`;

  let dt = await db.request().input('fecha', fecha).input('obs', tObsMovimiento)
    .query(`SELECT Numero FROM INVMovimientos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Observaciones = @obs`);

  let tNumero;
  if (dt.recordset.length > 0) {
    tNumero = dt.recordset[0].Numero;
  } else {
    tNumero = await obtenerConsecutivoSalidaProduccion(db);

    const dtConcepto = await db.request().query(`SELECT Concepto FROM SISTiposMovimiento WHERE Codigo = ${TIPO}`);
    const concepto = dtConcepto.recordset[0].Concepto;

    await db.request()
      .input('fecha', fecha).input('numero', tNumero).input('concepto', concepto).input('generadoPor', generadoPor).input('obs', tObsMovimiento)
      .query(`
        INSERT INTO INVMovimientos (SubEmpresa, Fecha, Tipo, Numero, Concepto, Tercero, Sucursal, GeneradoPor, Observaciones, FechaModificado, Estado)
        VALUES (${SUBEMPRESA}, @fecha, ${TIPO}, @numero, @concepto, 0, 0, @generadoPor, @obs, GETDATE(), 'Registrado')
      `);
  }

  const tBodega = await obtenerBodegaDeRollo(db, detalleRollo);

  // Guardia AR: si la orden es TipoPedido='AR', la bodega debe tener Detalle habilitado.
  const dtOrden = await db.request().input('idOrden', idOrden).query(`SELECT TipoPedido FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length > 0 && (dtOrden.recordset[0].TipoPedido || '').trim() === 'AR') {
    const dtBod = await db.request().input('bodega', tBodega).query(`SELECT Nombre, Detalle FROM INVBodegas WHERE Codigo = @bodega`);
    if (dtBod.recordset.length > 0 && dtBod.recordset[0].Detalle === false) {
      throw new Error(`La bodega '${dtBod.recordset[0].Nombre}' de la etiqueta '${detalleRollo}' no tiene habilitada la opción Etiquetas (Detalle).\nNo es posible procesar la salida de materia prima AR sin esta configuración. Corrija la bodega en Inventario antes de continuar.`);
    }
  }

  const dtDup = await db.request()
    .input('fecha', fecha).input('numero', tNumero).input('elemento', nElementoRollo).input('detalle', detalleRollo)
    .query(`SELECT COUNT(*) AS Cnt FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero AND Elemento = @elemento AND Detalle = @detalle`);

  if (dtDup.recordset[0].Cnt === 0) {
    const dtLinea = await db.request().input('fecha', fecha).input('numero', tNumero)
      .query(`SELECT ISNULL(MAX(Linea), 0) + 1 AS NL FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero`);
    const nNuevaLinea = dtLinea.recordset[0].NL;

    await db.request()
      .input('fecha', fecha).input('numero', tNumero).input('linea', nNuevaLinea)
      .input('bodega', tBodega).input('elemento', nElementoRollo).input('cantidad', cantidad).input('detalle', detalleRollo)
      .query(`
        INSERT INTO INVMovimientosElementos (SubEmpresa, Fecha, Tipo, Numero, Linea, Bodega, Elemento, UnidadMedida, Cantidad, Unidades, Detalle)
        VALUES (${SUBEMPRESA}, @fecha, ${TIPO}, @numero, @linea, @bodega, @elemento, 'KGS', @cantidad, 0, @detalle)
      `);
  }

  await descontarExistenciaPorDetalle(db, { bodega: tBodega, elemento: nElementoRollo, detalle: detalleRollo, cantidad, generadoPor });

  await db.request().query(`DELETE FROM INVExistencias WHERE Cantidad = 0 AND Unidades = 0`);
}

// SEL_InventarioMP.vb:259-266
async function obtenerLineaOriginalControlSellado(db, idOrden, numBultoActual) {
  const dt = await db.request().input('idOrden', idOrden).query(`
    SELECT MIN(b.num_bulto) AS MinBulto FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden
  `);
  if (dt.recordset.length > 0 && dt.recordset[0].MinBulto != null) return dt.recordset[0].MinBulto;
  return numBultoActual;
}

// SEL_InventarioMP.vb:ObtenerFechaLoteOriginalControlSellado (agregado 24/08/2026) -- Fecha/Lote
// REALES del bulto ancla (num_bulto = lineaOriginal), no los de "hoy". Un proceso de Selladora
// puede durar mas de un dia (Iniciar hoy, "Añadir Rollo" mañana) -- igual que Produccion.vb
// (linea 8467-8471: "la MP siempre se guarda bajo el ancla del proceso, nunca bajo el dia real de
// la etiqueta"), la materia prima agregada despues debe quedar anotada bajo la Fecha/Lote
// ORIGINAL, o queda invisible para MostrarHistorialMP/Produccion.vb:Buscar() y para el lookup de
// OrdenProduccion (ambos filtran por Fecha+Lote exactos). Devuelve null si el bulto ancla no existe.
async function obtenerFechaLoteOriginalControlSellado(db, idOrden, lineaOriginal) {
  const dt = await db.request().input('idOrden', idOrden).input('lineaOriginal', lineaOriginal).query(`
    SELECT TOP 1 b.agno, b.mes, b.dia FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.num_bulto = @lineaOriginal
  `);
  if (dt.recordset.length === 0) return null;
  const { agno, mes, dia } = dt.recordset[0];
  return {
    fecha: new Date(agno, mes - 1, dia),
    lote: String(mes).padStart(2, '0') + String(dia).padStart(2, '0')
  };
}

// SEL_InventarioMP.vb:273-282
async function calcularMaterialTotalSellado(db, elemento, lote, linea, year) {
  const dt = await db.request().input('elemento', elemento).input('lote', lote).input('linea', linea).input('year', year)
    .query(`SELECT SUM(Cantidad) AS Total FROM PRDProduccionMateriaPrima WHERE Elemento = @elemento AND Lote = @lote AND Linea = @linea AND Year(Fecha) = @year`);
  if (dt.recordset.length > 0 && dt.recordset[0].Total != null) return Number(dt.recordset[0].Total);
  return 0;
}

// SEL_InventarioMP.vb:292-347
// FIX 23/08/2026: @fecha se ata explicitamente como sql.Date (solo fecha, sin hora). Sin esto,
// mssql infiere el tipo del parametro a partir del Date de JS (que aqui es "new Date()" -- la
// hora actual, no medianoche), y lo manda como datetime/datetime2 con hora. Al compararlo con
// FechaOriginal (columna DATE) en el SELECT, SQL Server promueve la columna a medianoche y la
// compara contra un parametro CON hora -- nunca coincide si el segundo escaneo del dia ocurre a
// otra hora que el primero. El SELECT no encontraba la fila ya creada por el primer rollo, caia
// al INSERT, y ese INSERT chocaba con UK_ExtrusionControl_Original (mismo Elemento/Fecha/Linea/
// Lote que el primer rollo) -- exactamente el error reportado al usar "Añadir Rollo".
async function registrarControlParcialSellado(db, { idOrden, elemento, fecha, anio, numBultoActual, lote, pesoRolloBruto, generadoPor }) {
  const nLineaOriginal = await obtenerLineaOriginalControlSellado(db, idOrden, numBultoActual);

  const dtControl = await db.request()
    .input('elemento', elemento).input('fecha', sql.Date, fecha).input('lineaOriginal', nLineaOriginal).input('lote', lote)
    .query(`SELECT IdExtrusionControl FROM PRDExtrusionControl WHERE ElementoOriginal = @elemento AND FechaOriginal = @fecha AND LineaOriginal = @lineaOriginal AND LoteOriginal = @lote AND TipoProceso = 'Sellado'`);

  let nIdControl;
  if (dtControl.recordset.length > 0) {
    nIdControl = dtControl.recordset[0].IdExtrusionControl;
  } else {
    const nMaterialTotal = await calcularMaterialTotalSellado(db, elemento, lote, nLineaOriginal, anio);
    const dtNuevo = await db.request()
      .input('elemento', elemento).input('fecha', sql.Date, fecha).input('lineaOriginal', nLineaOriginal).input('lote', lote)
      .input('materialTotal', nMaterialTotal).input('generadoPor', generadoPor)
      .query(`
        INSERT INTO PRDExtrusionControl (ElementoOriginal, FechaOriginal, LineaOriginal, LoteOriginal, MaterialTotalKg, MaterialConsumidoKg, Estado, TipoProceso, UsuarioCreacion, FechaCreacion)
        OUTPUT INSERTED.IdExtrusionControl
        VALUES (@elemento, @fecha, @lineaOriginal, @lote, @materialTotal, 0, 'EnProceso', 'Sellado', @generadoPor, GETDATE())
      `);
    if (dtNuevo.recordset.length === 0) return;
    nIdControl = dtNuevo.recordset[0].IdExtrusionControl;
  }

  const dtExisteRollo = await db.request()
    .input('idControl', nIdControl).input('elemento', elemento).input('fecha', sql.Date, fecha).input('linea', numBultoActual).input('lote', lote)
    .query(`SELECT 1 AS X FROM PRDExtrusionRollos WHERE IdExtrusionControl = @idControl AND Elemento = @elemento AND Fecha = @fecha AND Linea = @linea AND Lote = @lote`);

  if (dtExisteRollo.recordset.length === 0) {
    const dtSec = await db.request().input('idControl', nIdControl)
      .query(`SELECT ISNULL(MAX(NumeroSecuencial),0) + 1 AS Sig FROM PRDExtrusionRollos WHERE IdExtrusionControl = @idControl`);
    const nSecuencial = dtSec.recordset[0].Sig;

    await db.request()
      .input('idControl', nIdControl).input('elemento', elemento).input('fecha', sql.Date, fecha).input('linea', numBultoActual)
      .input('lote', lote).input('secuencial', nSecuencial).input('generadoPor', generadoPor)
      .query(`
        INSERT INTO PRDExtrusionRollos (IdExtrusionControl, Elemento, Fecha, Linea, Lote, NumeroSecuencial, PesoBrutoKg, PesoConoKg, ResiduosKg, UsuarioCreacion, FechaHoraCreacion)
        VALUES (@idControl, @elemento, @fecha, @linea, @lote, @secuencial, 0, 0, 0, @generadoPor, GETDATE())
      `);
  }

  await db.request()
    .input('idControl', nIdControl).input('pesoBruto', pesoRolloBruto).input('generadoPor', generadoPor)
    .query(`
      UPDATE PRDExtrusionControl SET MaterialConsumidoKg = MaterialConsumidoKg + @pesoBruto,
        FechaUltimaModificacion = GETDATE(), UsuarioUltimaModificacion = @generadoPor
      WHERE IdExtrusionControl = @idControl
    `);
}

function parseHoraToSeconds(tHora) {
  const partes = String(tHora).split(':').map(Number);
  const [h = 0, m = 0, s = 0] = partes;
  return h * 3600 + m * 60 + s;
}

// SEL_InventarioMP.vb:735-751
async function resolverTurnoPorHora(db, maquina, fHora) {
  const dt = await db.request().input('maquina', maquina)
    .query(`SELECT CodigoTurno, HoraInicio, HoraFin FROM TURHorariosMaquinas WHERE CodigoMaquina = @maquina AND Activo = 1`);

  const f = new Date(fHora);
  const hActual = f.getHours() * 3600 + f.getMinutes() * 60 + f.getSeconds();
  for (const row of dt.recordset) {
    const hInicio = parseHoraToSeconds(row.HoraInicio);
    const hFin = parseHoraToSeconds(row.HoraFin);
    const enRango = hInicio <= hFin
      ? (hActual >= hInicio && hActual < hFin)
      : (hActual >= hInicio || hActual < hFin);
    if (enRango) return row.CodigoTurno;
  }
  return 0;
}

// SEL_InventarioMP.vb:761-789
async function resolverClienteDestino(db, numeroPedido) {
  if (!numeroPedido || numeroPedido <= 0) return { codCliente: 0, codDestino: 0 };
  const dt = await db.request().input('numeroPedido', String(numeroPedido)).query(`
    SELECT TOP 1 t.Codigo AS CodCliente, pd.Codigo AS CodDestino
    FROM VENMovimientos vm
    INNER JOIN VISTerceros t ON t.Codigo = vm.Tercero AND t.Sucursal = 0
    INNER JOIN VENMovimientosElementos vme ON vme.Numero = vm.Numero AND vme.Tipo = vm.Tipo
      AND vme.Fecha = vm.Fecha AND vme.SubEmpresa = vm.SubEmpresa
    LEFT JOIN INVBodegas ib ON ib.Codigo = vme.Bodega
    LEFT JOIN PRDDestinos pd ON pd.Codigo = CASE ib.Codigo
      WHEN '005003' THEN 3
      WHEN '005004' THEN 4
      WHEN '004'    THEN 7
      WHEN '001'    THEN 9
      WHEN '005001' THEN 10
      WHEN '005005' THEN 14
      WHEN '005014' THEN 15
      WHEN '005009' THEN 16
    END
    WHERE vm.Tipo = 16 AND vm.Numero = @numeroPedido
    ORDER BY vm.Fecha DESC
  `);
  if (dt.recordset.length > 0) {
    return { codCliente: dt.recordset[0].CodCliente || 0, codDestino: dt.recordset[0].CodDestino || 0 };
  }
  return { codCliente: 0, codDestino: 0 };
}

// SEL_InventarioMP.vb:ResolverDestinoOrden (agregado 23/08/2026) -- Destino se resuelve UNA SOLA
// VEZ en Programacion.vb (escritorio, con aviso + seleccion manual si el pivote automatico de
// resolverClienteDestino no encuentra mapeo) y se persiste en SEL_OrdenProduccion.Destino. Esta
// funcion es el unico punto de lectura para el resto de Selladora -- si la orden ya tiene Destino
// guardado, se usa ese; si no (ordenes viejas, o sin Programacion.vb involucrado), cae al mismo
// pivote automatico de siempre como respaldo.
async function resolverDestinoOrden(db, idOrden, numeroPedido) {
  const dtDestOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT TOP 1 Destino FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden AND Destino IS NOT NULL`);
  if (dtDestOrden.recordset.length > 0) return dtDestOrden.recordset[0].Destino;

  const { codDestino } = await resolverClienteDestino(db, numeroPedido);
  return codDestino;
}

// SEL_InventarioMP.vb:800-841
async function obtenerOCrearOrdenProduccion(db, { elemento, fecha, lineaAncla, lote, codigoDestino, generadoPor }) {
  try {
    const dtExiste = await db.request()
      .input('fecha', fecha).input('lote', lote).input('elemento', elemento).input('lineaAncla', lineaAncla)
      .query(`SELECT OrdenProduccion FROM PRDOrdenesProduccion WHERE Fecha = @fecha AND Lote = @lote AND Elemento = @elemento AND LineaAncla = @lineaAncla`);
    if (dtExiste.recordset.length > 0) return dtExiste.recordset[0].OrdenProduccion;

    let tNombreDestino = '';
    if (codigoDestino > 0) {
      const dtDest = await db.request().input('codigoDestino', codigoDestino).query(`SELECT Nombre FROM PRDDestinos WHERE Codigo = @codigoDestino`);
      if (dtDest.recordset.length > 0) tNombreDestino = dtDest.recordset[0].Nombre || '';
    }
    const tSigla = (tNombreDestino + 'XXX').slice(0, 3).toUpperCase();

    const dtCons = await db.request().input('lote', lote).input('destino', codigoDestino)
      .query(`SELECT ISNULL(MAX(Consecutivo), 0) + 1 AS NC FROM PRDOrdenesProduccion WHERE Lote = @lote AND Destino = @destino`);
    const nConsecutivo = dtCons.recordset[0].NC;

    const tOP = `OP${lote}${String(nConsecutivo).padStart(4, '0')}${tSigla}`;

    await db.request()
      .input('op', tOP).input('lote', lote).input('destino', codigoDestino).input('consecutivo', nConsecutivo)
      .input('fecha', fecha).input('elemento', elemento).input('lineaAncla', lineaAncla).input('generadoPor', generadoPor)
      .query(`
        INSERT INTO PRDOrdenesProduccion (OrdenProduccion, Lote, Destino, Consecutivo, Fecha, Elemento, LineaAncla, TipoProceso, GeneradoPor, FechaCreacion)
        VALUES (@op, @lote, @destino, @consecutivo, @fecha, @elemento, @lineaAncla, 'Sellado', @generadoPor, GETDATE())
      `);
    return tOP;
  } catch (err) {
    return '';
  }
}

// SEL_InventarioMP.vb:368-611
async function finalizarControlParcialSellado(db, { idOrden, retalManual, tortaManual, generadoPor }) {
  const dtBultos = await db.request().input('idOrden', idOrden).query(`
    SELECT b.id, b.serialPadre, b.num_bulto, b.refsalida, b.CantidadTotal, b.NumeroPedido,
      b.agno, b.mes, b.dia, b.HoraInicio, b.HoraFin, ISNULL(b.number_paqu,0) AS NumPaqu,
      b.id_maquina, ej.Operario, ISNULL(ej.BolsasxGolpe,0) AS BolsasxGolpe
    FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.estado = 'Cerrado'
    ORDER BY b.num_bulto ASC
  `);
  if (dtBultos.recordset.length === 0) return;

  const TIPO_PEDIDO_AR = 4;

  let nUltimoElemento = 0, nUltimoAgno = 0, tUltimoLote = '', nUltimaLinea = 0;

  const dtClienteOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT TOP 1 Cliente FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden AND Cliente IS NOT NULL`);
  const nCodClienteOrden = dtClienteOrden.recordset.length > 0 ? dtClienteOrden.recordset[0].Cliente : 0;

  for (const dr of dtBultos.recordset) {
    const nElemento = dr.refsalida;
    const nAgno = dr.agno, nMes = dr.mes, nDia = dr.dia;
    const fFechaBulto = new Date(nAgno, nMes - 1, nDia);
    const tLoteBulto = String(nMes).padStart(2, '0') + String(nDia).padStart(2, '0');
    const nLinea = dr.num_bulto;
    const tSerial = dr.serialPadre;
    const nCantidad = dr.CantidadTotal != null ? Number(dr.CantidadTotal) : 0;
    const nNumeroPedido = dr.NumeroPedido != null ? Number(dr.NumeroPedido) : 0;
    const nMaquina = dr.id_maquina;
    const nOperario = dr.Operario != null ? Number(dr.Operario) : 0;
    const nBolsasxGolpe = dr.BolsasxGolpe;
    // FIX 24/08/2026: ver mismo fix en SEL_InventarioMP.vb -- Unidades = bolsas TOTALES del bulto
    // (constante fija confirmada: 100 bolsas por paquete, no confundir con BolsasxGolpe).
    const BOLSAS_POR_PAQUETE = 100;
    const nUnidades = dr.NumPaqu * BOLSAS_POR_PAQUETE;
    const fHoraIni = dr.HoraInicio;
    const fHoraFin = dr.HoraFin;
    const fHoraTurno = fHoraFin || fHoraIni || new Date();

    const nCodCliente = nCodClienteOrden;
    const nCodDestino = await resolverDestinoOrden(db, idOrden, nNumeroPedido);

    const dtYaExiste = await db.request().input('serial', tSerial).query(`SELECT 1 AS X FROM PRDProduccion WHERE Detalle = @serial`);
    const nDuracion = dateDiffMinutos(fHoraIni, fHoraFin);

    if (dtYaExiste.recordset.length > 0) {
      await db.request()
        .input('cantidad', nCantidad).input('duracion', nDuracion).input('unidades', nUnidades)
        .input('cliente', nCodCliente > 0 ? nCodCliente : null).input('destino', nCodDestino > 0 ? nCodDestino : null)
        .input('tipoPedido', TIPO_PEDIDO_AR).input('horaFin', fHoraFin || null).input('serial', tSerial)
        .query(`
          UPDATE PRDProduccion SET
            Cantidad = @cantidad, Duracion = @duracion, Unidades = @unidades,
            ClienteProduccion = @cliente, Destino = @destino, TipoPedido = @tipoPedido,
            HoraFinal = @horaFin, FechaModificado = GETDATE()
          WHERE Detalle = @serial
        `);
    } else {
      const nTurno = await resolverTurnoPorHora(db, nMaquina, fHoraTurno);
      await db.request()
        .input('fecha', fFechaBulto).input('maquina', nMaquina).input('turno', nTurno > 0 ? String(nTurno) : null)
        .input('duracion', nDuracion).input('lote', tLoteBulto).input('elemento', nElemento).input('linea', nLinea)
        .input('cantidad', nCantidad).input('unidades', nUnidades).input('serial', tSerial)
        .input('cliente', nCodCliente > 0 ? nCodCliente : null).input('destino', nCodDestino > 0 ? nCodDestino : null)
        .input('generadoPor', generadoPor).input('horaIni', fHoraIni || null).input('horaFin', fHoraFin || null)
        .input('bolsas', nBolsasxGolpe).input('tipoPedido', TIPO_PEDIDO_AR)
        .input('numeroPedido', nNumeroPedido > 0 ? String(nNumeroPedido) : null)
        .query(`
          INSERT INTO PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
            ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor, FechaModificado, HoraInicio, HoraFinal,
            Torta, BolsasxGolpe, TipoPedido, NumeroPedido)
          VALUES (@fecha, @maquina, @turno, @duracion, @lote, @elemento, @linea, @cantidad, 0, @unidades, @serial,
            @cliente, @destino, 0, 0, 0, 0, @generadoPor, GETDATE(), @horaIni, @horaFin,
            0, @bolsas, @tipoPedido, @numeroPedido)
        `);
    }

    if (nOperario > 0) {
      const dtOpExiste = await db.request()
        .input('elemento', nElemento).input('agno', nAgno).input('lote', tLoteBulto).input('linea', nLinea)
        .query(`SELECT 1 AS X FROM PRDProduccionOperarios WHERE Elemento = @elemento AND Year(Fecha) = @agno AND Lote = @lote AND Linea = @linea`);
      if (dtOpExiste.recordset.length === 0) {
        await db.request()
          .input('fecha', fFechaBulto).input('lote', tLoteBulto).input('elemento', nElemento).input('linea', nLinea).input('operario', nOperario)
          .query(`INSERT INTO PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario) VALUES (@fecha, @lote, @elemento, @linea, @operario)`);
      }
    }

    nUltimoElemento = nElemento; nUltimoAgno = nAgno; tUltimoLote = tLoteBulto; nUltimaLinea = nLinea;
  }

  if (nUltimoElemento === 0) return;

  const dtPrimero = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 b.agno, b.mes, b.dia, b.num_bulto, b.NumeroPedido FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden
    ORDER BY b.num_bulto ASC
  `);
  if (dtPrimero.recordset.length === 0) return;

  const nAgnoOriginal = dtPrimero.recordset[0].agno;
  const nLineaOriginal = dtPrimero.recordset[0].num_bulto;
  const fFechaOriginal = new Date(nAgnoOriginal, dtPrimero.recordset[0].mes - 1, dtPrimero.recordset[0].dia);
  const tLoteOriginal = String(dtPrimero.recordset[0].mes).padStart(2, '0') + String(dtPrimero.recordset[0].dia).padStart(2, '0');
  const nNumeroPedidoOriginal = dtPrimero.recordset[0].NumeroPedido != null ? Number(dtPrimero.recordset[0].NumeroPedido) : 0;

  const nCodDestinoOriginal = await resolverDestinoOrden(db, idOrden, nNumeroPedidoOriginal);
  const tOP = await obtenerOCrearOrdenProduccion(db, {
    elemento: nUltimoElemento, fecha: fFechaOriginal, lineaAncla: nLineaOriginal, lote: tLoteOriginal,
    codigoDestino: nCodDestinoOriginal, generadoPor
  });
  if (tOP) {
    await db.request().input('op', tOP).input('idOrden', idOrden).query(`
      UPDATE p SET p.OrdenProduccion = @op
      FROM PRDProduccion p
      INNER JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND b.estado = 'Cerrado'
    `);
  }

  const dtCtrl = await db.request()
    .input('elemento', nUltimoElemento).input('fecha', fFechaOriginal).input('lineaOriginal', nLineaOriginal).input('lote', tLoteOriginal)
    .query(`SELECT IdExtrusionControl FROM PRDExtrusionControl WHERE ElementoOriginal = @elemento AND FechaOriginal = @fecha AND LineaOriginal = @lineaOriginal AND LoteOriginal = @lote AND TipoProceso = 'Sellado'`);
  if (dtCtrl.recordset.length === 0) return;
  const nIdCtrl = dtCtrl.recordset[0].IdExtrusionControl;

  for (const dr of dtBultos.recordset) {
    const nElem = dr.refsalida;
    const nLin = dr.num_bulto;
    const tLot = String(dr.mes).padStart(2, '0') + String(dr.dia).padStart(2, '0');
    const fFec = new Date(dr.agno, dr.mes - 1, dr.dia);
    const nCant = dr.CantidadTotal != null ? Number(dr.CantidadTotal) : 0;

    const dtExiste = await db.request()
      .input('idCtrl', nIdCtrl).input('elem', nElem).input('fecha', fFec).input('linea', nLin).input('lote', tLot)
      .query(`SELECT 1 AS X FROM PRDExtrusionRollos WHERE IdExtrusionControl = @idCtrl AND Elemento = @elem AND Fecha = @fecha AND Linea = @linea AND Lote = @lote`);

    if (dtExiste.recordset.length === 0) {
      await db.request()
        .input('idCtrl', nIdCtrl).input('elem', nElem).input('fecha', fFec).input('linea', nLin).input('lote', tLot)
        .input('cant', nCant).input('operario', dr.Operario != null ? Number(dr.Operario) : null).input('bolsas', dr.BolsasxGolpe)
        .input('generadoPor', generadoPor)
        .query(`
          INSERT INTO PRDExtrusionRollos (IdExtrusionControl, Elemento, Fecha, Linea, Lote, NumeroSecuencial, PesoBrutoKg, PesoConoKg, ResiduosKg, Operario, BolsasxGolpe, UsuarioCreacion, FechaHoraCreacion)
          VALUES (@idCtrl, @elem, @fecha, @linea, @lote, @linea, @cant, 0, 0, @operario, @bolsas, @generadoPor, GETDATE())
        `);
    } else {
      await db.request()
        .input('idCtrl', nIdCtrl).input('elem', nElem).input('fecha', fFec).input('linea', nLin).input('lote', tLot).input('cant', nCant)
        .query(`UPDATE PRDExtrusionRollos SET PesoBrutoKg = @cant WHERE IdExtrusionControl = @idCtrl AND Elemento = @elem AND Fecha = @fecha AND Linea = @linea AND Lote = @lote`);
    }
  }

  await db.request()
    .input('retal', retalManual).input('torta', tortaManual)
    .input('elemento', nUltimoElemento).input('year', nUltimoAgno).input('lote', tUltimoLote).input('linea', nUltimaLinea)
    .query(`
      UPDATE PRDProduccion SET Retal = @retal, Torta = @torta
      WHERE Elemento = @elemento AND Year(Fecha) = @year AND Lote = @lote AND Linea = @linea
    `);

  try {
    const dtMP = await db.request()
      .input('elemento', nUltimoElemento).input('year', nAgnoOriginal).input('lote', tLoteOriginal).input('linea', nLineaOriginal)
      .query(`SELECT ISNULL(SUM(Cantidad),0) AS TotalMP FROM PRDProduccionMateriaPrima WHERE Elemento = @elemento AND Year(Fecha) = @year AND Lote = @lote AND Linea = @linea`);
    const nTotalMP = dtMP.recordset.length > 0 ? Number(dtMP.recordset[0].TotalMP) : 0;

    const dtRollos = await db.request().input('idCtrl', nIdCtrl).query(`
      SELECT ISNULL(SUM((p.Cantidad - ISNULL(p.PesoCono,0)) + ISNULL(p.Torta,0) + ISNULL(p.ResiduoTroquelado,0) + ISNULL(p.ResiduoRefilado,0)),0) AS Cant
      FROM PRDExtrusionRollos er
      INNER JOIN PRDProduccion p ON p.Elemento=er.Elemento AND p.Fecha=er.Fecha AND p.Lote=er.Lote AND p.Linea=er.Linea
      WHERE er.IdExtrusionControl = @idCtrl
    `);
    const nSalidaRollos = dtRollos.recordset.length > 0 ? Number(dtRollos.recordset[0].Cant) : 0;

    let nMerma = nTotalMP - nSalidaRollos;
    if (nMerma < 0) nMerma = 0;

    await db.request()
      .input('merma', nMerma).input('elemento', nUltimoElemento).input('year', nUltimoAgno).input('lote', tUltimoLote).input('linea', nUltimaLinea)
      .query(`UPDATE PRDProduccion SET Retal = @merma WHERE Elemento = @elemento AND Year(Fecha) = @year AND Lote = @lote AND Linea = @linea`);
  } catch (err) {
    // no bloquear el cierre por esto -- igual que el Catch silencioso de SEL_InventarioMP.vb
  }

  await db.request().input('idCtrl', nIdCtrl).query(`UPDATE PRDExtrusionControl SET Estado = 'Cerrado' WHERE IdExtrusionControl = @idCtrl`);
}

// Source/Produccion/SEL_InventarioMP.vb:GenerarEntradaSellado -- version Node. TIPO=35
// ("Producción"), mismo criterio "un movimiento por dia" (Subempresa/Fecha/Tipo) que
// generarSalidaRollo. La resolucion de numeracion (SISNumeracion, TipoMovimiento=35) se corre
// como UN SOLO batch de SQL (en vez de reimplementar PATINDEX/SUBSTRING/FORMAT a mano en JS) --
// mismo algoritmo exacto que ya vive en nueva produccion/trigger_entrada_bulto_cerrado.sql
// (trg_SEL_Bultos_GenerarEntradaInventario), para no arriesgar una traduccion distinta con bugs
// sutiles de formato.
async function generarEntradaSellado(db, { bodega, detalle, fecha, generadoPor }) {
  const TIPO = 35;

  const dtReg = await db.request().input('detalle', detalle).query(`
    SELECT ie.Costo, ie.UnidadMedida, p.Elemento, p.Cantidad - p.PesoCono AS Cantidad, p.Unidades
    FROM PRDProduccion p INNER JOIN INVElementos ie ON ie.Codigo = p.Elemento
    WHERE p.Detalle = @detalle
  `);
  if (dtReg.recordset.length === 0) return;
  const reg = dtReg.recordset[0];

  let tNumero;
  const dtMov = await db.request().input('fecha', sql.Date, fecha).query(
    `SELECT Numero FROM INVMovimientos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO}`
  );
  if (dtMov.recordset.length > 0) {
    tNumero = dtMov.recordset[0].Numero;
    await db.request().input('fecha', sql.Date, fecha).input('numero', tNumero).input('detalle', detalle).query(
      `DELETE FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero AND Detalle = @detalle`
    );
  } else {
    const dtNum = await db.request().input('fecha', sql.Date, fecha).query(`
      DECLARE @Consecutivo int, @FormatoNumero varchar(50), @LineaNum int, @Concepto varchar(100), @NumeroMov varchar(20);
      SELECT TOP 1 @Consecutivo = Consecutivo, @FormatoNumero = FormatoNumero, @LineaNum = Linea
      FROM SISNumeracion
      WHERE TipoMovimiento = ${TIPO} AND (Subempresa IS NULL OR Subempresa = ${SUBEMPRESA})
        AND Estado = 'Activo' AND Concepto IS NULL AND Dependencia IS NULL
      ORDER BY Subempresa DESC, FechaDesde;

      IF @Consecutivo IS NULL
        RAISERROR('No se encontro numeracion activa (simple) para TipoMovimiento=35.', 16, 1);

      IF @FormatoNumero IS NULL OR @FormatoNumero = ''
        SET @NumeroMov = CAST(@Consecutivo AS varchar(20));
      ELSE
      BEGIN
        DECLARE @PosCero int = PATINDEX('%0%', @FormatoNumero);
        DECLARE @FmtFecha varchar(20) = CASE WHEN @PosCero > 1 THEN LEFT(@FormatoNumero, @PosCero - 1) ELSE '' END;
        DECLARE @FmtNum varchar(20) = CASE WHEN @PosCero > 0 THEN SUBSTRING(@FormatoNumero, @PosCero, LEN(@FormatoNumero)) ELSE @FormatoNumero END;
        SET @NumeroMov = CASE WHEN @FmtFecha <> '' THEN FORMAT(@fecha, @FmtFecha) ELSE '' END
                        + RIGHT(REPLICATE('0', LEN(@FmtNum)) + CAST(@Consecutivo AS varchar(20)), LEN(@FmtNum));
      END

      UPDATE SISNumeracion SET Consecutivo = Consecutivo + 1 WHERE TipoMovimiento = ${TIPO} AND Linea = @LineaNum;
      SELECT @Concepto = Concepto FROM SISTiposMovimiento WHERE Codigo = ${TIPO};

      SELECT @NumeroMov AS NumeroMov, @Concepto AS Concepto;
    `);
    tNumero = dtNum.recordset[0].NumeroMov;
    const concepto = dtNum.recordset[0].Concepto;

    await db.request()
      .input('fecha', sql.Date, fecha).input('numero', tNumero).input('concepto', concepto).input('generadoPor', generadoPor)
      .query(`
        INSERT INTO INVMovimientos (SubEmpresa, Fecha, Tipo, Numero, Concepto, Tercero, Sucursal, GeneradoPor, Observaciones, FechaModificado, Estado)
        VALUES (${SUBEMPRESA}, @fecha, ${TIPO}, @numero, @concepto, 0, 0, @generadoPor, 'Generado Automáticamente (Selladora)', GETDATE(), 'Registrado')
      `);
  }

  const dtLinea = await db.request().input('fecha', sql.Date, fecha).input('numero', tNumero).query(
    `SELECT ISNULL(MAX(Linea), 0) + 1 AS NL FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero`
  );
  const nLinea = dtLinea.recordset[0].NL;

  await db.request()
    .input('fecha', sql.Date, fecha).input('numero', tNumero).input('linea', nLinea).input('bodega', bodega)
    .input('elemento', reg.Elemento).input('unidadMedida', reg.UnidadMedida).input('costo', reg.Costo || 0)
    .input('cantidad', reg.Cantidad).input('unidades', reg.Unidades || 0).input('detalle', detalle)
    .query(`
      INSERT INTO INVMovimientosElementos (SubEmpresa, Fecha, Tipo, Numero, Linea, Bodega, Elemento, UnidadMedida, Costo, Cantidad, Unidades, Detalle)
      VALUES (${SUBEMPRESA}, @fecha, ${TIPO}, @numero, @linea, @bodega, @elemento, @unidadMedida, @costo, @cantidad, @unidades, @detalle)
    `);
}

// Source/Produccion/SEL_InventarioMP.vb:ResolverContextoBultoParaHijo -- info del padre necesaria
// para crear un registro hijo (Retal/Troquelado). Devuelve null si el bulto no existe.
async function resolverContextoBultoParaHijo(db, idBulto) {
  const dtBulto = await db.request().input('idBulto', idBulto).query(`
    SELECT b.agno, b.mes, b.dia, b.num_bulto, b.refsalida, b.id_maquina, b.NumeroPedido,
      b.HoraInicio, b.HoraFin, ej.Operario, ej.IdOrden
    FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE b.id = @idBulto
  `);
  if (dtBulto.recordset.length === 0) return null;
  const b = dtBulto.recordset[0];

  const elemento = b.refsalida;
  const fecha = new Date(b.agno, b.mes - 1, b.dia);
  const lote = String(b.mes).padStart(2, '0') + String(b.dia).padStart(2, '0');
  const lineaPadre = b.num_bulto;
  const maquina = b.id_maquina;
  const idOrden = b.IdOrden;
  const numeroPedido = b.NumeroPedido || 0;
  const horaInicio = b.HoraInicio || fecha;
  const horaFinal = b.HoraFin || new Date();
  const operario = b.Operario || 0;

  const { codCliente } = await resolverClienteDestino(db, numeroPedido);

  // Bodega del residuo hijo: mismo criterio que la version escritorio -- toma un Detalle de
  // materia prima ya consumido en este proceso (anclado a LineaOriginal) y resuelve su bodega.
  const lineaOriginal = await obtenerLineaOriginalControlSellado(db, idOrden, lineaPadre);
  let bodegaHijo = '';
  const dtDetalleMP = await db.request().input('fecha', sql.Date, fecha).input('lote', lote).input('elemento', elemento).input('lineaOriginal', lineaOriginal)
    .query(`SELECT TOP 1 Detalle FROM PRDProduccionMateriaPrima WHERE Fecha = @fecha AND Lote = @lote AND Elemento = @elemento AND Linea = @lineaOriginal`);
  if (dtDetalleMP.recordset.length > 0) bodegaHijo = await obtenerBodegaDeRollo(db, dtDetalleMP.recordset[0].Detalle.trim());

  // Turno: se copia el que ya quedo asignado al padre; si no lo tiene, se resuelve por hora.
  const dtTurnoPadre = await db.request().input('fecha', sql.Date, fecha).input('lote', lote).input('elemento', elemento).input('linea', lineaPadre)
    .query(`SELECT TOP 1 Turno FROM PRDProduccion WHERE Fecha = @fecha AND Lote = @lote AND Elemento = @elemento AND Linea = @linea`);
  let turnoHijo = (dtTurnoPadre.recordset.length > 0 && dtTurnoPadre.recordset[0].Turno) ? dtTurnoPadre.recordset[0].Turno : 0;
  if (turnoHijo <= 0) turnoHijo = await resolverTurnoPorHora(db, maquina, horaInicio);
  if (turnoHijo <= 0) {
    throw new Error(`No se pudo determinar el Turno para el bulto ${lineaPadre} -- corrija la configuracion de turnos (TURHorariosMaquinas) antes de continuar.`);
  }

  return { elemento, fecha, lote, lineaPadre, maquina, idOrden, numeroPedido, horaInicio, horaFinal, operario, codCliente, bodegaHijo, turnoHijo };
}

// Source/Produccion/SEL_InventarioMP.vb:MarcarResiduoHijoPendiente -- llamada por el OPERARIO
// (server.js, botones "Retal"/"Troquelado" de la orden Activa) mientras el bulto sigue Activo --
// marca que este bulto va a tener Retal(1) o Troquelado(3), creando el registro hijo con
// Cantidad=0 como placeholder. El digitador despues escribe la cantidad real en Mirane (escritorio
// -- "Registro de Residuos" no tiene version Node todavia, ver el plan). Idempotente: si el hijo
// ya existe (el operario le dio dos veces, o ya estaba marcado), no hace nada -- no se puede
// "desmarcar" desde aca a proposito, evita borrar sin querer un registro que el digitador ya
// esta llenando.
async function marcarResiduoHijoPendiente(db, { idBulto, tipoResiduo, generadoPor }) {
  const ctx = await resolverContextoBultoParaHijo(db, idBulto);
  if (!ctx) return;
  const { elemento, fecha, lote, lineaPadre, maquina, numeroPedido, horaInicio, horaFinal, operario, codCliente, bodegaHijo, turnoHijo } = ctx;

  const tipoTexto = tipoResiduo === 1 ? 'RETAL' : 'TROQUELADO';
  const linHijo = lineaPadre + 1000 * tipoResiduo;
  const serial = String(fecha.getFullYear()) + String(valNumerico(lote)).padStart(6, '0') + String(linHijo).padStart(4, '0') + String(elemento).padStart(5, '0');

  const dtExiste = await db.request().input('fecha', sql.Date, fecha).input('lote', lote).input('elemento', elemento).input('linea', linHijo)
    .query(`SELECT TOP 1 Linea FROM PRDProduccion WHERE Fecha = @fecha AND Lote = @lote AND Elemento = @elemento AND Linea = @linea`);
  if (dtExiste.recordset.length > 0) return; // ya marcado -- idempotente, no hace nada

  if (!bodegaHijo) {
    throw new Error(`No se pudo determinar la bodega para el registro hijo ${tipoTexto} -- verifique que el proceso tenga materia prima registrada.`);
  }

  await db.request()
    .input('fecha', sql.Date, fecha).input('maquina', maquina).input('turno', turnoHijo).input('lote', lote)
    .input('elemento', elemento).input('linea', linHijo).input('serial', serial)
    .input('codCliente', codCliente > 0 ? codCliente : null).input('tipoTexto', tipoTexto)
    .input('generadoPor', generadoPor).input('horaInicio', horaInicio).input('horaFinal', horaFinal)
    .input('numeroPedido', numeroPedido > 0 ? String(numeroPedido) : null)
    .query(`
      INSERT INTO PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea,
        Cantidad, PesoCono, Unidades, Detalle, ClienteProduccion, Destino,
        Grafilado, Abierto, Servicio, Observaciones,
        GeneradoPor, FechaModificado, HoraInicio, HoraFinal,
        TipoPedido, NumeroPedido)
      VALUES (@fecha, @maquina, @turno, 0, @lote, @elemento, @linea,
        0, 0, NULL, @serial, @codCliente, 16,
        0, 0, 0, @tipoTexto,
        @generadoPor, GETDATE(), @horaInicio, @horaFinal,
        4, @numeroPedido)
    `);

  // Existencia en 0 -- se corrige sola cuando el digitador escriba la cantidad real (mismo
  // criterio que la version escritorio: GenerarResiduoHijoSellado, rama "ya existe -> actualizar").
  const dtNuevaLinea = await db.request().input('bodega', bodegaHijo).input('elemento', elemento)
    .query(`SELECT ISNULL(MAX(Linea),0)+1 AS NL FROM INVExistencias WHERE Bodega = @bodega AND Elemento = @elemento`);
  const nuevaLineaInv = dtNuevaLinea.recordset[0].NL;
  await db.request()
    .input('bodega', bodegaHijo).input('elemento', elemento).input('linea', nuevaLineaInv).input('serial', serial)
    .input('serie', numeroPedido > 0 ? String(numeroPedido) : null)
    .query(`INSERT INTO INVExistencias (Bodega, Elemento, Linea, Cantidad, Unidades, Valor, Detalle, Serie) VALUES (@bodega, @elemento, @linea, 0, 0, 0, @serial, @serie)`);

  await generarEntradaSellado(db, { bodega: bodegaHijo, detalle: serial, fecha, generadoPor });

  if (operario > 0) {
    await db.request().input('fecha', sql.Date, fecha).input('lote', lote).input('elemento', elemento).input('linea', linHijo).input('operario', operario)
      .query(`INSERT INTO PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario) VALUES (@fecha, @lote, @elemento, @linea, @operario)`);
  }
}

module.exports = {
  obtenerBodegaDeRollo,
  obtenerLoteRollo,
  getInicialTipoProductoMP,
  esMateriaPrimaProhibidaSellado,
  registrarMateriaPrimaRollo,
  generarSalidaRollo,
  registrarControlParcialSellado,
  obtenerLineaOriginalControlSellado,
  obtenerFechaLoteOriginalControlSellado,
  resolverTurnoPorHora,
  resolverClienteDestino,
  resolverDestinoOrden,
  obtenerOCrearOrdenProduccion,
  finalizarControlParcialSellado,
  generarEntradaSellado,
  resolverContextoBultoParaHijo,
  marcarResiduoHijoPendiente,
  valNumerico
};
