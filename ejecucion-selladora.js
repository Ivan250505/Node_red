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

  // Sellado en paralelo (08/09/2026 -- ver DISENO_SELLADO_PARALELO_08092026.md): si esta orden
  // pertenece a un grupo SELLADORA, se finaliza TODO el grupo junto (confirmado con el usuario) --
  // es un solo rollo físico, cuando el operario termina, terminó para las 3 referencias, no solo
  // la que tenía el botón "Finalizar" a mano. Si no está agrupada, idsGrupo = [idOrden] y todo el
  // resto de la función se comporta exactamente igual que antes.
  // FIX 09/09/2026 (bug real -- causó el bloqueo falso "Todavía hay un bulto en proceso" con el
  // Pedido 11408: se coló la orden del Pedido 11085, que comparte el mismo Elemento de salida pero
  // no tiene nada que ver con este grupo). Elemento por sí solo NO es llave suficiente -- dos
  // pedidos DISTINTOS pueden usar la misma referencia de salida en momentos distintos. Exige
  // también el mismo NumeroPedido en ambos lados (ord1 Y ord2 contra g.Numero).
  // FIX 13/09/2026 (a pedido del usuario, mismo patrón ya corregido en server.js/scan-rollo.js/
  // frmLiberacionProduccion.vb para el bug del pedido 11243): la llave real es ord.Linea, no
  // ord.Elemento -- ver el comentario largo en scan-rollo.js:confirmarRollo.
  const dtGrupo = await pool.request().input('idOrden', idOrden).query(`
    SELECT ord2.IdOrden
    FROM SEL_OrdenProduccion ord1
    INNER JOIN PRDGrupoEtapasCompartidasLineas gl1 ON gl1.Linea = ord1.Linea
    INNER JOIN PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl1.IdGrupo AND g.CategoriaMaquina = 'SELLADORA'
      AND g.Numero = ord1.NumeroPedido
    INNER JOIN PRDGrupoEtapasCompartidasLineas gl2 ON gl2.IdGrupo = g.IdGrupo
    INNER JOIN SEL_OrdenProduccion ord2 ON ord2.Linea = gl2.Linea AND ord2.NumeroPedido = g.Numero
    WHERE ord1.IdOrden = @idOrden
  `);
  const idsGrupo = dtGrupo.recordset.length > 0
    ? [...new Set(dtGrupo.recordset.map(r => r.IdOrden))]
    : [idOrden];

  // Solo se finalizan los miembros que de verdad llegaron a 'Activa' -- uno del grupo al que el
  // operario nunca alternó (nunca se llegó a producir nada) se queda tal cual, en 'Pendiente'.
  const dtEstados = await pool.request().query(
    `SELECT IdOrden, Estado FROM SEL_OrdenProduccion WHERE IdOrden IN (${idsGrupo.join(',')})`
  );
  const idsActivos = dtEstados.recordset.filter(r => r.Estado === 'Activa').map(r => r.IdOrden);
  if (idsActivos.length === 0) {
    throw new Error('Solo se puede finalizar una orden que esté Activa.');
  }

  // FIX 24/08/2026: ver mismo fix en EjecucionSelladora.vb:HandleFinalizar -- Golpes/Potencia de
  // SEL_Bultos los escribe unicamente la maquina/PLC (Node-RED) al cerrar el bulto por si sola;
  // nada aca los calcula despues. Forzar el cierre de un bulto Activo antes de que la maquina lo
  // hiciera perdia esos dos campos para siempre. Ahora se bloquea -- ampliado a TODOS los miembros
  // activos del grupo, no solo la orden puntual que se está finalizando.
  const dtBultoActivo = await pool.request().query(`
    SELECT COUNT(*) AS Cnt FROM SEL_Bultos
    WHERE id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden IN (${idsActivos.join(',')}))
    AND estado = 'Activo'
  `);
  if (dtBultoActivo.recordset[0].Cnt > 0) {
    throw new Error('Todavía hay un bulto en proceso (de esta u otra referencia del mismo grupo): la máquina no ha terminado de llenarlo. Espere a que la máquina lo cierre sola antes de dar Finalizar -- si finaliza ahora, se pierden los golpes y la potencia registrados de ese bulto.');
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // Bultos 'EnEspera' con paquetes reales (de referencias del grupo a las que el operario
    // alternó y luego dejó, sin volver) -- el PLC nunca los va a cerrar solo, porque ya no están
    // en el estado que mira (id_maquina + estado IN ('Activo','Temporal'), ver
    // agregar_detalle_pesajeelemento.sql). Se cierran acá a mano, disparando el mismo
    // trg_SEL_Bultos_CierreBulto normal -- que de paso puede reservar un Temporal vacío nuevo,
    // por eso esto va ANTES de la limpieza de vacíos de abajo, no después.
    await tx.request().query(`
      UPDATE SEL_Bultos SET estado = 'Cerrado'
      WHERE id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden IN (${idsActivos.join(',')}))
        AND estado = 'EnEspera' AND number_paqu > 0
    `);

    for (const nIdOrdenMiembro of idsActivos) {
      await tx.request().input('idOrden', nIdOrdenMiembro).input('operarioFinal', operarioFinal).query(`
        UPDATE SEL_EjecucionOrden SET HoraFinReal = GETDATE(), Estado = 'PendienteValidacion', OperarioFinal = @operarioFinal
        WHERE IdOrden = @idOrden AND HoraFinReal IS NULL
      `);
      await tx.request().input('idOrden', nIdOrdenMiembro).query(`
        UPDATE SEL_OrdenProduccion SET Estado = 'PendienteValidacion' WHERE IdOrden = @idOrden
      `);
      // FIX 24/08/2026: el bulto que haya quedado Temporal NUNCA tuvo un paquete pesado
      // (number_paqu=0) -- no hay nada que "cerrar" ahi. Antes se forzaba a 'Cerrado', lo cual
      // disparaba trg_SEL_Bultos_CierreBulto sin necesidad (rompia con error 515 por el SUM sobre 0
      // paquetes, y de paso creaba OTRO Temporal que tambien habria que borrar). Ahora se borra
      // directo junto con sus filas espejo, sin pasar por Cerrado ni disparar el trigger. Ya no
      // puede haber ningun bulto Activo en el grupo (se bloquea mas arriba). Se borran ANTES que
      // SEL_Bultos porque dependen de el (Detalle=serialPadre / Elemento+Fecha+Lote+Linea=num_bulto)
      // para identificar la fila exacta.
      // FIX 08/09/2026 (Sellado en paralelo): también incluye 'EnEspera' vacío -- una referencia a
      // la que el operario alternó pero nunca llegó a pesar nada antes de irse a otra.
      await tx.request().input('idOrden', nIdOrdenMiembro).query(`
        DELETE FROM PRDExtrusionRollos
        WHERE EXISTS (
          SELECT 1 FROM SEL_Bultos b
          WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
            AND b.estado IN ('Temporal', 'EnEspera') AND b.number_paqu = 0
            AND PRDExtrusionRollos.Elemento = b.refsalida
            AND PRDExtrusionRollos.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
            AND PRDExtrusionRollos.Linea = b.num_bulto
            AND PRDExtrusionRollos.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
        )
      `);
      await tx.request().input('idOrden', nIdOrdenMiembro).query(`
        DELETE FROM PRDProduccionOperarios
        WHERE EXISTS (
          SELECT 1 FROM SEL_Bultos b
          WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
            AND b.estado IN ('Temporal', 'EnEspera') AND b.number_paqu = 0
            AND PRDProduccionOperarios.Elemento = b.refsalida
            AND PRDProduccionOperarios.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
            AND PRDProduccionOperarios.Linea = b.num_bulto
            AND PRDProduccionOperarios.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
        )
      `);
      await tx.request().input('idOrden', nIdOrdenMiembro).query(`
        DELETE FROM PRDProduccion
        WHERE Detalle IN (
          SELECT b.serialPadre FROM SEL_Bultos b
          WHERE b.id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
            AND b.estado IN ('Temporal', 'EnEspera') AND b.number_paqu = 0
        )
      `);
      await tx.request().input('idOrden', nIdOrdenMiembro).query(`
        DELETE FROM SEL_Bultos
        WHERE id_ejecucion IN (SELECT IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden)
        AND estado IN ('Temporal', 'EnEspera') AND number_paqu = 0
      `);

      // Retal/Torta fijos en 0 -- igual que EjecucionSelladora.vb hoy (ya no se piden por InputBox,
      // el digitador los ajusta despues en Registro de Residuos). Se llama una vez POR MIEMBRO --
      // cada referencia del grupo mantiene su propio PRDExtrusionControl(Sellado) independiente.
      await finalizarControlParcialSellado(tx, { idOrden: nIdOrdenMiembro, retalManual: 0, tortaManual: 0, generadoPor });
    }

    await tx.commit();
    return { ok: true };
  } catch (err) {
    // FIX 16/09/2026 (ver DIAGNOSTICO_FINALIZAR_ORDEN.md -- bug real "Transaction has been
    // aborted" al dar Finalizar): si la transaccion ya quedo abortada por un error anterior
    // (ej. "Conversion failed..." dentro de finalizarControlParcialSellado), este rollback()
    // TAMBIEN falla -- y sin protegerlo, SU error reemplazaba al original, tapando la causa real.
    try {
      await tx.rollback();
    } catch (errRollback) {
      console.error('Rollback fallido tras el error real:', errRollback.message);
    }
    throw err;
  }
}

module.exports = { validarPuedeIniciar, validarPuedeAnadirRollo, finalizarOrden };
