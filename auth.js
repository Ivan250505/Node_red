const { desencriptarDesdeBD } = require('./crypto-mirane');

// Login contra SISUsuarios (Carlixplast/CarlixplastPrueba) -- Codigo es el usuario que
// escribe el operario, Clave es la contraseña cifrada con el mismo TripleDES MERLIN/LINMER.
async function validarLogin(pool, codigo, passwordEscrito) {
  const result = await pool.request()
    .input('codigo', codigo)
    .query(`
      SELECT Codigo, Clave, Nombre, Estado
      FROM SISUsuarios
      WHERE Codigo = @codigo
    `);

  if (result.recordset.length === 0) return null;
  const usuario = result.recordset[0];

  if (usuario.Estado !== 'Activo') return null;

  const passwordReal = desencriptarDesdeBD(usuario.Clave);
  if (passwordReal !== passwordEscrito) return null;

  return { codigo: usuario.Codigo, nombre: usuario.Nombre || usuario.Codigo };
}

function requireLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();
  res.redirect('/login');
}

module.exports = { validarLogin, requireLogin };
