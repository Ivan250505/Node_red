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
      SELECT Codigo, Clave, CAST(Clave AS VARBINARY(50)) AS ClaveBin, Nombre, Estado, Tercero, CodigoOperarioPRD,
             IdCargo, Cargo
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
    codigoOperarioPRD: usuario.CodigoOperarioPRD || null,
    idCargo: usuario.IdCargo != null ? Number(usuario.IdCargo) : null,
    cargo: usuario.Cargo || null
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

// ---------------------------------------------------------------------------------------------
// Autorizacion de un pedido por un lider (22/09/2026). Ver SEL_AutorizacionPedido.
//
// Los cargos que el usuario definio, por IdCargo de SISCargos y NO por el texto del cargo: en
// SISUsuarios conviven 'Lider de Sellado' con tilde y 'Lider de Impresion' sin ella, asi que
// comparar textos deja lideres por fuera en cuanto alguien escriba una tilde distinta.
//
// Si manana hay que sumar o quitar un cargo, se cambia ESTA lista y nada mas -- el servidor la
// exporta a la tableta para pintar el mensaje de "quien puede autorizar", asi que no hay una
// segunda copia que se pueda desincronizar.
//
// OJO CON LOS IDS, QUE NO SON LOS MISMOS EN LAS DOS BASES (comprobado 24/09/2026 consultando
// SISCargos): 16/27/31 existen en la base de produccion (Carlixplast), pero en carlixplastPrueba
// SISCargos solo llega hasta 6 y el 'Lider de Sellado' de ahi es el IdCargo 6. Por eso la lista
// lleva los dos: asi la misma lista sirve en las dos bases sin tocar codigo al cambiar de .env.
// Si algun dia esto crece, lo que toca es leer los cargos de SISCargos por nombre normalizado en
// vez de dejar los ids escritos aca.
// Interruptor general de la autorizacion del lider (26/09/2026, a pedido del usuario: "desactiva
// la autorizacion en todos los aspectos"). En false: Finalizar y Cerrar sesion no piden firma (ni
// en la tableta ni en el servidor), no sale el aviso de fin de turno y no se pinta la isla con el
// boton "Autorizacion". La tabla SEL_AutorizacionPedido y los endpoints /autorizacion siguen ahi;
// para volver a exigir la firma basta con ponerlo en true.
const AUTORIZACION_LIDER_ACTIVA = false;

const CARGOS_AUTORIZAN_PEDIDO = [
  { idCargo: 16, nombre: 'Director de Calidad e Inocuidad' },
  { idCargo: 27, nombre: 'Jefe de Planta' },
  { idCargo: 31, nombre: 'Lider de Sellado' },
  { idCargo: 6,  nombre: 'Líder de Sellado' }   // carlixplastPrueba (a pedido del usuario, 24/09/2026)
];

// Valida usuario+clave y ADEMAS que tenga uno de los cargos de arriba.
//
// Devuelve { ok: true, usuario } o { ok: false, error }. A diferencia de validarLogin (que
// devuelve null para todo fallo), aca se distingue la causa: "esa clave no es" y "usted no tiene
// el cargo" son dos problemas distintos para quien esta parado frente a la tableta, y mezclarlos
// hace que un lider con el cargo mal puesto se quede intentando su contrasena una y otra vez.
async function validarAutorizadorPedido(pool, codigo, passwordEscrito) {
  const tCodigo = (codigo || '').trim();
  if (!tCodigo || !passwordEscrito) {
    return { ok: false, error: 'Escriba usuario y contraseña.' };
  }

  // validarLogin ya resuelve el descifrado TripleDES y el Estado != 'Activo'.
  const usuario = await validarLogin(pool, tCodigo, passwordEscrito);
  if (!usuario) {
    return { ok: false, error: 'Usuario o contraseña incorrectos.' };
  }

  const permitido = CARGOS_AUTORIZAN_PEDIDO.find(c => c.idCargo === usuario.idCargo);
  if (!permitido) {
    return {
      ok: false,
      error: `${usuario.nombre} no puede autorizar: su cargo es "${usuario.cargo || 'sin cargo asignado'}". ` +
             `Solo pueden ${CARGOS_AUTORIZAN_PEDIDO.map(c => c.nombre).join(', ')}.`
    };
  }

  return { ok: true, usuario: { ...usuario, cargoAutorizado: permitido.nombre } };
}

module.exports = { validarLogin, requireLogin, requireAdmin, ADMIN_CODIGO,
                   validarAutorizadorPedido, CARGOS_AUTORIZAN_PEDIDO, AUTORIZACION_LIDER_ACTIVA };
