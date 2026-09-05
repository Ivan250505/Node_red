const { desencriptarDesdeBD } = require('./crypto-mirane');

// Login contra SISUsuarios (Carlixplast/CarlixplastPrueba) -- Codigo es el usuario que
// escribe el operario, Clave es la contraseña cifrada con el mismo TripleDES MERLIN/LINMER.
// Tercero es el mismo valor que el escritorio guarda como gnUsuario (ver Accesso.vb:260) --
// lo usan como GeneradoPor/Operario en varias tablas de Produccion/Inventario, es distinto del
// Codigo (login) y del CodigoOperarioPRD (PRDOperarios, para Selladora -- ver
// agregar_codigooperarioprd_sisusuarios.sql).
async function validarLogin(pool, codigo, passwordEscrito) {
  // FIX 05/09/2026: se pide Clave como VARBINARY (ClaveBin), no como VARCHAR -- asi tedious
  // entrega el cifrado como Buffer crudo, sin pasarlo por ningun decode de texto que pueda
  // perder bytes (ver nota larga en crypto-mirane.js:desencriptarDesdeBD). Se deja Clave
  // tambien en el SELECT solo por si algo mas de este archivo llega a necesitarlo como texto.
  const result = await pool.request()
    .input('codigo', codigo)
    .query(`
      SELECT Codigo, Clave, CAST(Clave AS VARBINARY(50)) AS ClaveBin, Nombre, Estado, Tercero, CodigoOperarioPRD
      FROM SISUsuarios
      WHERE Codigo = @codigo
    `);

  if (result.recordset.length === 0) return null;
  const usuario = result.recordset[0];

  if (usuario.Estado !== 'Activo') return null;

  const passwordReal = desencriptarDesdeBD(usuario.ClaveBin);
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
  res.redirect('/login');
}

// No hay un sistema de roles en SISUsuarios (no existe una columna tipo "EsAdmin") -- el unico
// usuario administrador de esta app es el codigo literal 'ADMIN' (un SISUsuarios como cualquier
// otro, que entra con su contrasena). Usado para restringir la asignacion de "tablet fija"
// (SEL_TabletsFijas)
// a un unico apartado que solo el administrador puede tocar, a pedido del usuario (30/08/2026).
const ADMIN_CODIGO = 'ADMIN';

function requireAdmin(req, res, next) {
  if (req.session && req.session.usuario && req.session.usuario.codigo === ADMIN_CODIGO) return next();
  res.status(403).send('Acceso restringido al usuario administrador.');
}

module.exports = { validarLogin, requireLogin, requireAdmin, ADMIN_CODIGO };
