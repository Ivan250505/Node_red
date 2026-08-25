// Bitacora de entrada/salida en SISAccesos. El QR (via SISUsuarios.CodigoQR) es una
// forma alterna de identificarse en /marcar, que ahora es login igual que /login --
// ambos caminos registran 'Entrada' al entrar, y /logout registra 'Salida' al salir.

async function buscarUsuarioPorQR(pool, codigoQR) {
  const result = await pool.request()
    .input('codigoQR', codigoQR)
    .query(`
      SELECT Codigo, Nombre, Estado, Tercero, CodigoOperarioPRD
      FROM SISUsuarios
      WHERE CodigoQR = @codigoQR
    `);

  if (result.recordset.length === 0) return null;
  const usuario = result.recordset[0];
  if (usuario.Estado !== 'Activo') return null;

  return {
    codigo: usuario.Codigo,
    nombre: usuario.Nombre || usuario.Codigo,
    generadoPor: usuario.Tercero,
    codigoOperarioPRD: usuario.CodigoOperarioPRD || null
  };
}

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

module.exports = { buscarUsuarioPorQR, registrarEvento };
