// Puerto de las validaciones y de Finalizar de Source/Produccion/EjecucionSelladora.vb -- Iniciar
// y Añadir Rollo delegan el escaneo/escritura en scan-rollo.js, aca solo quedan las guardas de
// estado (mismas que dgvEjecuciones_CellFormatting/HandleIniciar/HandleAnadirRollo) y el cierre
// de la orden (HandleFinalizar). Residuos/Verificar/Cerrar Definitivo NO se portan -- quedan
// exclusivos del escritorio, ver el plan.

const sql = require('mssql');
const { finalizarControlParcialSellado } = require('./sel-inventario-mp');

// EjecucionSelladora.vb:293-336 (HandleIniciar, validaciones antes de abrir el escaneo)
async function validarPuedeIniciar(db, idOrden) {
  const dtOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT Estado FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) return { ok: false, error: 'Orden no encontrada.' };
  const tEstado = dtOrden.recordset[0].Estado;

  if (tEstado === 'Activa') return { ok: false, error: 'Esta orden ya está en curso.' };
  if (tEstado === 'Finalizada') return { ok: false, error: 'Esta orden ya fue finalizada.' };
  if (tEstado === 'PendienteValidacion') {
    return { ok: false, error: 'Esta orden ya cerró sus bultos y está pendiente de que el digitador valide residuos y peso.' };
  }

  const dtConflicto = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 maq.Nombre AS NombreMaquina
    FROM SEL_OrdenProduccion ord2
    INNER JOIN SEL_OrdenProduccion ord1 ON ord1.Maquina = ord2.Maquina
    INNER JOIN PRDMaquinas maq ON maq.Codigo = ord2.Maquina
    WHERE ord1.IdOrden = @idOrden AND ord2.Estado = 'Activa' AND ord2.IdOrden <> @idOrden
  `);
  if (dtConflicto.recordset.length > 0) {
    return {
      ok: false,
      error: `No se puede iniciar este proceso. La máquina '${dtConflicto.recordset[0].NombreMaquina}' ya tiene un proceso activo. Primero finalice ese proceso.`
    };
  }

  return { ok: true };
}

// EjecucionSelladora.vb:347-376 (HandleAnadirRollo, validaciones)
async function validarPuedeAnadirRollo(db, idOrden) {
  const dtOrden = await db.request().input('idOrden', idOrden)
    .query(`SELECT Estado FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) return { ok: false, error: 'Orden no encontrada.' };
  if (dtOrden.recordset[0].Estado !== 'Activa') {
    return { ok: false, error: 'Solo se puede añadir un rollo a una orden Activa.' };
  }

  const dtActivo = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden AND HoraFinReal IS NULL ORDER BY IdEjecucion DESC
  `);
  const idEjecucionActivo = dtActivo.recordset.length > 0 ? dtActivo.recordset[0].IdEjecucion : 0;

  // Bolsas x Golpe ya lo definió el operario al iniciar la orden -- se recupera para mostrarlo,
  // no se vuelve a pedir (igual que frmScanRollo.vb con EsNuevoRollo=True).
  const dtBolsas = await db.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 BolsasxGolpe FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden AND BolsasxGolpe IS NOT NULL ORDER BY IdEjecucion DESC
  `);
  const bolsasActual = dtBolsas.recordset.length > 0 ? dtBolsas.recordset[0].BolsasxGolpe : 0;

  return { ok: true, idEjecucionActivo, bolsasActual };
}

