const { desencriptarDesdeBD } = require('./crypto-mirane');

// Login contra SISUsuarios (Carlixplast/CarlixplastPrueba) -- Codigo es el usuario que
// escribe el operario, Clave es la contraseña cifrada con el mismo TripleDES MERLIN/LINMER.
// Tercero es el mismo valor que el escritorio guarda como gnUsuario (ver Accesso.vb:260) --
// lo usan como GeneradoPor/Operario en varias tablas de Produccion/Inventario, es distinto del
// Codigo (login) y del CodigoOperarioPRD (PRDOperarios, para Selladora -- ver
// agregar_codigooperarioprd_sisusuarios.sql).
async function validarLogin(pool, codigo, passwordEscrito) {
  const result = await pool.request()
    .input('codigo', codigo)
    .query(`
      SELECT Codigo, Clave, Nombre, Estado, Tercero, CodigoOperarioPRD
      FROM SISUsuarios
      WHERE Codigo = @codigo
    `);

  if (result.recordset.length === 0) return null;
  const usuario = result.recordset[0];

  if (usuario.Estado !== 'Activo') return null;

  const passwordReal = desencriptarDesdeBD(usuario.Clave);
  if (passwordReal !== passwordEscrito) return null;

  return {
    codigo: usuario.Codigo,
    nombre: usuario.Nombre || usuario.Codigo,
    generadoPor: usuario.Tercero,
    codigoOperarioPRD: usuario.CodigoOperarioPRD || null
  };
}

function requireLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();
  res.redirect('/marcar');
}

module.exports = { validarLogin, requireLogin };
