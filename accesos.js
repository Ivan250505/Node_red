// Bitacora de entrada/salida en SISAccesos. Se registra 'Entrada' al iniciar sesion en /login
// y 'Salida' en /logout. El ingreso por QR con la camara se elimino el 04/09/2026 a pedido del
// usuario -- el unico inicio de sesion es usuario/contrasena, por eso ya no existe
// buscarUsuarioPorQR() ni la pantalla /marcar.

async function registrarEvento(pool, codigo, tipoEvento, origen) {
  const insertado = await pool.request()
    .input('codigo', codigo)
    .input('tipoEvento', tipoEvento)
    .input('origen', origen)
    .query(`
      INSERT INTO SISAccesos (Codigo, FechaHora, TipoEvento, Origen)
      OUTPUT INSERTED.FechaHora
      VALUES (@codigo, GETDATE(), @tipoEvento, @origen)
    `);

  return insertado.recordset[0].FechaHora;
}

module.exports = { registrarEvento };