// EjecucionSelladora.vb:379-444 (HandleFinalizar) -- deja la orden en 'PendienteValidacion',
// exactamente igual que hoy; Residuos/Verificar/Cerrar Definitivo siguen siendo del escritorio.
// operarioFinal: PRDOperarios.Codigo de quien finaliza (distinto del que inicio, ya guardado en
// SEL_EjecucionOrden.Operario) -- mismo criterio que EjecucionSelladora.vb (HandleFinalizar,
// linea ~389 en adelante): se resuelve de SISUsuarios.CodigoOperarioPRD del usuario logueado
// (aca ya viene resuelto desde la sesion web, ver auth.js/accesos.js) y bloquea si no esta
// configurado -- ver agregar_operariofinal_selejecucionorden.sql.
async function finalizarOrden(pool, idOrden, generadoPor, operarioFinal) {
  if (!operarioFinal || operarioFinal <= 0) {
    throw new Error('Su usuario no tiene un operario de planta asignado (SISUsuarios.CodigoOperarioPRD) -- pida a un administrador que lo configure antes de finalizar.');
  }

  const dtOrden = await pool.request().input('idOrden', idOrden)
    .query(`SELECT Estado FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (dtOrden.recordset.length === 0) throw new Error('Orden no encontrada.');
  if (dtOrden.recordset[0].Estado !== 'Activa') {
    throw new Error('Solo se puede finalizar una orden que esté Activa.');
  }

  // FIX 24/08/2026: ver mismo fix en EjecucionSelladora.vb:HandleFinalizar -- Golpes/Potencia de
  // SEL_Bultos los escribe unicamente la maquina/PLC (Node-RED) al cerrar el bulto por si sola;
  // nada aca los calcula despues. Forzar el cierre de un bulto Activo antes de que la maquina lo
  // hiciera perdia esos dos campos para siempre. Ahora se bloquea.
  const dtBultoActivo = await pool.request().input('idOrden', idOrden).query(`
    SELECT COUNT(*) AS Cnt FROM SEL_Bultos
    WHERE id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
    AND estado = 'Activo'
  `);
  if (dtBultoActivo.recordset[0].Cnt > 0) {
    throw new Error('Esta orden todavía tiene un bulto en proceso: la máquina no ha terminado de llenarlo. Espere a que la máquina lo cierre sola antes de dar Finalizar -- si finaliza ahora, se pierden los golpes y la potencia registrados de ese bulto.');
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request().input('idOrden', idOrden).input('operarioFinal', operarioFinal).query(`
      UPDATE SEL_EjecucionOrden SET HoraFinReal = GETDATE(), Estado = 'PendienteValidacion', OperarioFinal = @operarioFinal
      WHERE IdOrden = @idOrden AND HoraFinReal IS NULL
    `);
    await tx.request().input('idOrden', idOrden).query(`
      UPDATE SEL_OrdenProduccion SET Estado = 'PendienteValidacion' WHERE IdOrden = @idOrden
    `);
    // FIX 24/08/2026: el bulto que haya quedado Temporal NUNCA tuvo un paquete pesado
    // (number_paqu=0) -- no hay nada que "cerrar" ahi. Antes se forzaba a 'Cerrado', lo cual
    // disparaba trg_SEL_Bultos_CierreBulto sin necesidad (rompia con error 515 por el SUM sobre 0
    // paquetes, y de paso creaba OTRO Temporal que tambien habria que borrar). Ahora se borra
    // directo junto con sus filas espejo, sin pasar por Cerrado ni disparar el trigger. Ya no puede
    // haber ningun bulto Activo en esta orden (se bloquea mas arriba). Se borran ANTES que
    // SEL_Bultos porque dependen de el (Detalle=serialPadre / Elemento+Fecha+Lote+Linea=num_bulto)
    // para identificar la fila exacta.
    await tx.request().input('idOrden', idOrden).query(`
      DELETE FROM PRDExtrusionRollos
      WHERE EXISTS (
        SELECT 1 FROM SEL_Bultos b
        WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
          AND b.estado = 'Temporal' AND b.number_paqu = 0
          AND PRDExtrusionRollos.Elemento = b.refsalida
          AND PRDExtrusionRollos.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
          AND PRDExtrusionRollos.Linea = b.num_bulto
          AND PRDExtrusionRollos.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
      )
    `);
    await tx.request().input('idOrden', idOrden).query(`
      DELETE FROM PRDProduccionOperarios
      WHERE EXISTS (
        SELECT 1 FROM SEL_Bultos b
        WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
          AND b.estado = 'Temporal' AND b.number_paqu = 0
          AND PRDProduccionOperarios.Elemento = b.refsalida
          AND PRDProduccionOperarios.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
          AND PRDProduccionOperarios.Linea = b.num_bulto
          AND PRDProduccionOperarios.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
      )
    `);
    await tx.request().input('idOrden', idOrden).query(`
      DELETE FROM PRDProduccion
      WHERE Detalle IN (
        SELECT b.serialPadre FROM SEL_Bultos b
        WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
          AND b.estado = 'Temporal' AND b.number_paqu = 0
      )
    `);
    await tx.request().input('idOrden', idOrden).query(`
      DELETE FROM SEL_Bultos
      WHERE id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
      AND estado = 'Temporal' AND number_paqu = 0
    `);

    // Retal/Torta fijos en 0 -- igual que EjecucionSelladora.vb hoy (ya no se piden por InputBox,
    // el digitador los ajusta despues en Registro de Residuos).
    await finalizarControlParcialSellado(tx, { idOrden, retalManual: 0, tortaManual: 0, generadoPor });

    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { validarPuedeIniciar, validarPuedeAnadirRollo, finalizarOrden };
