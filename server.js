require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');
const { validarLogin, requireLogin } = require('./auth');
const { buscarUsuarioPorQR, registrarEvento } = require('./accesos');
const { consultarSerial, confirmarRollo } = require('./scan-rollo');
const { validarPuedeIniciar, validarPuedeAnadirRollo, finalizarOrden } = require('./ejecucion-selladora');
const { obtenerLineaOriginalControlSellado } = require('./sel-inventario-mp');

const dbConfig = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: desencriptar(process.env.DB_PASSWORD_ENC),
  options: {
    encrypt: false,
    trustServerCertificate: true,
    // FIX 24/08/2026: por defecto tedious usa useUTC:true -- reinterpreta cualquier Date de JS sin
    // tipo explicito (new Date(), la hora actual) como si sus componentes UTC fueran la hora a
    // guardar. Colombia es UTC-5, asi que cualquier escritura hecha despues de ~7pm hora local
    // cruzaba medianoche y quedaba guardada un dia adelantado (confirmado con datos reales:
    // PRDProduccionMateriaPrima.Fecha de un "Añadir Rollo" a las 9:48pm quedo en 02:48 del dia
    // SIGUIENTE). Mirane/VB no tiene este problema porque su driver no reinterpreta la hora.
    useUTC: false
  }
};

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-esto-en-.env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas, un turno
}));

let pool;

async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

// Convierte un texto a un literal JS seguro para pegar dentro de un <script> inline (usado para
// pasarle mensajes de error/éxito a SweetAlert2 sin arriesgar que corten el <script> o inyecten
// HTML/JS -- JSON.stringify ya escapa comillas/backslashes, el replace adicional cubre "</script>".
function jsString(texto) {
  return JSON.stringify(texto == null ? '' : String(texto)).replace(/</g, '\\u003c');
}

function renderLogin(error) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ingresar — Bultos</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #00a2cb, #006984);
    }
    .caja {
      background: white; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 340px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25);
    }
    .logo-login { height: 40px; display: block; margin: 0 auto 14px; }
    .caja .sub { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 24px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #1c2733; margin-bottom: 6px; }
    input {
      width: 100%; padding: 12px 14px; margin-bottom: 16px; border: 1px solid #d0d7de;
      border-radius: 10px; font-size: 16px; box-sizing: border-box;
    }
    button {
      width: 100%; padding: 13px; border: none; border-radius: 10px; font-size: 16px; font-weight: 600;
      background: #00a2cb; color: white; cursor: pointer;
    }
    button:active { transform: translateY(1px); }
    .error {
      background: #fdeceb; color: #b00; border: 1px solid #f3b8b3;
      padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;
    }
    .ingresar-qr { text-align: center; margin-top: 16px; }
    .ingresar-qr a { color: #64748b; font-size: 13px; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="caja">
    <img class="logo-login" src="/logo-carlixplast.png" alt="Carlixplast">
    <div class="sub">Bultos — Selladora · Ingresa con tu usuario de Mirane</div>
    <form method="post" action="/login">
      <label>Usuario</label>
      <input type="text" name="codigo" autocapitalize="none" autocomplete="username" required autofocus>
      <label>Contraseña</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Ingresar</button>
    </form>
    <div class="ingresar-qr"><a href="/marcar">Ingresar escaneando tu código QR</a></div>
  </div>
  <script src="/sweetalert2.min.js"></script>
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'No se pudo ingresar', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

// Pantalla publica de marcacion por QR: no pasa por requireLogin porque es justamente
// para que el operario no tenga que escribir usuario/contrasena en la tablet de planta.
function renderMarcar() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Marcar — Carlixplast</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
      background: linear-gradient(135deg, #00a2cb, #006984); color: white; padding: 20px 16px;
      box-sizing: border-box;
    }
    .logo-wrap {
      background: white; padding: 10px 22px; border-radius: 12px; margin-bottom: 18px;
    }
    .logo { height: 40px; display: block; }
    h1 { font-size: 18px; margin: 0 0 16px; text-align: center; }
    #lector {
      width: 100%; max-width: 380px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25); background: black;
    }
    .ingresar-manual {
      margin-top: 22px; text-align: center;
    }
    .ingresar-manual a {
      color: white; opacity: 0.9; font-size: 13px; text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
  <h1>Escanea tu código para ingresar</h1>
  <div id="lector"></div>
  <div class="ingresar-manual"><a href="/login">Ingresar por usuario y contraseña</a></div>

  <script src="/html5-qrcode.min.js"></script>
  <script src="/sweetalert2.min.js"></script>
  <script>
    let procesando = false;

    function continuar() { procesando = false; }

    function mostrarError(mensaje) {
      Swal.fire({
        icon: 'error', title: 'No se pudo ingresar', text: mensaje,
        confirmButtonText: 'Reintentar', confirmButtonColor: '#71bf44'
      }).then(() => continuar());
    }

    function mostrarExitoYRedirigir(nombre, redirect) {
      Swal.fire({
        icon: 'success', title: 'Bienvenido, ' + nombre,
        timer: 900, showConfirmButton: false
      }).then(() => { window.location.href = redirect || '/'; });
    }

    async function onScan(textoLeido) {
      if (procesando) return;
      procesando = true;
      try {
        const resp = await fetch('/marcar/registrar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codigoQR: textoLeido })
        });
        const datos = await resp.json();
        if (datos.ok) {
          mostrarExitoYRedirigir(datos.nombre, datos.redirect);
        } else {
          mostrarError(datos.error);
        }
      } catch (err) {
        mostrarError('Error de conexión: ' + err.message);
      }
    }

    const lector = new Html5Qrcode('lector');
    Html5Qrcode.getCameras().then(camaras => {
      if (!camaras || camaras.length === 0) {
        mostrarError('No se encontró ninguna cámara en este dispositivo.');
        return;
      }
      // Prefiere la camara trasera (environment) si el navegador la distingue.
      const trasera = camaras.find(c => /back|trasera|rear|environment/i.test(c.label));
      const camaraId = trasera ? trasera.id : camaras[0].id;
      lector.start(
        camaraId,
        { fps: 10, qrbox: 250 },
        onScan
      );
    }).catch(err => {
      mostrarError('No se pudo acceder a la cámara: ' + err);
    });
  </script>
