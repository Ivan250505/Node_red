// Puerto deliberado (no una llamada) de Source/Produccion/SEL_InventarioMP.vb -- solo las
// funciones que usan Iniciar/Añadir Rollo/Finalizar de EjecucionSelladora.vb (Residuos/
// Verificar/Cerrar Definitivo quedan fuera, ver el plan). Cada funcion referencia la linea
// original de SEL_InventarioMP.vb de la que viene.
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

// ─── Movimientos 24 por Orden de Trabajo (23/09/2026, a pedido del usuario) ───────────────────────
// Mismo criterio que Produccion.vb:ObtenerOCrearMovimientoOT: UN movimiento Tipo 24 (salida de MP)
// por OT -- el rollo original y todos los "Añadir Rollo", de cualquier dia, caen en el MISMO
// movimiento, fechado en la linea original de la OT (PRDOrdenesProduccion.Fecha). Antes cada
// "Añadir Rollo" quedaba en otro movimiento (fecha de hoy CON hora y lote de hoy en la Observacion).
// La LLAVE es la columna INVMovimientos.OrdenProduccion (ver
// nueva produccion/orden_trabajo/1_estructura/agregar_ordenproduccion_invmovimientos_23092026.sql) -- no el texto de
// Observaciones, que se puede editar desde Inventario. En Selladora aplica a TODO proceso (siempre
// hay OT, se crea en Iniciar). Respaldo solo para ordenes que ya venian en curso: el movimiento con
// la Observacion vieja y la columna en NULL se adopta (se le llena la columna).
const OBS_SALIDA_MP_OT_SELLADORA = 'Salida Materia Prima Selladora - OT ';

async function obtenerFechaAnclaOT(db, ordenProduccion, fechaDefecto) {
  const dt = await db.request().input('ot', ordenProduccion)
    .query(`SELECT Fecha FROM PRDOrdenesProduccion WHERE OrdenProduccion = @ot`);
  if (dt.recordset.length > 0 && dt.recordset[0].Fecha) return dt.recordset[0].Fecha;
  return fechaDefecto;
}

// Devuelve { numero, fecha } -- fecha es la REAL del movimiento (con la que se escriben las lineas).
async function obtenerOCrearMovimiento24OT(db, { ordenProduccion, fechaDefecto, obsAnterior, fechaAnterior, generadoPor }) {
  const TIPO = 24;
  const tObsOT = OBS_SALIDA_MP_OT_SELLADORA + ordenProduccion;

  let dt = await db.request().input('ot', ordenProduccion).query(`
    SELECT TOP 1 Fecha, Numero FROM INVMovimientos
    WHERE Subempresa = ${SUBEMPRESA} AND Tipo = ${TIPO} AND OrdenProduccion = @ot AND ISNULL(Estado, '') <> 'Anulado'
    ORDER BY Fecha
  `);
  if (dt.recordset.length > 0) return { numero: dt.recordset[0].Numero, fecha: dt.recordset[0].Fecha };

  if (obsAnterior && fechaAnterior) {
    dt = await db.request().input('fecha', sql.Date, fechaAnterior).input('obs', obsAnterior).query(`
      SELECT Numero FROM INVMovimientos
      WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Observaciones = @obs
        AND OrdenProduccion IS NULL AND ISNULL(Estado, '') <> 'Anulado'
    `);
    if (dt.recordset.length > 0) {
      const tNumeroAdoptado = dt.recordset[0].Numero;
      await db.request().input('fecha', sql.Date, fechaAnterior).input('numero', tNumeroAdoptado)
        .input('ot', ordenProduccion).input('obs', tObsOT)
        .query(`
          UPDATE INVMovimientos SET OrdenProduccion = @ot, Observaciones = @obs, FechaModificado = GETDATE()
          WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero
        `);
      return { numero: tNumeroAdoptado, fecha: fechaAnterior };
    }
  }

  const fechaOT = await obtenerFechaAnclaOT(db, ordenProduccion, fechaDefecto);
  const tNumero = await obtenerConsecutivoSalidaProduccion(db);
  const dtConcepto = await db.request().query(`SELECT Concepto FROM SISTiposMovimiento WHERE Codigo = ${TIPO}`);
  await db.request()
    .input('fecha', sql.Date, fechaOT).input('numero', tNumero).input('concepto', dtConcepto.recordset[0].Concepto)
    .input('generadoPor', generadoPor).input('obs', tObsOT).input('ot', ordenProduccion)
    .query(`
      INSERT INTO INVMovimientos (SubEmpresa, Fecha, Tipo, Numero, Concepto, Tercero, Sucursal, GeneradoPor, Observaciones, FechaModificado, Estado, OrdenProduccion)
      VALUES (${SUBEMPRESA}, @fecha, ${TIPO}, @numero, @concepto, 0, 0, @generadoPor, @obs, GETDATE(), 'Registrado', @ot)
    `);
  return { numero: tNumero, fecha: fechaOT };
}

