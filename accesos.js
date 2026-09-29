// Bitacora de entrada/salida en SISAccesos. Se registra 'Entrada' al iniciar sesion en /login
// y 'Salida' en /logout. El ingreso por QR con la camara se elimino el 04/09/2026 a pedido del
// usuario -- el unico inicio de sesion es usuario/contrasena, por eso ya no existe
// buscarUsuarioPorQR() ni la pantalla /marcar.

// 28/09/2026: en la 'Entrada' se guarda también el turno que el operario escogió en el login y la
// máquina de la tableta fija (SISAccesos.Turno / Maquina, sql/pendientes/20260928_turno_en_login.sql).
// Si esas columnas todavía no existen, se registra como antes.
let _columnasTurno = null;
async function registrarEvento(pool, codigo, tipoEvento, origen, extra = {}) {
  if (_columnasTurno !== true) {
    try {
      const r = await pool.request().query(
        `SELECT CASE WHEN COL_LENGTH('dbo.SISAccesos','Turno') IS NOT NULL AND COL_LENGTH('dbo.SISAccesos','Maquina') IS NOT NULL THEN 1 ELSE 0 END AS Existe`);
      _columnasTurno = Number(r.recordset[0].Existe) === 1 ? true : false;
    } catch (e) { _columnasTurno = false; }
  }
  const req = pool.request()
    .input('codigo', codigo)
    .input('tipoEvento', tipoEvento)
    .input('origen', origen);
  let insertado;
  if (_columnasTurno === true) {
    insertado = await req.input('turno', extra.turno || null).input('maquina', extra.maquina || null).query(`
      INSERT INTO SISAccesos (Codigo, FechaHora, TipoEvento, Origen, Turno, Maquina)
      OUTPUT INSERTED.FechaHora
      VALUES (@codigo, GETDATE(), @tipoEvento, @origen, @turno, @maquina)
    `);
  } else {
    insertado = await req.query(`
      INSERT INTO SISAccesos (Codigo, FechaHora, TipoEvento, Origen)
      OUTPUT INSERTED.FechaHora
      VALUES (@codigo, GETDATE(), @tipoEvento, @origen)
    `);
  }

  return insertado.recordset[0].FechaHora;
}

module.exports = { registrarEvento };
