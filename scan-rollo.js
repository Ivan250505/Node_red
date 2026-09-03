// Puerto de Source/Produccion/frmScanRollo.vb -- la pantalla de escaneo del rollo de entrada,
// usada tanto para Iniciar (primer rollo) como para Añadir Rollo (rollo adicional).
// consultarSerial es de solo lectura (valida antes de confirmar, igual que ConsultarSerial
// habilitando btnIniciar); confirmarRollo hace la escritura real dentro de una transacción,
// igual que btnIniciar_Click + CrearBultoInicial.

const sql = require('mssql');
const {
  obtenerBodegaDeRollo, obtenerLoteRollo, esMateriaPrimaProhibidaSellado,
  registrarMateriaPrimaRollo, generarSalidaRollo, registrarControlParcialSellado,
  resolverTurnoPorHora, resolverClienteDestino, resolverDestinoOrden,
  obtenerLineaOriginalControlSellado, obtenerFechaLoteOriginalControlSellado,
  obtenerOCrearOrdenProduccion, valNumerico
} = require('./sel-inventario-mp');

function formatMMDD(d) {
  return String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

// frmScanRollo.vb:154-165 (Elemento/Maquina/NumeroPedido de la orden)
// FIX 31/08/2026 (bug real encontrado -- pedidos alfanumericos como "A0003" nunca resolvian
// Cliente/Destino, ni guardaban NumeroPedido en PRDProduccion): numeroPedido pasa de
// valNumerico(...) (parseInt, devuelve 0 para cualquier string que no empiece con un digito) a
// texto crudo. NumeroPedido vive como varchar en SEL_OrdenProduccion (viene de
// VENMovimientos.Numero) -- forzarlo a numero acá era la causa raiz del bug, ver
// SEL_InventarioMP.vb:ResolverClienteDestino (mismo fix del lado VB).
async function obtenerDatosOrden(db, idOrden) {
  const dt = await db.request().input('idOrden', idOrden)
    .query(`SELECT Elemento, Maquina, NumeroPedido FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dt.recordset.length === 0) return null;
  const r = dt.recordset[0];
  return { elemento: r.Elemento, maquina: r.Maquina, numeroPedido: r.NumeroPedido != null ? String(r.NumeroPedido).trim() : '' };
}

// frmScanRollo.vb:57-139 (ConsultarSerial) -- validacion previa a confirmar, no escribe nada.
async function consultarSerial(db, { idOrden, serial, esNuevoRollo }) {
  const tSerial = (serial || '').trim();
  if (!tSerial) return { ok: false, error: 'Serial vacío.' };

  const dtExist = await db.request().input('serial', tSerial)
    .query(`SELECT TOP 1 Cantidad, Elemento FROM INVExistencias WHERE Detalle = @serial`);
  if (dtExist.recordset.length === 0) {
    return { ok: false, error: `No se encontró el serial '${tSerial}' en existencias.` };
  }

  const datosOrden = await obtenerDatosOrden(db, idOrden);
  if (!datosOrden) return { ok: false, error: 'Orden no encontrada.' };

  const tBodegaRollo = await obtenerBodegaDeRollo(db, tSerial);

  if (esNuevoRollo) {
    const tLoteHoy = formatMMDD(new Date());
    const dtBodegaPpal = await db.request().input('lote', tLoteHoy).input('elemento', datosOrden.elemento)
      .query(`SELECT TOP 1 Bodega FROM PRDProduccionMateriaPrima WHERE Lote = @lote AND Elemento = @elemento AND Bodega IS NOT NULL ORDER BY Linea ASC`);
    if (dtBodegaPpal.recordset.length > 0) {
      const tBodegaPpal = (dtBodegaPpal.recordset[0].Bodega || '').trim();
      if (tBodegaRollo && tBodegaPpal && tBodegaRollo.toUpperCase() !== tBodegaPpal.toUpperCase()) {
        return {
          ok: false,
          error: `Este rollo pertenece a la bodega '${tBodegaRollo}', pero la etiqueta principal de esta ejecución usa la bodega '${tBodegaPpal}'. Debe escanear un rollo de la misma bodega.`
        };
      }
    }
  }

  let tBodegaNombre = '';
  if (tBodegaRollo) {
    const dtBodegaNombre = await db.request().input('bodega', tBodegaRollo).query(`SELECT Nombre FROM INVBodegas WHERE Codigo = @bodega`);
    if (dtBodegaNombre.recordset.length > 0) tBodegaNombre = (dtBodegaNombre.recordset[0].Nombre || '').trim();
  }

  const nElementoRollo = dtExist.recordset[0].Elemento || 0;
  let tReferencia = '-';
  if (nElementoRollo > 0) {
    const dtRefRollo = await db.request().input('elemento', nElementoRollo).query(`SELECT Referencia FROM INVElementos WHERE Codigo = @elemento`);
    if (dtRefRollo.recordset.length > 0 && dtRefRollo.recordset[0].Referencia != null) tReferencia = String(dtRefRollo.recordset[0].Referencia).trim();

    const { prohibida, mensaje } = await esMateriaPrimaProhibidaSellado(db, nElementoRollo);
    if (prohibida) return { ok: false, error: mensaje };
  }

  return {
    ok: true,
    serial: tSerial,
    cantidad: Number(dtExist.recordset[0].Cantidad),
    lote: await obtenerLoteRollo(db, tSerial),
    bodega: tBodegaRollo,
    bodegaNombre: tBodegaNombre || tBodegaRollo || '-',
    referencia: tReferencia
  };
}

// frmScanRollo.vb:173-295 (CrearBultoInicial) -- crea el primer bulto (SEL_Bultos) de la
// ejecucion recien abierta, dentro de la transaccion de confirmarRollo.
async function crearBultoInicial(tx, { idOrden, idEjecucion, codOperario, serial, cantidad, lote, bolsasXGolpe, generadoPor }) {
  const datosOrden = await obtenerDatosOrden(tx, idOrden);
  if (!datosOrden) throw new Error('Orden no encontrada.');
  const { elemento: nElemento, maquina: nMaquina, numeroPedido: tNumeroPedido } = datosOrden;

  // FIX 24/08/2026: al Iniciar, este operario pasa a ser el "operario actual" de la maquina --
  // ver agregar_operarioactualmaquina.sql. trg_SEL_Bultos_CierreBulto la consulta para cada bulto
  // nuevo que crea solo (el PLC puede seguir corriendo horas sin que nadie toque esta pagina); si
  // cambia el turno, el operario que confirme "tomar control" (ver /api/selladora/maquina/.../
  // tomar-control) actualiza esta misma fila.
  if (codOperario > 0) {
    await tx.request().input('maquina', nMaquina).input('operario', codOperario).query(`
      MERGE SEL_OperarioActualMaquina AS destino
      USING (SELECT @maquina AS Maquina) AS origen ON destino.Maquina = origen.Maquina
      WHEN MATCHED THEN UPDATE SET Operario = @operario, FechaHora = GETDATE()
      WHEN NOT MATCHED THEN INSERT (Maquina, Operario, FechaHora) VALUES (@maquina, @operario, GETDATE());
    `);
  }

  const fHoy = new Date();
  const nAgno = fHoy.getFullYear();
  const nMes = fHoy.getMonth() + 1;
  const nDia = fHoy.getDate();
  const tLote = formatMMDD(fHoy);
  // FIX 31/08/2026 (bug real encontrado -- Operario/historial en null/vacio al escanear desde
  // la tablet): en Mirane (escritorio), la columna Fecha SIEMPRE se guarda a medianoche
  // (dtpFecha solo tiene el dia, sin hora) -- todo el resto del sistema (busqueda de historial,
  // ancla de OrdenProduccion, PRDProduccionOperarios) compara "WHERE Fecha = @fecha" asumiendo
  // eso. Acá se usaba fHoy (con hora real, ej. 08:39:00) tanto para Fecha como para HoraInicio
  // -- las filas quedaban con Fecha "manchada" de hora, y cualquier lookup posterior con Fecha a
  // medianoche (sql.Date) nunca las encontraba. fFechaSolo es SOLO para la columna Fecha (el
  // "dia" del proceso); fHoy se sigue usando para HoraInicio y lo que sí necesita la hora real.
  const fFechaSolo = new Date(nAgno, fHoy.getMonth(), nDia);

  const dtLinea = await tx.request()
    .input('agno', nAgno).input('lote', tLote).input('elemento', nElemento).input('mes', nMes).input('dia', nDia)
    .query(`
      SELECT ISNULL(MAX(x.Linea), 0) AS MaxLinea FROM (
        SELECT Linea FROM PRDProduccion
        WHERE Year(Fecha) = @agno AND Lote = @lote AND Elemento = @elemento AND Linea < 1000
        UNION ALL
        SELECT num_bulto FROM SEL_Bultos
        WHERE agno = @agno AND mes = @mes AND dia = @dia AND refsalida = @elemento
      ) x
    `);
  const nNumBulto = dtLinea.recordset[0].MaxLinea + 1;

  // Mismo formato que Detalle/CodigoBarras en Produccion.vb: Año(4) + Lote(6) + Linea(4) + Elemento(5) = 19 digitos
  const tSerialPadre = String(nAgno) + String(valNumerico(tLote)).padStart(6, '0') + String(nNumBulto).padStart(4, '0') + String(nElemento).padStart(5, '0');

  const tBodegaRollo = await obtenerBodegaDeRollo(tx, serial);
  // PRDProduccionMateriaPrima se guarda bajo la Linea ANCLA (LineaOriginal, el primer bulto de
  // toda la ejecucion), no bajo el num_bulto de este rollo puntual -- mismo criterio que ya usan
  // registrarControlParcialSellado/calcularMaterialTotalSellado. Sin esto, Produccion.vb:Buscar()
  // (que filtra por Linea=LineaOriginal exacto) nunca encuentra el historial de un rollo agregado
  // via "Añadir Rollo" -- descubierto 23/08/2026.
  const nLineaOriginal = await obtenerLineaOriginalControlSellado(tx, idOrden, nNumBulto);

  // OrdenProduccion (codigo OP...) se asigna/recupera aqui mismo, en el primer bulto de la
  // ejecucion, en vez de esperar al cierre -- mismo cambio que frmScanRollo.vb:CrearBultoInicial
  // (23/08/2026). Asi queda disponible para estampar en PRDProduccionMateriaPrima desde el
  // primer rollo (incluidos los que llegan luego via "Añadir Rollo").
  const nCodDestinoBulto = await resolverDestinoOrden(tx, idOrden, tNumeroPedido);
  const tOrdenProduccion = await obtenerOCrearOrdenProduccion(tx, {
    elemento: nElemento, fecha: fFechaSolo, lineaAncla: nLineaOriginal, lote: tLote,
    codigoDestino: nCodDestinoBulto, generadoPor
  });

  await registrarMateriaPrimaRollo(tx, {
    fecha: fFechaSolo, lote: tLote, elementoProducto: nElemento, linea: nLineaOriginal,
    detalleRollo: serial, cantidad, loteMP: lote, bodega: tBodegaRollo, ordenProduccion: tOrdenProduccion
  });
  await generarSalidaRollo(tx, {
    idOrden, fecha: fFechaSolo, lote: tLote, elementoProducto: nElemento, linea: nNumBulto,
    detalleRollo: serial, cantidad, generadoPor
  });
  await registrarControlParcialSellado(tx, {
    idOrden, elemento: nElemento, fecha: fFechaSolo, anio: nAgno, numBultoActual: nNumBulto,
    lote: tLote, pesoRolloBruto: cantidad, generadoPor
  });

  // FIX 31/08/2026: SEL_Bultos.NumeroPedido paso de INT a VARCHAR(20) (a pedido del usuario --
  // antes un pedido alfanumerico como "A0003" quedaba en null aqui). Ahora se guarda el texto
  // completo, igual que PRDProduccion/SEL_OrdenProduccion.
  const tNumeroPedidoBultoSQL = tNumeroPedido || null;

  await tx.request()
    .input('agno', nAgno).input('mes', nMes).input('dia', nDia).input('numBulto', nNumBulto)
    .input('elemento', nElemento).input('serialPadre', tSerialPadre).input('maquina', nMaquina)
    .input('idEjecucion', idEjecucion).input('numeroPedido', tNumeroPedidoBultoSQL).input('horaInicio', fHoy)
    .query(`
      INSERT INTO SEL_Bultos (agno, mes, dia, number_paqu, num_bulto, refsalida, estado, serialArmado, serialPadre, id_maquina, id_ejecucion, NumeroPedido, HoraInicio)
      VALUES (@agno, @mes, @dia, 0, @numBulto, @elemento, 'Activo', @serialPadre, @serialPadre, @maquina, @idEjecucion, @numeroPedido, @horaInicio)
    `);

  const nTurnoBulto = await resolverTurnoPorHora(tx, nMaquina, fHoy);
  if (nTurnoBulto <= 0) {
    throw new Error('No se encontró un turno activo configurado para esta máquina a esta hora en TURHorariosMaquinas.\nTurno es un campo obligatorio en PRDProduccion -- corrija la configuración de turnos antes de continuar.');
  }

  const { codCliente: nCodClienteBulto } = await resolverClienteDestino(tx, tNumeroPedido);

  await tx.request()
    .input('fecha', fFechaSolo).input('horaInicio', fHoy).input('maquina', nMaquina).input('turno', String(nTurnoBulto))
    .input('lote', tLote).input('elemento', nElemento).input('linea', nNumBulto).input('serialPadre', tSerialPadre)
    .input('cliente', nCodClienteBulto > 0 ? nCodClienteBulto : null).input('destino', nCodDestinoBulto > 0 ? nCodDestinoBulto : null)
    .input('generadoPor', generadoPor).input('bolsas', bolsasXGolpe)
    .input('numeroPedido', tNumeroPedido || null)
    .input('ordenProduccion', tOrdenProduccion || null)
    .query(`
      -- FIX 03/09/2026 (a pedido del usuario -- mismo cambio que frmScanRollo.vb:CrearBultoInicial):
      -- HoraFinal ya no se inserta en NULL -- se deja igual a HoraInicio (placeholder, duracion "0"
      -- mientras el bulto sigue abierto). Motivo: pantallas que todavia no tienen el build mas
      -- reciente leen HoraFinal sin blindaje contra NULL y truenan la ventana completa. Al cerrar
      -- el bulto, trg_SEL_Bultos_CierreBulto sobreescribe este placeholder con el HoraFinal real.
      INSERT INTO PRDProduccion (Fecha, Maquina, Turno, Duracion, Lote, Elemento, Linea, Cantidad, PesoCono, Unidades, Detalle,
        ClienteProduccion, Destino, Grafilado, Abierto, Servicio, Retal, GeneradoPor,
        FechaModificado, HoraInicio, HoraFinal, Torta, BolsasxGolpe, TipoPedido, NumeroPedido, OrdenProduccion)
      VALUES (@fecha, @maquina, @turno, 0, @lote, @elemento, @linea, 0, 0, 0, @serialPadre,
        @cliente, @destino, 0, 0, 0, 0, @generadoPor,
        GETDATE(), @horaInicio, @horaInicio, 0, @bolsas, 4, @numeroPedido, @ordenProduccion)
    `);

  if (codOperario > 0) {
    await tx.request()
      .input('fecha', fFechaSolo).input('lote', tLote).input('elemento', nElemento).input('linea', nNumBulto).input('operario', codOperario)
      .query(`INSERT INTO PRDProduccionOperarios (Fecha, Lote, Elemento, Linea, Operario) VALUES (@fecha, @lote, @elemento, @linea, @operario)`);
  }
}

// frmScanRollo.vb:btnIniciar_Click (rama Else, 23/08/2026) -- SEL_EjecucionOrden debe quedar UN
// solo registro por orden: el placeholder ya lo crea Programacion.vb al programar. Iniciar debe
// UPDATEarlo, no insertar uno nuevo (el diseno anterior duplicaba la ejecucion cada vez).
async function abrirNuevaEjecucion(tx, { idOrden, codOperario, serial, cantidad, bolsasXGolpe, maquina }) {
  const dtPlaceholder = await tx.request().input('idOrden', idOrden)
    .query(`SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion ASC`);

  if (dtPlaceholder.recordset.length > 0) {
    const nIdEjecucion = dtPlaceholder.recordset[0].IdEjecucion;
    await tx.request()
      .input('idEjecucion', nIdEjecucion).input('codOperario', codOperario).input('serial', serial)
      .input('cantidad', cantidad).input('bolsas', bolsasXGolpe).input('maquina', maquina)
      .query(`
        UPDATE SEL_EjecucionOrden SET
          Operario = CASE WHEN @codOperario > 0 THEN @codOperario ELSE Operario END,
          SerialRolloEntrada = @serial,
          PesoRolloBruto = @cantidad,
          PesoCono = 0,
          PesoRolloNeto = @cantidad,
          Estado = 'Activa',
          HoraInicioReal = GETDATE(),
          BolsasxGolpe = @bolsas,
          Maquina = @maquina
        WHERE IdEjecucion = @idEjecucion
      `);
    return nIdEjecucion;
  }

  const dt = await tx.request()
    .input('idOrden', idOrden).input('codOperario', codOperario).input('serial', serial)
    .input('cantidad', cantidad).input('bolsas', bolsasXGolpe).input('maquina', maquina)
    .query(`
      INSERT INTO SEL_EjecucionOrden (IdOrden, Operario, SerialRolloEntrada, PesoRolloBruto, PesoCono, PesoRolloNeto, Estado, HoraInicioReal, BolsasxGolpe, Maquina)
      OUTPUT INSERTED.IdEjecucion
      VALUES (@idOrden, @codOperario, @serial, @cantidad, 0, @cantidad, 'Activa', GETDATE(), @bolsas, @maquina)
    `);
  return dt.recordset[0].IdEjecucion;
}

// frmScanRollo.vb:311-384 (btnIniciar_Click) -- transaccion completa: Iniciar (primer rollo) o
// Añadir Rollo (rollo adicional, cierra el anterior). `pool` es el pool de mssql; esta funcion
// abre y maneja su propia transaction.
async function confirmarRollo(pool, { idOrden, idEjecucionActivo, serial, esNuevoRollo, codOperario, bolsasXGolpe, generadoPor }) {
  // Revalida server-side con los datos de este momento (la pagina es sin estado entre el
  // escaneo y la confirmacion -- a diferencia del formulario de escritorio, que ya tenia
  // mfCantidad/msSerial/mtLote fijados desde ConsultarSerial).
  const consulta = await consultarSerial(pool, { idOrden, serial, esNuevoRollo });
  if (!consulta.ok) throw new Error(consulta.error);

  const datosOrden = await obtenerDatosOrden(pool, idOrden);
  if (!datosOrden) throw new Error('Orden no encontrada.');

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    if (esNuevoRollo) {
      // Añadir Rollo: NO crea ejecucion nueva, ni bulto nuevo, ni fila en PRDProduccion. Por
      // maquina solo puede haber UN bulto Activo -- añadir un rollo es alimentar mas materia
      // prima al MISMO bulto que ya esta en curso (igual que un proceso de etiquetas parciales
      // en extrusion). Solo se registra la salida de inventario y la linea de historial
      // (PRDProduccionMateriaPrima), contra la ejecucion/bulto que YA existen. Confirmado con el
      // usuario 23/08/2026 -- el diseno anterior llamaba crearBultoInicial en cada rollo,
      // creando un bulto y una fila de PRDProduccion nuevos por cada uno, lo cual estaba mal.
      const fHoy = new Date();
      const tLote = formatMMDD(fHoy);
      const nLineaOriginal = await obtenerLineaOriginalControlSellado(tx, idOrden, 0);
      const tBodegaRollo = await obtenerBodegaDeRollo(tx, consulta.serial);

      // FIX 24/08/2026: la materia prima de "Añadir Rollo" se anotaba bajo la Fecha/Lote de HOY --
      // si el proceso viene de un dia anterior (Iniciar ayer, Añadir Rollo hoy), esa fila queda
      // invisible para MostrarHistorialMP y para este mismo lookup de OrdenProduccion (ambos
      // filtran por Fecha+Lote exactos contra el ancla original). Mismo criterio que
      // Produccion.vb:8467-8471 -- la MP siempre va bajo el ancla del proceso, nunca bajo el dia
      // real de la etiqueta. La salida de inventario (generarSalidaRollo) sigue fechada HOY porque
      // esa si es la fecha real del movimiento.
      const original = await obtenerFechaLoteOriginalControlSellado(tx, idOrden, nLineaOriginal);
      const fechaMP = original ? original.fecha : fHoy;
      const loteMP = original ? original.lote : tLote;

      // El codigo OP... ya quedo asignado en el primer bulto (crearBultoInicial) -- se recupera
      // aqui del ancla (LineaOriginal) para estampar el mismo codigo en este rollo adicional,
      // igual que frmScanRollo.vb:btnIniciar_Click (rama EsNuevoRollo, 23/08/2026).
      const dtOP = await tx.request()
        .input('elemento', datosOrden.elemento).input('fecha', sql.Date, fechaMP).input('lote', loteMP).input('linea', nLineaOriginal)
        .query(`SELECT TOP 1 OrdenProduccion FROM PRDProduccion WHERE Elemento = @elemento AND Fecha = @fecha AND Lote = @lote AND Linea = @linea`);
      const tOrdenProduccionAR = (dtOP.recordset.length > 0 && dtOP.recordset[0].OrdenProduccion) ? dtOP.recordset[0].OrdenProduccion : '';

      await registrarMateriaPrimaRollo(tx, {
        fecha: fechaMP, lote: loteMP, elementoProducto: datosOrden.elemento, linea: nLineaOriginal,
        detalleRollo: consulta.serial, cantidad: consulta.cantidad, loteMP: consulta.lote, bodega: tBodegaRollo,
        ordenProduccion: tOrdenProduccionAR
      });
      await generarSalidaRollo(tx, {
        idOrden, fecha: fHoy, lote: tLote, elementoProducto: datosOrden.elemento, linea: nLineaOriginal,
        detalleRollo: consulta.serial, cantidad: consulta.cantidad, generadoPor
      });
    } else {
      const nuevaIdEjecucion = await abrirNuevaEjecucion(tx, {
        idOrden, codOperario, serial: consulta.serial, cantidad: consulta.cantidad,
        bolsasXGolpe, maquina: datosOrden.maquina
      });

      await crearBultoInicial(tx, {
        idOrden, idEjecucion: nuevaIdEjecucion, codOperario, serial: consulta.serial,
        cantidad: consulta.cantidad, lote: consulta.lote, bolsasXGolpe, generadoPor
      });

      await tx.request().input('idOrden', idOrden).query(`UPDATE SEL_OrdenProduccion SET Estado = 'Activa' WHERE IdOrden = @idOrden`);
    }

    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { obtenerDatosOrden, consultarSerial, confirmarRollo };