// SEL_InventarioMP.vb:137-236
// ordenProduccion (23/09/2026): con OT, el movimiento es el de la OT (ver obtenerOCrearMovimiento24OT);
// obsAnterior/fechaAnterior = Observacion vieja del proceso, solo para adoptar el movimiento de una
// orden que ya venia en curso. Sin OT, igual que antes.
async function generarSalidaRollo(db, { idOrden, fecha, lote, elementoProducto, linea, detalleRollo, cantidad, generadoPor, ordenProduccion = '', obsAnterior = '', fechaAnterior = null }) {
  if (!detalleRollo || cantidad <= 0 || detalleRollo.length < 5) return;
  const nElementoRollo = parseInt(detalleRollo.slice(-5), 10);
  if (!Number.isFinite(nElementoRollo) || nElementoRollo <= 0) return;

  const TIPO = 24;
  const tObsMovimiento = `Salida Materia Prima Selladora - ${lote} - ${elementoProducto} - ${linea}`;

  let tNumero;
  // Fecha con la que se escriben las lineas: la del movimiento. Con OT se ata como sql.Date (solo
  // dia); sin OT se deja exactamente como antes.
  let fMov = fecha;
  const conFecha = (req) => (ordenProduccion ? req.input('fecha', sql.Date, fMov) : req.input('fecha', fMov));
  if (ordenProduccion) {
    const mov = await obtenerOCrearMovimiento24OT(db, { ordenProduccion, fechaDefecto: fecha, obsAnterior, fechaAnterior, generadoPor });
    tNumero = mov.numero;
    fMov = mov.fecha;
  } else {
    let dt = await db.request().input('fecha', fecha).input('obs', tObsMovimiento)
      .query(`SELECT Numero FROM INVMovimientos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Observaciones = @obs`);

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

  const dtDup = await conFecha(db.request())
    .input('numero', tNumero).input('elemento', nElementoRollo).input('detalle', detalleRollo)
    .query(`SELECT COUNT(*) AS Cnt FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero AND Elemento = @elemento AND Detalle = @detalle`);

  if (dtDup.recordset[0].Cnt === 0) {
    const dtLinea = await conFecha(db.request()).input('numero', tNumero)
      .query(`SELECT ISNULL(MAX(Linea), 0) + 1 AS NL FROM INVMovimientosElementos WHERE Subempresa = ${SUBEMPRESA} AND Fecha = @fecha AND Tipo = ${TIPO} AND Numero = @numero`);
    const nNuevaLinea = dtLinea.recordset[0].NL;

    await conFecha(db.request())
      .input('numero', tNumero).input('linea', nNuevaLinea)
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
// FIX 23/09/2026 (a pedido del usuario -- el bulto nuevo toma la fecha REAL del dia en que abre, ver
// trg_SEL_Bultos_CierreBulto): num_bulto ya se reinicia por dia (igual que Linea en
// Produccion.vb:GuardarNuevoRollo), asi que MIN(num_bulto) dejo de ser el ancla -- el bulto 1 del
// dia siguiente saldria "menor" que el ancla real (ej. 20). El ancla es el PRIMER bulto creado de la
// orden, por id.
async function obtenerLineaOriginalControlSellado(db, idOrden, numBultoActual) {
  const dt = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 b.num_bulto AS MinBulto FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden
    ORDER BY b.id ASC
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
// FIX 23/09/2026: num_bulto se reinicia por dia -- otro dia de la misma orden puede repetir el
// num_bulto del ancla, asi que se desempata por id (el ancla siempre es el primero creado).
async function obtenerFechaLoteOriginalControlSellado(db, idOrden, lineaOriginal) {
  const dt = await db.request().input('idOrden', idOrden).input('lineaOriginal', lineaOriginal).query(`
    SELECT TOP 1 b.agno, b.mes, b.dia FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.num_bulto = @lineaOriginal
    ORDER BY b.id ASC
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

  // FIX 24/09/2026: TipoProceso vuelve a ser 'Sellado' (el PROCESO, igual que Mirane:
  // TipoProcesoParcial, RecalcularMermaSellado, CerrarProcesoSellado). El cambio del 16/09 a
  // 'SELLADORA' (tipo de MAQUINA) dejo los controles de la tablet fuera del cierre y de la merma
  // de Validacion Selladora. La busqueda acepta los dos para los controles que quedaron con
  // 'SELLADORA' (se corrigen con Mirane: nueva produccion/corregir_tipoproceso_selladora_a_sellado_24092026.sql).
  const dtControl = await db.request()
    .input('elemento', elemento).input('fecha', sql.Date, fecha).input('lineaOriginal', nLineaOriginal).input('lote', lote)
    .query(`SELECT IdExtrusionControl FROM PRDExtrusionControl WHERE ElementoOriginal = @elemento AND FechaOriginal = @fecha AND LineaOriginal = @lineaOriginal AND LoteOriginal = @lote AND TipoProceso IN ('Sellado', 'SELLADORA')`);

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

// FIX 08/09/2026 (a pedido del usuario -- antes TipoPedido quedaba fijo en 4 "por defecto", que es
// incorrecto): PRDProduccion.TipoPedido = código de SISListas (Categoria='PRDPedidos') --
// 4=AR-Trazabilidad NTC, 1=RF-Requisición Almacén, 2=PC-Pedido Cliente. Regla:
//   1) Si la referencia de salida es AR/BR (posiciones 2-3, mismo criterio que ConstruirFiltroMP
//      en frmLiberacionProduccion.vb y EsTipoPedidoAR en Produccion.vb) -> 4.
//   2) Si no es AR/BR pero el cliente del pedido es CARLIXPLAST mismo (Tercero=0 en VISTerceros,
//      confirmado con el usuario) -> 1 (Requisición Almacén).
//   3) Si no es AR/BR y el cliente es un tercero real (no Carlixplast) -> 2 (Pedido Cliente).
// codCliente ya viene resuelto por el llamador (resolverClienteDestino) -- no se toca esa función,
// a pedido del usuario, aunque 0 también puede significar "no se resolvió ningún cliente" (mismo
// valor que Carlixplast) -- caso conocido, aceptado tal cual.
async function resolverTipoPedido(db, elemento, codCliente) {
  const dtRef = await db.request().input('elemento', elemento)
    .query(`SELECT Referencia FROM INVElementos WHERE Codigo = @elemento`);
  const tReferencia = dtRef.recordset.length > 0 ? (dtRef.recordset[0].Referencia || '') : '';
  const tPrefijo = tReferencia.length >= 3 ? tReferencia.substring(1, 3).toUpperCase() : '';
  const bEsArBr = tPrefijo === 'AR' || tPrefijo === 'BR';

  if (bEsArBr) return 4;
  if (!codCliente || codCliente === 0) return 1;
  return 2;
}

// SEL_InventarioMP.vb:800-841
// FIX 09/09/2026 (bug real reportado por el usuario -- Pedido 11408 terminó con DOS
// OrdenProduccion/OP distintas, una por cada referencia del grupo, cuando debería ser UNA sola
// para todo el proceso compartido). obtenerOCrearOrdenProduccion busca/crea la OP por
// (Fecha, Lote, Elemento, LineaAncla) -- como cada referencia de un grupo Sellado en paralelo
// tiene su propio Elemento Y su propio LineaAncla (cada una lleva su propia numeración de bultos
// independiente), esa llave nunca coincide entre hermanas, así que cada una terminaba creando su
// propia OP. Esta función resuelve la ANCLA del grupo (la referencia de menor IdOrden, la que
// arrancó con "Iniciar") para que TODOS los miembros usen el Elemento+LineaAncla de la ANCLA al
// pedir la OP -- así conviven bajo la misma OP, sin tocar el esquema de PRDOrdenesProduccion.
// Devuelve null si idOrden no pertenece a ningún grupo SELLADORA (caso normal, sin cambios).
// FIX 13/09/2026 (a pedido del usuario, mismo patrón ya corregido en server.js/scan-rollo.js/
// ejecucion-selladora.js/frmLiberacionProduccion.vb para el bug del pedido 11243): la llave real
// es ord.Linea, no ord.Elemento -- ver el comentario largo en scan-rollo.js:confirmarRollo.
async function obtenerAnclaGrupoSellado(db, idOrden) {
  // Tarjeta #9 (06/10/2026): el grupo puede traer miembros de otros pedidos
  // (PRDGrupoEtapasPedidosExtra, estructura #7). El ancla es el menor IdOrden del conjunto
  // (misma máquina, por construcción del grupo). Sin filas extra, idéntico a antes.
  const dt = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 ord2.IdOrden, ord2.Elemento
    FROM SEL_OrdenProduccion ord1
    INNER JOIN PRDGrupoEtapasCompartidas g ON g.CategoriaMaquina = 'SELLADORA'
      AND (EXISTS (SELECT 1 FROM PRDGrupoEtapasCompartidasLineas gl
                  WHERE gl.IdGrupo = g.IdGrupo AND gl.Linea = ord1.Linea AND g.Numero = ord1.NumeroPedido)
        OR EXISTS (SELECT 1 FROM PRDGrupoEtapasPedidosExtra pe
                  WHERE pe.IdGrupo = g.IdGrupo AND pe.SubEmpresa = g.SubEmpresa AND pe.Tipo = g.Tipo AND pe.Fecha = g.Fecha
                    AND pe.Numero = ord1.NumeroPedido AND pe.Linea = ord1.Linea))
    INNER JOIN (
      SELECT gl2.Linea AS Linea, g2.Numero AS Numero, gl2.IdGrupo AS IdGrupo
      FROM PRDGrupoEtapasCompartidasLineas gl2
      INNER JOIN PRDGrupoEtapasCompartidas g2 ON g2.IdGrupo = gl2.IdGrupo
      UNION
      SELECT pe2.Linea AS Linea, pe2.Numero AS Numero, pe2.IdGrupo AS IdGrupo
      FROM PRDGrupoEtapasPedidosExtra pe2
      INNER JOIN PRDGrupoEtapasCompartidas g3 ON g3.IdGrupo = pe2.IdGrupo
        AND pe2.SubEmpresa = g3.SubEmpresa AND pe2.Tipo = g3.Tipo AND pe2.Fecha = g3.Fecha
    ) gm ON gm.IdGrupo = g.IdGrupo
    INNER JOIN SEL_OrdenProduccion ord2 ON ord2.Linea = gm.Linea AND ord2.NumeroPedido = gm.Numero
      AND ord2.Maquina = ord1.Maquina
    WHERE ord1.IdOrden = @idOrden
    ORDER BY ord2.IdOrden ASC
  `);
  return dt.recordset.length > 0 ? dt.recordset[0] : null;
}

async function obtenerOCrearOrdenProduccion(db, { elemento, fecha, lineaAncla, lote, codigoDestino, maquina, turno, generadoPor, idEjecucion }) {
  try {
    // FIX 16/09/2026 (REVERTIDO el intento anterior de "reintentar tras choque" -- causaba
    // "transaccion abortada" bloqueando Iniciar/Cerrar bulto completos): tanto scan-rollo.js como
    // ejecucion-selladora.js llaman esta funcion con una TRANSACCION activa (tx). Si el INSERT de
    // mas abajo choca contra UQ_PRDOrdenesProduccion_Ancla/_Codigo, la transaccion del paquete
    // mssql queda abortada (XACT_ABORT ON por defecto en Transaction) -- CUALQUIER consulta
    // posterior sobre esa misma tx (incluido un reintento) revienta con "transaccion abortada",
    // tumbando TODO el resto del Iniciar/Cerrar, no solo esta funcion. La solucion correcta es
    // EVITAR la carrera, no recuperarse despues del choque: WITH (UPDLOCK, HOLDLOCK) toma un lock
    // de actualizacion sobre esta clave (Fecha,Lote,Elemento,LineaAncla) que se mantiene hasta que
    // termine la transaccion -- una segunda llamada concurrente para la MISMA clave queda
    // bloqueada (esperando) en este SELECT hasta que la primera haga COMMIT, y en ese momento ve
    // la fila ya insertada y la reutiliza -- nunca llega a intentar el INSERT duplicado.
    // FIX 16/09/2026 (ver DIAGNOSTICO_FINALIZAR_ORDEN.md -- "Conversion failed when converting
    // date and/or time from character string" real, todavia sin causa raiz identificada del todo):
    // se tipa explicito sql.Date en vez de dejar que mssql infiera el tipo del objeto Date de JS --
    // es la causa mas comun de esa conversion fallida (si la inferencia no da con DateTime/Date,
    // tedious puede terminar mandando el valor como texto, y SQL Server no siempre lo puede
    // convertir de vuelta). Mismo tipo en el SELECT y en el INSERT de mas abajo para que no haya
    // ninguna diferencia de comportamiento entre los dos usos de "fecha".
    const dtExiste = await db.request()
      .input('fecha', sql.Date, fecha).input('lote', lote).input('elemento', elemento).input('lineaAncla', lineaAncla)
      .query(`SELECT OrdenProduccion FROM PRDOrdenesProduccion WITH (UPDLOCK, HOLDLOCK) WHERE Fecha = @fecha AND Lote = @lote AND Elemento = @elemento AND LineaAncla = @lineaAncla`);
    if (dtExiste.recordset.length > 0) return dtExiste.recordset[0].OrdenProduccion;

    // FIX 22/09/2026 (a pedido del usuario, reunion 22/09 -- mismo cambio portado a
    // ObtenerOCrearOrdenProduccion en Produccion.vb): "OP" vuelve a ser "OT" y el serial cambia de
    // raiz -- ya NO usa el Destino, usa la Maquina (sigla de PRDMaquinas.LetraSerial+CodigoSerial)
    // y el Turno (letra de NOMTurnos.LetraSerial). Formato nuevo, ejemplo "OT20260922S005M01":
    //   OT + Año(4) + Lote/MesDia(4) + LetraMaquina+CodigoMaquina(1+3) + LetraTurno(1) + Consecutivo(2)
    // Si la maquina/turno todavia no tiene su LetraSerial/CodigoSerial asignado, esos pedazos del
    // codigo quedan en blanco (no se inventan) -- mismo criterio que el lado VB.
    let tSiglaMaquina = '';
    if (maquina > 0) {
      const dtMaq = await db.request().input('maquina', maquina)
        .query(`SELECT ISNULL(LetraSerial,'') AS LetraSerial, ISNULL(CodigoSerial,'') AS CodigoSerial FROM PRDMaquinas WHERE Codigo = @maquina`);
      if (dtMaq.recordset.length > 0) tSiglaMaquina = (dtMaq.recordset[0].LetraSerial || '') + (dtMaq.recordset[0].CodigoSerial || '');
    }

    let tLetraTurno = '';
    if (turno > 0) {
      const dtTurno = await db.request().input('turno', turno)
        .query(`SELECT ISNULL(LetraSerial,'') AS LetraSerial FROM NOMTurnos WHERE Codigo = @turno`);
      if (dtTurno.recordset.length > 0) tLetraTurno = dtTurno.recordset[0].LetraSerial || '';
    }

    // El consecutivo ahora se agrupa por (Fecha, Maquina, Turno) -- antes era por (Lote, Destino) y
    // no tenia en cuenta la maquina, mezclando procesos de maquinas distintas en la misma secuencia.
    const dtCons = await db.request().input('fecha', sql.Date, fecha).input('maquina', maquina).input('turno', turno)
      .query(`SELECT ISNULL(MAX(Consecutivo), 0) + 1 AS NC FROM PRDOrdenesProduccion WHERE Fecha = @fecha AND Maquina = @maquina AND Turno = @turno`);
    const nConsecutivo = dtCons.recordset[0].NC;

    const tOP = `OT-${fecha.getFullYear()}${lote}${tSiglaMaquina}${tLetraTurno}${String(nConsecutivo).padStart(2, '0')}`;

    // FIX 15/09/2026 (a pedido del usuario): HoraInicioReal NO es GETDATE() -- el trabajo real
    // empieza en el alistamiento/limpieza del protocolo de arranque (pasos 1-2), que corren ANTES
    // de que exista esta OT (SEL_TiempoMuerto ya tiene filas para esta id_ejecucion, pero sin
    // OrdenProduccion todavia porque no habia a que asociarlas). Se busca la hora MAS ANTIGUA de
    // esos registros y esa es la que se usa como inicio real; solo si no hay ninguno (se salto el
    // protocolo) se cae a GETDATE().
    let fHoraInicioReal = null;
    if (idEjecucion) {
      const dtPrimerTM = await db.request().input('idEjecucion', idEjecucion)
        .query(`SELECT MIN(HoraInicio) AS PrimeraHora FROM SEL_TiempoMuerto WHERE id_ejecucion = @idEjecucion`);
      fHoraInicioReal = dtPrimerTM.recordset[0].PrimeraHora || null;
    }

    // FIX 15/09/2026 (Fase 1 del plan de Orden de Trabajo, a pedido del usuario -- mismo cambio
    // portado a Produccion.vb): Estado/HoraInicioReal al crear la OT -- ver
    // agregar_estado_horas_ordenesproduccion.sql (Source/Produccion/nueva produccion). NO se toca
    // el lookup de arriba (WHERE Fecha/Lote/Elemento/LineaAncla) ni obtenerAnclaGrupoSellado.
    // El UPDLOCK/HOLDLOCK del SELECT de arriba ya evita la carrera -- este INSERT no deberia
    // volver a chocar contra UQ_PRDOrdenesProduccion_Ancla/_Codigo en uso normal.
    await db.request()
      .input('op', tOP).input('lote', lote).input('destino', codigoDestino).input('consecutivo', nConsecutivo)
      .input('fecha', sql.Date, fecha).input('elemento', elemento).input('lineaAncla', lineaAncla).input('generadoPor', generadoPor)
      .input('horaInicioReal', sql.DateTime, fHoraInicioReal).input('maquina', maquina).input('turno', turno)
      .query(`
        INSERT INTO PRDOrdenesProduccion (OrdenProduccion, Lote, Destino, Consecutivo, Fecha, Elemento, LineaAncla, TipoProceso, GeneradoPor, FechaCreacion, Estado, HoraInicioReal, Maquina, Turno)
        VALUES (@op, @lote, @destino, @consecutivo, @fecha, @elemento, @lineaAncla, 'Sellado', @generadoPor, GETDATE(), 'Activa', ISNULL(@horaInicioReal, GETDATE()), @maquina, @turno)
      `);

    // FIX 15/09/2026 (a pedido del usuario): backfill -- los SEL_TiempoMuerto de esta ejecucion
    // que quedaron con OrdenProduccion NULL (limpieza/alistamiento previos, ver arriba) ya pueden
    // asociarse a la OT recien creada. Requiere SEL_TiempoMuerto.OrdenProduccion (ver
    // sql/pendientes/20260915_agregar_ordenproduccion_tiempomuerto.sql).
    if (idEjecucion) {
      await db.request().input('idEjecucion', idEjecucion).input('op', tOP)
        .query(`UPDATE SEL_TiempoMuerto SET OrdenProduccion = @op WHERE id_ejecucion = @idEjecucion AND OrdenProduccion IS NULL`);
    }

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
      b.id_maquina, ej.Operario, ISNULL(ej.BolsasxGolpe,0) AS BolsasxGolpe,
      ISNULL(pv.Validado, 0) AS Validado, pv.Cantidad AS CantidadValidada
    FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    -- FIX 30/09/2026 (a pedido del usuario): los bultos se validan uno a uno a medida que salen
    -- (frmValidacionSelladora), ANTES de que el operario dé Finalizar. Este Finalizar recalculaba
    -- PRDProduccion con el peso del PLC y pisaba lo validado (Cantidad/Unidades/TipoPedido/Cliente...),
    -- dejando PRDProduccion descuadrado contra INVExistencias (pedidos 11731 y 11940). Ahora Finalizar
    -- no reescribe ningún bulto existente; Validado/Cantidad solo se leen para el peso de un rollo que falte.
    OUTER APPLY (SELECT TOP 1 p.Validado, p.Cantidad FROM PRDProduccion p WHERE p.Detalle = b.serialPadre) pv
    WHERE ej.IdOrden = @idOrden AND b.estado = 'Cerrado'
    ORDER BY b.id ASC
  `);
  if (dtBultos.recordset.length === 0) return;

  // FIX 23/09/2026 (a pedido del usuario): los bultos de una misma orden ya pueden tener fechas/Lotes
  // distintos (el trigger de cierre abre cada bulto nuevo con la fecha real del dia, y num_bulto se
  // reinicia por dia) -- el orden cronologico real es por id, y el ancla del proceso (Fecha/Lote/
  // Linea original) es el PRIMER bulto creado, no el de menor num_bulto. Se resuelve aca, antes del
  // loop, para poder estampar LoteOriginal/FechaOriginal en las filas de PRDProduccion que se creen
  // abajo -- misma convencion que Produccion.vb:GuardarNuevoRollo (NULL en la fila ancla, lleno en
  // todas las demas).
  const dtPrimero = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 b.id, b.agno, b.mes, b.dia, b.num_bulto, b.NumeroPedido, b.id_maquina, b.HoraInicio, b.HoraFin FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden
    ORDER BY b.id ASC
  `);
  const anclaBulto = dtPrimero.recordset.length > 0 ? dtPrimero.recordset[0] : null;

  let nUltimoElemento = 0, nUltimoAgno = 0, tUltimoLote = '', nUltimaLinea = 0;

  const dtClienteOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT TOP 1 Cliente FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden AND Cliente IS NOT NULL`);
  const nCodClienteOrden = dtClienteOrden.recordset.length > 0 ? dtClienteOrden.recordset[0].Cliente : 0;

  // FIX 31/08/2026 (bug real encontrado -- pedidos alfanumericos como "A0003" nunca resolvian
  // Destino): NumeroPedido se toma de SEL_OrdenProduccion (siempre texto, la fuente confiable) en
  // vez de SEL_Bultos.NumeroPedido (columna INT que queda en null para pedidos alfanumericos) --
  // mismo criterio que SEL_InventarioMP.vb:FinalizarControlParcialSellado.
  const dtPedidoOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT TOP 1 NumeroPedido FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden AND NumeroPedido IS NOT NULL`);
  const tNumeroPedidoOrden = dtPedidoOrden.recordset.length > 0 ? String(dtPedidoOrden.recordset[0].NumeroPedido) : '';

  for (const dr of dtBultos.recordset) {
    const nElemento = dr.refsalida;
    const nAgno = dr.agno, nMes = dr.mes, nDia = dr.dia;
    const fFechaBulto = new Date(nAgno, nMes - 1, nDia);
    const tLoteBulto = String(nMes).padStart(2, '0') + String(nDia).padStart(2, '0');
    const nLinea = dr.num_bulto;
    const tSerial = dr.serialPadre;
    const nCantidad = dr.CantidadTotal != null ? Number(dr.CantidadTotal) : 0;
    // FIX 31/08/2026: SEL_Bultos.NumeroPedido paso de INT a VARCHAR(20) -- ya se lee como texto
    // directo, sin Number() (que antes descartaba en silencio pedidos alfanumericos como "A0003").
    const tNumeroPedidoBulto = dr.NumeroPedido != null ? String(dr.NumeroPedido) : '';
    const nMaquina = dr.id_maquina;
    const nOperario = dr.Operario != null ? Number(dr.Operario) : 0;
    const nBolsasxGolpe = dr.BolsasxGolpe;
    // FIX 24/08/2026 (REVERTIDO 13/09/2026, a pedido del usuario -- "Modificar cantidad de
    // bolsas"): antes Unidades = NumPaqu x 100 fijo (mismo criterio que SEL_InventarioMP.vb en el
    // escritorio, que también hay que corregir aparte). Ahora suma el UnidadesPaquete real de cada
    // paquete del bulto (SEL_PesajeElemento.UnidadesPaquete, DEFAULT 100 -- ver
    // agregar_unidadespaquete_pesajeelemento.sql) -- sigue dando exactamente NumPaqu x 100 para
    // cualquier bulto donde nadie corrigió nada, solo deja de ser una multiplicación ciega.
    const dtUnidadesBulto = await db.request().input('idBulto', dr.id).query(
      `SELECT ISNULL(SUM(ISNULL(UnidadesPaquete, 100)), 0) AS Total FROM SEL_PesajeElemento WHERE id_bulto = @idBulto`
    );
    const nUnidades = Number(dtUnidadesBulto.recordset[0].Total);
    const fHoraIni = dr.HoraInicio;
    const fHoraFin = dr.HoraFin;
    const fHoraTurno = fHoraFin || fHoraIni || new Date();

    const nCodCliente = nCodClienteOrden;
    const nCodDestino = await resolverDestinoOrden(db, idOrden, tNumeroPedidoOrden);

    const dtYaExiste = await db.request().input('serial', tSerial).query(`SELECT 1 AS X FROM PRDProduccion WHERE Detalle = @serial`);
    const nDuracion = dateDiffMinutos(fHoraIni, fHoraFin);

    // FIX 30/09/2026 (a pedido del usuario): Finalizar YA NO recalcula PRDProduccion de los bultos que
    // ya tienen su fila. Antes hacía UPDATE de Cantidad/Unidades/Duracion/HoraFinal/Cliente/Destino y
    // TipoPedido fijo en 4 con el peso del PLC, y pisaba lo que el digitador ya había validado bulto a
    // bulto (pedidos 11731 y 11940: PRDProduccion quedó descuadrado contra INVExistencias). Esos datos
    // ya los deja trg_SEL_Bultos_CierreBulto al cerrar cada bulto, y la Validación los corrige. Aquí
    // solo se crea la fila si por algún motivo falta (respaldo), sin tocar las existentes.
    if (dtYaExiste.recordset.length === 0) {
      const nTurno = await resolverTurnoPorHora(db, nMaquina, fHoraTurno);
      const nTipoPedido = await resolverTipoPedido(db, nElemento, nCodCliente);
      // FIX 23/09/2026: LoteOriginal/FechaOriginal apuntan al ancla del proceso, salvo en la propia
      // fila ancla (queda NULL, esa fila ES el original) -- ver comentario de anclaBulto arriba.
      const esAncla = !anclaBulto || anclaBulto.id === dr.id;
      await db.request()
        .input('fecha', fFechaBulto).input('maquina', nMaquina).input('turno', nTurno > 0 ? String(nTurno) : null)
        .input('duracion', nDuracion).input('lote', tLoteBulto).input('elemento', nElemento).input('linea', nLinea)
        .input('cantidad', nCantidad).input('unidades', nUnidades).input('serial', tSerial)
        .input('cliente', nCodCliente > 0 ? nCodCliente : null).input('destino', nCodDestino > 0 ? nCodDestino : null)
        .input('generadoPor', generadoPor).input('horaIni', fHoraIni || null).input('horaFin', fHoraFin || null)
        .input('bolsas', nBolsasxGolpe).input('tipoPedido', nTipoPedido)
        .input('numeroPedido', tNumeroPedidoBulto || null)
        .input('loteOriginal', esAncla ? null : String(anclaBulto.mes).padStart(2, '0') + String(anclaBulto.dia).padStart(2, '0'))
        .input('fechaOriginal', sql.Date, esAncla ? null : new Date(anclaBulto.agno, anclaBulto.mes - 1, anclaBulto.dia))
        .query(`
          INSERT INTO PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
            ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor, FechaModificado, HoraInicio, HoraFinal,
            Torta, BolsasxGolpe, TipoPedido, NumeroPedido, LoteOriginal, FechaOriginal)
          VALUES (@fecha, @maquina, @turno, @duracion, @lote, @elemento, @linea, @cantidad, 0, @unidades, @serial,
            @cliente, @destino, 0, 0, 0, 0, @generadoPor, GETDATE(), @horaIni, @horaFin,
            0, @bolsas, @tipoPedido, @numeroPedido, @loteOriginal, @fechaOriginal)
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

  // dtPrimero (ancla por id) ya se resolvio antes del loop -- ver FIX 23/09/2026 arriba.
  if (dtPrimero.recordset.length === 0) return;

  const nAgnoOriginal = dtPrimero.recordset[0].agno;
  const nLineaOriginal = dtPrimero.recordset[0].num_bulto;
  const fFechaOriginal = new Date(nAgnoOriginal, dtPrimero.recordset[0].mes - 1, dtPrimero.recordset[0].dia);
  // FIX 16/09/2026 (ver DIAGNOSTICO_FINALIZAR_ORDEN.md): si agno/mes/dia viniera NULL en SEL_Bultos
  // (bulto viejo/incompleto -- este idOrden en particular ya tuvo un incidente de datos mezclados,
  // ver FIX 09/09/2026 mas abajo en el archivo), fFechaOriginal sale "Invalid Date" en silencio y
  // recien revienta mucho mas adelante como "Conversion failed..." dentro del INSERT de la OT,
  // con el rollo() tapando el mensaje real. Cortar aca con un error claro en vez de dejar que
  // arrastre un dato corrupto.
  if (isNaN(fFechaOriginal.getTime())) {
    throw new Error(`SEL_Bultos con agno/mes/dia inválido para IdOrden=${idOrden} (num_bulto=${nLineaOriginal}) -- no se puede resolver la fecha original para crear la Orden de Trabajo.`);
  }
  const tLoteOriginal = String(dtPrimero.recordset[0].mes).padStart(2, '0') + String(dtPrimero.recordset[0].dia).padStart(2, '0');
  // FIX 31/08/2026: reusa tNumeroPedidoOrden (SEL_OrdenProduccion, confiable) en vez de releer
  // SEL_Bultos.NumeroPedido -- mismo criterio que la otra llamada a resolverDestinoOrden mas arriba.
  const nCodDestinoOriginal = await resolverDestinoOrden(db, idOrden, tNumeroPedidoOrden);
  // FIX 22/09/2026: Maquina/Turno del ancla (el PRIMER bulto, no el ultimo procesado en el loop de
  // arriba) -- mismo criterio que el resto de esta funcion resuelve la ancla por nLineaOriginal.
  const nMaquinaOriginal = dtPrimero.recordset[0].id_maquina;
  const fHoraTurnoOriginal = dtPrimero.recordset[0].HoraFin || dtPrimero.recordset[0].HoraInicio || fFechaOriginal;
  const nTurnoOriginal = await resolverTurnoPorHora(db, nMaquinaOriginal, fHoraTurnoOriginal);
  // Tarjeta #9 (06/10/2026): reutilizar la OT del ancla del grupo en vez de recalcularla con
  // el Elemento/Línea del miembro (eso creaba una OT extra por cada referencia no-ancla al
  // Finalizar). Solo crea si el ancla aún no tiene.
  let tOP = null;
  const anclaGrupoFin = await obtenerAnclaGrupoSellado(db, idOrden);
  if (anclaGrupoFin) {
    const dtOTAncla = await db.request().input('idOrden', anclaGrupoFin.IdOrden).query(`
      SELECT TOP 1 pp.OrdenProduccion FROM SEL_Bultos b
      INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND pp.OrdenProduccion IS NOT NULL
      ORDER BY b.id DESC`);
    if (dtOTAncla.recordset.length > 0) tOP = dtOTAncla.recordset[0].OrdenProduccion;
  }
  if (!tOP) tOP = await obtenerOCrearOrdenProduccion(db, {
    elemento: nUltimoElemento, fecha: fFechaOriginal, lineaAncla: nLineaOriginal, lote: tLoteOriginal,
    codigoDestino: nCodDestinoOriginal, maquina: nMaquinaOriginal, turno: nTurnoOriginal > 0 ? nTurnoOriginal : null,
    generadoPor
  });
  if (tOP) {
    await db.request().input('op', tOP).input('idOrden', idOrden).query(`
      UPDATE p SET p.OrdenProduccion = @op
      FROM PRDProduccion p
      INNER JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND b.estado = 'Cerrado'
        -- FIX 30/09/2026: solo se completa la OT donde falta; no se reasigna la que ya tiene el bulto.
        AND p.OrdenProduccion IS NULL
    `);
    // FIX 15/09/2026 (Fase 1, a pedido del usuario): registra HoraFinReal en cada Finalizar.
    // A PROPOSITO no se toca Estado aqui -- cuando la OT es compartida por un grupo Sellado en
    // paralelo (obtenerAnclaGrupoSellado), finalizar UNA referencia no significa que las demas
    // del grupo tambien terminaron; marcar Estado='Finalizada' aqui podria cerrar en falso una OT
    // que otra referencia hermana sigue usando. Queda pendiente de definir el criterio de "grupo
    // completo finalizado" antes de tocar Estado. HoraFinReal si es seguro: es solo timestamp del
    // ultimo cierre, sin efecto en reportes que dependan de Estado.
    // FIX 24/09/2026 (a pedido del usuario -- "una OT activa por maquina", sin agregar restriccion en
    // Node): la OT pasa a 'PendienteValidacion' (no 'Finalizada'): la maquina queda libre y el cierre
    // real lo hace el digitador en Validacion Selladora (Mirane: CerrarProcesoSellado ->
    // SincronizarEstadoOT, que la deja 'Finalizada' cuando TODOS sus controles quedan cerrados y
    // conserva esta HoraFinReal). Seguro en sellado en paralelo: finalizarOrden finaliza a la vez todas
    // las referencias activas del grupo que comparten la OT. 'Suspendida' no se toca.
    await db.request().input('op', tOP).query(`
      UPDATE PRDOrdenesProduccion
      SET HoraFinReal = GETDATE(),
          Estado = CASE WHEN Estado = 'Activa' THEN 'PendienteValidacion' ELSE Estado END
      WHERE OrdenProduccion = @op
    `);
  }

  const dtCtrl = await db.request()
    .input('elemento', nUltimoElemento).input('fecha', fFechaOriginal).input('lineaOriginal', nLineaOriginal).input('lote', tLoteOriginal)
    .query(`SELECT IdExtrusionControl FROM PRDExtrusionControl WHERE ElementoOriginal = @elemento AND FechaOriginal = @fecha AND LineaOriginal = @lineaOriginal AND LoteOriginal = @lote AND TipoProceso IN ('Sellado', 'SELLADORA')`);
  if (dtCtrl.recordset.length === 0) return;
  const nIdCtrl = dtCtrl.recordset[0].IdExtrusionControl;

  // FIX 24/09/2026: el control tambien queda 'PendienteValidacion' (antes seguia 'EnProceso' hasta que el
  // digitador cerraba). CerrarProcesoSellado (Mirane) lo cierra sin mirar el estado previo.
  await db.request().input('idCtrl', nIdCtrl).query(`
    UPDATE PRDExtrusionControl SET Estado = 'PendienteValidacion', FechaUltimaModificacion = GETDATE()
    WHERE IdExtrusionControl = @idCtrl AND Estado = 'EnProceso'
  `);

  for (const dr of dtBultos.recordset) {
    const nElem = dr.refsalida;
    const nLin = dr.num_bulto;
    const tLot = String(dr.mes).padStart(2, '0') + String(dr.dia).padStart(2, '0');
    const fFec = new Date(dr.agno, dr.mes - 1, dr.dia);
    // FIX 30/09/2026: bulto validado -> el peso del rollo es el validado (PRDProduccion.Cantidad), no el del PLC.
    const nCant = Number(dr.Validado) === 1 && dr.CantidadValidada != null
      ? Number(dr.CantidadValidada)
      : (dr.CantidadTotal != null ? Number(dr.CantidadTotal) : 0);

    const dtExiste = await db.request()
      .input('idCtrl', nIdCtrl).input('elem', nElem).input('fecha', fFec).input('linea', nLin).input('lote', tLot)
      .query(`SELECT 1 AS X FROM PRDExtrusionRollos WHERE IdExtrusionControl = @idCtrl AND Elemento = @elem AND Fecha = @fecha AND Linea = @linea AND Lote = @lote`);

    if (dtExiste.recordset.length === 0) {
      await db.request()
        .input('idCtrl', nIdCtrl).input('elem', nElem).input('fecha', fFec).input('linea', nLin).input('lote', tLot)
        .input('cant', nCant).input('operario', dr.Operario != null ? Number(dr.Operario) : null).input('bolsas', dr.BolsasxGolpe)
        .input('generadoPor', generadoPor)
        // FIX 23/09/2026: NumeroSecuencial ya no puede ser la Linea -- con num_bulto reiniciado por
        // dia, dos bultos del mismo control (dias distintos) pueden compartir Linea. Se usa el
        // siguiente consecutivo del control, igual que trg_SEL_Bultos_CierreBulto.
        .query(`
          INSERT INTO PRDExtrusionRollos (IdExtrusionControl, Elemento, Fecha, Linea, Lote, NumeroSecuencial, PesoBrutoKg, PesoConoKg, ResiduosKg, Operario, BolsasxGolpe, UsuarioCreacion, FechaHoraCreacion)
          SELECT @idCtrl, @elem, @fecha, @linea, @lote, ISNULL(MAX(NumeroSecuencial), 0) + 1, @cant, 0, 0, @operario, @bolsas, @generadoPor, GETDATE()
          FROM PRDExtrusionRollos WHERE IdExtrusionControl = @idCtrl
        `);
    }
    // FIX 30/09/2026: si el rollo ya existe no se le vuelve a escribir el peso (antes UPDATE con el
    // peso del PLC). Tampoco se pone Retal/Torta = 0 en el último bulto (lo hacía siempre, con 0 fijo
    // desde finalizarOrden): los residuos los registra el digitador y Finalizar no debe borrarlos.
  }

  // CAMBIO 31/08/2026 (bug real encontrado -- Finalizar desde la tablet calculaba Merma y cerraba
  // PRDExtrusionControl, cuando ya no debe hacerlo): esta funcion es el puerto de
  // SEL_InventarioMP.vb:FinalizarControlParcialSellado, y ese lado YA se corrigio para que
  // Finalizar (el operario, en planta) solo deje la orden en 'PendienteValidacion' -- el calculo
  // de Merma y el cierre real de PRDExtrusionControl se movieron a "Cerrar Definitivo"
  // (frmValidacionSelladora.vb:HandleCerrar), que sigue siendo exclusivamente del escritorio.
  // Este cambio nunca se replico aca -- Finalizar desde la tablet seguia calculando Merma y
  // cerrando el proceso en el mismo paso, adelantandose al digitador. Se saca ese bloque
  // completo (antes calculaba Merma y hacia UPDATE PRDExtrusionControl SET Estado='Cerrado' acá
  // mismo) -- ahora ninguna ruta de Node cierra PRDExtrusionControl, solo "Cerrar Definitivo" en
  // el escritorio.
}

// ============================ Bitacora de turno ============================
// MOVIDO de server.js a este modulo el 13/09/2026 (a pedido del usuario -- "debería tambien no
// solo al retomar, al iniciar, porque ahi es donde se toma el alistamiento") para que
// scan-rollo.js:crearBultoInicial (el flujo de "Iniciar") tambien pueda abrir la bitacora, no solo
// tomar-control-ejecucion (server.js, el flujo de "retomar/ceder la maquina entre operarios") --
// server.js no se puede requerir desde scan-rollo.js sin crear un require circular (server.js ya
// requiere scan-rollo.js), asi que el punto en comun tiene que vivir aca abajo en la cadena. Nada
// de la logica cambio en el traslado -- ver agregar_bitacora_turno.sql para el porque de la tabla.

// Turnos que se usan cuando la maquina no tiene ninguno cargado en TURHorariosMaquinas (en
// produccion pasa con 4 de las 16 selladoras: 03, 08, 09 y 12 -- comprobado el 12/09/2026). Son los
// tres de 8 horas que si tienen asignados las otras 12, todas con las mismas cinco franjas.
// Ver la NOTA SOBRE EL TURNO en agregar_bitacora_turno.sql.
const TURNOS_BASE_SELLADORA = [6, 7, 8];

// 'HH:MM' -> minutos desde medianoche. NOMTurnos.HoraInicial/HoraFinal y
// TURHorariosMaquinas.HoraInicio/HoraFin son varchar, no time.
function minutosDelDia(hhmm) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  const minutos = Number(m[1]) * 60 + Number(m[2]);
  return minutos >= 0 && minutos < 1440 ? minutos : null;
}

// Fecha local en 'YYYY-MM-DD'. Se manda como TEXTO a la columna DATE: pasar un Date de JS deja que
// el driver lo convierta a UTC y un turno abierto a las 21:30 terminaria imputado al dia siguiente.
function fechaISOLocal(fecha) {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Turno en el que cae `momento` para una maquina, deducido de su horario (decision del usuario,
// 12/09/2026). Devuelve { turno, descripcion, fechaTurno } -- turno/descripcion en null si no hay
// ninguna franja que contenga esa hora (la bitacora igual se abre: tiene operario, maquina y horas).
//
// Las DOS reglas que no salen de ninguna tabla y que hay que conocer antes de tocar esto:
//   - Los horarios SE SOLAPAN (la SELLADORA 04 tiene Tarde 14:00-22:00 y Pleno Noche 18:00-05:45 a
//     la vez). Desempata la franja MAS CORTA: los turnos "Pleno" son jornadas extendidas montadas
//     encima de los tres turnos normales de 8 horas, y el ordinario es el que la planta usa por
//     defecto.
//   - Si la maquina no tiene horarios, se usan los tres turnos base (TURNOS_BASE_SELLADORA).
// Si alguna de las dos no es lo que quiere la planta, lo correcto es arreglar los DATOS antes que
// este codigo -- ver agregar_bitacora_turno.sql.
async function resolverTurnoMaquina(p, maquinaCodigo, momento) {
  const cuando = momento ? new Date(momento) : new Date();
  // FIX 26/09/2026 (a pedido del usuario): solo los turnos ACTIVOS (Activo = 1) de la máquina, igual
  // que el primer bulto (resolverTurnoPorHora) y trg_SEL_Bultos_CierreBulto -- antes miraba TODOS los
  // horarios y, con turnos plenos activos, la bitácora quedaba en Mañana mientras los bultos iban a
  // Pleno Día. El turno activo lo escoge el operario al Iniciar / tomar control (ver
  // candidatosTurnoMaquina / activarTurnoMaquina). Si la máquina no tiene ningún horario
  // configurado se siguen usando los turnos base, como antes.
  const dtHorarios = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT th.CodigoTurno AS Codigo, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  let franjas = dtHorarios.recordset.length > 0
    ? dtHorarios.recordset.filter(f => Number(f.Activo) === 1)
    : [];
  if (dtHorarios.recordset.length === 0) {
    const dtBase = await p.request().query(`
      SELECT Codigo, Descripcion, HoraInicial AS HoraInicio, HoraFinal AS HoraFin
      FROM NOMTurnos WHERE Codigo IN (${TURNOS_BASE_SELLADORA.join(',')})
    `);
    franjas = dtBase.recordset;
  }

  const minutosAhora = cuando.getHours() * 60 + cuando.getMinutes();
  const candidatas = franjas.map(f => {
    const ini = minutosDelDia(f.HoraInicio);
    const fin = minutosDelDia(f.HoraFin);
    if (ini == null || fin == null) return null;
    // fin <= ini => la franja cruza medianoche (22:00-06:00).
    const cruzaMedianoche = fin <= ini;
    const contiene = cruzaMedianoche ? (minutosAhora >= ini || minutosAhora < fin) : (minutosAhora >= ini && minutosAhora < fin);
    if (!contiene) return null;
    return {
      codigo: f.Codigo,
      descripcion: f.Descripcion,
      duracion: cruzaMedianoche ? (1440 - ini + fin) : (fin - ini),
      // Estamos en el pedazo DESPUES de medianoche de un turno que empezo ayer.
      despuesDeMedianoche: cruzaMedianoche && minutosAhora < fin
    };
  }).filter(Boolean);

  if (candidatas.length === 0) {
    return { turno: null, descripcion: null, fechaTurno: fechaISOLocal(cuando) };
  }
  candidatas.sort((a, b) => a.duracion - b.duracion);
  const elegida = candidatas[0];

  // El turno de la noche que arranco ayer se imputa a AYER, no al dia del reloj: los bultos de las
  // 2 a.m. son del turno de anoche, que es como los cuenta la planta.
  const fechaBase = new Date(cuando);
  if (elegida.despuesDeMedianoche) fechaBase.setDate(fechaBase.getDate() - 1);

  return { turno: elegida.codigo, descripcion: elegida.descripcion, fechaTurno: fechaISOLocal(fechaBase) };
}

// ======================= Turno activo de la máquina (26/09/2026) =======================
// A pedido del usuario: antes de Iniciar (o de tomar control) el operario deja UN turno activo en
// TURHorariosMaquinas para su máquina. Todo lo demás (primer bulto, trg_SEL_Bultos_CierreBulto, la
// bitácora, los reportes de Mirane) ya lee Activo = 1, así que no hay que cambiar nada más.
// Misma regla de choque que Mirane: Turnos/GestionTurnos.vb (RangosSeSolapan / HayConflictoActivo)
// -- solo puede haber un turno activo por rango de horas.

function minutosRango(f) {
  const ini = minutosDelDia(f.HoraInicio);
  const fin = minutosDelDia(f.HoraFin);
  return { ini, fin };
}

function contieneMinuto(f, m) {
  const { ini, fin } = minutosRango(f);
  if (ini == null || fin == null) return false;
  return fin > ini ? (m >= ini && m < fin) : (m >= ini || m < fin);
}

// Puerto de GestionTurnos.vb:RangosSeSolapan (rangos que pueden cruzar medianoche).
function rangosSeSolapan(f1, f2) {
  const a = minutosRango(f1), b = minutosRango(f2);
  if (a.ini == null || a.fin == null || b.ini == null || b.fin == null) return false;
  const seg = r => r.fin > r.ini ? [[r.ini, r.fin]] : [[r.ini, 1440], [0, r.fin]];
  for (const [x1, x2] of seg(a)) {
    for (const [y1, y2] of seg(b)) {
      if (x1 < y2 && y1 < x2) return true;
    }
  }
  return false;
}

// Minutos desde el inicio de la franja hasta "ahora", en (-720, 720] (negativo = todavía no empieza).
function minutosDesdeInicio(f, m) {
  const { ini } = minutosRango(f);
  let d = (m - ini) % 1440;
  if (d < 0) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

// Fecha del turno para una franja y un momento (la noche que cruza medianoche es del día anterior).
function fechaTurnoDe(f, cuando) {
  const m = cuando.getHours() * 60 + cuando.getMinutes();
  const { ini, fin } = minutosRango(f);
  const base = new Date(cuando);
  if (fin <= ini && m < fin) base.setDate(base.getDate() - 1);
  return fechaISOLocal(base);
}

const TURNO_VENTANA_ANTES_MIN = 30;   // un turno "está empezando" desde 30 min antes de su hora...
const TURNO_VENTANA_DESPUES_MIN = 90; // ...hasta 90 min después

// Qué turnos ofrecerle al operario y si hay que preguntar. Devuelve
// { necesita, candidatos: [{ codigo, descripcion, horaInicio, horaFin, activo }], activoActual }.
//   - Candidatos: los turnos que están EMPEZANDO ahora (ventana de arriba); de ellos, solo el/los de
//     hora de inicio más cercana (a las 06:00 Mañana y Pleno Día empatan: se pregunta). Si ninguno
//     está empezando (alguien retoma a mitad de turno), los que cubren la hora actual. Siempre se
//     agrega el turno que ya está activo y cubre la hora, para poder seguir con él.
//   - No se pregunta si el turno activo ya es el que corresponde a este momento y ya hay bitácora de
//     ese turno hoy (alguien ya lo escogió en este turno), o si la máquina no tiene horarios.
async function candidatosTurnoMaquina(p, maquinaCodigo, momento) {
  const cuando = momento ? new Date(momento) : new Date();
  const m = cuando.getHours() * 60 + cuando.getMinutes();
  const dt = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  const franjas = dt.recordset;
  if (franjas.length === 0) return { necesita: false, candidatos: [], activoActual: null };

  const empezando = franjas.filter(f => {
    const d = minutosDesdeInicio(f, m);
    return d >= -TURNO_VENTANA_ANTES_MIN && d <= TURNO_VENTANA_DESPUES_MIN;
  });
  let candidatas;
  if (empezando.length > 0) {
    const minAbs = Math.min(...empezando.map(f => Math.abs(minutosDesdeInicio(f, m))));
    candidatas = empezando.filter(f => Math.abs(minutosDesdeInicio(f, m)) === minAbs);
  } else {
    candidatas = franjas.filter(f => contieneMinuto(f, m));
  }
  const activa = franjas.find(f => Number(f.Activo) === 1 && contieneMinuto(f, m)) || null;
  if (activa && !candidatas.includes(activa)) candidatas.push(activa);

  const duracion = f => { const r = minutosRango(f); return r.fin > r.ini ? r.fin - r.ini : 1440 - r.ini + r.fin; };
  candidatas.sort((a, b) => duracion(a) - duracion(b));

  let necesita = candidatas.length > 0;
  // Ya se escogió en este turno: el activo es uno de los que corresponden ahora (o nadie está
  // empezando) y ya hay bitácora de ese turno hoy en la máquina.
  if (activa && (empezando.length === 0 || empezando.includes(activa))) {
    const dtBit = await p.request()
      .input('maquina', maquinaCodigo).input('turno', activa.CodigoTurno).input('fecha', fechaTurnoDe(activa, cuando))
      .query(`SELECT TOP 1 1 AS X FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND Turno = @turno AND FechaTurno = @fecha`);
    if (dtBit.recordset.length > 0) necesita = false;
  }

  const aJson = f => ({
    codigo: Number(f.CodigoTurno), descripcion: String(f.Descripcion || '').trim(),
    horaInicio: String(f.HoraInicio || '').trim(), horaFin: String(f.HoraFin || '').trim(),
    activo: Number(f.Activo) === 1
  });
  return { necesita, candidatos: candidatas.map(aJson), activoActual: activa ? aJson(activa) : null };
}

// Regla de turnos activos de una máquina (26/09/2026, corregida 27/09/2026 -- a pedido del usuario:
// "siempre se debe garantizar que nada quede inactivo durante un turno"). Al escoger un turno se arma
// el JUEGO COMPLETO que cubre el día a partir de él, sin cruces, prefiriendo los de su misma duración:
// M -> M,T,N · T -> T,M,N · N -> N,M,T · D -> D,V · V -> V,D. Luego se enciende lo del juego y se
// APAGA TODO lo demás que estuviera activo.
// FIX 27/09/2026 (bug real, máquina 7): la versión del 26/09 solo apagaba los que se cruzaban con el
// escogido y encendía los libres que no chocaran con NINGÚN activo -- al escoger D con M,T,N activos
// apagaba M y T pero la Noche seguía activa (no se cruza con D) y tapaba a Pleno Noche: quedó D + N y
// un hueco de 17:55 a 22:00 sin turno (el trigger de cierre no inserta esos bultos en PRDProduccion).
// Devuelve { desactivar, activar, minutosSinCubrir } (sin incluir el escogido). minutosSinCubrir > 0
// solo si los HORARIOS no alcanzan a cubrir el día (ej. Pleno Día hasta 17:55 y Pleno Noche desde
// 18:00) -- eso se arregla en los datos (sql/pendientes/20260926_corregir_horas_turnos_12h.sql).
function duracionFranja(f) {
  const r = minutosRango(f);
  return r.fin > r.ini ? r.fin - r.ini : 1440 - r.ini + r.fin;
}

function planTurnosActivos(franjas, elegido) {
  const esElegido = f => Number(f.CodigoTurno) === Number(elegido.CodigoTurno);
  const dElegido = duracionFranja(elegido);
  const juego = [elegido];
  const cubierto = min => juego.some(a => contieneMinuto(a, min));
  const resto = franjas.filter(f => !esElegido(f)).sort((a, b) =>
    (Math.abs(duracionFranja(a) - dElegido) - Math.abs(duracionFranja(b) - dElegido)) ||
    ((Number(b.Activo) === 1 ? 1 : 0) - (Number(a.Activo) === 1 ? 1 : 0)) ||
    (duracionFranja(a) - duracionFranja(b)));
  for (const f of resto) {
    if (juego.some(a => rangosSeSolapan(a, f))) continue;
    let tapa = false;
    for (let min = 0; min < 1440 && !tapa; min += 5) if (contieneMinuto(f, min) && !cubierto(min)) tapa = true;
    if (tapa) juego.push(f);
  }
  let minutosSinCubrir = 0;
  for (let min = 0; min < 1440; min++) if (!cubierto(min)) minutosSinCubrir++;
  const activar = juego.filter(f => !esElegido(f) && Number(f.Activo) !== 1);
  const desactivar = franjas.filter(f => !juego.includes(f) && Number(f.Activo) === 1);
  return { desactivar, activar, minutosSinCubrir };
}

// Guardia cada 5 minutos (27/09/2026, a pedido del usuario): aunque alguien deje los turnos activos
// mal (Mirane GestionTurnos, un UPDATE a mano, la versión vieja de la regla), en cada máquina se
// vuelve a armar el juego completo a partir del turno que está corriendo AHORA -- ese nunca se cambia,
// solo se completa el resto del día y se apagan los que sobran. Si ahora cae en un hueco, se parte del
// activo que acaba de terminar; si no hay ningún activo, de la franja que cubre la hora que menos
// choque (y la más corta). No toca las
// máquinas que ya están bien. Nunca revienta hacia afuera.
async function repararCoberturaTurnos(p) {
  try {
    const ahora = await horaServidorBD(p);
    const mAhora = ahora.getHours() * 60 + ahora.getMinutes();
    const dt = await p.request().query(`
      SELECT th.CodigoMaquina, th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
      FROM TURHorariosMaquinas th
      INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    `);
    const porMaquina = new Map();
    for (const f of dt.recordset) {
      if (minutosDelDia(f.HoraInicio) == null || minutosDelDia(f.HoraFin) == null) continue;
      if (!porMaquina.has(f.CodigoMaquina)) porMaquina.set(f.CodigoMaquina, []);
      porMaquina.get(f.CodigoMaquina).push(f);
    }
    for (const [maquina, franjas] of porMaquina) {
      const activos = franjas.filter(f => Number(f.Activo) === 1);
      // Ancla: el activo que corre ahora; si ninguno (hueco), el activo que ACABA de terminar -- así un
      // hueco de 5 min en los datos (17:55-18:00) no voltea una jornada de 12 h a turnos de 8 h. Solo
      // si no hay ningún activo se toma una franja que cubra la hora.
      const desdeFin = f => { const r = minutosRango(f); return (mAhora - r.fin + 1440) % 1440; };
      const ancla = activos.filter(f => contieneMinuto(f, mAhora)).sort((a, b) => duracionFranja(a) - duracionFranja(b))[0]
        || activos.slice().sort((a, b) => desdeFin(a) - desdeFin(b))[0]
        || franjas.filter(f => contieneMinuto(f, mAhora)).sort((a, b) =>
             (activos.filter(x => rangosSeSolapan(x, a)).length - activos.filter(x => rangosSeSolapan(x, b)).length) ||
             (duracionFranja(a) - duracionFranja(b)))[0];
      if (!ancla) continue;
      const plan = planTurnosActivos(franjas, ancla);
      if (Number(ancla.Activo) === 1 && plan.activar.length === 0 && plan.desactivar.length === 0) continue;
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        await aplicarPlanTurnos(tx, maquina, ancla.CodigoTurno, plan);
        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch (e) { /* ya abortada */ }
        throw err;
      }
      const nom = f => String(f.Descripcion || f.CodigoTurno).trim();
      console.log(`Turnos activos reparados en máquina ${maquina}: se mantiene ${nom(ancla)}` +
        (plan.activar.length ? `, se encienden ${plan.activar.map(nom).join(', ')}` : '') +
        (plan.desactivar.length ? `, se apagan ${plan.desactivar.map(nom).join(', ')}` : '') +
        (plan.minutosSinCubrir ? ` (quedan ${plan.minutosSinCubrir} min sin turno por los horarios)` : ''));
    }
  } catch (err) {
    console.error('No se pudo revisar la cobertura de turnos activos:', { message: err.message, number: err.number });
  }
}

async function aplicarPlanTurnos(tx, maquinaCodigo, codigoTurno, plan) {
  await tx.request().input('maquina', maquinaCodigo).input('turno', codigoTurno)
    .query(`UPDATE TURHorariosMaquinas SET Activo = 1 WHERE CodigoMaquina = @maquina AND CodigoTurno = @turno`);
  for (const f of plan.desactivar) {
    await tx.request().input('maquina', maquinaCodigo).input('turno', f.CodigoTurno)
      .query(`UPDATE TURHorariosMaquinas SET Activo = 0 WHERE CodigoMaquina = @maquina AND CodigoTurno = @turno`);
  }
  for (const f of plan.activar) {
    await tx.request().input('maquina', maquinaCodigo).input('turno', f.CodigoTurno)
      .query(`UPDATE TURHorariosMaquinas SET Activo = 1 WHERE CodigoMaquina = @maquina AND CodigoTurno = @turno`);
  }
}

// Deja activo el turno escogido y desactiva los demás turnos de la máquina que se crucen con él
// (solo uno activo por rango de horas). Devuelve la lista de turnos desactivados.
async function activarTurnoMaquina(p, maquinaCodigo, codigoTurno) {
  const dt = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  const elegido = dt.recordset.find(f => Number(f.CodigoTurno) === Number(codigoTurno));
  if (!elegido) throw new Error('Ese turno no está configurado para esta máquina.');
  const plan = planTurnosActivos(dt.recordset, elegido);
  const aDesactivar = plan.desactivar;

  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    await aplicarPlanTurnos(tx, maquinaCodigo, codigoTurno, plan);
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* ya abortada */ }
    throw err;
  }
  return aDesactivar.map(f => String(f.Descripcion || '').trim());
}

// ============================ Corregir turno (26/09/2026) ============================
// A pedido del usuario: si el operario escogió mal el turno, lo corrige él mismo DENTRO del turno
// (botón "Turno" junto a Pausa). Corrige SOLO:
//   - el turno activo de la máquina (TURHorariosMaquinas.Activo, misma regla de activarTurnoMaquina),
//   - la bitácora abierta de la máquina (Turno, FechaTurno, Serial). Si ya existe una bitácora del
//     turno correcto para esa fecha, se unen en esa: se le pasan los bultos, tiempos muertos, firmas y
//     observaciones, se reabre, y la equivocada queda cerrada con MotivoCierre 'correccion_turno',
//   - el Turno (y la bitácora) de los bultos de ESA máquina desde que se abrió la bitácora
//     (PRDProduccion), incluidos los que todavía no cierran -- el trigger CierreBulto busca la
//     bitácora por ese Turno al cerrarlos,
//   - un movimiento BITACORA_TURNO / CORRECCION_TURNO en SISMovimientos (anterior, nuevo, quién).
// NO toca la OT (PRDOrdenesProduccion: ni Turno ni código) -- decisión del usuario, ese caso se
// resuelve aparte.

// Turnos que el operario puede escoger al corregir: los que cubren la hora actual.
async function turnosParaCorregir(p, maquinaCodigo) {
  const ahora = await horaServidorBD(p);
  const m = ahora.getHours() * 60 + ahora.getMinutes();
  const dt = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  const dtBit = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT TOP 1 b.IdBitacora, b.Turno, ISNULL(t.Descripcion, '') AS Descripcion, b.Serial
    FROM SEL_BitacoraTurno b LEFT JOIN NOMTurnos t ON t.Codigo = b.Turno
    WHERE b.Maquina = @maquina AND b.HoraCierre IS NULL ORDER BY b.IdBitacora DESC
  `);
  const bit = dtBit.recordset[0] || null;
  const duracion = f => { const r = minutosRango(f); return r.fin > r.ini ? r.fin - r.ini : 1440 - r.ini + r.fin; };
  const candidatos = dt.recordset.filter(f => contieneMinuto(f, m)).sort((a, b) => duracion(a) - duracion(b))
    .map(f => ({
      codigo: Number(f.CodigoTurno), descripcion: String(f.Descripcion || '').trim(),
      horaInicio: String(f.HoraInicio || '').trim(), horaFin: String(f.HoraFin || '').trim(),
      activo: Number(f.Activo) === 1
    }));
  return {
    candidatos,
    bitacora: bit ? { id: bit.IdBitacora, turno: bit.Turno == null ? null : Number(bit.Turno),
                      descripcion: String(bit.Descripcion || '').trim(), serial: bit.Serial || '' } : null
  };
}

async function corregirTurnoMaquina(p, { maquina, codigoTurno, usuario, motivo }) {
  const dtFr = await p.request().input('maquina', maquina).query(`
    SELECT th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  const elegido = dtFr.recordset.find(f => Number(f.CodigoTurno) === Number(codigoTurno));
  if (!elegido) throw new Error('Ese turno no está configurado para esta máquina.');
  const plan = planTurnosActivos(dtFr.recordset, elegido);
  const aDesactivar = plan.desactivar;

  const dtBit = await p.request().input('maquina', maquina).query(`
    SELECT TOP 1 IdBitacora, Turno, CONVERT(varchar(10), FechaTurno, 23) AS FechaTurno, HoraApertura, Serial
    FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL ORDER BY IdBitacora DESC
  `);
  const bit = dtBit.recordset[0] || null;
  const ahora = await horaServidorBD(p);
  const apertura = bit ? new Date(bit.HoraApertura) : ahora;
  const fechaNueva = fechaTurnoDe(elegido, apertura);
  const serialNuevo = await construirSerialBitacora(p, maquina, fechaNueva, Number(codigoTurno));
  const descNueva = String(elegido.Descripcion || '').trim();
  const turnoAnterior = bit && bit.Turno != null ? Number(bit.Turno) : null;
  const cambiaBitacora = !!bit && (turnoAnterior !== Number(codigoTurno) || bit.FechaTurno !== fechaNueva);

  const tx = new sql.Transaction(p);
  await tx.begin();
  let idFinal = bit ? bit.IdBitacora : null;
  let fusionada = false;
  let bultos = 0;
  try {
    await aplicarPlanTurnos(tx, maquina, codigoTurno, plan);

    if (cambiaBitacora) {
      const dtDest = await tx.request()
        .input('maquina', maquina).input('turno', codigoTurno).input('fecha', fechaNueva).input('id', bit.IdBitacora)
        .query(`SELECT TOP 1 IdBitacora FROM SEL_BitacoraTurno WITH (UPDLOCK)
                WHERE Maquina = @maquina AND Turno = @turno AND FechaTurno = @fecha AND IdBitacora <> @id
                ORDER BY IdBitacora DESC`);
      if (dtDest.recordset.length > 0) {
        // Ya existe la bitácora del turno correcto: todo lo de la equivocada pasa a esa.
        fusionada = true;
        idFinal = dtDest.recordset[0].IdBitacora;
        await tx.request().input('id', bit.IdBitacora).input('dest', idFinal).input('apertura', sql.DateTime, apertura)
          .query(`
            UPDATE PRDProduccion SET IdBitacora = @dest WHERE IdBitacora = @id;
            UPDATE SEL_Bultos SET IdBitacora = @dest WHERE IdBitacora = @id;
            IF COL_LENGTH('dbo.SEL_TiempoMuerto', 'IdBitacora') IS NOT NULL
              EXEC sp_executesql N'UPDATE SEL_TiempoMuerto SET IdBitacora = @dest WHERE IdBitacora = @id', N'@id INT, @dest INT', @id, @dest;
            IF COL_LENGTH('dbo.SEL_AutorizacionPedido', 'IdBitacora') IS NOT NULL
              EXEC sp_executesql N'UPDATE SEL_AutorizacionPedido SET IdBitacora = @dest WHERE IdBitacora = @id', N'@id INT, @dest INT', @id, @dest;
            IF COL_LENGTH('dbo.SEL_ObservacionOperario', 'IdBitacora') IS NOT NULL
              EXEC sp_executesql N'UPDATE SEL_ObservacionOperario SET IdBitacora = @dest WHERE IdBitacora = @id', N'@id INT, @dest INT', @id, @dest;
            -- primero se cierra la equivocada (solo puede haber una abierta por máquina) y luego se reabre la correcta
            UPDATE SEL_BitacoraTurno SET HoraCierre = GETDATE(), MotivoCierre = 'correccion_turno' WHERE IdBitacora = @id;
            UPDATE SEL_BitacoraTurno
            SET HoraCierre = NULL, MotivoCierre = NULL,
                HoraApertura = CASE WHEN @apertura < HoraApertura THEN @apertura ELSE HoraApertura END
            WHERE IdBitacora = @dest;
          `);
      } else {
        await tx.request().input('id', bit.IdBitacora).input('turno', codigoTurno).input('fecha', fechaNueva)
          .input('serial', serialNuevo)
          .query(`UPDATE SEL_BitacoraTurno SET Turno = @turno, FechaTurno = @fecha, Serial = ISNULL(@serial, Serial)
                  WHERE IdBitacora = @id`);
      }

      // Bultos de ESTA máquina desde que se abrió la bitácora (los ya cerrados de esa bitácora y los
      // que siguen abiertos, que todavía no tienen IdBitacora). La OT no se toca.
      const rB = await tx.request().input('maquina', maquina).input('turnoTxt', String(codigoTurno))
        .input('idFinal', idFinal).input('apertura', sql.DateTime, apertura)
        .query(`
          UPDATE PRDProduccion SET Turno = @turnoTxt, IdBitacora = @idFinal
          WHERE Maquina = @maquina
            AND (IdBitacora = @idFinal OR (IdBitacora IS NULL AND HoraInicio >= @apertura));
        `);
      bultos = rB.rowsAffected ? rB.rowsAffected[0] : 0;
    }

    const resumen = !bit
      ? `Turno activo corregido a ${descNueva} (sin bitácora abierta)`
      : !cambiaBitacora
        ? `Turno activo confirmado: ${descNueva} (la bitácora ya estaba en ese turno)`
        : `Turno corregido a ${descNueva}` + (fusionada ? ` (unida a la bitácora ${idFinal})` : '') + ` -- ${bultos} bulto(s)`;
    await tx.request()
      .input('idBit', idFinal).input('serial', (serialNuevo || (bit && bit.Serial) || null))
      .input('usuario', usuario || null).input('motivo', String(motivo || 'Corrección de turno desde la tableta').slice(0, 500))
      .input('resumen', resumen.slice(0, 500))
      .input('tAnt', turnoAnterior == null ? null : String(turnoAnterior)).input('tNue', String(codigoTurno))
      .input('fAnt', bit ? bit.FechaTurno : null).input('fNue', fechaNueva)
      .input('idAnt', bit ? String(bit.IdBitacora) : null).input('idNue', idFinal == null ? null : String(idFinal))
      .input('desact', aDesactivar.map(f => String(f.CodigoTurno)).join(',') || null)
      .input('activ', plan.activar.map(f => String(f.CodigoTurno)).join(',') || null)
      .input('bultos', String(bultos))
      .query(`
        IF OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
        BEGIN
          DECLARE @Mov TABLE (Id INT);
          INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
          OUTPUT INSERTED.IdMovimiento INTO @Mov
          VALUES ('BITACORA_TURNO', 'CORRECCION_TURNO', @idBit, @serial, GETDATE(), @usuario, 'Tableta', @motivo, @resumen);
          INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
          SELECT Id, 'SEL_BitacoraTurno', 'Turno', @tAnt, @tNue FROM @Mov
          UNION ALL SELECT Id, 'SEL_BitacoraTurno', 'FechaTurno', @fAnt, @fNue FROM @Mov
          UNION ALL SELECT Id, 'SEL_BitacoraTurno', 'IdBitacora', @idAnt, @idNue FROM @Mov
          UNION ALL SELECT Id, 'TURHorariosMaquinas', 'Activo=0', @desact, NULL FROM @Mov WHERE @desact IS NOT NULL
          UNION ALL SELECT Id, 'TURHorariosMaquinas', 'Activo=1 (completa el día)', NULL, @activ FROM @Mov WHERE @activ IS NOT NULL
          UNION ALL SELECT Id, 'PRDProduccion', 'Turno (bultos)', NULL, @bultos FROM @Mov;
        END
      `);

    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* ya abortada */ }
    throw err;
  }
  return { idBitacora: idFinal, turno: Number(codigoTurno), descripcion: descNueva, fechaTurno: fechaNueva,
           fusionada, bultos, cambioBitacora: cambiaBitacora };
}

// ======================= Turno escogido en el LOGIN (28/09/2026) =======================
// Reunión 28/09/2026: el operario escoge su turno al iniciar sesión en la tableta (desplegable con
// las opciones que tienen sentido a esa hora), el turno se ve al lado del logo, y para cambiarlo
// cierra sesión y vuelve a entrar. Al entrar se crea o corrige la bitácora de la máquina de la
// tableta. La OT nunca la cambia el operario. Si entra antes de su hora (hasta 30 min), su bitácora
// se abre sola cuando termine la del turno anterior (ver abrirBitacorasPendientes).

const MINUTOS_ENTRADA_ANTICIPADA = 30;

// Cache de "¿existe esta columna?" -- los scripts de la base pueden no estar corridos todavía.
const _columnasCache = new Map();
async function columnaExiste(p, tabla, columna) {
  const clave = tabla + '.' + columna;
  if (_columnasCache.has(clave)) return _columnasCache.get(clave);
  try {
    const r = await p.request().input('t', 'dbo.' + tabla).input('c', columna)
      .query(`SELECT CASE WHEN COL_LENGTH(@t, @c) IS NULL THEN 0 ELSE 1 END AS Existe`);
    const existe = Number(r.recordset[0].Existe) === 1;
    if (existe) _columnasCache.set(clave, true); // solo se cachea el sí: el no puede cambiar al correr el script
    return existe;
  } catch (e) {
    return false;
  }
}

// Franjas de la máquina (TURHorariosMaquinas) o, si no tiene / no se sabe la máquina, los turnos
// base de NOMTurnos -- mismo respaldo que resolverTurnoMaquina.
async function franjasMaquinaOBase(p, maquinaCodigo) {
  if (maquinaCodigo) {
    const dt = await p.request().input('maquina', maquinaCodigo).query(`
      SELECT th.CodigoTurno, t.Descripcion, th.HoraInicio, th.HoraFin, ISNULL(th.Activo, 0) AS Activo
      FROM TURHorariosMaquinas th
      INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
      WHERE th.CodigoMaquina = @maquina
    `);
    if (dt.recordset.length > 0) return dt.recordset.filter(f => minutosDelDia(f.HoraInicio) != null && minutosDelDia(f.HoraFin) != null);
  }
  const dtBase = await p.request().query(`
    SELECT Codigo AS CodigoTurno, Descripcion, HoraInicial AS HoraInicio, HoraFinal AS HoraFin, 1 AS Activo
    FROM NOMTurnos WHERE Codigo IN (${TURNOS_BASE_SELLADORA.join(',')})
  `);
  return dtBase.recordset;
}

// "6:00 a.m - 2:00 p.m (Mañana)" -> "Mañana"
function nombreCortoTurno(descripcion) {
  const t = String(descripcion || '').trim();
  const m = /\(([^)]+)\)\s*$/.exec(t);
  return m ? m[1].trim() : t;
}

// Inicio y fin (Date) de la franja para la jornada que cubre "cuando", o la próxima si todavía no
// empieza (entrada anticipada).
function rangoTurno(f, cuando) {
  const { ini, fin } = minutosRango(f);
  const m = cuando.getHours() * 60 + cuando.getMinutes();
  const base = new Date(cuando.getFullYear(), cuando.getMonth(), cuando.getDate());
  let inicio = new Date(base.getTime() + ini * 60000);
  if (fin <= ini && m < fin) inicio = new Date(inicio.getTime() - 86400000); // pedazo de después de medianoche
  else if (!contieneMinuto(f, m) && inicio < cuando) inicio = new Date(inicio.getTime() + 86400000);
  const dur = fin > ini ? fin - ini : 1440 - ini + fin;
  return { inicio, fin: new Date(inicio.getTime() + dur * 60000), fechaTurno: fechaISOLocal(inicio) };
}

function turnoAJson(f, cuando) {
  const m = cuando.getHours() * 60 + cuando.getMinutes();
  const r = rangoTurno(f, cuando);
  return {
    codigo: Number(f.CodigoTurno), descripcion: String(f.Descripcion || '').trim(), corto: nombreCortoTurno(f.Descripcion),
    horaInicio: String(f.HoraInicio || '').trim(), horaFin: String(f.HoraFin || '').trim(),
    cubreAhora: contieneMinuto(f, m), inicio: r.inicio, fin: r.fin, fechaTurno: r.fechaTurno
  };
}

// Opciones del desplegable del login: los turnos que cubren la hora y los que empiezan dentro de
// MINUTOS_ENTRADA_ANTICIPADA. Preselecciona el turno de la bitácora abierta de la máquina (si está
// entre las opciones) o el más corto que cubre la hora.
async function turnosParaLogin(p, maquinaCodigo, ahora) {
  const franjas = await franjasMaquinaOBase(p, maquinaCodigo);
  const m = ahora.getHours() * 60 + ahora.getMinutes();
  const opciones = franjas.filter(f => {
    if (contieneMinuto(f, m)) return true;
    const d = minutosDesdeInicio(f, m); // negativo = todavía no empieza
    return d < 0 && -d <= MINUTOS_ENTRADA_ANTICIPADA;
  }).map(f => turnoAJson(f, ahora))
    .sort((a, b) => (a.inicio - b.inicio) || ((a.fin - a.inicio) - (b.fin - b.inicio)));

  let preseleccion = null;
  if (maquinaCodigo) {
    try {
      const dt = await p.request().input('maquina', maquinaCodigo).query(
        `SELECT TOP 1 Turno FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL ORDER BY IdBitacora DESC`);
      if (dt.recordset.length > 0 && opciones.some(o => o.codigo === Number(dt.recordset[0].Turno))) preseleccion = Number(dt.recordset[0].Turno);
    } catch (e) { /* sin preselección */ }
  }
  if (preseleccion == null) {
    const cubren = opciones.filter(o => o.cubreAhora).sort((a, b) => (a.fin - a.inicio) - (b.fin - b.inicio));
    if (cubren.length > 0) preseleccion = cubren[0].codigo;
  }
  return { opciones, preseleccion };
}

// Registros de una bitácora: los del operario y los de otros (tiempos muertos, bultos, protocolo).
async function registrosDeBitacora(p, bit, maquinaCodigo, operario) {
  const r = { tmMios: 0, tmOtros: 0, bultosMios: 0, bultosOtros: 0, protMios: 0, protOtros: 0 };
  try {
    if (await columnaExiste(p, 'SEL_TiempoMuerto', 'IdBitacora')) {
      const dt = await p.request().input('id', bit.IdBitacora).input('op', operario).query(`
        SELECT SUM(CASE WHEN Operario = @op THEN 1 ELSE 0 END) AS Mios, SUM(CASE WHEN ISNULL(Operario, -1) <> @op THEN 1 ELSE 0 END) AS Otros
        FROM SEL_TiempoMuerto WHERE IdBitacora = @id`);
      r.tmMios = Number(dt.recordset[0].Mios) || 0; r.tmOtros = Number(dt.recordset[0].Otros) || 0;
    }
    const dtB = await p.request().input('id', bit.IdBitacora).input('op', operario).query(`
      SELECT SUM(CASE WHEN o.Otros > 0 THEN 1 ELSE 0 END) AS Otros, COUNT(*) AS Total
      FROM PRDProduccion p
      OUTER APPLY (SELECT COUNT(*) AS Otros FROM PRDProduccionOperarios po
                   WHERE po.Fecha = p.Fecha AND po.Lote = p.Lote AND po.Elemento = p.Elemento AND po.Linea = p.Linea
                     AND po.Operario <> @op) o
      WHERE p.IdBitacora = @id AND p.Linea < 1000`);
    r.bultosOtros = Number(dtB.recordset[0].Otros) || 0;
    r.bultosMios = (Number(dtB.recordset[0].Total) || 0) - r.bultosOtros;
    const dtP = await p.request().input('maquina', maquinaCodigo).input('op', operario).input('desde', sql.DateTime, bit.HoraApertura).query(`
      SELECT SUM(CASE WHEN pa.Operario = @op THEN 1 ELSE 0 END) AS Mios, SUM(CASE WHEN ISNULL(pa.Operario, -1) <> @op THEN 1 ELSE 0 END) AS Otros
      FROM SEL_ProtocoloArranque pa
      INNER JOIN SEL_EjecucionOrden e ON e.IdEjecucion = pa.id_ejecucion
      WHERE e.Maquina = @maquina AND pa.FechaHora >= @desde`);
    r.protMios = Number(dtP.recordset[0].Mios) || 0; r.protOtros = Number(dtP.recordset[0].Otros) || 0;
  } catch (err) {
    console.error('No se pudieron contar los registros de la bitácora:', err.message);
  }
  r.mios = r.tmMios + r.bultosMios + r.protMios;
  r.otros = r.tmOtros + r.bultosOtros + r.protOtros;
  return r;
}

// Al iniciar sesión un operario en la tableta fija de una máquina, con el turno escogido.
// Devuelve { accion, ... }:
//   'pendiente'  -> entró antes de su turno: no se toca nada; su bitácora se abre al terminar la actual
//   'creada' / 'reusada' / 'nueva' -> bitácora lista con su turno
//   'confirmar'  -> la bitácora abierta es de otro turno y tiene registros SUYOS: hay que avisarle
//                   que pasan al turno nuevo (se aplica con corregirTurnoMaquina)
//   'bloqueado'  -> la bitácora abierta tiene registros de OTROS operarios: él no la puede cambiar
async function sincronizarBitacoraAlEntrar(p, { maquina, operario, codigoTurno, ahora }) {
  const franjas = await franjasMaquinaOBase(p, maquina);
  const f = franjas.find(x => Number(x.CodigoTurno) === Number(codigoTurno));
  if (!f) return { accion: 'sin_turno' };
  const turno = turnoAJson(f, ahora);
  if (!turno.cubreAhora) return { accion: 'pendiente', turno };

  const dt = await p.request().input('maquina', maquina).query(`
    SELECT TOP 1 b.IdBitacora, b.Operario, b.Turno, CONVERT(varchar(10), b.FechaTurno, 23) AS FechaTurno, b.HoraApertura,
           b.Serial, ISNULL(t.Descripcion, '') AS Descripcion
    FROM SEL_BitacoraTurno b LEFT JOIN NOMTurnos t ON t.Codigo = b.Turno
    WHERE b.Maquina = @maquina AND b.HoraCierre IS NULL ORDER BY b.IdBitacora DESC`);
  const abierta = dt.recordset[0] || null;

  if (!abierta) {
    await activarTurnoMaquina(p, maquina, codigoTurno);
    const id = await abrirOReanudarBitacora(p, maquina, operario);
    return { accion: 'creada', idBitacora: id, turno };
  }

  const mismoTurno = Number(abierta.Turno) === Number(codigoTurno) && abierta.FechaTurno === turno.fechaTurno;
  if (mismoTurno) {
    await activarTurnoMaquina(p, maquina, codigoTurno);
    await pasarBitacoraSiAnteriorSalio(p, abierta, operario);
    return { accion: 'reusada', idBitacora: abierta.IdBitacora, turno };
  }

  const reg = await registrosDeBitacora(p, abierta, maquina, operario);
  const esSuya = Number(abierta.Operario) === Number(operario) || reg.mios > 0;
  const anterior = { idBitacora: abierta.IdBitacora, turno: Number(abierta.Turno), corto: nombreCortoTurno(abierta.Descripcion) };
  if (esSuya && reg.otros > 0) return { accion: 'bloqueado', turno, anterior, registros: reg };
  if (esSuya) return { accion: 'confirmar', turno, anterior, registros: reg };

  // Bitácora de otro operario, sin nada suyo: relevo entre turnos -- se cierra la anterior y se abre la suya.
  await cerrarBitacora(p, abierta.IdBitacora, 'cambio_turno');
  await activarTurnoMaquina(p, maquina, codigoTurno);
  const id = await abrirOReanudarBitacora(p, maquina, operario);
  return { accion: 'nueva', idBitacora: id, turno, anterior };
}

// Entradas anticipadas (28/09/2026): operarios que iniciaron sesión en la tableta fija de una máquina
// con un turno que todavía no empezaba. Cuando ese turno ya empezó y la máquina no tiene bitácora
// abierta (la anterior se cerró por fin de turno), se abre la suya con su turno -- siempre un turno
// POSTERIOR al que se cerró -- y los tiempos muertos que él ya había registrado desde que entró pasan
// a ella. Requiere SISAccesos.Turno / Maquina (sql/pendientes/20260928_turno_en_login.sql). La
// llama la guardia de cada 5 minutos, después de cerrarBitacorasPorFinTurno. Nunca revienta.
async function abrirBitacorasPendientes(p) {
  try {
    if (!(await columnaExiste(p, 'SISAccesos', 'Turno')) || !(await columnaExiste(p, 'SISAccesos', 'Maquina'))) return 0;
    const ahora = await horaServidorBD(p);
    const dt = await p.request().query(`
      SELECT a.Codigo, a.FechaHora, a.Turno, a.Maquina, u.CodigoOperarioPRD
      FROM SISAccesos a
      INNER JOIN SISUsuarios u ON u.Codigo = a.Codigo
      WHERE a.TipoEvento = 'Entrada' AND a.Turno IS NOT NULL AND a.Maquina IS NOT NULL
        AND u.CodigoOperarioPRD IS NOT NULL
        AND a.FechaHora >= DATEADD(HOUR, -13, GETDATE())
        AND NOT EXISTS (SELECT 1 FROM SISAccesos s WHERE s.Codigo = a.Codigo AND s.FechaHora > a.FechaHora)
        AND NOT EXISTS (SELECT 1 FROM SEL_BitacoraTurno b WHERE b.Maquina = a.Maquina AND b.HoraCierre IS NULL)
      ORDER BY a.FechaHora DESC
    `);
    let abiertas = 0;
    const hechas = new Set();
    for (const e of dt.recordset) {
      if (hechas.has(e.Maquina)) continue;
      const franjas = await franjasMaquinaOBase(p, e.Maquina);
      const f = franjas.find(x => Number(x.CodigoTurno) === Number(e.Turno));
      if (!f) continue;
      const turno = turnoAJson(f, ahora);
      // Solo si ese turno ya empezó y entró ANTES de que empezara (anticipada) o durante él.
      if (!turno.cubreAhora || new Date(e.FechaHora) >= turno.fin) continue;
      hechas.add(e.Maquina);

      const dtCerrada = await p.request().input('maquina', e.Maquina).query(
        `SELECT TOP 1 IdBitacora FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NOT NULL ORDER BY IdBitacora DESC`);
      const idAnterior = dtCerrada.recordset.length > 0 ? dtCerrada.recordset[0].IdBitacora : null;

      await activarTurnoMaquina(p, e.Maquina, e.Turno);
      const idNueva = await abrirOReanudarBitacora(p, e.Maquina, e.CodigoOperarioPRD);
      if (!idNueva) continue;
      // La bitácora arranca a la hora del turno (la guardia corre cada 5 min, no justo en punto).
      await p.request().input('id', idNueva).input('inicio', sql.DateTime, turno.inicio)
        .query(`UPDATE SEL_BitacoraTurno SET HoraApertura = @inicio WHERE IdBitacora = @id AND HoraApertura > @inicio`);
      // Lo que él ya hizo desde que entró (limpieza, alistamiento del relevo) pasa a su bitácora.
      if (idAnterior && (await columnaExiste(p, 'SEL_TiempoMuerto', 'IdBitacora'))) {
        await p.request().input('nueva', idNueva).input('anterior', idAnterior)
          .input('op', e.CodigoOperarioPRD).input('desde', sql.DateTime, e.FechaHora)
          .query(`UPDATE SEL_TiempoMuerto SET IdBitacora = @nueva
                  WHERE IdBitacora = @anterior AND Operario = @op AND HoraInicio >= @desde`);
      }
      abiertas++;
      console.log(`Bitácora ${idNueva} abierta para la entrada anticipada del operario ${e.CodigoOperarioPRD} (máquina ${e.Maquina}, turno ${turno.corto})`);
    }
    return abiertas;
  } catch (err) {
    console.error('No se pudieron abrir las bitácoras de entradas anticipadas:', { message: err.message, number: err.number });
    return 0;
  }
}

// Supervisores (reunión 28/09/2026): administrador (1) y los cargos que firman la autorización del
// líder (6, 16, 27, 31). Solo ellos corrigen el turno una vez hay producción (botón 🕘 Turno).
const CARGOS_SUPERVISOR = [1, 6, 16, 27, 31];
function esSupervisor(usuario) {
  return !!usuario && (usuario.codigo === 'ADMIN' || CARGOS_SUPERVISOR.includes(Number(usuario.idCargo)));
}

// ======================= Corregir el turno de una OT (28/09/2026) =======================
// A pedido del usuario: una OT ACTIVA creada con el turno equivocado (ej. Mañana en vez de Pleno Día,
// aunque se haya creado ayer) la corrige un supervisor desde la tableta, en la sección "Orden de
// trabajo". Solo la OT: su código cambia (lleva la letra del turno y el consecutivo se cuenta por
// fecha + máquina + turno) y el código nuevo se pone en TODAS las tablas que lo guardan. La bitácora
// y el turno de los bultos NO se tocan (eso se corrige con el turno del usuario al entrar).
// Todo en una transacción: o queda todo o nada. Deja un movimiento CAMBIO_OT en SISMovimientos con
// la observación obligatoria.

async function infoOTParaCorreccion(p, ordenProduccion) {
  if (!ordenProduccion) return null;
  try {
    const dt = await p.request().input('ot', ordenProduccion).query(`
      SELECT o.IdOrdenProduccion, o.OrdenProduccion, o.Estado, o.Turno, o.Maquina, ISNULL(t.Descripcion, '') AS Descripcion,
             h.HoraInicio, h.HoraFin
      FROM PRDOrdenesProduccion o LEFT JOIN NOMTurnos t ON t.Codigo = o.Turno
      -- 30/09/2026: rango de horas del turno para mostrarlo junto al nombre. Primero el horario de la
      -- máquina (TURHorariosMaquinas) y si no tiene, el general de NOMTurnos.
      OUTER APPLY (
          SELECT TOP 1 x.HoraInicio, x.HoraFin
          FROM (
              SELECT th.HoraInicio, th.HoraFin, 1 AS Prioridad
              FROM TURHorariosMaquinas th
              WHERE th.CodigoMaquina = o.Maquina AND th.CodigoTurno = o.Turno
              UNION ALL
              SELECT t2.HoraInicial, t2.HoraFinal, 2
              FROM NOMTurnos t2
              WHERE t2.Codigo = o.Turno
          ) x
          ORDER BY x.Prioridad
      ) h
      WHERE o.OrdenProduccion = @ot`);
    if (dt.recordset.length === 0) return null;
    const r = dt.recordset[0];
    const hIni = String(r.HoraInicio || '').trim(), hFin = String(r.HoraFin || '').trim();
    return { id: r.IdOrdenProduccion, codigo: r.OrdenProduccion, estado: String(r.Estado || '').trim(),
             turno: r.Turno == null ? null : Number(r.Turno), corto: nombreCortoTurno(r.Descripcion) || '-', maquina: r.Maquina,
             rango: hIni && hFin ? `${hIni} a ${hFin}` : '' };
  } catch (err) {
    return null;
  }
}

// Turnos a los que se puede pasar la OT: los de su máquina (o los base), menos el que ya tiene.
async function turnosParaCorregirOT(p, ordenProduccion) {
  const ot = await infoOTParaCorreccion(p, ordenProduccion);
  if (!ot) return { ot: null, opciones: [] };
  const franjas = await franjasMaquinaOBase(p, ot.maquina);
  const opciones = franjas.filter(f => Number(f.CodigoTurno) !== ot.turno).map(f => ({
    codigo: Number(f.CodigoTurno), corto: nombreCortoTurno(f.Descripcion),
    horaInicio: String(f.HoraInicio || '').trim(), horaFin: String(f.HoraFin || '').trim()
  }));
  return { ot, opciones };
}

async function corregirTurnoOT(p, { ordenProduccion, codigoTurno, usuario, observacion }) {
  const tObs = String(observacion || '').trim();
  if (tObs.length < 5) throw new Error('Escriba una observación (por qué se corrige el turno).');

  const dtOT = await p.request().input('ot', ordenProduccion).query(`
    SELECT IdOrdenProduccion, OrdenProduccion, Fecha, Lote, Maquina, Turno, Consecutivo, Estado
    FROM PRDOrdenesProduccion WHERE OrdenProduccion = @ot`);
  if (dtOT.recordset.length === 0) throw new Error('No se encontró la orden de trabajo.');
  const ot = dtOT.recordset[0];
  if (String(ot.Estado || '').trim() !== 'Activa') throw new Error('Solo se puede corregir una orden de trabajo Activa.');
  if (Number(ot.Turno) === Number(codigoTurno)) throw new Error('La orden de trabajo ya tiene ese turno.');

  const franjas = await franjasMaquinaOBase(p, ot.Maquina);
  if (!franjas.some(f => Number(f.CodigoTurno) === Number(codigoTurno))) throw new Error('Ese turno no está configurado para la máquina de la OT.');

  // Código nuevo, igual que obtenerOCrearOrdenProduccion: OT- + año + lote + sigla máquina + letra turno + consecutivo
  const dtSig = await p.request().input('maquina', ot.Maquina).input('turno', codigoTurno).query(`
    SELECT (SELECT ISNULL(LetraSerial,'') + ISNULL(CodigoSerial,'') FROM PRDMaquinas WHERE Codigo = @maquina) AS Sigla,
           (SELECT ISNULL(LetraSerial,'') FROM NOMTurnos WHERE Codigo = @turno) AS Letra,
           (SELECT Descripcion FROM NOMTurnos WHERE Codigo = @turno) AS DescNueva`);
  const sigla = String(dtSig.recordset[0].Sigla || '');
  const letra = String(dtSig.recordset[0].Letra || '');
  const fecha = new Date(ot.Fecha);
  const lote = String(ot.Lote || '').trim();

  // Tablas que guardan el código de la OT (se buscan en la base: así no se escapa ninguna nueva)
  const dtTablas = await p.request().query(`
    SELECT c.TABLE_NAME AS Tabla
    FROM INFORMATION_SCHEMA.COLUMNS c
    INNER JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_TYPE = 'BASE TABLE'
    WHERE c.COLUMN_NAME = 'OrdenProduccion' AND c.TABLE_SCHEMA = 'dbo'
      AND c.TABLE_NAME NOT IN ('PRDOrdenesProduccion', 'PRDOrdenesProduccionPausas')`);
  const tablas = dtTablas.recordset.map(r => String(r.Tabla)).filter(t => /^[A-Za-z0-9_]+$/.test(t));
  const conTipoPausa = await columnaExiste(p, 'PRDOrdenesProduccionPausas', 'Tipo');
  const hayPausas = (await p.request().query(`SELECT OBJECT_ID('dbo.PRDOrdenesProduccionPausas') AS X`)).recordset[0].X != null;
  const haySIS = (await p.request().query(`SELECT OBJECT_ID('dbo.SISMovimientos') AS X`)).recordset[0].X != null;

  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    // Consecutivo libre para fecha + máquina + turno nuevo (bajo bloqueo, para que nadie cree la misma a la vez)
    const dtCons = await tx.request().input('fecha', sql.Date, fecha).input('maquina', ot.Maquina).input('turno', codigoTurno).query(`
      SELECT ISNULL(MAX(Consecutivo), 0) + 1 AS NC FROM PRDOrdenesProduccion WITH (UPDLOCK, HOLDLOCK)
      WHERE Fecha = @fecha AND Maquina = @maquina AND Turno = @turno`);
    let nCons = Number(dtCons.recordset[0].NC);
    let nuevo;
    for (;;) {
      nuevo = `OT-${fecha.getFullYear()}${lote}${sigla}${letra}${String(nCons).padStart(2, '0')}`;
      const ex = await tx.request().input('ot', nuevo).query(`SELECT 1 AS X FROM PRDOrdenesProduccion WITH (UPDLOCK, HOLDLOCK) WHERE OrdenProduccion = @ot`);
      if (ex.recordset.length === 0) break;
      nCons++;
    }
    const viejo = ot.OrdenProduccion;

    const colsPausa = 'HoraInicioPausa, HoraFinPausa, Observaciones, UsuarioPausa, UsuarioReanuda' + (conTipoPausa ? ', Tipo' : '');
    const lineasTablas = tablas.map(t =>
      `UPDATE [dbo].[${t}] SET OrdenProduccion = @nuevo WHERE OrdenProduccion = @viejo;
       INSERT INTO @Conteo VALUES ('${t}', @@ROWCOUNT);`).join('\n');

    const r = await tx.request()
      .input('viejo', viejo).input('nuevo', nuevo).input('id', ot.IdOrdenProduccion)
      .input('turno', codigoTurno).input('cons', nCons)
      .query(`
        DECLARE @Conteo TABLE (Tabla VARCHAR(128), Filas INT);
        ${hayPausas ? `
        -- La FK de las pausas no actualiza en cascada: se copian, se borran y se vuelven a insertar con el código nuevo.
        DECLARE @Pausas TABLE (IdPausa INT, HoraInicioPausa DATETIME, HoraFinPausa DATETIME, Observaciones VARCHAR(200),
                               UsuarioPausa INT, UsuarioReanuda INT${conTipoPausa ? ', Tipo VARCHAR(20)' : ''});
        INSERT INTO @Pausas (IdPausa, ${colsPausa}) SELECT IdPausa, ${colsPausa} FROM PRDOrdenesProduccionPausas WHERE OrdenProduccion = @viejo;
        DELETE FROM PRDOrdenesProduccionPausas WHERE OrdenProduccion = @viejo;` : ''}

        UPDATE PRDOrdenesProduccion SET OrdenProduccion = @nuevo, Turno = @turno, Consecutivo = @cons WHERE IdOrdenProduccion = @id;
        INSERT INTO @Conteo VALUES ('PRDOrdenesProduccion', @@ROWCOUNT);

        ${hayPausas ? `
        INSERT INTO PRDOrdenesProduccionPausas (OrdenProduccion, ${colsPausa})
        SELECT @nuevo, ${colsPausa} FROM @Pausas ORDER BY IdPausa;
        INSERT INTO @Conteo VALUES ('PRDOrdenesProduccionPausas', @@ROWCOUNT);` : ''}

        ${lineasTablas}

        -- El texto de la observación de sus movimientos de inventario también nombra la OT
        IF COL_LENGTH('dbo.INVMovimientos', 'OrdenProduccion') IS NOT NULL
          UPDATE INVMovimientos SET Observaciones = REPLACE(Observaciones, @viejo, @nuevo)
          WHERE OrdenProduccion = @nuevo AND Observaciones LIKE '%' + @viejo + '%';

        ${haySIS ? `UPDATE SISMovimientos SET Referencia = @nuevo WHERE Tipo = 'ORDEN_TRABAJO' AND Referencia = @viejo;` : ''}

        SELECT Tabla, Filas FROM @Conteo WHERE Filas > 0;
      `);
    const conteo = r.recordset || [];

    if (haySIS) {
      const dtTurnoViejo = await tx.request().input('t', ot.Turno).query(`SELECT Descripcion FROM NOMTurnos WHERE Codigo = @t`);
      const cortoViejo = nombreCortoTurno(dtTurnoViejo.recordset.length ? dtTurnoViejo.recordset[0].Descripcion : String(ot.Turno));
      const cortoNuevo = nombreCortoTurno(dtSig.recordset[0].DescNueva || String(codigoTurno));
      const req = tx.request()
        .input('id', ot.IdOrdenProduccion).input('nuevo', nuevo).input('viejo', viejo)
        .input('usuario', usuario || null).input('motivo', tObs.slice(0, 500))
        .input('resumen', `Turno de la OT corregido: ${cortoViejo} -> ${cortoNuevo}. Código ${viejo} -> ${nuevo}.`.slice(0, 500))
        .input('tAnt', ot.Turno == null ? null : String(ot.Turno)).input('tNue', String(codigoTurno))
        .input('cAnt', String(ot.Consecutivo)).input('cNue', String(nCons));
      const filas = conteo.map((c, i) => `UNION ALL SELECT Id, @tb${i}, 'Filas con el código nuevo', NULL, @fl${i} FROM @Mov`).join('\n');
      conteo.forEach((c, i) => { req.input(`tb${i}`, String(c.Tabla)); req.input(`fl${i}`, String(c.Filas)); });
      await req.query(`
        DECLARE @Mov TABLE (Id INT);
        INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
        OUTPUT INSERTED.IdMovimiento INTO @Mov
        VALUES ('ORDEN_TRABAJO', 'CAMBIO_OT', @id, @nuevo, GETDATE(), @usuario, 'Tableta', @motivo, @resumen);
        INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
        SELECT Id, 'PRDOrdenesProduccion', 'OrdenProduccion', @viejo, @nuevo FROM @Mov
        UNION ALL SELECT Id, 'PRDOrdenesProduccion', 'Turno', @tAnt, @tNue FROM @Mov
        UNION ALL SELECT Id, 'PRDOrdenesProduccion', 'Consecutivo', @cAnt, @cNue FROM @Mov
        ${filas};
      `);
    }

    await tx.commit();
    console.log(`OT corregida: ${viejo} -> ${nuevo} (turno ${ot.Turno} -> ${codigoTurno})`);
    return { viejo, nuevo, conteo };
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* ya abortada */ }
    throw err;
  }
}

// Letra de turno para el serial de la bitacora (D/V/M/T/N) -- mismo mapeo NOMTurnos ya usado en
// Mirane (ver ConsProduccionSeguimiento.vb:LetraTurnoCodigo): 6=Mañana, 7=Tarde, 8=Noche,
// 9=Pleno Noche, 10=Pleno Dia. Null si el codigo no se reconoce (esquema viejo 1-5, no aplica aca).
function letraTurno(codigoTurno) {
  switch (Number(codigoTurno)) {
    case 6: return 'M';
    case 7: return 'T';
    case 8: return 'N';
    case 9: return 'V';
    case 10: return 'D';
    default: return null;
  }
}

// FIX 22/09/2026 (bug real encontrado por el usuario -- comparó contra el catalogo completo de
// PRDMaquinas): el numero de la selladora en el serial NO es el Codigo interno de PRDMaquinas --
// casi nunca coinciden (ej. Codigo=7 es "SELLADORA 05", Codigo=34 es "SELLADORA 19"). El numero
// real es el que trae el propio Nombre ("SELLADORA 05" -> "05"). Se saca de ahi, no de @maquina.
// Devuelve null si la maquina no tiene un numero al final del Nombre (ej. "EXTRUSORA PP") -- la
// bitacora es exclusiva de Selladora por ahora (reunion 18/09: "solamente aplica para el PLC"),
// asi que en la practica esto siempre resuelve para selladoras, que sí siguen el patron "NOMBRE NN".
async function numeroMaquinaParaSerial(p, maquinaCodigo) {
  const dt = await p.request().input('maquina', maquinaCodigo).query(
    `SELECT Nombre FROM PRDMaquinas WHERE Codigo = @maquina`
  );
  if (dt.recordset.length === 0) return null;
  const m = String(dt.recordset[0].Nombre).match(/(\d+)\s*$/);
  return m ? m[1].padStart(2, '0') : null;
}

// Serial de la bitacora de turno (a pedido del usuario, reunion 18/09/2026 + confirmacion 20/09/2026):
// Fecha(yyyyMMdd) + SE + Numero de la maquina (del Nombre, ver numeroMaquinaParaSerial) + Letra de turno.
// Ejemplo: 20260917SE05D. Devuelve null si no hay turno resuelto (maquina sin horario configurado) o si
// no se pudo sacar el numero del Nombre -- no se inventa ninguno de los dos.
// FIX 24/09/2026 (a pedido del usuario): SIN el prefijo "OT" -- la bitacora es el TURNO, no una Orden de
// Trabajo (el documento de OT: "la OT no equivale al turno"); la OT real es PRDOrdenesProduccion
// ("OT-20260923E301M01", ver obtenerOCrearOrdenProduccion). Las bitacoras viejas se corrigen con
// Mirane: nueva produccion/orden_trabajo/2_migracion_historicos/quitar_ot_serial_bitacora_24092026.sql.
async function construirSerialBitacora(p, maquinaCodigo, fechaTurnoISO, turnoCodigo) {
  const letra = letraTurno(turnoCodigo);
  if (!letra) return null;
  const numeroMaquina = await numeroMaquinaParaSerial(p, maquinaCodigo);
  if (!numeroMaquina) return null;
  const fecha = String(fechaTurnoISO).replace(/-/g, '');
  return `${fecha}SE${numeroMaquina}${letra}`;
}

// FIX 25/09/2026 (a pedido del usuario -- tiempos muertos con fin ANTES del inicio): la hora "ahora"
// que se guarda como inicio de un tiempo muerto o de un bulto se toma del reloj de la BASE (GETDATE()),
// no del PC donde corre Node -- el fin ya se guardaba con GETDATE(), y el PC de Node iba unos 7 s
// adelantado, asi que un evento de pocos segundos quedaba con fin < inicio. Con useUTC:false (ver
// dbConfig en server.js) el DATETIME vuelve como hora local y se puede reenviar tal cual.
async function horaServidorBD(db) {
  const r = await db.request().query('SELECT GETDATE() AS Ahora');
  return new Date(r.recordset[0].Ahora);
}

async function cerrarBitacora(p, idBitacora, motivo) {
  await p.request().input('id', idBitacora).input('motivo', motivo).query(
    `UPDATE SEL_BitacoraTurno SET HoraCierre = GETDATE(), MotivoCierre = @motivo
     WHERE IdBitacora = @id AND HoraCierre IS NULL`
  );
}

// ============================ Suspender / Reanudar la OT ============================
// 24/09/2026 (a pedido del usuario): mismo criterio que Produccion.vb (btnSuspender/btnReanudar) --
// la suspension de la tablet ya no solo cambia SEL_EjecucionOrden/SEL_OrdenProduccion, tambien:
//   - la OT (PRDOrdenesProduccion.Estado) Activa <-> Suspendida,
//   - sus controles (PRDExtrusionControl) EnProceso <-> Suspendida,
//   - una fila en PRDOrdenesProduccionPausas (es la que descuenta el tiempo productivo de la OT),
//   - un movimiento PAUSA / REANUDAR en SISMovimientos (trazabilidad; REANUDAR enlazado al PAUSA).
// Las pausas cortas (limpieza, alistamiento, descanso...) NO pasan por aca: siguen en SEL_TiempoMuerto.
// La OT se ubica por el bulto MAS RECIENTE de la orden: al suspender es la que esta corriendo, y al
// reanudar es la del bulto que se acaba de crear. OJO: si la orden se retoma OTRO dia,
// obtenerOCrearOrdenProduccion (busca por Fecha/Lote de hoy) crea una OT nueva -- entonces la vieja
// queda 'Suspendida' y no se reactiva (asi nunca quedan dos 'Activa'). Si no hay OT, o la OT no esta
// en el estado esperado, no hace nada. Nunca revienta hacia afuera: suspender/reanudar no puede
// fallar por esto.

// SQL comun: @OT = OT del bulto mas reciente de la orden (@idOrden).
const SQL_OT_DE_ORDEN = `
  DECLARE @OT VARCHAR(20), @IdOT INT;
  SELECT TOP 1 @OT = p.OrdenProduccion
  FROM PRDProduccion p
  INNER JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
  INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
  WHERE ej.IdOrden = @idOrden AND p.OrdenProduccion IS NOT NULL
  ORDER BY b.id DESC;
  SELECT @IdOT = IdOrdenProduccion FROM PRDOrdenesProduccion WHERE OrdenProduccion = @OT;
`;

// Controles de la OT: los PRDExtrusionControl cuya etiqueta ancla pertenece a @OT (mismo criterio que
// SincronizarEstadoOT en Mirane -- una OT de sellado en paralelo tiene un control por referencia).
const SQL_CONTROLES_DE_OT = `
  SELECT ec.IdExtrusionControl FROM PRDExtrusionControl ec
  INNER JOIN PRDProduccion pa ON pa.Elemento = ec.ElementoOriginal AND pa.Fecha = ec.FechaOriginal
                             AND pa.Lote = ec.LoteOriginal AND pa.Linea = ec.LineaOriginal
  WHERE pa.OrdenProduccion = @OT
`;

async function suspenderOTDeOrden(db, { idOrden, usuario, motivo, origen }) {
  try {
    // TARJETA #11: propagar suspensión a TODO el grupo si la orden pertenece a un grupo
    const miembros = await obtenerMiembrosGrupoSellado(db, idOrden);
    const idsMiembros = miembros.join(',');

    const r = await db.request()
      .input('idOrden', idOrden).input('usuario', usuario || null)
      .input('motivo', String(motivo || 'Suspensión desde la tableta').slice(0, 200))
      .input('origen', String(origen || 'Tableta').slice(0, 40))
      .input('idsMiembros', idsMiembros)
      .query(`
        ${SQL_OT_DE_ORDEN}
        IF @OT IS NULL OR NOT EXISTS (SELECT 1 FROM PRDOrdenesProduccion WHERE OrdenProduccion = @OT AND Estado = 'Activa')
        BEGIN SELECT CAST(NULL AS VARCHAR(20)) AS OT; RETURN; END

        -- Suspender OT compartida
        UPDATE PRDOrdenesProduccion SET Estado = 'Suspendida' WHERE OrdenProduccion = @OT AND Estado = 'Activa';
        UPDATE PRDExtrusionControl SET Estado = 'Suspendida', FechaUltimaModificacion = GETDATE()
        WHERE Estado = 'EnProceso' AND IdExtrusionControl IN (${SQL_CONTROLES_DE_OT});
        IF NOT EXISTS (SELECT 1 FROM PRDOrdenesProduccionPausas WHERE OrdenProduccion = @OT AND HoraFinPausa IS NULL)
          INSERT INTO PRDOrdenesProduccionPausas (OrdenProduccion, HoraInicioPausa, UsuarioPausa, Observaciones)
          VALUES (@OT, GETDATE(), @usuario, @motivo);

        -- TARJETA #11: suspender TODAS las órdenes/ejecuciones del grupo
        UPDATE op SET op.Estado = 'Suspendida'
        FROM SEL_OrdenProduccion op
        WHERE op.IdOrden IN (${idsMiembros}) AND op.Estado IN ('Pendiente', 'Activa');

        UPDATE ej SET ej.Estado = 'Suspendida'
        FROM SEL_EjecucionOrden ej
        WHERE ej.IdOrden IN (${idsMiembros}) AND ej.Estado IN ('Pendiente', 'Activa', 'PendienteSuspension', 'SuspensionEnCurso');

        IF OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
        BEGIN
          DECLARE @Mov TABLE (Id INT);
          INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
          OUTPUT INSERTED.IdMovimiento INTO @Mov
          VALUES ('ORDEN_TRABAJO', 'PAUSA', @IdOT, @OT, GETDATE(), @usuario, @origen, @motivo, N'Orden de trabajo suspendida desde la tableta (grupo)');
          INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
          SELECT Id, 'PRDOrdenesProduccion', 'Estado', 'Activa', 'Suspendida' FROM @Mov;
        END
        SELECT @OT AS OT;
      `);
    return r.recordset && r.recordset[0] ? r.recordset[0].OT : null;
  } catch (err) {
    console.error('No se pudo registrar la suspension de la OT:', { idOrden, message: err.message, number: err.number });
    return null;
  }
}

async function reanudarOTDeOrden(db, { idOrden, usuario, origen }) {
  try {
    const r = await db.request()
      .input('idOrden', idOrden).input('usuario', usuario || null)
      .input('origen', String(origen || 'Tableta').slice(0, 40))
      .query(`
        ${SQL_OT_DE_ORDEN}
        IF @OT IS NULL OR NOT EXISTS (SELECT 1 FROM PRDOrdenesProduccion WHERE OrdenProduccion = @OT AND Estado = 'Suspendida')
        BEGIN SELECT CAST(NULL AS VARCHAR(20)) AS OT; RETURN; END

        UPDATE PRDOrdenesProduccion SET Estado = 'Activa' WHERE OrdenProduccion = @OT AND Estado = 'Suspendida';
        UPDATE PRDExtrusionControl SET Estado = 'EnProceso', FechaUltimaModificacion = GETDATE()
        WHERE Estado = 'Suspendida' AND IdExtrusionControl IN (${SQL_CONTROLES_DE_OT});
        UPDATE PRDOrdenesProduccionPausas SET HoraFinPausa = GETDATE(), UsuarioReanuda = @usuario
        WHERE OrdenProduccion = @OT AND HoraFinPausa IS NULL;

        IF OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
        BEGIN
          DECLARE @Pausa INT = (SELECT TOP 1 IdMovimiento FROM SISMovimientos
                                WHERE Tipo = 'ORDEN_TRABAJO' AND Subtipo = 'PAUSA' AND IdReferencia = @IdOT
                                ORDER BY IdMovimiento DESC);
          DECLARE @Mov TABLE (Id INT);
          INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen, IdMovimientoRelacionado)
          OUTPUT INSERTED.IdMovimiento INTO @Mov
          VALUES ('ORDEN_TRABAJO', 'REANUDAR', @IdOT, @OT, GETDATE(), @usuario, @origen, NULL, N'Orden de trabajo reanudada desde la tableta', @Pausa);
          INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
          SELECT Id, 'PRDOrdenesProduccion', 'Estado', 'Suspendida', 'Activa' FROM @Mov;
        END
        SELECT @OT AS OT;
      `);
    return r.recordset && r.recordset[0] ? r.recordset[0].OT : null;
  } catch (err) {
    console.error('No se pudo registrar la reanudacion de la OT:', { idOrden, message: err.message, number: err.number });
    return null;
  }
}

// FIX 24/09/2026 (a pedido del usuario): la bitacora se cierra cuando TERMINA SU TURNO, no cuando
// alguien abre la siguiente (antes una bitacora podia quedar abierta dias si nadie tomaba control).
// El fin del turno sale del turno guardado en la bitacora (el que tiene asignado la maquina en
// TURHorariosMaquinas; si la maquina no tiene horario, NOMTurnos -- mismo criterio que
// resolverTurnoMaquina). Si HoraFin <= HoraInicio el turno cruza medianoche y termina el dia
// siguiente a FechaTurno. HoraCierre queda en la hora OFICIAL de fin del turno, no en la hora en
// que corrio esta revision. NO abre la bitacora del turno nuevo: esa la abre el operario al tomar
// control (abrirOReanudarBitacora); los bultos que abran antes quedan sin bitacora y el trigger
// trg_SEL_Bultos_CierreBulto se la completa al cerrarlos. Bitacoras sin Turno no se tocan.
// Devuelve cuantas cerro; nunca revienta hacia afuera.
async function cerrarBitacorasPorFinTurno(p) {
  try {
    const r = await p.request().query(`
      UPDATE bi
      SET bi.HoraCierre = CASE WHEN f.FinTurno < bi.HoraApertura THEN bi.HoraApertura ELSE f.FinTurno END,
          bi.MotivoCierre = 'fin_turno'
      FROM SEL_BitacoraTurno bi
      CROSS APPLY (
          SELECT TOP 1 x.HoraInicio, x.HoraFin
          FROM (
              SELECT th.HoraInicio, th.HoraFin, 1 AS Prioridad
              FROM TURHorariosMaquinas th
              WHERE th.CodigoMaquina = bi.Maquina AND th.CodigoTurno = bi.Turno
              UNION ALL
              SELECT t.HoraInicial, t.HoraFinal, 2
              FROM NOMTurnos t
              WHERE t.Codigo = bi.Turno
          ) x
          ORDER BY x.Prioridad
      ) h
      CROSS APPLY (
          SELECT DATEADD(DAY,
                   CASE WHEN CAST(h.HoraFin AS time) <= CAST(h.HoraInicio AS time) THEN 1 ELSE 0 END,
                   CAST(CAST(bi.FechaTurno AS date) AS datetime) + CAST(CAST(h.HoraFin AS time) AS datetime)
                 ) AS FinTurno
      ) f
      WHERE bi.HoraCierre IS NULL AND bi.Turno IS NOT NULL AND f.FinTurno <= GETDATE()
    `);
    const cerradas = r.rowsAffected ? r.rowsAffected[0] : 0;
    if (cerradas > 0) console.log(`Bitacoras cerradas por fin de turno: ${cerradas}`);
    return cerradas;
  } catch (err) {
    console.error('No se pudieron cerrar las bitacoras por fin de turno:',
      { message: err.message, number: err.number, code: err.code });
    return 0;
  }
}

// Abre la bitacora del turno, o REUSA la que ya este abierta si es del mismo turno (SIN importar
// el operario -- ver FIX 20/09/2026 abajo). Se llama desde "Iniciar" (crearBultoInicial,
// scan-rollo.js) y desde "tomar control de la maquina" (tomar-control-ejecucion, server.js) -- los
// dos puntos donde el operario pasa a ser el dueño de la maquina.
//
// Lo de reusar es un requisito explicito del usuario (12/09/2026): "no cuando el operario cierra
// sesion porque puede pasar que se vaya el internet o retome la orden". Un corte de red, un
// re-login o volver a tomar control a mitad del turno NO pueden partir la bitacora en dos.
// Por eso tampoco hay nada que cierre la bitacora en /logout: solo la cierra el CAMBIO DE TURNO
// (un relevo de operario dentro del MISMO turno ya NO la cierra, ver FIX 20/09/2026).
//
// Nunca revienta hacia afuera: si algo falla, se registra en consola y el operario igual toma
// control de la maquina. La bitacora es un registro, no puede bloquear la produccion.
// 27/09/2026 (a pedido del usuario -- caso real máquina 7: Andrés terminó el alistamiento de su orden a
// las 18:00:12, eso abrió la bitácora de Pleno Noche a su nombre, cerró sesión y el 182 retomó a las
// 18:01:58, pero la bitácora siguió a nombre de Andrés): ¿el operario (PRDOperarios.Codigo) ya no
// está en la tableta? Sí si su último evento en SISAccesos es 'Salida', o si su última entrada fue
// hace más de 8 horas (lo que dura la sesión, ver cookie maxAge en server.js). Si nunca entró por la
// tableta, tampoco está. Se cruza por SISUsuarios.CodigoOperarioPRD.
async function operarioSalioDeSesion(p, operarioPRD) {
  const dt = await p.request().input('op', operarioPRD).query(`
    SELECT TOP 1
      CASE WHEN a.TipoEvento = 'Salida' OR a.FechaHora < DATEADD(HOUR, -13, GETDATE()) THEN 1 ELSE 0 END AS Salio
    FROM SISAccesos a
    INNER JOIN SISUsuarios u ON u.Codigo = a.Codigo
    WHERE u.CodigoOperarioPRD = @op
    ORDER BY a.FechaHora DESC
  `);
  return dt.recordset.length === 0 || Number(dt.recordset[0].Salio) === 1;
}

// La bitácora abierta del turno pasa al operario que toma el control, SOLO si el que la tenía ya
// salió de la tableta (fin de turno / primer retomar del turno). Si el anterior sigue conectado es un
// relevo corto dentro del turno y la bitácora se queda con él. Lo hecho por el anterior sigue a su
// nombre fila por fila (tiempos muertos, bultos, protocolo) -- solo cambia el encabezado, que es el
// operario de la planilla. Deja rastro en SISMovimientos. Nunca revienta hacia afuera.
async function pasarBitacoraSiAnteriorSalio(p, abierta, operarioCodigo) {
  try {
    if (!operarioCodigo || abierta.Operario == null || Number(abierta.Operario) === Number(operarioCodigo)) return;
    if (!(await operarioSalioDeSesion(p, abierta.Operario))) return;
    // 28/09/2026: si el que llega declaró en el login OTRO turno (entró antes para el turno
    // siguiente), esta bitácora no es la suya: la suya se abre al terminar ésta (abrirBitacorasPendientes).
    if (await columnaExiste(p, 'SISAccesos', 'Turno')) {
      const dtDecl = await p.request().input('op', operarioCodigo).query(`
        SELECT TOP 1 a.Turno FROM SISAccesos a INNER JOIN SISUsuarios u ON u.Codigo = a.Codigo
        WHERE u.CodigoOperarioPRD = @op AND a.TipoEvento = 'Entrada' ORDER BY a.FechaHora DESC`);
      const tDecl = dtDecl.recordset.length > 0 ? dtDecl.recordset[0].Turno : null;
      if (tDecl != null && abierta.Turno != null && Number(tDecl) !== Number(abierta.Turno)) return;
    }
    const r = await p.request()
      .input('id', abierta.IdBitacora).input('nuevo', operarioCodigo).input('anterior', abierta.Operario)
      .input('serial', abierta.Serial || null)
      .input('tAnt', String(abierta.Operario)).input('tNue', String(operarioCodigo))
      .query(`
        UPDATE SEL_BitacoraTurno SET Operario = @nuevo
        WHERE IdBitacora = @id AND Operario = @anterior AND HoraCierre IS NULL;
        IF @@ROWCOUNT > 0 AND OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
        BEGIN
          DECLARE @Mov TABLE (Id INT);
          INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
          OUTPUT INSERTED.IdMovimiento INTO @Mov
          VALUES ('BITACORA_TURNO', 'CAMBIO_OPERARIO', @id, @serial, GETDATE(), NULL, 'Tableta',
                  N'Toma de control: el operario anterior ya había cerrado sesión',
                  N'La bitácora pasa del operario ' + @tAnt + N' al ' + @tNue);
          INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
          SELECT Id, 'SEL_BitacoraTurno', 'Operario', @tAnt, @tNue FROM @Mov;
        END
      `);
    if (r.rowsAffected && r.rowsAffected[0] > 0) {
      console.log(`Bitácora ${abierta.IdBitacora}: pasa del operario ${abierta.Operario} al ${operarioCodigo} (el anterior ya salió de la tableta)`);
    }
  } catch (err) {
    console.error('No se pudo pasar la bitácora al operario que toma el control:',
      { idBitacora: abierta.IdBitacora, message: err.message, number: err.number });
  }
}

async function abrirOReanudarBitacora(p, maquinaCodigo, operarioCodigo) {
  try {
    const turnoAhora = await resolverTurnoMaquina(p, maquinaCodigo);

    const dtAbierta = await p.request().input('maquina', maquinaCodigo).query(`
      SELECT TOP 1 IdBitacora, Operario, Turno, CONVERT(varchar(10), FechaTurno, 23) AS FechaTurno, Serial
      FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL
      ORDER BY IdBitacora DESC
    `);

    if (dtAbierta.recordset.length > 0) {
      const abierta = dtAbierta.recordset[0];
      // Turno en null a los dos lados tambien cuenta como "el mismo" -- si no, una maquina sin
      // horarios abriria una bitacora nueva en cada toma de control.
      const mismoTurno = (abierta.Turno == null ? null : Number(abierta.Turno)) === turnoAhora.turno
        && abierta.FechaTurno === turnoAhora.fechaTurno;
      // FIX 20/09/2026 (a pedido del usuario, reunion 18/09 -- el serial final de la OT/bitacora
      // quedo como "OT+Fecha+Maquina+Turno", SIN operario en la llave -- se descarto por "muy
      // enredado" partir la OT cuando cambia el operario dentro del mismo turno): un relevo YA NO
      // cierra la bitacora, solo el cambio de turno/fecha la cierra. Varios operarios pueden
      // convivir en la misma bitacora -- quien hizo cada bulto se sigue viendo por bulto
      // (SEL_Bultos/SEL_EjecucionOrden.Operario, PRDProduccionOperarios), igual que ya se ajusto en
      // el reporte de seguimiento. El "protocolo de relevo" (limpieza/alistamiento que debe repetir
      // el operario entrante, SEL_ProtocoloArranque paso 'relevo') sigue intacto -- es un control de
      // calidad/seguridad aparte, no tiene que ver con la identidad de la bitacora.
      // 27/09/2026: sigue la misma bitácora del turno, pero si el operario que la tenía ya salió de la
      // tableta (fin de turno / primer retomar del turno), pasa al que toma el control -- ver
      // pasarBitacoraSiAnteriorSalio.
      if (mismoTurno) {
        await pasarBitacoraSiAnteriorSalio(p, abierta, operarioCodigo);
        return abierta.IdBitacora;
      }
      await cerrarBitacora(p, abierta.IdBitacora, 'cambio_turno');
    }

    // FIX 20/09/2026 (a pedido del usuario, reunion 18/09): serial nuevo de la OT/bitacora, ver
    // construirSerialBitacora. Requiere sql/pendientes/20260920_agregar_serial_bitacora_turno.sql
    // -- si esa columna todavia no existe, el INSERT de abajo falla y cae al catch de siempre (no
    // bloquea Iniciar/tomar control, ver comentario de la funcion).
    const serial = await construirSerialBitacora(p, maquinaCodigo, turnoAhora.fechaTurno, turnoAhora.turno);
    const dtNueva = await p.request()
      .input('maquina', maquinaCodigo).input('operario', operarioCodigo)
      .input('turno', turnoAhora.turno).input('fechaTurno', turnoAhora.fechaTurno)
      .input('serial', serial)
      .query(`
        DECLARE @Insertados TABLE (Id INT);
        INSERT INTO SEL_BitacoraTurno (Maquina, Operario, Turno, FechaTurno, Serial)
        OUTPUT INSERTED.IdBitacora INTO @Insertados
        VALUES (@maquina, @operario, @turno, @fechaTurno, @serial);
        SELECT Id FROM @Insertados;
      `);
    return dtNueva.recordset[0].Id;
  } catch (err) {
    // FIX 16/09/2026 (debug a pedido del usuario -- "Transaction has been aborted" en Iniciar/
    // Cerrar bulto, causado por esta funcion recibiendo `tx` compartida -- ya corregido en
    // scan-rollo.js, ahora recibe un Request aislado del pool global). Se deja el log ampliado
    // (numero/codigo de error SQL, no solo el mensaje) para diagnosticar rapido si vuelve a fallar
    // -- por ejemplo si de verdad falta correr agregar_bitacora_turno.sql.
    console.error('No se pudo abrir/reanudar la bitacora de turno (¿falta ejecutar agregar_bitacora_turno.sql?):',
      { message: err.message, number: err.number, code: err.code, maquina: maquinaCodigo, operario: operarioCodigo });
    return null;
  }
}

// ===========================================================================================
// Ajuste de la cantidad realmente consumida de un rollo
// Ver AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md (documento de diseno, 18/09/2026) y
// sql/aplicados/20260918_agregar_ajuste_consumo_rollo.sql.
//
// El problema: consultarSerial (scan-rollo.js) toma INVExistencias.Cantidad COMPLETA y
// generarSalidaRollo la descuenta entera -- el sistema asume que el rollo se gasto al 100%. Si el
// operario solo uso una parte, la diferencia queda perdida: descontada del inventario, contada
// como materia prima del pedido e inflando la merma.
//
// La correccion se hace sobre la CANTIDAD CONSUMIDA (C), no sobre "cuanto sobro". Es el mismo dato
// visto desde el lado que ya entiende el resto del sistema: la merma sale sola de
// SUM(PRDProduccionMateriaPrima.Cantidad) menos la salida real, sin ninguna cuenta aparte.
//
// Las cuatro variables del documento (seccion 4):
//   R = cantidad original del rollo         C = cantidad consumida que digita el usuario
//   S = salida real acumulada de la orden   D = R - C, lo que se devuelve al inventario
// ===========================================================================================

// S -- salida real acumulada, formula de ObtenerDatosMermaOrden (SEL_InventarioMP.vb):
//   SUM[(Cantidad - PesoCono) + Torta + NuevoRetal + ResiduoTroquelado + ResiduoRefilado +
//       ResiduoNoConforme] sobre los bultos.
// Se suma sobre TODOS los miembros del grupo de sellado, no solo la orden pedida: es un solo rollo
// fisico para hasta 3 referencias de salida, asi que lo que "salio" de ese rollo es la produccion
// de las tres juntas. Comparar C contra la salida de una sola referencia dejaria pasar ajustes
// imposibles (devolver kilos que en realidad ya se convirtieron en bultos de una hermana).
async function obtenerSalidaRealSellado(db, idsOrdenes) {
  if (!idsOrdenes || idsOrdenes.length === 0) return 0;
  const dt = await db.request().query(`
    SELECT ISNULL(SUM(
      (ISNULL(p.Cantidad, 0) - ISNULL(p.PesoCono, 0))
      + ISNULL(p.Torta, 0) + ISNULL(p.NuevoRetal, 0)
      + ISNULL(p.ResiduoTroquelado, 0) + ISNULL(p.ResiduoRefilado, 0)
      + ISNULL(p.ResiduoNoConforme, 0)
    ), 0) AS Salida
    FROM PRDProduccion p
    INNER JOIN SEL_Bultos b ON b.serialPadre = p.Detalle
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden IN (${idsOrdenes.join(',')})
  `);
  return Number(dt.recordset[0].Salida) || 0;
}

// Todos los miembros del grupo de sellado (incluida la orden pedida), de este y de otros
// pedidos (PedidosExtra, tarjeta #9). Mismo criterio por (pedido, línea) que ya usan
// confirmarRollo/finalizarOrden desde el FIX 13/09/2026 -- Elemento por si solo NO es
// llave suficiente (dos lineas del mismo pedido pueden vender la misma referencia sin ser la misma
// agrupacion fisica). Si la orden no esta agrupada devuelve [idOrden] y todo lo demas funciona igual.
async function obtenerMiembrosGrupoSellado(db, idOrden) {
  const dt = await db.request().input('idOrden', idOrden).query(`
    SELECT ord2.IdOrden
    FROM SEL_OrdenProduccion ord1
    INNER JOIN PRDGrupoEtapasCompartidas g ON g.CategoriaMaquina = 'SELLADORA'
      AND (EXISTS (SELECT 1 FROM PRDGrupoEtapasCompartidasLineas gl
                  WHERE gl.IdGrupo = g.IdGrupo AND gl.Linea = ord1.Linea AND g.Numero = ord1.NumeroPedido)
        OR EXISTS (SELECT 1 FROM PRDGrupoEtapasPedidosExtra pe
                  WHERE pe.IdGrupo = g.IdGrupo AND pe.SubEmpresa = g.SubEmpresa AND pe.Tipo = g.Tipo AND pe.Fecha = g.Fecha
                    AND pe.Numero = ord1.NumeroPedido AND pe.Linea = ord1.Linea))
    INNER JOIN (
      SELECT gl2.Linea AS Linea, g2.Numero AS Numero, gl2.IdGrupo AS IdGrupo
      FROM PRDGrupoEtapasCompartidasLineas gl2
      INNER JOIN PRDGrupoEtapasCompartidas g2 ON g2.IdGrupo = gl2.IdGrupo
      UNION
      SELECT pe2.Linea AS Linea, pe2.Numero AS Numero, pe2.IdGrupo AS IdGrupo
      FROM PRDGrupoEtapasPedidosExtra pe2
      INNER JOIN PRDGrupoEtapasCompartidas g3 ON g3.IdGrupo = pe2.IdGrupo
        AND pe2.SubEmpresa = g3.SubEmpresa AND pe2.Tipo = g3.Tipo AND pe2.Fecha = g3.Fecha
    ) gm ON gm.IdGrupo = g.IdGrupo
    INNER JOIN SEL_OrdenProduccion ord2 ON ord2.Linea = gm.Linea AND ord2.NumeroPedido = gm.Numero
    WHERE ord1.IdOrden = @idOrden
  `);
  const ids = [...new Set(dt.recordset.map(r => r.IdOrden))];
  return ids.length > 0 ? ids : [Number(idOrden)];
}

// El ancla bajo la que vive la materia prima de la orden (o del grupo), con su Fecha/Lote/Linea.
// Es la MISMA resolucion que hace crearBultoInicial antes de llamar a obtenerOCrearOrdenProduccion:
// en un grupo, la MP se registro una sola vez contra la ancla (sinMateriaPrima=true para los
// hermanos), asi que el ajuste tiene que apuntar ahi y no a la orden desde la que se pidio.
async function resolverAnclaMateriaPrima(db, idOrden) {
  const anclaGrupo = await obtenerAnclaGrupoSellado(db, idOrden);
  const idOrdenAncla = anclaGrupo ? anclaGrupo.IdOrden : Number(idOrden);

  const dtOrden = await db.request().input('idOrden', idOrdenAncla)
    .query(`SELECT Elemento FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) throw new Error('Orden ancla no encontrada.');

  const lineaOriginal = await obtenerLineaOriginalControlSellado(db, idOrdenAncla, 0);
  const original = await obtenerFechaLoteOriginalControlSellado(db, idOrdenAncla, lineaOriginal);
  if (!original) {
    throw new Error('Esta orden todavía no tiene bultos creados -- no hay materia prima que ajustar.');
  }

  return {
    idOrdenAncla,
    elemento: dtOrden.recordset[0].Elemento,
    lineaOriginal,
    fecha: original.fecha,
    lote: original.lote
  };
}

// Los rollos de la orden con R y C, para la pantalla y para revalidar dentro de la transaccion.
//
// R sale, en este orden: del PRIMER ajuste guardado en SEL_AjusteConsumoRollo, de
// SEL_RolloEjecucion.CantidadOriginal, o -- si el rollo nunca se ajusto y es de antes de que esa
// tabla existiera (09/09/2026) -- de la cantidad que hay hoy en PRDProduccionMateriaPrima, que en
// ese caso todavia ES la original. El orden importa: leer R de la MP despues de un ajuste daria el
// valor ya corregido y encadenaria ajuste sobre ajuste (seccion 6 del documento).
async function listarRollosOrden(db, idOrden) {
  const ancla = await resolverAnclaMateriaPrima(db, idOrden);

  const dt = await db.request()
    .input('elemento', ancla.elemento).input('fecha', sql.Date, ancla.fecha)
    .input('lote', ancla.lote).input('linea', ancla.lineaOriginal)
    .input('idOrdenAncla', ancla.idOrdenAncla)
    .query(`
      SELECT
        mp.Detalle AS Serial,
        mp.MateriaPrima,
        mp.Cantidad AS CantidadActual,
        mp.LoteMP,
        mp.Bodega,
        e.Nombre AS Referencia,
        COALESCE(
          (SELECT TOP 1 aj.CantidadOriginal FROM SEL_AjusteConsumoRollo aj
            WHERE aj.Serial = mp.Detalle AND aj.IdOrdenAncla = @idOrdenAncla ORDER BY aj.Id ASC),
          (SELECT TOP 1 re.CantidadOriginal FROM SEL_RolloEjecucion re
            INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = re.id_ejecucion
            WHERE re.Serial = mp.Detalle AND ej.IdOrden = @idOrdenAncla ORDER BY re.Id ASC),
          mp.Cantidad
        ) AS CantidadOriginal,
        (SELECT COUNT(*) FROM SEL_AjusteConsumoRollo aj2
          WHERE aj2.Serial = mp.Detalle AND aj2.IdOrdenAncla = @idOrdenAncla) AS Ajustes
      FROM PRDProduccionMateriaPrima mp
      LEFT JOIN INVElementos e ON mp.MateriaPrima = e.Codigo
      WHERE mp.Elemento = @elemento AND mp.Fecha = @fecha AND mp.Lote = @lote AND mp.Linea = @linea
      ORDER BY mp.Detalle
    `);

  return { ancla, rollos: dt.recordset };
}

// Devuelve D kilos al inventario, contra la MISMA etiqueta (Detalle) de la que salieron. Es el
// inverso de descontarExistenciaPorDetalle y se apoya en el mismo AUD_INVExi_Borradas.
//
// El caso normal es que la fila YA NO EXISTA: generarSalidaRollo la dejo en 0 y el
// "DELETE FROM INVExistencias WHERE Cantidad = 0 AND Unidades = 0" del final la borro. Por eso
// esto es una ENTRADA que recrea la fila (Linea = MAX(Linea)+1 de esa bodega/elemento, igual que
// EntradaInventario en INVModulo.vb), no un "deshacer" del UPDATE.
//
// Valor: la fila borrada se llevo su valorizacion. Se reconstruye a prorrata desde el snapshot que
// descontarExistenciaPorDetalle dejo en AUD_INVExi_Borradas justo antes de descontar -- ahi estan
// el Valor, la FechaIngreso, la Serie y el Lote exactos que tenia el rollo. Prorratear por
// D/Cantidad es lo unico honesto: devolver la mitad de los kilos devuelve la mitad del valor.
// Sin snapshot (rollo de antes de que existiera la auditoria) entra en 0 y queda dicho en el log:
// es preferible a inventarse un costo.
async function entradaExistenciaPorDetalle(db, { bodega, elemento, detalle, cantidad, serie, generadoPor }) {
  const nCant = Number(cantidad);
  if (!(nCant > 0)) return;

  // El snapshot se lee SIEMPRE, no solo cuando hay que recrear la fila: de el sale el valor
  // unitario del rollo, y ese hace falta tanto para valorizar la fila nueva como para sumarle
  // valor a una que ya existe. Leerlo solo en la rama del INSERT fue un bug real encontrado
  // probando dos ajustes seguidos (18/09/2026): el segundo subia Cantidad de 16 a 26 Kg y dejaba
  // Valor clavado en los 16 Kg originales, o sea kilos sin costo dentro del inventario.
  const dtSnap = await db.request().input('bodega', bodega).input('elemento', elemento).input('detalle', detalle)
    .query(`
      SELECT TOP 1 Cantidad, Valor, FechaIngreso, Serie, Lote
      FROM AUD_INVExi_Borradas
      WHERE Bodega = @bodega AND Elemento = @elemento AND Detalle = @detalle AND Operacion = 'SALIDA'
      ORDER BY AuditId DESC
    `);

  let nValorUnitario = 0, fFechaIngreso = null, tSerie = serie || null, nLote = null;
  if (dtSnap.recordset.length > 0) {
    const snap = dtSnap.recordset[0];
    const nCantSnap = Number(snap.Cantidad) || 0;
    nValorUnitario = nCantSnap > 0 ? (Number(snap.Valor) || 0) / nCantSnap : 0;
    fFechaIngreso = snap.FechaIngreso || null;
    tSerie = snap.Serie != null ? String(snap.Serie).trim() : tSerie;
    nLote = snap.Lote != null ? snap.Lote : null;
  } else {
    console.warn(`ajustarConsumoRollo: sin snapshot en AUD_INVExi_Borradas para ${detalle} (bodega ${bodega}, elemento ${elemento}) -- el saldo entra con Valor 0.`);
  }
  const nValor = nValorUnitario * nCant;

  const dtExiste = await db.request().input('bodega', bodega).input('elemento', elemento).input('detalle', detalle)
    .query(`SELECT Linea, Cantidad FROM INVExistencias WHERE Bodega = @bodega AND Elemento = @elemento AND Detalle = @detalle`);

  if (dtExiste.recordset.length > 0) {
    // El rollo todavia tiene saldo (se ajusta antes de que se consumiera del todo, o es un segundo
    // ajuste sobre un rollo ya devuelto): se suma sobre la fila que ya esta, sin crear otra.
    const fila = dtExiste.recordset[0];
    await db.request()
      .input('bodega', bodega).input('elemento', elemento).input('linea', fila.Linea)
      .input('cantidad', nCant).input('valor', nValor)
      .query(`UPDATE INVExistencias SET Cantidad = Cantidad + @cantidad, Valor = Valor + @valor WHERE Bodega = @bodega AND Elemento = @elemento AND Linea = @linea`);
  } else {
    const dtLinea = await db.request().input('bodega', bodega).input('elemento', elemento)
      .query(`SELECT ISNULL(MAX(Linea), 0) + 1 AS NL FROM INVExistencias WHERE Bodega = @bodega AND Elemento = @elemento`);

    await db.request()
      .input('bodega', bodega).input('elemento', elemento).input('linea', dtLinea.recordset[0].NL)
      .input('cantidad', nCant).input('valor', nValor).input('detalle', detalle)
      .input('serie', tSerie).input('lote', nLote).input('fechaIngreso', fFechaIngreso)
      .query(`
        INSERT INTO INVExistencias (Bodega, Elemento, Linea, UnidadMedida, Cantidad, Unidades, Valor, FechaIngreso, Serie, Lote, Detalle)
        VALUES (@bodega, @elemento, @linea, 'KGS', @cantidad, 0, @valor, ISNULL(@fechaIngreso, GETDATE()), @serie, @lote, @detalle)
      `);
  }

  // Mismo rastro que deja la salida, con Operacion invertida -- asi la auditoria de una etiqueta se
  // lee de corrido: SALIDA cuando se monto el rollo, ENTRADA cuando se corrigio lo consumido.
  //
  // Se guarda la FOTO DE LA FILA, no el movimiento: es la semantica de esta tabla (las filas
  // SALIDA que escribe descontarExistenciaPorDetalle son la fila entera tal como estaba ANTES de
  // descontar, no los kilos descontados). Las de ENTRADA son la fila tal como queda DESPUES de
  // devolver. Cuantos kilos se movieron en cada ajuste esta en SEL_AjusteConsumoRollo.Diferencia,
  // que es su sitio -- mezclar aqui un delta en Cantidad con un total en Valor haria la tabla
  // ilegible.
  await db.request()
    .input('generadoPor', generadoPor).input('bodega', bodega).input('elemento', elemento)
    .input('detalle', detalle)
    .query(`
      INSERT INTO AUD_INVExi_Borradas
        (FechaHora, GeneradoPor, Origen, Bodega, Elemento, Linea, Cantidad, Unidades, Valor, FechaIngreso, Serie, Lote, Detalle, Operacion)
      SELECT TOP 1 GETDATE(), @generadoPor, 'NodeSelladora.ajustarConsumoRollo', Bodega, Elemento, Linea,
             Cantidad, Unidades, Valor, FechaIngreso, Serie, Lote, Detalle, 'ENTRADA'
      FROM INVExistencias
      WHERE Bodega = @bodega AND Elemento = @elemento AND Detalle = @detalle
    `);
}

// Reescribe la linea del movimiento Tipo 24 con la cantidad nueva.
//
// Se ACTUALIZA la linea, no se borra y se vuelve a crear (seccion 5 punto 3 del documento): borrar
// y recrear gastaria un consecutivo de SISNumeracion por cada correccion.
//
// Como se ubica: por Tipo + Detalle + Elemento, NO por Observaciones (el prefijo de Node es
// "Salida Materia Prima Selladora - " y el de Mirane "Salida Materia Prima - ") ni por Fecha exacta
// (en "Añadir Rollo" Node pasa fHoy con hora, en el primer rollo la fecha sin hora).
//
// El supuesto de que un serial aparece una sola vez en Tipo 24 se cumple hoy porque el rollo se
// consume entero y su fila de existencias se borra, asi que no se puede volver a pitar. Pero este
// ajuste ROMPE esa garantia: al devolver kilos el serial vuelve a existir y puede montarse en otra
// orden, generando una segunda linea con el mismo Detalle. Por eso, cuando hay varias candidatas,
// se desempata por la que tiene exactamente la cantidad que estamos corrigiendo, y si ni asi se
// puede decidir se corta con un error claro en vez de pisar la linea equivocada.
async function ajustarLineaSalidaTipo24(db, { detalle, elemento, cantidadAnterior, cantidadNueva }) {
  const dt = await db.request().input('detalle', detalle).input('elemento', elemento)
    .query(`
      SELECT SubEmpresa, Fecha, Tipo, Numero, Linea, Cantidad
      FROM INVMovimientosElementos
      WHERE Tipo = 24 AND Detalle = @detalle AND Elemento = @elemento
      ORDER BY Fecha DESC, Numero DESC, Linea DESC
    `);

  if (dt.recordset.length === 0) {
    throw new Error(`No se encontró la línea de salida (Tipo 24) del rollo '${detalle}'. El ajuste no se puede aplicar desde aquí -- corríjalo desde el escritorio.`);
  }

  let fila;
  if (dt.recordset.length === 1) {
    fila = dt.recordset[0];
  } else {
    const exactas = dt.recordset.filter(r => Math.abs(Number(r.Cantidad) - Number(cantidadAnterior)) < 0.005);
    if (exactas.length !== 1) {
      throw new Error(`El rollo '${detalle}' tiene ${dt.recordset.length} líneas de salida (Tipo 24) y no se puede determinar cuál corresponde a esta orden. Ajústelo desde el escritorio.`);
    }
    fila = exactas[0];
  }

  await db.request()
    .input('subempresa', fila.SubEmpresa).input('fecha', fila.Fecha).input('numero', fila.Numero)
    .input('linea', fila.Linea).input('cantidad', cantidadNueva)
    .query(`
      UPDATE INVMovimientosElementos SET Cantidad = @cantidad
      WHERE SubEmpresa = @subempresa AND Fecha = @fecha AND Tipo = 24 AND Numero = @numero AND Linea = @linea
    `);

  await db.request()
    .input('subempresa', fila.SubEmpresa).input('fecha', fila.Fecha).input('numero', fila.Numero)
    .query(`
      UPDATE INVMovimientos SET FechaModificado = GETDATE()
      WHERE SubEmpresa = @subempresa AND Fecha = @fecha AND Tipo = 24 AND Numero = @numero
    `);

  return { numero: fila.Numero, fecha: fila.Fecha };
}

// Deja PRDExtrusionControl coherente con la materia prima despues del ajuste.
//
// Los dos totales se recalculan como SUM(PRDProduccionMateriaPrima.Cantidad) del ancla (decision
// del usuario, 18/09/2026 -- pregunta abierta 4 del documento). Mantiene la invariante que Node ya
// tiene hoy (MaterialTotalKg = MaterialConsumidoKg, y por lo tanto la columna calculada
// MaterialDisponibleKg en 0) y de paso corrige el caso de varios rollos, donde hoy ninguno de los
// dos se mueve porque "Añadir Rollo" nunca llama a registrarControlParcialSellado.
//
// MaterialDisponibleKg NO se toca: es columna calculada ([MaterialTotalKg]-[MaterialConsumidoKg]),
// escribirla revienta.
//
// El filtro de TipoProceso acepta los DOS valores a proposito. El valor correcto es 'Sellado' (ver
// FIX 24/09/2026 en registrarControlParcialSellado); entre el 16 y el 24/09 Node escribio
// 'SELLADORA' y pueden quedar controles con ese valor hasta correr la correccion en la base.
async function recalcularControlSellado(db, { elemento, fecha, lineaOriginal, lote, generadoPor }) {
  const dtTotal = await db.request()
    .input('elemento', elemento).input('fecha', sql.Date, fecha).input('lote', lote).input('linea', lineaOriginal)
    .query(`SELECT ISNULL(SUM(Cantidad), 0) AS Total FROM PRDProduccionMateriaPrima WHERE Elemento = @elemento AND Fecha = @fecha AND Lote = @lote AND Linea = @linea`);
  const nTotal = Number(dtTotal.recordset[0].Total) || 0;

  const r = await db.request()
    .input('elemento', elemento).input('fecha', sql.Date, fecha).input('lineaOriginal', lineaOriginal)
    .input('lote', lote).input('total', nTotal).input('generadoPor', generadoPor)
    .query(`
      UPDATE PRDExtrusionControl
      SET MaterialTotalKg = @total, MaterialConsumidoKg = @total,
          FechaUltimaModificacion = GETDATE(), UsuarioUltimaModificacion = @generadoPor
      WHERE ElementoOriginal = @elemento AND FechaOriginal = @fecha AND LineaOriginal = @lineaOriginal
        AND LoteOriginal = @lote AND TipoProceso IN ('SELLADORA', 'Sellado')
    `);

  return { total: nTotal, filasActualizadas: r.rowsAffected[0] || 0 };
}

// Lo que ve la pantalla antes de dejar ajustar: los rollos con R/C y los topes que salen de S.
// Se expone aparte de ajustarConsumoRollo porque la MISMA cuenta se vuelve a hacer adentro de la
// transaccion -- entre que el operario abre la ventana y confirma, la maquina pudo cerrar otro
// bulto y mover S (seccion 6 del documento).
async function obtenerEstadoAjusteConsumo(pool, idOrden) {
  const dtOrden = await pool.request().input('idOrden', idOrden)
    .query(`SELECT Estado, NumeroPedido, Elemento FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) throw new Error('Orden no encontrada.');

  const { ancla, rollos } = await listarRollosOrden(pool, idOrden);
  const idsGrupo = await obtenerMiembrosGrupoSellado(pool, ancla.idOrdenAncla);
  const salidaReal = await obtenerSalidaRealSellado(pool, idsGrupo);

  const totalActual = rollos.reduce((acc, r) => acc + (Number(r.CantidadActual) || 0), 0);

  return {
    estado: dtOrden.recordset[0].Estado,
    idOrdenAncla: ancla.idOrdenAncla,
    salidaReal,
    totalActual,
    // Margen de maniobra del conjunto: cuanto se puede bajar en total sin que la suma de C quede
    // por debajo de la salida real. Es el tope de verdad -- el maximo por rollo (R) es solo el
    // techo individual.
    margenDevolucion: Math.max(0, totalActual - salidaReal),
    rollos: rollos.map(r => ({
      serial: r.Serial,
      referencia: (r.Referencia || '').trim() || '—',
      lote: (r.LoteMP || '').trim() || '—',
      bodega: (r.Bodega || '').trim() || '',
      materiaPrima: r.MateriaPrima,
      cantidadOriginal: Number(r.CantidadOriginal) || 0,
      cantidadActual: Number(r.CantidadActual) || 0,
      ajustes: Number(r.Ajustes) || 0
    }))
  };
}

// El ajuste completo, en UNA sola transaccion (seccion 5 del documento).
//
// Que se toca y en que orden:
//   1. PRDProduccionMateriaPrima.Cantidad = C            (la fuente de verdad de la MP)
//   2. INVExistencias                                     (entrada de D, o salida si C sube)
//   3. INVMovimientosElementos Tipo 24 .Cantidad = C      (la salida ya registrada)
//   4. PRDExtrusionControl                                (Total/Consumido recalculados)
//   5. SEL_RolloEjecucion.Cantidad = C                    (linea de tiempo del rollo)
//   6. SEL_EjecucionOrden                                 (solo si el serial es el que figura ahi)
//   7. SEL_RolloPendienteInicio                           (solo si quedo sin materializar)
//   8. SEL_AjusteConsumoRollo                             (bitacora del ajuste)
//
// La merma NO se escribe (punto 8 del documento): en Node no se calcula -- la calcula el escritorio
// en "Cerrar Definitivo" leyendo SUM(PRDProduccionMateriaPrima.Cantidad). Por eso el ajuste se
// limita a PendienteValidacion: es la ventana que va desde el Finalizar de la tableta (que no
// calcula merma) hasta el cierre del digitador, asi que la merma se calcula despues del ajuste y
// con los numeros ya corregidos, sin que haya nada que recalcular a mano.
//
// D se calcula contra la cantidad ACTUAL, no contra R: en un segundo ajuste (50 -> 40 -> 35) los
// primeros 10 kilos ya volvieron al inventario, y devolver R - C otra vez los duplicaria. Si C
// SUBE (el operario se corrigio al reves), D queda negativo y se vuelve a descontar por el mismo
// camino que la salida original, con su misma guardia de existencia insuficiente.
async function ajustarConsumoRollo(pool, { idOrden, serial, cantidadNueva, motivo, generadoPor, usuario }) {
  const tSerial = (serial || '').trim();
  if (!tSerial) throw new Error('Serial vacío.');

  const nNueva = Number(cantidadNueva);
  if (!Number.isFinite(nNueva) || nNueva <= 0) {
    throw new Error('La cantidad consumida debe ser un número mayor que cero.');
  }

  const dtOrden = await pool.request().input('idOrden', idOrden)
    .query(`SELECT Estado FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) throw new Error('Orden no encontrada.');
  if (dtOrden.recordset[0].Estado !== 'PendienteValidacion') {
    throw new Error('Solo se puede ajustar el consumo mientras la orden está pendiente de validación. Una vez que el digitador la cierra definitivamente, su merma ya está calculada y el ajuste tiene que hacerse desde el escritorio.');
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // Todo se vuelve a leer DENTRO de la transaccion: entre que se pinto la pantalla y llego este
    // POST, la maquina pudo cerrar un bulto y subir S, u otro usuario pudo ajustar el mismo rollo.
    const { ancla, rollos } = await listarRollosOrden(tx, idOrden);
    const rollo = rollos.find(r => String(r.Serial).trim() === tSerial);
    if (!rollo) {
      throw new Error(`El rollo '${tSerial}' no pertenece a la materia prima de esta orden.`);
    }

    const nOriginal = Number(rollo.CantidadOriginal) || 0;
    const nActual = Number(rollo.CantidadActual) || 0;

    if (nNueva > nOriginal + 0.0001) {
      throw new Error(`No se puede consumir más de lo que entró: el rollo '${tSerial}' tiene ${nOriginal.toFixed(2)} Kg.`);
    }

    const idsGrupo = await obtenerMiembrosGrupoSellado(tx, ancla.idOrdenAncla);
    const nSalidaReal = await obtenerSalidaRealSellado(tx, idsGrupo);

    // Regla C > S ESTRICTA (seccion 4, regla 2): lo que entra nunca puede ser igual a lo que sale,
    // siempre hay merma. Se valida sobre el TOTAL de la orden, no rollo por rollo -- con varios
    // rollos lo que tiene que superar la salida es la suma.
    const nTotalOtros = rollos
      .filter(r => String(r.Serial).trim() !== tSerial)
      .reduce((acc, r) => acc + (Number(r.CantidadActual) || 0), 0);
    const nTotalNuevo = nTotalOtros + nNueva;

    if (nTotalNuevo <= nSalidaReal) {
      const nMinimo = nSalidaReal - nTotalOtros;
      throw new Error(`La orden ya produjo ${nSalidaReal.toFixed(2)} Kg de salida real. El consumo total no puede quedar en ${nTotalNuevo.toFixed(2)} Kg: siempre tiene que haber merma. Para este rollo digite más de ${nMinimo.toFixed(2)} Kg.`);
    }

    const nDiferencia = nActual - nNueva; // > 0 devuelve al inventario, < 0 vuelve a descontar
    const nElementoRollo = parseInt(tSerial.slice(-5), 10);
    if (!Number.isFinite(nElementoRollo) || nElementoRollo <= 0) {
      throw new Error(`No se pudo determinar el elemento de materia prima del serial '${tSerial}'.`);
    }

    // 1. La materia prima -- llave completa, que es la PK de la tabla.
    await tx.request()
      .input('cantidad', nNueva).input('fecha', sql.Date, ancla.fecha).input('elemento', ancla.elemento)
      .input('lote', ancla.lote).input('linea', ancla.lineaOriginal)
      .input('materiaPrima', rollo.MateriaPrima).input('detalle', tSerial)
      .query(`
        UPDATE PRDProduccionMateriaPrima SET Cantidad = @cantidad
        WHERE Fecha = @fecha AND Elemento = @elemento AND Lote = @lote AND Linea = @linea
          AND MateriaPrima = @materiaPrima AND Detalle = @detalle
      `);

    // 2. El inventario. La bodega se resuelve igual que en la salida (obtenerBodegaDeRollo cae al
    //    movimiento Tipo 24 cuando la fila de existencias ya no esta, que es justo este caso).
    const tBodega = (rollo.Bodega || '').trim() || await obtenerBodegaDeRollo(tx, tSerial);
    if (!tBodega) {
      throw new Error(`No se pudo determinar la bodega del rollo '${tSerial}' -- sin ella no se puede devolver el saldo al inventario.`);
    }

    // Misma guardia AR que generarSalidaRollo: sin Detalle habilitado en la bodega no hay forma de
    // devolver el saldo contra la etiqueta, que es lo unico que lo hace rastreable.
    const dtTipoPedido = await tx.request().input('idOrden', ancla.idOrdenAncla)
      .query(`SELECT TipoPedido FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
    if (dtTipoPedido.recordset.length > 0 && (dtTipoPedido.recordset[0].TipoPedido || '').trim() === 'AR') {
      const dtBod = await tx.request().input('bodega', tBodega)
        .query(`SELECT Nombre, Detalle FROM INVBodegas WHERE Codigo = @bodega`);
      if (dtBod.recordset.length > 0 && dtBod.recordset[0].Detalle === false) {
        throw new Error(`La bodega '${dtBod.recordset[0].Nombre}' no tiene habilitada la opción Etiquetas (Detalle). No es posible devolver el saldo del rollo sin esa configuración.`);
      }
    }

    if (nDiferencia > 0.0001) {
      await entradaExistenciaPorDetalle(tx, {
        bodega: tBodega, elemento: nElementoRollo, detalle: tSerial,
        cantidad: nDiferencia, serie: (rollo.LoteMP || '').trim() || null, generadoPor
      });
    } else if (nDiferencia < -0.0001) {
      // C subio: el operario se habia quedado corto y hay que volver a sacar kilos del saldo. Se
      // reusa la misma funcion que la salida original, con su guardia de existencia insuficiente.
      await descontarExistenciaPorDetalle(tx, {
        bodega: tBodega, elemento: nElementoRollo, detalle: tSerial,
        cantidad: -nDiferencia, generadoPor
      });
      // descontarExistenciaPorDetalle solo mueve Cantidad/Unidades, nunca Valor -- asi viene
      // portado de Mirane y asi se deja, porque lo usa tambien el escaneo normal del rollo. Pero
      // acá la entrada SI valoriza (entradaExistenciaPorDetalle), y dejar la salida sin valorizar
      // haria que un ciclo bajar-subir dejara kilos y pesos desalineados en la misma fila. Se
      // corrige solo en este camino, a prorrata de lo que queda, y en 0 si la fila quedo vacia.
      await tx.request()
        .input('bodega', tBodega).input('elemento', nElementoRollo).input('detalle', tSerial)
        .input('quitado', -nDiferencia)
        .query(`
          UPDATE INVExistencias
          SET Valor = CASE
                        WHEN Cantidad <= 0 THEN 0
                        ELSE CASE WHEN (Cantidad + @quitado) > 0
                                  THEN Valor * (Cantidad / (Cantidad + @quitado))
                                  ELSE 0 END
                      END
          WHERE Bodega = @bodega AND Elemento = @elemento AND Detalle = @detalle
        `);
    }

    // 3. La linea del movimiento de salida ya registrado.
    await ajustarLineaSalidaTipo24(tx, {
      detalle: tSerial, elemento: nElementoRollo,
      cantidadAnterior: nActual, cantidadNueva: nNueva
    });

    // 4. El control del proceso (Total y Consumido, los dos como SUM de la MP ya corregida).
    const control = await recalcularControlSellado(tx, {
      elemento: ancla.elemento, fecha: ancla.fecha, lineaOriginal: ancla.lineaOriginal,
      lote: ancla.lote, generadoPor
    });

    // 5. La linea de tiempo del rollo -- sobre TODAS las ejecuciones del grupo, porque en sellado
    //    en paralelo el mismo serial puede tener fila en la ejecucion de mas de un miembro.
    const idsGrupoLista = idsGrupo.join(',');
    await tx.request().input('serial', tSerial).input('cantidad', nNueva).query(`
      IF OBJECT_ID('SEL_RolloEjecucion', 'U') IS NOT NULL
      UPDATE re SET re.Cantidad = @cantidad
      FROM SEL_RolloEjecucion re
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = re.id_ejecucion
      WHERE re.Serial = @serial AND ej.IdOrden IN (${idsGrupoLista})
    `);

    // 6. SEL_EjecucionOrden guarda UN solo rollo por ejecucion (el ultimo escaneado) y no
    //    representa el total consumido, asi que por defecto no se toca. Solo se alinea si el rollo
    //    ajustado es justamente el que quedo ahi, para que los dos datos no se contradigan.
    await tx.request().input('serial', tSerial).input('cantidad', nNueva).query(`
      UPDATE SEL_EjecucionOrden SET PesoRolloBruto = @cantidad, PesoRolloNeto = @cantidad
      WHERE IdOrden IN (${idsGrupoLista}) AND SerialRolloEntrada = @serial
    `);

    // 7. Rollo confirmado que nunca llego a materializarse (Alistamiento a medias). En una orden
    //    PendienteValidacion no deberia quedar ninguno, pero si lo hay se deja coherente para que
    //    no materialice despues con la cantidad vieja.
    await tx.request().input('serial', tSerial).input('cantidad', nNueva).query(`
      IF OBJECT_ID('SEL_RolloPendienteInicio', 'U') IS NOT NULL
      UPDATE SEL_RolloPendienteInicio SET Cantidad = @cantidad
      WHERE Serial = @serial AND Procesado = 0 AND IdOrden IN (${idsGrupoLista})
    `);

    // 8. La bitacora. CantidadOriginal se guarda SIEMPRE con el R resuelto arriba -- es lo que hace
    //    que el proximo ajuste lea el original de aca y no encadene sobre el valor ya corregido.
    await tx.request()
      .input('idOrden', idOrden).input('idOrdenAncla', ancla.idOrdenAncla).input('serial', tSerial)
      .input('original', nOriginal).input('anterior', nActual).input('nueva', nNueva)
      .input('diferencia', nDiferencia).input('salidaReal', nSalidaReal)
      .input('motivo', (motivo || '').trim() || null)
      .input('generadoPor', generadoPor).input('usuario', usuario || null)
      .query(`
        INSERT INTO SEL_AjusteConsumoRollo
          (IdOrden, IdOrdenAncla, Serial, CantidadOriginal, CantidadAnterior, CantidadNueva, Diferencia, SalidaRealKg, Motivo, GeneradoPor, Usuario)
        VALUES (@idOrden, @idOrdenAncla, @serial, @original, @anterior, @nueva, @diferencia, @salidaReal, @motivo, @generadoPor, @usuario)
      `);

    await tx.commit();

    return {
      ok: true,
      serial: tSerial,
      cantidadOriginal: nOriginal,
      cantidadAnterior: nActual,
      cantidadNueva: nNueva,
      devuelto: nDiferencia,
      salidaReal: nSalidaReal,
      consumoTotal: nTotalNuevo,
      mermaEstimada: nTotalNuevo - nSalidaReal,
      // Cero filas actualizadas significa que no hay PRDExtrusionControl para este proceso: la MP y
      // el inventario ya quedaron bien, pero el control (y con el la merma del escritorio) no.
      // Se avisa hacia arriba en vez de tragarselo.
      controlActualizado: control.filasActualizadas > 0,
      materialTotal: control.total
    };
  } catch (err) {
    try {
      await tx.rollback();
    } catch (errRollback) {
      console.error('Rollback fallido tras el error real del ajuste de consumo:', errRollback.message);
    }
    throw err;
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
  resolverTipoPedido,
  obtenerAnclaGrupoSellado,
  obtenerOCrearOrdenProduccion,
  finalizarControlParcialSellado,
  valNumerico,
  resolverTurnoMaquina,
  cerrarBitacora,
  horaServidorBD,
  candidatosTurnoMaquina,
  activarTurnoMaquina,
  turnosParaCorregir,
  corregirTurnoMaquina,
  turnosParaLogin,
  sincronizarBitacoraAlEntrar,
  infoOTParaCorreccion,
  turnosParaCorregirOT,
  corregirTurnoOT,
  abrirBitacorasPendientes,
  franjasMaquinaOBase,
  turnoAJson,
  nombreCortoTurno,
  columnaExiste,
  esSupervisor,
  CARGOS_SUPERVISOR,
  repararCoberturaTurnos,
  cerrarBitacorasPorFinTurno,
  suspenderOTDeOrden,
  reanudarOTDeOrden,
  abrirOReanudarBitacora,
  obtenerSalidaRealSellado,
  obtenerMiembrosGrupoSellado,
  resolverAnclaMateriaPrima,
  listarRollosOrden,
  recalcularControlSellado,
  obtenerEstadoAjusteConsumo,
  ajustarConsumoRollo
};