</body>
</html>`;
}

function badgeEstado(estado) {
  const clase = estado === 'Activo' ? 'badge-activo' : 'badge-temporal';
  return `<span class="badge ${clase}">${estado}</span>`;
}

// CSS y encabezado compartidos entre el dashboard de selladoras y el detalle de bultos.
function estilosBase() {
  return `
    :root {
      --azul: #00a2cb;
      --azul-osc: #006984;
      --verde: #4a9c2e;
      --verde-fondo: #e9f6e3;
      --verde-logo: #71be47;
      --verde-marca: #71bf44;
      --verde-fondo-suave: #c9e8bb;
      --naranja: #b46200;
      --naranja-fondo: #fdecd8;
      --gris-fondo: #f4f6f8;
      --texto: #1c2733;
      --texto-suave: #64748b;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      background: var(--verde-fondo-suave);
      color: var(--texto);
    }
    header {
      background: linear-gradient(135deg, var(--azul), var(--azul-osc));
      color: white;
      padding: 18px 20px 22px;
    }
    header h1 { margin: 0 0 4px; font-size: 20px; }
    header .sub { font-size: 13px; opacity: 0.85; }
    header a.volver { color: white; opacity: 0.85; font-size: 13px; text-decoration: none; }
    .header-top { text-align: center; }
    .header-inner { max-width: 960px; margin: 0 auto; }
    .logo-wrap {
      background: white; display: inline-block; padding: 10px 22px;
      border-radius: 12px; margin-bottom: 14px;
    }
    .logo { height: 40px; display: block; }
    .logo-login { height: 40px; display: block; margin: 0 auto 12px; }
    main { max-width: 960px; margin: 0 auto; padding: 16px 14px 30px; }
    .barra {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .actualizado { font-size: 12px; color: var(--texto-suave); }
    .usuario-bar {
      display: flex; justify-content: space-between; align-items: center;
      gap: 12px;
      font-size: 12px; opacity: 0.9; margin-bottom: 8px;
    }
    .usuario-bar a.salir {
      color: white;
      background: #c0392b;
      padding: 5px 12px;
      border-radius: 8px;
      font-weight: 600;
      text-decoration: none;
    }
    .usuario-bar a.salir:active { background: #a53125; }
    form { margin: 0; width: 100%; }
    button {
      font-size: 16px;
      font-weight: 600;
      padding: 12px 22px;
      border: none;
      border-radius: 10px;
      background: white;
      color: var(--azul-osc);
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      cursor: pointer;
      width: 100%;
    }
    button:active { transform: translateY(1px); }
    .error {
      background: #fdeceb; color: #b00; border: 1px solid #f3b8b3;
      padding: 12px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 14px;
    }
    .vacio {
      background: white; border-radius: 12px; padding: 30px; text-align: center;
      color: var(--texto-suave); box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 14px;
    }
    .card {
      background: white;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      position: relative;
    }
    .card-top {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 12px;
    }
    .bulto-num { font-size: 17px; font-weight: 700; }
    .rollo-serial { font-size: 11px; font-family: monospace; color: var(--texto-suave); margin-top: 2px; }
    .badge {
      font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    }
    .badge-activo { background: var(--verde-fondo); color: var(--verde); }
    .badge-temporal { background: var(--naranja-fondo); color: var(--naranja); }
    .badge-pendiente { background: #e0ecfb; color: #0b5ed7; }
    .orden-cola {
      background: white; border-radius: 14px; padding: 14px 16px; margin-bottom: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08); display: flex; flex-wrap: wrap; align-items: center;
      justify-content: space-between; gap: 10px;
    }
    .orden-cola .orden-info { flex: 1 1 200px; }
    .orden-cola .orden-pedido { font-weight: 700; font-size: 15px; }
    .orden-cola .orden-elemento { font-size: 13px; color: var(--texto-suave); margin-top: 2px; }
    .orden-cola .orden-acciones { display: flex; gap: 8px; flex-wrap: wrap; }
    .orden-cola .orden-acciones form { width: auto; }
    .btn-accion {
      font-size: 14px; font-weight: 600; padding: 10px 16px; border: none; border-radius: 10px;
      cursor: pointer; text-decoration: none; display: inline-block; color: white;
      box-shadow: none; width: auto;
    }
    .btn-iniciar { background: #0078d7; }
    .btn-anadir { background: #0078d7; }
    .btn-finalizar { background: #c00000; }
    .btn-info { background: var(--verde); }
    .btn-accion:active { transform: translateY(1px); }
    .pesajes-box {
      margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef0f2;
    }
    .pesaje-fila {
      display: flex; justify-content: space-between; gap: 8px; font-size: 13px;
      padding: 4px 0; color: var(--texto-suave);
    }
    .pesaje-vacio { font-size: 13px; color: var(--texto-suave); }
    .hist-fila {
      display: grid; grid-template-columns: 1.4fr 1fr 0.7fr; gap: 8px; font-size: 13px;
      padding: 8px 0; border-bottom: 1px solid #eef0f2;
    }
    .hist-fila:last-child { border-bottom: none; }
    .card-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px;
    }
    .card-grid > div { display: flex; flex-direction: column; }
    .card-grid .full { grid-column: 1 / -1; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--texto-suave); }
    .valor { font-size: 15px; font-weight: 600; }
    .valor.serial { font-size: 13px; font-family: monospace; font-weight: 500; word-break: break-all; }
    .maquina-card {
      display: block; background: white; border-radius: 14px; padding: 18px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08); text-decoration: none; color: var(--texto);
      margin-bottom: 12px;
    }
    .maquina-card:active { transform: translateY(1px); }
    .maquina-top { display: flex; justify-content: space-between; align-items: center; }
    .maquina-nombre { font-size: 17px; font-weight: 700; }
    .maquina-chevron { color: var(--texto-suave); font-size: 20px; }
    .maquina-count { font-size: 12px; color: var(--texto-suave); margin-top: 4px; }
    .maquina-sub { font-size: 13px; color: var(--texto-suave); margin-top: 6px; }
    .ejecucion-box {
      background: white; border-radius: 14px; padding: 16px 18px; margin-bottom: 18px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .ejecucion-box h2 { margin: 0 0 12px; font-size: 15px; }
    .ejecucion-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 14px;
    }
    .ejecucion-grid > div { display: flex; flex-direction: column; }
    @media (max-width: 480px) {
      .ejecucion-grid { grid-template-columns: 1fr 1fr; }
      .grid { grid-template-columns: 1fr; }
      header h1 { font-size: 18px; }
      .barra { flex-direction: column; align-items: stretch; }
      .actualizado { text-align: center; }
    }
  `;
}

function badgeEstadoOrden(estado) {
  const clases = { Activa: 'badge-activo', Pendiente: 'badge-pendiente', PendienteValidacion: 'badge-temporal' };
  const textos = { Activa: 'Activa', Pendiente: 'Por iniciar', PendienteValidacion: 'Pend. validación' };
  return `<span class="badge ${clases[estado] || 'badge-temporal'}">${textos[estado] || estado}</span>`;
}

function renderDashboard(maquinas, usuario, error) {
  const tarjetas = maquinas.map(m => `
    <a class="maquina-card" href="/selladora/${m.Codigo}">
      <div class="maquina-top">
        <span class="maquina-nombre">🏭 ${m.Nombre}</span>
        ${badgeEstadoOrden(m.EstadoOrden)}
      </div>
      <div class="maquina-sub">Pedido ${m.NumeroPedido || '—'} · ${m.Elemento}</div>
      <div class="maquina-count">${m.BultosActivos} bulto(s) activo(s)/temporal(es)</div>
    </a>`).join('');

  const contenido = maquinas.length
    ? tarjetas
    : `<div class="vacio">No hay selladoras con producción activa en este momento.</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Selladoras</title>
  <style>${estilosBase()}</style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
    </div>
    <div class="header-inner">
      <div class="usuario-bar">
        <span>👤 ${usuario}</span>
        <a class="salir" href="/logout">Salir</a>
      </div>
      <div class="sub">Máquinas con producción activa en este momento</div>
    </div>
  </header>
  <main>
    ${contenido}
  </main>
  <script src="/sweetalert2.min.js"></script>
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'Error', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

// Cola de ordenes de la maquina (Activa/Pendiente/PendienteValidacion) con su boton de accion,
// mismas reglas de habilitacion que EjecucionSelladora.vb (dgvEjecuciones_CellFormatting +
// HandleIniciar/HandleAnadirRollo): Pendiente -> Iniciar, Activa -> +Rollo y Finalizar,
// PendienteValidacion -> sin accion (Residuos/Verificar/Cerrar Definitivo quedan en el escritorio).
function renderColaOrdenes(ordenes, maquinaCodigo) {
  if (ordenes.length === 0) return '';
  const filas = ordenes.map(o => {
    let acciones = `<a class="btn-accion btn-info" href="/selladora/${maquinaCodigo}/orden/${o.IdOrden}">ℹ Información</a>`;
    if (o.Estado === 'Pendiente') {
      acciones += `<a class="btn-accion btn-iniciar" href="/selladora/${maquinaCodigo}/orden/${o.IdOrden}/escanear?nuevo=0">▶ Iniciar</a>`;
    } else if (o.Estado === 'Activa') {
      acciones += `
        <a class="btn-accion btn-anadir" href="/selladora/${maquinaCodigo}/orden/${o.IdOrden}/escanear?nuevo=1">+ Rollo</a>
        <form method="post" action="/api/selladora/orden/${o.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
          <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
        </form>`;
    } else {
      acciones += `<span class="label">Esperando validación del digitador</span>`;
    }
    return `
      <div class="orden-cola">
        <div class="orden-info">
          <div class="orden-pedido">Pedido ${o.NumeroPedido || '—'} ${badgeEstadoOrden(o.Estado)}</div>
          <div class="orden-elemento">${o.Elemento}</div>
        </div>
        <div class="orden-acciones">${acciones}</div>
      </div>`;
  }).join('');
  return `<h2 style="font-size:15px;margin:0 0 10px;">Órdenes de esta máquina</h2>${filas}`;
}

// Script compartido por renderPage y renderOrdenDetalle -- confirmacion antes de Finalizar.
function scriptConfirmarFinalizar() {
  return `
    function confirmarFinalizar(evento, formulario) {
      evento.preventDefault();
      Swal.fire({
        icon: 'warning',
        title: '¿Finalizar este proceso?',
        text: 'Se cerrarán todos los rollos abiertos de esta orden.',
        showCancelButton: true,
        confirmButtonText: 'Sí, finalizar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#c00000',
        cancelButtonColor: '#71bf44'
      }).then(resultado => { if (resultado.isConfirmed) formulario.submit(); });
      return false;
    }
  `;
}

// Solo la cola de ordenes de la maquina -- el detalle de bultos/pesajes/historial de cada orden
// vive en /selladora/:codigo/orden/:idOrden (boton "Informacion").
function renderPage(error, usuario, maquinaNombre, maquinaCodigo, colaOrdenes) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Órdenes — ${maquinaNombre}</title>
  <style>${estilosBase()}</style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
    </div>
    <div class="header-inner">
      <div class="usuario-bar">
        <span>👤 ${usuario}</span>
        <a class="salir" href="/logout">Salir</a>
      </div>
      <a class="volver" href="/">‹ Selladoras</a>
      <h1>🏭 ${maquinaNombre}</h1>
      <div class="sub">Órdenes de esta máquina</div>
    </div>
  </header>
  <main>
    <div class="barra">
      <span class="actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
      <form method="get" action="/selladora/${maquinaCodigo}"><button type="submit">↻ Actualizar</button></form>
    </div>
    ${renderColaOrdenes(colaOrdenes || [], maquinaCodigo)}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptConfirmarFinalizar()}</script>
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'Error', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

// Detalle de una orden puntual: bultos con indice relativo (no el num_bulto crudo), pesajes de
// cada bulto y el historial de materia prima (Serial/Referencia/Lote unicamente -- nada de
// cantidades ni fechas, a pedido del usuario). Los rollos/SEL_EjecucionOrden no aparecen aqui:
// solo interesan los bultos.
function renderOrdenDetalle(orden, bultos, pesajesPorBulto, historial, usuario, maquinaCodigo, relevo) {
  const tarjetas = bultos.map(b => {
    const pesajes = pesajesPorBulto.get(b.id) || [];
    const filasPesajes = pesajes.length
      ? pesajes.map(pe => `
          <div class="pesaje-fila">
            <span>Paquete ${pe.ConsecutivoPaquete}</span>
            <span>${pe.Hora}</span>
            <span>${Number(pe.PesoPaqueGr).toString()}</span>
          </div>`).join('')
      : `<div class="pesaje-vacio">Sin paquetes pesados todavía.</div>`;

    return `
    <div class="card">
      <div class="card-top">
        <span class="bulto-num">Bulto ${b.numRelativo}</span>
        ${badgeEstado(b.estado)}
      </div>
      <div class="card-grid">
        <div><span class="label">Cant. Total (KG)</span><span class="valor">${b.CantidadTotal ?? '—'}</span></div>
        <div><span class="label">Golpes</span><span class="valor">${b.Golpes ?? '—'}</span></div>
        <div><span class="label">Potencia (KW)</span><span class="valor">${b.Potencia ?? '—'}</span></div>
        <div><span class="label">Hora</span><span class="valor">${b.Hora ?? '—'}</span></div>
        <div class="full"><span class="label">Serial</span><span class="valor serial">${b.serialPadre ?? '—'}</span></div>
      </div>
      <div class="pesajes-box">
        <div class="label" style="margin-bottom:6px;">Paquetes pesados (${pesajes.length})</div>
        ${filasPesajes}
      </div>
    </div>`;
  }).join('');

  const contenidoBultos = bultos.length
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">Esta orden todavía no tiene bultos.</div>`;

  const filasHistorial = historial.length
    ? historial.map(h => `
        <div class="hist-fila">
          <span class="valor serial">${h.Serial ?? '—'}</span>
          <span>${h.Referencia ?? '—'}</span>
          <span>${h.Lote ?? '—'}</span>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  // FIX 24/08/2026: aviso de relevo -- no se asume el cambio de operario solo por entrar a
  // mirar la pagina, el operario debe confirmarlo explicitamente (ver
  // agregar_operarioactualmaquina.sql).
  const bloqueRelevo = relevo ? `
    <div class="error" style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
      <span>Esta máquina la está operando <strong>${relevo.nombreOperarioActual}</strong>.</span>
      <form method="post" action="/api/selladora/maquina/${maquinaCodigo}/tomar-control" style="width:auto;">
        <input type="hidden" name="idOrden" value="${orden.IdOrden}">
        <button type="submit" class="btn-accion" style="background:#b46200;">Tomar control</button>
      </form>
    </div>` : '';

  let acciones = '';
  if (orden.Estado === 'Pendiente') {
    acciones = `<a class="btn-accion btn-iniciar" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/escanear?nuevo=0">▶ Iniciar</a>`;
  } else if (orden.Estado === 'Activa') {
    acciones = `
      <a class="btn-accion btn-anadir" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/escanear?nuevo=1">+ Rollo</a>
      <form method="post" action="/api/selladora/orden/${orden.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
        <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
      </form>`;
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pedido ${orden.NumeroPedido || orden.IdOrden} — ${orden.MaquinaNombre}</title>
  <style>${estilosBase()}</style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
    </div>
    <div class="header-inner">
      <div class="usuario-bar">
        <span>👤 ${usuario}</span>
        <a class="salir" href="/logout">Salir</a>
      </div>
      <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${orden.MaquinaNombre}</a>
      <h1>Pedido ${orden.NumeroPedido || '—'} ${badgeEstadoOrden(orden.Estado)}</h1>
      <div class="sub">${orden.Elemento}</div>
    </div>
  </header>
  <main>
    ${bloqueRelevo}
    ${acciones ? `<div class="orden-cola" style="margin-bottom:18px;"><div class="orden-acciones">${acciones}</div></div>` : ''}
    <h2 style="font-size:15px;margin:0 0 10px;">Bultos</h2>
    ${contenidoBultos}
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial de materia prima</h2>
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptConfirmarFinalizar()}</script>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  if (req.session && req.session.usuario) return res.redirect('/');
  res.send(renderLogin());
});

app.post('/login', async (req, res) => {
  const { codigo, password } = req.body;
  try {
    const p = await getPool();
    const usuario = await validarLogin(p, codigo, password);
    if (!usuario) return res.send(renderLogin('Usuario o contraseña incorrectos.'));
    req.session.usuario = usuario;
    await registrarEvento(p, usuario.codigo, 'Entrada', 'Manual');
    res.redirect('/');
  } catch (err) {
    res.send(renderLogin('Error al validar: ' + err.message));
  }
});

app.get('/logout', async (req, res) => {
  const usuario = req.session && req.session.usuario;
  try {
    if (usuario) {
      const p = await getPool();
      await registrarEvento(p, usuario.codigo, 'Salida', 'Manual');
    }
  } catch (err) {
    console.error('Error registrando Salida:', err.message);
  }
  req.session.destroy(() => res.redirect('/marcar'));
});

// /marcar es ahora la pantalla de login principal (QR), con enlace de respaldo al login
// clasico de usuario/contrasena (/login). Cualquiera de los dos caminos crea sesion,
// registra 'Entrada' en SISAccesos y entra al dashboard (/); /logout registra 'Salida'.
app.get('/marcar', (req, res) => {
  if (req.session && req.session.usuario) return res.redirect('/');
  res.send(renderMarcar());
});

app.post('/marcar/registrar', async (req, res) => {
  const { codigoQR } = req.body;
  if (!codigoQR) return res.json({ ok: false, error: 'Código vacío.' });
  try {
    const p = await getPool();
    const usuario = await buscarUsuarioPorQR(p, codigoQR);
    if (!usuario) return res.json({ ok: false, error: 'Código no reconocido o usuario inactivo.' });

    req.session.usuario = usuario;
    await registrarEvento(p, usuario.codigo, 'Entrada', 'QR');
    res.json({ ok: true, nombre: usuario.nombre, redirect: '/' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Selladoras con una orden accionable en este momento (Activa, Pendiente de iniciar, o
// PendienteValidacion) -- mismo criterio de estados que EjecucionSelladora.vb:CargarGrid.
// Una fila por maquina: la orden mas relevante (Activa primero, luego Pendiente por prioridad,
// luego PendienteValidacion) via CROSS APPLY -- el detalle de la maquina (/selladora/:codigo)
// lista TODAS sus ordenes en cola, esto es solo la tarjeta resumen.
app.get('/', requireLogin, async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(`
      SELECT maq.Codigo, maq.Nombre, ord.IdOrden, ord.Estado AS EstadoOrden, ord.NumeroPedido, ie.Referencia AS Elemento,
             (SELECT COUNT(*) FROM SEL_Bultos b
               WHERE b.id_maquina = maq.Codigo AND b.estado IN ('Activo', 'Temporal')) AS BultosActivos
      FROM PRDMaquinas maq
      CROSS APPLY (
        SELECT TOP 1 o.* FROM SEL_OrdenProduccion o
        WHERE o.Maquina = maq.Codigo AND o.Estado IN ('Activa', 'Pendiente', 'PendienteValidacion')
        ORDER BY CASE o.Estado WHEN 'Activa' THEN 0 WHEN 'Pendiente' THEN 1 ELSE 2 END ASC,
                 ISNULL(o.Prioridad, 99999) ASC, o.IdOrden ASC
      ) ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      WHERE maq.Tipo = 'SELLADORA'
      ORDER BY maq.Nombre
    `);
    res.send(renderDashboard(result.recordset, req.session.usuario.nombre));
  } catch (err) {
    res.status(500).send(renderDashboard([], req.session.usuario.nombre, err.message));
  }
});

app.get('/selladora/:codigo', requireLogin, async (req, res) => {
  const codigo = req.params.codigo;
  try {
    const p = await getPool();

    const maquina = await p.request().input('codigo', codigo).query(`SELECT Nombre FROM PRDMaquinas WHERE Codigo = @codigo`);
    const nombre = maquina.recordset[0] ? maquina.recordset[0].Nombre : 'Selladora';

    // Cola de ordenes de esta maquina, mismo criterio y orden que EjecucionSelladora.vb:CargarGrid.
    // El detalle de bultos/pesajes/historial de cada orden vive en /selladora/:codigo/orden/:idOrden
    // (boton "Informacion" de cada fila) -- esta pagina es solo la lista.
    const colaResult = await p.request().input('codigo', codigo).query(`
      SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      WHERE ord.Maquina = @codigo AND ord.Estado IN ('Activa','Pendiente','PendienteValidacion')
      ORDER BY CASE ord.Estado WHEN 'Activa' THEN 0 WHEN 'Pendiente' THEN 1 ELSE 2 END ASC,
               ISNULL(ord.Prioridad, 99999) ASC, ord.IdOrden ASC
    `);

    res.send(renderPage(null, req.session.usuario.nombre, nombre, codigo, colaResult.recordset));
  } catch (err) {
    res.status(500).send(renderPage(err.message, req.session.usuario.nombre, 'Selladora', codigo, []));
  }
});

// Detalle de una orden puntual: bultos (indice relativo 1,2,3... no el num_bulto crudo -- mismo
// criterio que EjecucionSelladora.vb:CargarBultos), pesajes/paquetes de cada bulto (SEL_PesajeElemento,
// igual que CargarPesajes) e historial de materia prima (Serial/Referencia/Lote, igual que
// SEL_InventarioMP.vb:MostrarHistorialMP). Reemplaza el viejo bloque "Rollo en curso" (SEL_EjecucionOrden)
// que mezclaba conceptos de rollo/MP que al usuario no le interesan aqui -- solo bultos.
app.get('/selladora/:codigo/orden/:idOrden', requireLogin, async (req, res) => {
  const { codigo, idOrden } = req.params;
  try {
    const p = await getPool();

    const ordenResult = await p.request().input('idOrden', idOrden).query(`
      SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
             maq.Nombre AS MaquinaNombre
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      WHERE ord.IdOrden = @idOrden
    `);
    if (ordenResult.recordset.length === 0) {
      return res.status(404).send(renderErrorSimple('Orden no encontrada.', `/selladora/${codigo}`));
    }
    const orden = ordenResult.recordset[0];

    const bultosResult = await p.request().input('idOrden', idOrden).query(`
      SELECT b.id, b.num_bulto, b.serialPadre, b.CantidadTotal, b.estado, ISNULL(b.Golpes,0) AS Golpes, b.Potencia,
             FORMAT(ISNULL(b.HoraFin, b.HoraInicio), 'dd/MM/yyyy HH:mm') AS Hora
      FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY b.num_bulto ASC
    `);
    const bultos = bultosResult.recordset.map((b, idx) => ({ ...b, numRelativo: idx + 1 }));

    let pesajesPorBulto = new Map();
    if (bultos.length > 0) {
      const pesajesResult = await p.request().input('idOrden', idOrden).query(`
        SELECT pe.id_bulto, pe.ConsecutivoPaquete, FORMAT(pe.FechaHora,'dd/MM/yyyy HH:mm:ss') AS Hora, pe.PesoPaqueGr
        FROM SEL_PesajeElemento pe
        INNER JOIN SEL_Bultos b ON b.id = pe.id_bulto
        INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        WHERE ej.IdOrden = @idOrden
        ORDER BY pe.id_bulto ASC, pe.ConsecutivoPaquete ASC
      `);
      for (const row of pesajesResult.recordset) {
        if (!pesajesPorBulto.has(row.id_bulto)) pesajesPorBulto.set(row.id_bulto, []);
        pesajesPorBulto.get(row.id_bulto).push(row);
      }
    }

    // Historial MP -- mismo criterio que EjecucionSelladora.vb:btnVerHistorial_Click +
    // SEL_InventarioMP.vb:MostrarHistorialMP (Elemento/Lote del ultimo bulto + LineaOriginal ancla).
    let historial = [];
    const ultimoBulto = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 b.refsalida, b.mes, b.dia FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY b.num_bulto DESC
    `);
    if (ultimoBulto.recordset.length > 0) {
      const { refsalida: nElemento, mes, dia } = ultimoBulto.recordset[0];
      const tLote = String(mes).padStart(2, '0') + String(dia).padStart(2, '0');
      const nLineaOriginal = await obtenerLineaOriginalControlSellado(p, idOrden, 0);
      const historialResult = await p.request()
        .input('elemento', nElemento).input('lote', tLote).input('lineaOriginal', nLineaOriginal)
        .query(`
          SELECT mp.Detalle AS Serial, e.Nombre AS Referencia, mp.LoteMP AS Lote
          FROM PRDProduccionMateriaPrima mp
          INNER JOIN INVElementos e ON mp.MateriaPrima = e.Codigo
          WHERE mp.Elemento = @elemento AND mp.Lote = @lote AND mp.Linea = @lineaOriginal
          ORDER BY mp.Linea
        `);
      historial = historialResult.recordset;
    }

    // FIX 24/08/2026: si esta maquina esta Activa y el "operario actual" (ver
    // agregar_operarioactualmaquina.sql -- lo consulta trg_SEL_Bultos_CierreBulto para cada bulto
    // nuevo que crea solo, sin que nadie toque esta pagina) es distinto del que esta viendo la
    // pagina ahora, se ofrece "Tomar control" -- no se asume el relevo solo por entrar a mirar.
    let relevo = null;
    const miOperario = req.session.usuario.codigoOperarioPRD;
    if (orden.Estado === 'Activa' && miOperario > 0) {
      const dtActual = await p.request().input('codigo', codigo).query(`
        SELECT oam.Operario, op.Nombre AS NombreOperario
        FROM SEL_OperarioActualMaquina oam
        LEFT JOIN PRDOperarios op ON op.Codigo = oam.Operario
        WHERE oam.Maquina = @codigo
      `);
      if (dtActual.recordset.length > 0 && dtActual.recordset[0].Operario !== miOperario) {
        relevo = { nombreOperarioActual: dtActual.recordset[0].NombreOperario || 'otro operario' };
      }
    }

    res.send(renderOrdenDetalle(orden, bultos, pesajesPorBulto, historial, req.session.usuario.nombre, codigo, relevo));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
  }
});

// Relevo de operario (ver agregar_operarioactualmaquina.sql) -- el operario que confirma "Tomar
// control" queda como el que trg_SEL_Bultos_CierreBulto usara de aqui en adelante para cada bulto
// nuevo que la maquina cree sola, sin tocar SEL_EjecucionOrden ni SEL_Bultos.
app.post('/api/selladora/maquina/:codigo/tomar-control', requireLogin, async (req, res) => {
  const { codigo } = req.params;
  const idOrden = req.body.idOrden;
  const miOperario = req.session.usuario.codigoOperarioPRD;
  if (!miOperario || miOperario <= 0) {
    return res.status(400).send(renderErrorSimple('Su usuario no tiene un operario de planta asignado.', `/selladora/${codigo}`));
  }
  try {
    const p = await getPool();
    await p.request().input('maquina', codigo).input('operario', miOperario).query(`
      MERGE SEL_OperarioActualMaquina AS destino
      USING (SELECT @maquina AS Maquina) AS origen ON destino.Maquina = origen.Maquina
      WHEN MATCHED THEN UPDATE SET Operario = @operario, FechaHora = GETDATE()
      WHEN NOT MATCHED THEN INSERT (Maquina, Operario, FechaHora) VALUES (@maquina, @operario, GETDATE());
    `);
    res.redirect(`/selladora/${codigo}/orden/${idOrden}`);
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}/orden/${idOrden}`));
  }
});

// Pantalla de escaneo (Iniciar cuando nuevo=0, Añadir Rollo cuando nuevo=1) -- mismo lector
// Html5Qrcode que ya usa renderMarcar() para el QR de acceso, aca configurado para el codigo de
// barras de 19 digitos (Code128C) que trae la etiqueta impresa del rollo.
function renderEscanear(maquinaCodigo, maquinaNombre, idOrden, nuevo, bolsasActual) {
  const tituloAccion = nuevo ? 'Añadir Rollo' : 'Iniciar Ejecución';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${tituloAccion} — ${maquinaNombre}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; min-height: 100vh; background: #f4f6f8; color: #1c2733; padding: 16px;
      box-sizing: border-box;
    }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { font-size: 13px; color: #64748b; margin-bottom: 16px; }
    #lector { width: 100%; max-width: 380px; border-radius: 16px; overflow: hidden; background: black; margin: 0 auto; }
    #manual { max-width: 380px; margin: 14px auto 0; display: flex; gap: 8px; }
    #manual input { flex: 1; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 10px; font-size: 16px; box-sizing: border-box; }
    #manual button { padding: 10px 14px; border: none; border-radius: 10px; background: #0078d7; color: white; font-weight: 600; }
    #resultado { max-width: 380px; margin: 16px auto 0; padding: 16px; border-radius: 14px; background: white; box-shadow: 0 1px 4px rgba(0,0,0,0.08); display: none; }
    #resultado .fila { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px; }
    #resultado label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 6px; }
    #resultado input { width: 100%; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 10px; font-size: 16px; box-sizing: border-box; }
    #resultado button { margin-top: 12px; width: 100%; padding: 12px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; background: #0078d7; color: white; cursor: pointer; }
    .volver { display: block; max-width: 380px; margin: 16px auto 0; color: #64748b; font-size: 13px; text-decoration: none; text-align: center; }
  </style>
</head>
<body>
  <h1>${tituloAccion}</h1>
  <div class="sub">${maquinaNombre} — escanee la etiqueta del rollo (código de 19 dígitos)</div>
  <div id="lector"></div>
  <div id="manual">
    <input type="text" id="txtManual" placeholder="O escriba el código manualmente" inputmode="numeric">
    <button type="button" onclick="consultar(document.getElementById('txtManual').value)">Buscar</button>
  </div>
  <div id="resultado"></div>
  <a class="volver" href="/selladora/${maquinaCodigo}">‹ Volver</a>

  <script src="/html5-qrcode.min.js"></script>
  <script src="/sweetalert2.min.js"></script>
  <script>
    const idOrden = ${JSON.stringify(idOrden)};
    const esNuevoRollo = ${nuevo ? 'true' : 'false'};
    const bolsasActual = ${Number(bolsasActual) || 0};
    const divResultado = document.getElementById('resultado');
    let procesando = false;
    let ultimaConsulta = null;

    async function consultar(serial) {
      serial = (serial || '').trim();
      if (!serial || procesando) return;
      procesando = true;
      try {
        const resp = await fetch('/api/selladora/orden/' + idOrden + '/rollo/consultar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial, esNuevoRollo })
        });
        const datos = await resp.json();
        if (!datos.ok) { mostrarError(datos.error); return; }
        ultimaConsulta = datos;
        mostrarPreview(datos);
      } catch (err) {
        mostrarError('Error de conexión: ' + err.message);
      } finally {
        procesando = false;
      }
    }

    function mostrarError(mensaje) {
      divResultado.style.display = 'none';
      Swal.fire({ icon: 'error', title: 'No se pudo continuar', text: mensaje, confirmButtonColor: '#71bf44' });
    }

    function mostrarPreview(datos) {
      divResultado.className = '';
      const bolsasCampo = esNuevoRollo
        ? '<div class="fila"><span>Bolsas x golpe</span><strong>' + (bolsasActual || '—') + '</strong></div>'
        : '<label for="txtBolsas">Bolsas x golpe</label><input type="number" id="txtBolsas" min="1" inputmode="numeric">';
      divResultado.innerHTML =
        '<div class="fila"><span>Serial</span><strong>' + datos.serial + '</strong></div>' +
        '<div class="fila"><span>Peso (Kg)</span><strong>' + datos.cantidad + '</strong></div>' +
        '<div class="fila"><span>Lote</span><strong>' + (datos.lote || '—') + '</strong></div>' +
        '<div class="fila"><span>Bodega</span><strong>' + datos.bodegaNombre + '</strong></div>' +
        '<div class="fila"><span>Referencia</span><strong>' + datos.referencia + '</strong></div>' +
        bolsasCampo +
        '<button type="button" onclick="confirmar()">' + (esNuevoRollo ? 'Añadir Rollo' : 'Iniciar') + '</button>';
      divResultado.style.display = 'block';
    }

    async function confirmar() {
      if (!ultimaConsulta) return;
      let bolsasXGolpe = bolsasActual;
      if (!esNuevoRollo) {
        const campo = document.getElementById('txtBolsas');
        bolsasXGolpe = parseInt(campo.value, 10);
        if (!bolsasXGolpe || bolsasXGolpe <= 0) {
          Swal.fire({ icon: 'warning', title: 'Dato inválido', text: 'Ingrese un número de bolsas x golpe válido.', confirmButtonColor: '#71bf44' });
          return;
        }
      }
      try {
        const resp = await fetch('/api/selladora/orden/' + idOrden + '/rollo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial: ultimaConsulta.serial, esNuevoRollo, bolsasXGolpe })
        });
        const datos = await resp.json();
        if (!datos.ok) { mostrarError(datos.error); return; }
        Swal.fire({
          icon: 'success', title: esNuevoRollo ? 'Rollo añadido' : 'Ejecución iniciada',
          timer: 1000, showConfirmButton: false
        }).then(() => { window.location.href = datos.redirect; });
      } catch (err) {
        mostrarError('Error de conexión: ' + err.message);
      }
    }

    const lector = new Html5Qrcode('lector', { formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128] });
    Html5Qrcode.getCameras().then(camaras => {
      if (!camaras || camaras.length === 0) return;
      const trasera = camaras.find(c => /back|trasera|rear|environment/i.test(c.label));
      const camaraId = trasera ? trasera.id : camaras[0].id;
      lector.start(camaraId, { fps: 10, qrbox: 250 }, function (texto) { consultar(texto); });
    }).catch(() => {});
  </script>
</body>
</html>`;
}

function renderErrorSimple(mensaje, volverA) {
  const destino = volverA || '/';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Selladora</title>
  <style>${estilosBase()}</style>
</head>
<body>
  <main style="padding-top:24px;">
    <a href="${destino}" style="color:#00a2cb;font-size:14px;">‹ Volver</a>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>
    Swal.fire({
      icon: 'error', title: 'No se pudo continuar', text: ${jsString(mensaje)},
      confirmButtonText: 'Volver', confirmButtonColor: '#71bf44'
    }).then(() => { window.location.href = ${jsString(destino)}; });
  </script>
</body>
</html>`;
}

async function obtenerCodigoMaquinaDeOrden(p, idOrden) {
  const r = await p.request().input('idOrden', idOrden).query(`SELECT Maquina FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  if (r.recordset.length === 0) throw new Error('Orden no encontrada.');
  return r.recordset[0].Maquina;
}

app.get('/selladora/:codigo/orden/:idOrden/escanear', requireLogin, async (req, res) => {
  const { codigo, idOrden } = req.params;
  const nuevo = req.query.nuevo === '1';
  const usuario = req.session.usuario;

  if (!usuario.codigoOperarioPRD) {
    return res.status(403).send(renderErrorSimple(
      'Su usuario no tiene un operario de planta configurado (CodigoOperarioPRD). Pida a sistemas que lo configure antes de usar Iniciar/Añadir Rollo.',
      `/selladora/${codigo}`
    ));
  }

  try {
    const p = await getPool();
    const maquina = await p.request().input('codigo', codigo).query(`SELECT Nombre FROM PRDMaquinas WHERE Codigo = @codigo`);
    const nombreMaquina = maquina.recordset[0] ? maquina.recordset[0].Nombre : 'Selladora';

    let bolsasActual = 0;
    if (nuevo) {
      const v = await validarPuedeAnadirRollo(p, idOrden);
      if (!v.ok) return res.status(400).send(renderErrorSimple(v.error, `/selladora/${codigo}`));
      bolsasActual = v.bolsasActual;
    } else {
      const v = await validarPuedeIniciar(p, idOrden);
      if (!v.ok) return res.status(400).send(renderErrorSimple(v.error, `/selladora/${codigo}`));
    }

    res.send(renderEscanear(codigo, nombreMaquina, idOrden, nuevo, bolsasActual));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
  }
});

app.post('/api/selladora/orden/:idOrden/rollo/consultar', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const { serial, esNuevoRollo } = req.body;
  try {
    const p = await getPool();
    const resultado = await consultarSerial(p, { idOrden, serial, esNuevoRollo: !!esNuevoRollo });
    res.json(resultado);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/selladora/orden/:idOrden/rollo', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const { serial, esNuevoRollo, bolsasXGolpe } = req.body;
  const usuario = req.session.usuario;

  if (!usuario.codigoOperarioPRD) {
    return res.json({ ok: false, error: 'Su usuario no tiene un operario de planta configurado.' });
  }

  try {
    const p = await getPool();
    const check = esNuevoRollo ? await validarPuedeAnadirRollo(p, idOrden) : await validarPuedeIniciar(p, idOrden);
    if (!check.ok) return res.json({ ok: false, error: check.error });

    const maquinaCodigo = await obtenerCodigoMaquinaDeOrden(p, idOrden);

    await confirmarRollo(p, {
      idOrden,
      idEjecucionActivo: check.idEjecucionActivo || 0,
      serial,
      esNuevoRollo: !!esNuevoRollo,
      codOperario: usuario.codigoOperarioPRD,
      bolsasXGolpe: esNuevoRollo ? check.bolsasActual : Number(bolsasXGolpe),
      generadoPor: usuario.generadoPor
    });

    res.json({ ok: true, redirect: `/selladora/${maquinaCodigo}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/selladora/orden/:idOrden/finalizar', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const usuario = req.session.usuario;
  let maquinaCodigo = '';
  try {
    const p = await getPool();
    maquinaCodigo = await obtenerCodigoMaquinaDeOrden(p, idOrden);
    // OperarioFinal (distinto del que inicio) -- mismo bloqueo que EjecucionSelladora.vb si el
    // usuario logueado no tiene SISUsuarios.CodigoOperarioPRD configurado.
    await finalizarOrden(p, idOrden, usuario.generadoPor, usuario.codigoOperarioPRD);
    res.redirect(`/selladora/${maquinaCodigo}`);
  } catch (err) {
    res.status(400).send(renderErrorSimple(err.message, maquinaCodigo ? `/selladora/${maquinaCodigo}` : '/'));
  }
});

const webPort = Number(process.env.WEB_PORT || 3000);
app.listen(webPort, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${webPort} (y en la IP de este PC en la red local)`);
});
