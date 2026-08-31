require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');
const { validarLogin, requireLogin, requireAdmin, ADMIN_CODIGO } = require('./auth');
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

// --- Tablet fija a una maquina -----------------------------------------------
// A pedido del usuario (29/08/2026): cada tablet queda pegada a una sola selladora fisicamente, asi
// que no tiene sentido que el operario tenga que elegir la maquina del dashboard cada vez que entra.
// En vez de un ID de hardware (MAC/IMEI -- no viable desde un navegador: la MAC no la ve el
// servidor HTTP, y Android/iOS la aleatorizan por red desde hace años), se usa un TOKEN OPAQUE
// (UUID aleatorio, sin significado por si solo) guardado en la tabla SEL_TabletsFijas, con una
// cookie propia (NO la de express-session, esa expira a las 8h/turno -- esta dura 1 año) que solo
// lleva ese token. FIX 30/08/2026 (a pedido del usuario, "mas segura"): antes la cookie llevaba el
// codigo de maquina en texto plano -- cualquiera podia editarla a mano (devtools) y hacerse pasar
// por otra maquina. Con el token, editar la cookie a un UUID inventado simplemente no matchea nada
// en la tabla y cae al dashboard normal -- no hay forma de "adivinar" o fabricar un token valido.
// No se agrega cookie-parser (dependencia nueva) para esto solo -- se parsea el header Cookie a
// mano, es una sola cookie de un solo valor.
const COOKIE_MAQUINA_FIJA = 'tabletToken';
function leerCookie(req, nombre) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const parte of header.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    const clave = decodeURIComponent(parte.slice(0, igual).trim());
    if (clave === nombre) return decodeURIComponent(parte.slice(igual + 1).trim());
  }
  return null;
}

// Resuelve el token de la cookie (si existe) a un codigo de maquina real, consultando
// SEL_TabletsFijas -- devuelve null si no hay cookie, o si el token no matchea ninguna fila (cookie
// manipulada/vencida/borrada de la tabla).
async function resolverMaquinaFija(req) {
  const token = leerCookie(req, COOKIE_MAQUINA_FIJA);
  if (!token) return null;
  try {
    const p = await getPool();
    const r = await p.request().input('token', token).query(
      `SELECT Maquina FROM SEL_TabletsFijas WHERE Token = @token`
    );
    return r.recordset[0] ? r.recordset[0].Maquina : null;
  } catch (err) {
    return null; // no bloquear la navegacion normal si esto falla -- solo se pierde el "fijado"
  }
}

// --- Peso en vivo via Node-RED --------------------------------------------
// Node-RED (mismo servidor, puerto por defecto 1880) expone un websocket-out node en /ws/peso
// que va emitiendo el peso leido de la bascula. Este servidor actua de proxy: mantiene UNA
// conexion de cliente hacia Node-RED (reconectando sola si se cae) y reenvia cada mensaje tal
// cual a todos los navegadores conectados a nuestro propio /ws/peso -- asi el celular/tablet no
// necesita ver ni la IP ni el puerto 1880 de Node-RED, solo habla con este servidor.
const NODERED_WS_URL = process.env.NODERED_WS_URL || 'ws://localhost:1880/ws/peso';
let ultimoPeso = null; // se manda de una vez a cada navegador que se conecta, para no esperar el proximo dato

function broadcastPeso(mensaje) {
  ultimoPeso = mensaje;
  for (const cliente of wssPeso.clients) {
    if (cliente.readyState === WebSocket.OPEN) cliente.send(mensaje);
  }
}

function conectarNodeRed() {
  const ws = new WebSocket(NODERED_WS_URL);
  ws.on('message', (data) => broadcastPeso(data.toString()));
  ws.on('close', () => setTimeout(conectarNodeRed, 5000));
  ws.on('error', (err) => {
    console.error('Error conectando a Node-RED (%s):', NODERED_WS_URL, err.message);
    ws.close();
  });
}

// Comandos hacia Node-RED (Imprimir etiqueta / Cierre bulto, ver /api/comando mas abajo): a
// diferencia del peso, aca el navegador nunca habla directo con Node-RED -- publica en nuestro
// /api/comando y este servidor reenvia por HTTP al mismo path en Node-RED. El flujo de Node-RED
// que recibe esto NO tiene nodo "http response" (confirmado probando: la conexion queda abierta
// sin devolver nada), asi que se le pone un timeout corto y un timeout se trata como "entregado"
// -- solo un error de conexion real (Node-RED caido) se reporta como fallo al boton.
const NODERED_HTTP_URL = process.env.NODERED_HTTP_URL || 'http://localhost:1880';

async function enviarComandoANodeRed(cuerpo) {
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), 4000);
  try {
    await fetch(`${NODERED_HTTP_URL}/api/comando`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: controlador.signal
    });
  } catch (err) {
    if (err.name !== 'AbortError') throw err; // AbortError = timeout esperado, no error real
  } finally {
    clearTimeout(timeout);
  }
}

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
    label { display: block; font-size: 13px; font-weight: 600; color: var(--texto); margin-bottom: 6px; }
    select {
      width: 100%; padding: 12px 14px; border: 1px solid #d0d7de; border-radius: 10px;
      font-size: 16px; box-sizing: border-box; background: white; color: var(--texto);
    }
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
    .pesajes-box summary {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--texto-suave);
      cursor: pointer; list-style: none;
    }
    .pesajes-box summary::-webkit-details-marker { display: none; }
    .pesajes-box summary::before { content: '▸ '; }
    .pesajes-box[open] summary::before { content: '▾ '; }
    .pesajes-box summary + * { margin-top: 6px; }
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
    .peso-box {
      background: white; border-radius: 14px; padding: 16px 18px; margin-bottom: 18px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .peso-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    .peso-valor { font-size: 30px; font-weight: 700; color: var(--azul-osc); }
    .peso-valor .unidad { font-size: 15px; font-weight: 600; color: var(--texto-suave); margin-left: 4px; }
    .peso-estado { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; }
    .peso-estado.conectado { background: var(--verde-fondo); color: var(--verde); }
    .peso-estado.desconectado { background: var(--naranja-fondo); color: var(--naranja); }
    .botones-fila {
      display: flex; gap: 8px; flex-wrap: wrap; align-items: stretch;
    }
    .separador-v { width: 1px; background: #d0d7de; align-self: stretch; }
    .imprimir-acciones-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: stretch;
    }
    .btn-imprimir {
      background: #0078d7; min-height: 110px; width: 100%;
      display: flex; align-items: center; justify-content: center;
    }
    .btn-cierre-bulto { background: var(--naranja); }
    .btn-residuo { background: var(--texto-suave); }
    .btn-no-conforme { background: #c00000; }
    .btn-pausa { background: var(--naranja); }
    .btn-accion:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-accion:disabled:active { transform: none; }
    .calidad-apartado { text-align: left; margin-bottom: 16px; }
    .calidad-apartado:last-child { margin-bottom: 0; }
    .calidad-apartado-titulo {
      font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
      color: var(--azul-osc); background: var(--gris-fondo); padding: 6px 10px; border-radius: 6px;
      margin-bottom: 4px;
    }
    .calidad-pregunta {
      text-align: left; padding: 12px 4px; border-bottom: 1px solid #eef0f2;
    }
    .calidad-pregunta:last-child { border-bottom: none; }
    .calidad-titulo { font-size: 14px; font-weight: 600; color: var(--texto); margin-bottom: 8px; }
    .calidad-opciones { display: flex; gap: 18px; }
    .calidad-opcion {
      display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: normal;
      cursor: pointer;
    }
    .calidad-opcion input { width: auto; margin: 0; }
    @media (max-width: 480px) {
      .ejecucion-grid { grid-template-columns: 1fr 1fr; }
      .grid { grid-template-columns: 1fr; }
      .imprimir-acciones-grid { grid-template-columns: 1fr; }
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

function renderDashboard(maquinas, usuario, error, esAdmin) {
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
      ${esAdmin ? `<a class="volver" href="/admin/tablet-fija" style="display:block;margin-top:8px;">📌 Tablet fija a máquina</a>` : ''}
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
function renderColaOrdenes(ordenes, maquinaCodigo, miOperario) {
  if (ordenes.length === 0) return '';
  const filas = ordenes.map(o => {
    let acciones = `<a class="btn-accion btn-info" href="/selladora/${maquinaCodigo}/orden/${o.IdOrden}">ℹ Información</a>`;
    // FIX 01/09/2026: no basta con EstadoEjecucion='PendienteOperador' -- ese flag solo se pone si
    // el operario anterior cerro sesion con el boton Salir; si el servidor se reinicia a mitad de
    // turno, las sesiones se pierden pero esa fila nunca se marca. Por eso se combinan dos señales
    // (OR, no se reemplaza una por la otra):
    //  1) el flag 'PendienteOperador' -- cubre el logout explicito, y a proposito NO se apaga solo
    //     porque el operario coincida: aunque sea el mismo que se fue, debe confirmar "Reanudar"
    //     explicitamente (esa confirmacion fue pedida a proposito, no es un no-op).
    //  2) comparacion EN VIVO del Operario de la ejecucion contra quien esta mirando esta pagina
    //     ahora -- cubre el reinicio del servidor sin logout, donde el flag nunca se puso.
    // Si nadie de las dos aplica (el operario coincide Y no hay flag), es continuidad normal: no
    // hace falta boton, +Rollo/Finalizar quedan disponibles de una.
    const flagPendienteOperador = o.Estado === 'Activa' && o.EstadoEjecucion === 'PendienteOperador';
    const operarioDistintoEnVivo = o.Estado === 'Activa' && o.EstadoEjecucion != null && !!miOperario && o.OperarioEjecucionCodigo !== miOperario;
    const necesitaTomarControl = flagPendienteOperador || operarioDistintoEnVivo;
    let infoOperarioAsignado = '';
    if (necesitaTomarControl) {
      const esElMismo = miOperario != null && o.OperarioEjecucionCodigo === miOperario;
      const nombreAsignado = o.OperarioEjecucionNombre || 'un operario sin nombre configurado';
      const textoBoton = esElMismo ? '▶ Reanudar ejecución' : '🔓 Retomar ejecución';
      infoOperarioAsignado = `<div class="orden-elemento" style="color:var(--naranja);font-weight:600;">Operario anterior: ${nombreAsignado}</div>`;
      acciones += `
        <form method="post" action="/api/selladora/orden/${o.IdOrden}/tomar-control-ejecucion" onsubmit="return confirmarTomarControlEjecucion(event, this, ${esElMismo}, ${jsString(nombreAsignado).replace(/"/g, '&quot;')});">
          <button type="submit" class="btn-accion" style="background:#b46200;">${textoBoton}</button>
        </form>`;
    } else if (o.Estado === 'Pendiente') {
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
    const badge = necesitaTomarControl
      ? `<span class="badge badge-temporal">Pendiente de operador</span>`
      : badgeEstadoOrden(o.Estado);
    return `
      <div class="orden-cola">
        <div class="orden-info">
          <div class="orden-pedido">Pedido ${o.NumeroPedido || '—'} ${badge}</div>
          <div class="orden-elemento">${o.Elemento}</div>
          ${infoOperarioAsignado}
        </div>
        <div class="orden-acciones">${acciones}</div>
      </div>`;
  }).join('');
  return `<h2 style="font-size:15px;margin:0 0 10px;">Programación máquina</h2>${filas}`;
}

// Widget de peso en vivo (pagina de Informacion de la orden, solo con la orden Activa) -- se
// conecta al /ws/peso de ESTE servidor (que a su vez hace de proxy hacia Node-RED, ver
// conectarNodeRed() arriba), no directo a Node-RED. Reconecta sola si se cae. El flujo de
// Node-RED manda JSON tipo {"peso": 0.2088..., "timestamp": "..."} con el peso ya en KG -- se
// muestra tal cual, sin convertir (a diferencia de SEL_PesajeElemento.PesoPaqueGr que es en gramos).
function scriptPesoEnVivo() {
  return `
    (function() {
      var pesoNumero = document.getElementById('peso-numero');
      var pesoEstado = document.getElementById('peso-estado');
      if (!pesoNumero || !pesoEstado) return;

      function fijarEstado(conectado, texto) {
        pesoEstado.textContent = texto;
        pesoEstado.className = 'peso-estado ' + (conectado ? 'conectado' : 'desconectado');
      }

      function conectar() {
        var protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var ws = new WebSocket(protocolo + '//' + location.host + '/ws/peso');

        ws.onopen = function() { fijarEstado(true, 'Conectado'); };
        ws.onclose = function() { fijarEstado(false, 'Desconectado'); setTimeout(conectar, 3000); };
        ws.onerror = function() { ws.close(); };
        ws.onmessage = function(evento) {
          var texto = '—';
          try {
            var json = JSON.parse(evento.data);
            if (json && typeof json.peso === 'number') texto = json.peso.toFixed(2);
          } catch (e) { /* mensaje no valido -- se deja el guion */ }
          pesoNumero.textContent = texto;
        };
      }
      conectar();
    })();
  `;
}

// Resumen del bulto Activo (paquetes pesados + peso acumulado) -- a pedido del usuario
// (27/08/2026), se actualiza solo cada 4s pidiendo /resumen-bulto-activo (no viene por el
// websocket de peso: ese es la lectura instantanea de la bascula, esto es la suma acumulada de
// los paquetes ya registrados en SEL_PesajeElemento para el bulto Activo). El endpoint devuelve
// pesoTotalGr en gramos (asi esta la columna en BD); se muestra en kg con 2 decimales (a pedido
// del usuario, 31/08/2026).
function scriptResumenBultoActivo(idOrden, maquinaCodigo) {
  return `
    (function() {
      var elPaquetes = document.getElementById('resumen-paquetes');
      var elPeso = document.getElementById('resumen-peso-acumulado');
      if (!elPaquetes || !elPeso) return;

      async function actualizar() {
        try {
          const resp = await fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/orden/' + ${JSON.stringify(idOrden)} + '/resumen-bulto-activo');
          if (!resp.ok) return;
          const datos = await resp.json();
          if (!datos.ok) return;
          elPaquetes.textContent = datos.paquetes;
          elPeso.textContent = (datos.pesoTotalGr / 1000).toFixed(2);
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }
      actualizar();
      setInterval(actualizar, 4000);
    })();
  `;
}

// Apartados/preguntas del modal de Calidad (a pedido del usuario, 26/08/2026) -- que apartados y
// que preguntas aparecen depende de datos reales de la orden:
// - Pelicula: siempre, solo "Color de la película" (apartado propio).
// - Deslizamiento: siempre, solo "Deslizamiento (caras de película separadas)" (apartado propio).
// - Impresion: apartado propio, solo si la orden lleva impresion (ver TieneImpresion,
//   INVElementosReferencia Categoria=12) -- "Nombre de la impresion vs programa" e "Impresion
//   centrada".
// - Sellado: siempre (todas las ordenes).
// - Accesorios: solo si Manija, Tula, Parche, CierreDeslizador, CierreHermetico o CintaAdhesiva
//   vale 'Sí' (no alcanza con que no sea NULL -- estas columnas casi siempre traen 'Sí'/'No').
// - Troquelado/Perforaciones: aparece si hay Troquelado (columna != 'SinTroquelado') o
//   Perforaciones (!= 0/NULL). Con solo Troquelado van 2 preguntas (Posicion correcta/Estado de
//   corte); si hay Perforaciones (con o sin Troquelado) se agrega la 3ra ("No. Perforaciones vs
//   programa") -- por eso alcanza con revisar tienePerforaciones para decidir si van 2 o 3.
function construirApartadosCalidad({ tieneImpresion, tieneAccesorios, tieneTroquelado, tienePerforaciones }) {
  const apartados = [
    { titulo: 'Película', preguntas: [{ clave: 'color_pelicula', titulo: 'Color de la película' }] },
    { titulo: 'Deslizamiento', preguntas: [{ clave: 'deslizamiento', titulo: 'Deslizamiento (caras de película separadas)' }] }
  ];

  if (tieneImpresion) {
    apartados.push({
      titulo: 'Impresión',
      preguntas: [
        { clave: 'impresion_nombre_programa', titulo: 'Nombre de la impresión vs programa' },
        { clave: 'impresion_centrada', titulo: 'Impresión centrada' }
      ]
    });
  }

  apartados.push({
    titulo: 'Sellado',
    preguntas: [
      { clave: 'sellado_fisuras', titulo: 'Fisuras' },
      { clave: 'sellado_resistencia', titulo: 'Resistencia (prueba de elongación e impacto)' }
    ]
  });

  if (tieneAccesorios) {
    apartados.push({
      titulo: 'Accesorios',
      preguntas: [
        { clave: 'accesorios_color', titulo: 'Color vs programa' },
        { clave: 'accesorios_resistencia', titulo: 'Resistencia / Adhesión' }
      ]
    });
  }

  if (tieneTroquelado || tienePerforaciones) {
    const preguntasTroquelado = [
      { clave: 'troquelado_posicion', titulo: 'Posición correcta' },
      { clave: 'troquelado_corte', titulo: 'Estado de corte' }
    ];
    if (tienePerforaciones) {
      preguntasTroquelado.push({ clave: 'perforaciones_cantidad', titulo: 'No. Perforaciones vs programa' });
    }
    apartados.push({ titulo: 'Troquelado/Perforaciones', preguntas: preguntasTroquelado });
  }

  return apartados;
}

// Botones "Imprimir etiqueta" / "Cierre bulto" / "Retal" / "Troquelado" -- publican en
// /api/comando (este servidor), que reenvia a Node-RED. idOrden/maquinaCodigo se cierran sobre el
// scope de la funcion (valores fijos de esta pagina), asi los botones no necesitan mas que el
// nombre del comando. `datos` es opcional -- lo usa el modal de Calidad para mandar las
// respuestas junto con el comando (ver abrirCalidad() mas abajo). `calidadFlags` decide que
// apartados/preguntas de Calidad aplican para esta orden, ver construirApartadosCalidad().
function scriptComandos(idOrden, maquinaCodigo, calidadFlags, pausaActiva) {
  const apartadosCalidad = construirApartadosCalidad(calidadFlags);
  return `
    function enviarComando(comando, boton, datos) {
      if (boton) boton.disabled = true;
      fetch('/api/comando', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comando: comando, idOrden: ${JSON.stringify(idOrden)}, maquinaCodigo: ${jsString(maquinaCodigo)}, datos: datos })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            Swal.fire({ icon: 'success', title: 'Comando enviado', timer: 1500, showConfirmButton: false });
          } else {
            Swal.fire({ icon: 'error', title: 'Error', text: data.error || 'No se pudo enviar el comando.', confirmButtonColor: '#71bf44' });
          }
        })
        .catch(function(err) {
          Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo enviar el comando: ' + err.message, confirmButtonColor: '#71bf44' });
        })
        .finally(function() { if (boton) boton.disabled = false; });
    }

    // Confirmacion "¿Esta seguro de...?" antes de Imprimir etiqueta/Cierre bulto/Retal/Troquelado/
    // Refilado/Salida no conforme (a pedido del usuario, 30/08/2026) -- Calidad NO pasa por aca,
    // ya tiene su propia confirmacion (el formulario del modal con "Guardar"/"Cancelar").
    function confirmarYEnviar(mensaje, comando, boton) {
      Swal.fire({
        icon: 'warning',
        title: mensaje,
        showCancelButton: true,
        confirmButtonText: 'Sí',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (resultado.isConfirmed) enviarComando(comando, boton);
      });
    }

    // Pausa (SEL_TiempoMuerto) -- pantalla emergente para elegir el motivo (Alistamiento
    // despliega sus 3 subopciones justo debajo, Otro pide una breve descripcion). Al confirmar,
    // escribe directo en la BD (Estado='En pausa' + fila en SEL_TiempoMuerto) y recarga la pagina
    // -- la recarga dispara abrirModalPausaActiva() mas abajo, que muestra el cronometro.
    var MOTIVOS_PAUSA = [
      { clave: 'descanso', titulo: 'Descanso' },
      { clave: 'mantenimiento', titulo: 'Mantenimiento' },
      { clave: 'alistamiento', titulo: 'Alistamiento' },
      { clave: 'limpieza', titulo: 'Limpieza y desinfección' },
      { clave: 'otro', titulo: 'Otro' }
    ];
    var SUBMOTIVOS_ALISTAMIENTO = [
      { clave: 'materiales', titulo: 'Materiales' },
      { clave: 'mecanico', titulo: 'Mecánico' },
      { clave: 'espacio_trabajo', titulo: 'Espacio de trabajo' }
    ];

    function abrirPausa() {
      var htmlSubmotivos = SUBMOTIVOS_ALISTAMIENTO.map(function(s) {
        return '<label class="calidad-opcion" style="display:flex;margin-bottom:6px;"><input type="radio" name="subtipoPausa" value="' + s.clave + '"> ' + s.titulo + '</label>';
      }).join('');

      // Las subopciones de Alistamiento van justo debajo de esa opcion (a pedido del usuario,
      // 31/08/2026), no en un bloque aparte al final de la lista.
      var htmlMotivos = MOTIVOS_PAUSA.map(function(m) {
        var item = '<label class="calidad-opcion" style="display:flex;margin-bottom:8px;"><input type="radio" name="motivoPausa" value="' + m.clave + '"> ' + m.titulo + '</label>';
        if (m.clave === 'alistamiento') {
          item += '<div id="pausa-submotivos" style="display:none;margin:0 0 8px 24px;">' + htmlSubmotivos + '</div>';
        }
        return item;
      }).join('');

      var html =
        '<div style="text-align:left;">' + htmlMotivos + '</div>' +
        '<div id="pausa-observaciones-wrap" style="display:none;text-align:left;margin-top:8px;">' +
          '<label for="pausa-observaciones">Describa el motivo</label>' +
          '<input type="text" id="pausa-observaciones" maxlength="200">' +
        '</div>';

      Swal.fire({
        title: 'Motivo de la pausa',
        html: html,
        confirmButtonText: 'Pausar',
        confirmButtonColor: '#b46200',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#c0392b',
        focusConfirm: false,
        didOpen: function() {
          var contenedor = Swal.getHtmlContainer();
          var submotivos = contenedor.querySelector('#pausa-submotivos');
          var obsWrap = contenedor.querySelector('#pausa-observaciones-wrap');
          contenedor.querySelectorAll('input[name="motivoPausa"]').forEach(function(r) {
            r.addEventListener('change', function() {
              submotivos.style.display = r.value === 'alistamiento' ? 'block' : 'none';
              obsWrap.style.display = r.value === 'otro' ? 'block' : 'none';
            });
          });
        },
        preConfirm: function() {
          var contenedor = Swal.getHtmlContainer();
          var motivo = contenedor.querySelector('input[name="motivoPausa"]:checked');
          if (!motivo) { Swal.showValidationMessage('Seleccione un motivo.'); return false; }
          var datos = { tipo: motivo.value };
          if (motivo.value === 'alistamiento') {
            var sub = contenedor.querySelector('input[name="subtipoPausa"]:checked');
            if (!sub) { Swal.showValidationMessage('Seleccione el motivo de alistamiento.'); return false; }
            datos.subtipo = sub.value;
          }
          if (motivo.value === 'otro') {
            var obs = contenedor.querySelector('#pausa-observaciones').value.trim();
            if (!obs) { Swal.showValidationMessage('Describa el motivo.'); return false; }
            datos.observaciones = obs;
          }
          return datos;
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        fetch('/api/selladora/orden/${idOrden}/pausar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resultado.value)
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) { location.reload(); }
            else Swal.fire({ icon: 'error', title: 'Error', text: data.error || 'No se pudo pausar.', confirmButtonColor: '#71bf44' });
          })
          .catch(function(err) {
            Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo pausar: ' + err.message, confirmButtonColor: '#71bf44' });
          });
      });
    }

    // Cronometro de la pausa: ventana emergente BLOQUEANTE (a pedido del usuario, 31/08/2026) --
    // sin boton cancelar/cerrar, sin cerrar por click afuera ni Escape (allowOutsideClick/
    // allowEscapeKey en false). La UNICA forma de cerrarla es "Reanudar", y eso pasa por
    // preConfirm: si /reanudar falla, la ventana se queda abierta mostrando el error (no se cierra
    // "en falso"). Arranca desde pausaInfo.HoraInicio (la real, guardada en BD), no desde que se
    // abre la ventana -- por eso tambien se auto-abre sola al cargar la pagina si la ejecucion ya
    // esta en pausa (ver el llamado mas abajo), y no solo cuando el operario acaba de pausar.
    function abrirModalPausaActiva(pausaInfo) {
      var motivo = MOTIVOS_PAUSA.find(function(m) { return m.clave === pausaInfo.Tipo; });
      var motivoTexto = motivo ? motivo.titulo : pausaInfo.Tipo;
      if (pausaInfo.Subtipo) {
        var sub = SUBMOTIVOS_ALISTAMIENTO.find(function(s) { return s.clave === pausaInfo.Subtipo; });
        motivoTexto += ' · ' + (sub ? sub.titulo : pausaInfo.Subtipo);
      }
      if (pausaInfo.Observaciones) motivoTexto += ' — ' + pausaInfo.Observaciones;

      var inicio = new Date(pausaInfo.HoraInicio).getTime();
      var intervalId;

      Swal.fire({
        title: '⏸ En pausa',
        html: '<div style="font-size:14px;color:#64748b;margin-bottom:10px;">' + motivoTexto + '</div>' +
              '<div style="font-size:36px;font-weight:700;color:#006984;" id="pausa-cronometro-modal">00:00:00</div>',
        confirmButtonText: '▶ Reanudar',
        confirmButtonColor: '#4a9c2e',
        showCancelButton: false,
        showCloseButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: function() {
          var el = document.getElementById('pausa-cronometro-modal');
          function actualizar() {
            var seg = Math.max(0, Math.floor((Date.now() - inicio) / 1000));
            var hh = String(Math.floor(seg / 3600)).padStart(2, '0');
            var mm = String(Math.floor((seg % 3600) / 60)).padStart(2, '0');
            var ss = String(seg % 60).padStart(2, '0');
            el.textContent = hh + ':' + mm + ':' + ss;
          }
          actualizar();
          intervalId = setInterval(actualizar, 1000);
        },
        willClose: function() { clearInterval(intervalId); },
        preConfirm: function() {
          return fetch('/api/selladora/orden/${idOrden}/reanudar', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.ok) { Swal.showValidationMessage(data.error || 'No se pudo reanudar.'); return false; }
              return true;
            })
            .catch(function(err) {
              Swal.showValidationMessage('No se pudo reanudar: ' + err.message);
              return false;
            });
        }
      }).then(function(resultado) {
        if (resultado.isConfirmed) location.reload();
      });
    }

    ${pausaActiva ? `abrirModalPausaActiva(${JSON.stringify(pausaActiva)});` : 'programarCalidadAleatoria();'}

    // Apartado de Calidad: pantalla emergente con las preguntas agrupadas por apartado (Pelicula,
    // Sellado, Accesorios, Troquelado/Perforaciones -- ver construirApartadosCalidad() en
    // server.js, que decide cuales apartados/preguntas aplican segun los datos reales de esta
    // orden). Cada pregunta es Conforme/No conforme via checkbox (los dos checkboxes de una misma
    // pregunta son mutuamente excluyentes -- marcar uno desmarca el otro). No deja confirmar si
    // falta alguna respuesta. Publica comando 'calidad' con TODAS las respuestas (de todos los
    // apartados) en 'datos', mismo mecanismo que los demas botones.
    var APARTADOS_CALIDAD = ${JSON.stringify(apartadosCalidad)};

    function abrirCalidad() {
      var html = APARTADOS_CALIDAD.map(function(ap) {
        var preguntasHtml = ap.preguntas.map(function(p) {
          return '<div class="calidad-pregunta">' +
            '<div class="calidad-titulo">' + p.titulo + '</div>' +
            '<div class="calidad-opciones">' +
              '<label class="calidad-opcion"><input type="checkbox" name="' + p.clave + '" value="conforme"> Conforme</label>' +
              '<label class="calidad-opcion"><input type="checkbox" name="' + p.clave + '" value="no_conforme"> No conforme</label>' +
            '</div>' +
          '</div>';
        }).join('');
        return '<div class="calidad-apartado">' +
          '<div class="calidad-apartado-titulo">' + ap.titulo + '</div>' +
          preguntasHtml +
        '</div>';
      }).join('');

      Swal.fire({
        title: 'Calidad',
        html: html,
        width: 520,
        confirmButtonText: 'Guardar',
        confirmButtonColor: '#71bf44',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#c0392b',
        focusConfirm: false,
        didOpen: function() {
          var contenedor = Swal.getHtmlContainer();
          APARTADOS_CALIDAD.forEach(function(ap) {
            ap.preguntas.forEach(function(p) {
              var checks = contenedor.querySelectorAll('input[name="' + p.clave + '"]');
              checks.forEach(function(actual) {
                actual.addEventListener('change', function() {
                  if (actual.checked) {
                    checks.forEach(function(otro) { if (otro !== actual) otro.checked = false; });
                  }
                });
              });
            });
          });
        },
        preConfirm: function() {
          var contenedor = Swal.getHtmlContainer();
          var respuestas = {};
          var faltantes = [];
          APARTADOS_CALIDAD.forEach(function(ap) {
            ap.preguntas.forEach(function(p) {
              var marcado = contenedor.querySelector('input[name="' + p.clave + '"]:checked');
              if (!marcado) faltantes.push(p.titulo);
              else respuestas[p.clave] = marcado.value;
            });
          });
          if (faltantes.length > 0) {
            Swal.showValidationMessage('Falta responder: ' + faltantes.join(', '));
            return false;
          }
          return respuestas;
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        enviarComando('calidad', null, resultado.value);
      });
    }

    // Calidad ya no tiene boton (a pedido del usuario, 31/08/2026) -- sale sola, en un momento
    // aleatorio entre 20 y 30 minutos desde que la orden esta Activa, y se repite mientras siga
    // asi (cada vez que se cierra el modal se programa el siguiente, con un nuevo intervalo
    // aleatorio). Solo corre en esta carga de pagina -- un refresh reinicia la cuenta, no hay
    // forma de "recordar" el tiempo transcurrido de una carga a otra sin guardar algo en el
    // servidor, que no se pidio. No se programa mientras hay una pausa activa (ver el llamado al
    // final del archivo) para no competir con esa ventana bloqueante.
    function programarCalidadAleatoria() {
      var minMs = 20 * 60 * 1000;
      var maxMs = 30 * 60 * 1000;
      var espera = minMs + Math.random() * (maxMs - minMs);
      setTimeout(function() {
        abrirCalidad();
        programarCalidadAleatoria();
      }, espera);
    }
  `;
}

// Script compartido por renderPage y renderOrdenDetalle -- confirmacion antes de Finalizar, y
// (31/08/2026) antes de Tomar control de una ejecucion PendienteOperador.
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

    function confirmarTomarControlEjecucion(evento, formulario, esElMismo, nombreOperarioAnterior) {
      evento.preventDefault();
      Swal.fire({
        icon: 'question',
        title: esElMismo ? '¿Reanudar esta ejecución?' : '¿Retomar esta ejecución?',
        text: 'Esta ejecución estaba siendo ejecutada por "' + nombreOperarioAnterior + '". Al confirmar la retoma con su usuario.',
        showCancelButton: true,
        confirmButtonText: esElMismo ? 'Sí, reanudar' : 'Sí, retomar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#b46200',
        cancelButtonColor: '#71bf44'
      }).then(resultado => { if (resultado.isConfirmed) formulario.submit(); });
      return false;
    }
  `;
}

// Antes de entrar a producir -- al Iniciar una orden con su primer rollo (renderEscanear, nuevo=0
// unicamente, NO aplica a +Rollo) o al Retomar/Reanudar una ejecucion tras un cambio de operario
// (confirmarTomarControlEjecucion arriba) -- se pregunta si hay alguna actividad de las que se
// registran como pausa (Alistamiento, Mantenimiento, etc.) por hacer primero, o si se entra directo
// a producir (a pedido del usuario, 31/08/2026). Si elige una actividad, queda registrada igual que
// si hubiera usado el boton "Pausa" normal (mismo POST /pausar) -- la ejecucion arranca/vuelve en
// 'En pausa' desde ese momento, en vez de tener que pausarla a mano despues de haber entrado.
// Comparte los mismos motivos/submotivos que abrirPausa() en scriptComandos(), pero se duplican aca
// (MOTIVOS_PAUSA_INICIAL) porque esta funcion se usa en paginas (renderEscanear, renderPage) que no
// cargan scriptComandos.
function scriptPreguntaActividadInicial() {
  return `
    var MOTIVOS_PAUSA_INICIAL = [
      { clave: 'descanso', titulo: 'Descanso' },
      { clave: 'mantenimiento', titulo: 'Mantenimiento' },
      { clave: 'alistamiento', titulo: 'Alistamiento' },
      { clave: 'limpieza', titulo: 'Limpieza y desinfección' },
      { clave: 'otro', titulo: 'Otro' }
    ];
    var SUBMOTIVOS_ALISTAMIENTO_INICIAL = [
      { clave: 'materiales', titulo: 'Materiales' },
      { clave: 'mecanico', titulo: 'Mecánico' },
      { clave: 'espacio_trabajo', titulo: 'Espacio de trabajo' }
    ];

    function preguntarActividadInicial(idOrden, alTerminar) {
      Swal.fire({
        icon: 'question',
        title: '¿Va a realizar alguna actividad antes de producir?',
        text: 'Por ejemplo alistamiento, mantenimiento o limpieza. Si no, entra directo a producción.',
        showCancelButton: true,
        confirmButtonText: 'Sí, registrar actividad',
        cancelButtonText: '▶ Entrar a producción',
        confirmButtonColor: '#b46200',
        cancelButtonColor: '#4a9c2e'
      }).then(function(resultado) {
        if (resultado.isConfirmed) { elegirMotivoInicial(idOrden, alTerminar); }
        else { alTerminar(); }
      });
    }

    function elegirMotivoInicial(idOrden, alTerminar) {
      var htmlSubmotivos = SUBMOTIVOS_ALISTAMIENTO_INICIAL.map(function(s) {
        return '<label style="display:flex;margin-bottom:6px;"><input type="radio" name="subtipoPausaInicial" value="' + s.clave + '"> ' + s.titulo + '</label>';
      }).join('');
      var htmlMotivos = MOTIVOS_PAUSA_INICIAL.map(function(m) {
        var item = '<label style="display:flex;margin-bottom:8px;"><input type="radio" name="motivoPausaInicial" value="' + m.clave + '"> ' + m.titulo + '</label>';
        if (m.clave === 'alistamiento') {
          item += '<div id="pausa-inicial-submotivos" style="display:none;margin:0 0 8px 24px;">' + htmlSubmotivos + '</div>';
        }
        return item;
      }).join('');
      var html =
        '<div style="text-align:left;">' + htmlMotivos + '</div>' +
        '<div id="pausa-inicial-observaciones-wrap" style="display:none;text-align:left;margin-top:8px;">' +
          '<label for="pausa-inicial-observaciones" style="display:block;font-size:13px;font-weight:600;margin:10px 0 6px;">Describa el motivo</label>' +
          '<input type="text" id="pausa-inicial-observaciones" maxlength="200" style="width:100%;padding:10px 12px;border:1px solid #d0d7de;border-radius:10px;font-size:16px;box-sizing:border-box;">' +
        '</div>';
      Swal.fire({
        title: 'Motivo de la actividad',
        html: html,
        confirmButtonText: 'Registrar',
        confirmButtonColor: '#71bf44',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        didOpen: function() {
          var radios = document.getElementsByName('motivoPausaInicial');
          for (var i = 0; i < radios.length; i++) {
            radios[i].addEventListener('change', function() {
              document.getElementById('pausa-inicial-submotivos').style.display = (this.value === 'alistamiento') ? 'block' : 'none';
              document.getElementById('pausa-inicial-observaciones-wrap').style.display = (this.value === 'otro') ? 'block' : 'none';
            });
          }
        },
        preConfirm: function() {
          var tipoEl = document.querySelector('input[name=motivoPausaInicial]:checked');
          if (!tipoEl) { Swal.showValidationMessage('Seleccione un motivo.'); return false; }
          var tipo = tipoEl.value;
          var subtipo = null;
          if (tipo === 'alistamiento') {
            var subEl = document.querySelector('input[name=subtipoPausaInicial]:checked');
            if (!subEl) { Swal.showValidationMessage('Seleccione el motivo de alistamiento.'); return false; }
            subtipo = subEl.value;
          }
          var observaciones = null;
          if (tipo === 'otro') {
            observaciones = document.getElementById('pausa-inicial-observaciones').value.trim();
            if (!observaciones) { Swal.showValidationMessage('Describa el motivo.'); return false; }
          }
          return fetch('/api/selladora/orden/' + idOrden + '/pausar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo: tipo, subtipo: subtipo, observaciones: observaciones })
          }).then(function(r) { return r.json(); }).then(function(data) {
            if (!data.ok) { Swal.showValidationMessage(data.error || 'No se pudo registrar.'); return false; }
            return true;
          }).catch(function(err) {
            Swal.showValidationMessage('Error de conexión: ' + err.message);
            return false;
          });
        }
      }).then(function(resultado) {
        if (resultado.isConfirmed) { alTerminar(); }
        else { preguntarActividadInicial(idOrden, alTerminar); }
      });
    }
  `;
}

// Solo la cola de ordenes de la maquina -- el detalle de bultos/pesajes/historial de cada orden
// vive en /selladora/:codigo/orden/:idOrden (boton "Informacion").
function renderPage(error, usuario, maquinaNombre, maquinaCodigo, colaOrdenes, miOperario, idOrdenPreguntarActividad) {
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
      <div class="sub">Programación máquina</div>
    </div>
  </header>
  <main>
    <div class="barra">
      <span class="actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
      <form method="get" action="/selladora/${maquinaCodigo}"><button type="submit">↻ Actualizar</button></form>
    </div>
    ${renderColaOrdenes(colaOrdenes || [], maquinaCodigo, miOperario)}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  ${idOrdenPreguntarActividad ? `<script>
    // Termine con actividad o directo a produccion, se entra a Informacion de la orden retomada --
    // no se queda en la cola de la maquina (a pedido del usuario, 31/08/2026).
    preguntarActividadInicial(${JSON.stringify(idOrdenPreguntarActividad)}, function() {
      window.location.href = ${JSON.stringify(`/selladora/${maquinaCodigo}/orden/${idOrdenPreguntarActividad}`)};
    });
  </script>` : ''}
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'Error', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

// Unico apartado para fijar/quitar la tablet de una maquina -- solo lo puede tocar el
// administrador (requireAdmin, ver auth.js). Reemplaza los enlaces "Fijar esta tablet"/"Tablet
// fija aqui" que antes vivian en CADA pagina de selladora (renderPage) -- a pedido del usuario
// (30/08/2026), la dinamica del token queda centralizada aca.
function renderTabletFija(usuario, maquinas, maquinaActual, error) {
  const opciones = maquinas.map(m =>
    `<option value="${m.Codigo}" ${maquinaActual && String(maquinaActual.Codigo) === String(m.Codigo) ? 'selected' : ''}>${m.Nombre}</option>`
  ).join('');

  const estadoActual = maquinaActual ? `
    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">Estado actual</div>
      <p style="margin:0 0 14px;">Esta tablet está fija a: <strong>${maquinaActual.Nombre}</strong></p>
      <form method="post" action="/admin/tablet-fija/quitar">
        <button type="submit" class="btn-accion" style="background:#c0392b;width:100%;">Quitar fija</button>
      </form>
    </div>` : `
    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">Estado actual</div>
      <p style="margin:0;">Esta tablet no está fija a ninguna máquina.</p>
    </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tablet fija — Admin</title>
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
      <h1>📌 Tablet fija a máquina</h1>
      <div class="sub">Solo el administrador puede asignar o quitar esta tablet de una selladora.</div>
    </div>
  </header>
  <main>
    ${estadoActual}
    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">Fijar a una máquina</div>
      <form method="post" action="/admin/tablet-fija">
        <label for="maquina">Selecciona la máquina</label>
        <select name="maquina" id="maquina" required>
          <option value="">-- Selecciona --</option>
          ${opciones}
        </select>
        <button type="submit" style="margin-top:14px;">Fijar esta tablet</button>
      </form>
    </div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'Error', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

// Botones de residuos (Retal/Troquelado/Refilado -- columnas PRDProduccion.Retal/
// ResiduoTroquelado/ResiduoRefilado) para la ejecucion Activa de la orden: cuales aparecen depende
// del Tipo de la maquina (PRDMaquinas.Tipo). Por ahora solo SELLADORA esta soportada en esta app y
// solo Retal/Troquelado tienen sentido ahi -- Refilado es de REFILADORA. FIX 26/08/2026: este
// servidor ya NO escribe nada en la BD para estos botones -- publican 'residuo:retal'/
// 'residuo:troquelado' en /api/comando (mismo mecanismo que Imprimir etiqueta/Cierre bulto,
// fire-and-forget hacia Node-RED, ver enviarComando() en scriptComandos()). Toda la logica de
// insertar el registro hijo vive ahora en Node-RED, no aqui.
const BOTONES_RESIDUOS_POR_TIPO = {
  SELLADORA: ['retal', 'troquelado']
};
const BOTONES_RESIDUOS = [
  { clave: 'retal', label: 'Retal' },
  { clave: 'troquelado', label: 'Troquelado' },
  { clave: 'refilado', label: 'Refilado' }
];

// Detalle/especificaciones de una orden puntual y el historial de materia prima
// (Serial/Referencia/Lote unicamente -- nada de cantidades ni fechas, a pedido del usuario). Los
// bultos producidos NO viven aqui -- con las columnas de especificaciones esta pagina ya tiene
// suficiente informacion; los bultos se ven aparte en
// /selladora/:codigo/orden/:idOrden/bultos (ver renderBultosOrden), enlazados desde aqui.
// FIX 31/08/2026: el aviso de relevo ("Esta máquina la está operando X" + "Tomar control") que
// vivia aca se elimino -- a pedido del usuario, esa accion (MERGE SEL_OperarioActualMaquina) ahora
// la hacen los botones condicionales de la cola de ordenes de la maquina (renderColaOrdenes,
// "Tomar control de la ejecución"/"Reanudar ejecución"), asi que ya no hacia falta duplicarla aca.
function renderOrdenDetalle(orden, totalBultos, historial, usuario, maquinaCodigo, pausaActiva) {
  const filasHistorial = historial.length
    ? historial.map(h => `
        <div class="hist-fila">
          <span class="valor serial">${h.Serial ?? '—'}</span>
          <span>${h.Referencia ?? '—'}</span>
          <span>${h.Lote ?? '—'}</span>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  let acciones = '';
  const activa = orden.Estado === 'Activa';
  if (orden.Estado === 'Pendiente') {
    acciones = `<a class="btn-accion btn-iniciar" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/escanear?nuevo=0">▶ Iniciar</a>`;
  } else if (activa) {
    acciones = `
      <a class="btn-accion btn-anadir" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/escanear?nuevo=1">+ Rollo</a>
      <form method="post" action="/api/selladora/orden/${orden.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
        <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
      </form>`;
  }

  // Botones de residuos (Retal/Troquelado) van en el MISMO bloque de acciones que Imprimir
  // etiqueta/Cierre bulto, separados por una linea vertical -- a pedido del usuario (24/08/2026),
  // no en una caja aparte. FIX 26/08/2026: usan el mismo enviarComando()/POST /api/comando que
  // Imprimir etiqueta/Cierre bulto (publican 'residuo:retal' o 'residuo:troquelado' para que
  // Node-RED los lea) -- ya no hacen ninguna escritura directa en esta BD. "Refilado" queda sin
  // boton (no aplica a SELLADORA, BOTONES_RESIDUOS_POR_TIPO no lo habilita para este tipo).
  const botonesResiduosHabilitados = BOTONES_RESIDUOS_POR_TIPO[orden.MaquinaTipo] || [];
  const botonesResiduosHTML = botonesResiduosHabilitados.length ? `
        <span class="separador-v"></span>
        ${BOTONES_RESIDUOS
          .filter(b => botonesResiduosHabilitados.includes(b.clave))
          .map(b => `<button type="button" class="btn-accion btn-residuo" onclick="confirmarYEnviar('¿Está seguro de marcar este bulto con ${b.label}?', '${b.clave}', this)">${b.label}</button>`)
          .join('')}` : '';

  // Peso en vivo + Imprimir etiqueta/Cierre bulto/Residuos: solo tienen sentido con la orden
  // Activa (bascula/impresora actuando sobre el bulto que se esta armando en este momento).
  // Peso en vivo + resumen del bulto actual (paquetes/acumulado) van juntos, uno al lado del otro
  // (a pedido del usuario, 27/08/2026) -- ya no comparten caja con los botones de accion.
  const pesoBox = activa ? `
    <div class="peso-box">
      <div class="peso-top">
        <div>
          <div class="label">Peso paquete (báscula)</div>
          <div class="peso-valor"><span id="peso-numero">—</span><span class="unidad">kg</span></div>
        </div>
        <div>
          <div class="label">Paquetes bulto actual</div>
          <div class="peso-valor"><span id="resumen-paquetes">—</span></div>
        </div>
        <div>
          <div class="label">Peso acumulado</div>
          <div class="peso-valor"><span id="resumen-peso-acumulado">—</span><span class="unidad">kg</span></div>
        </div>
        <span class="peso-estado desconectado" id="peso-estado">Conectando…</span>
      </div>
    </div>` : '';

  // Imprimir etiqueta + resto de acciones (Cierre bulto/Retal/Troquelado/Refilado/Calidad/Salida
  // no conforme/Pausa) van en la MISMA fila, en dos columnas (a pedido del usuario, 31/08/2026):
  // izquierda Imprimir etiqueta, derecha el resto. El boton de Pausa solo aparece si NO esta ya
  // pausada -- mientras esta pausada, el cronometro sale como ventana emergente aparte (ver
  // abrirModalPausaActiva en scriptComandos), no hay caja para eso en la pagina.
  const imprimirYAccionesBox = activa ? `
    <div class="peso-box">
      <div class="imprimir-acciones-grid">
        <button type="button" class="btn-accion btn-imprimir" onclick="confirmarYEnviar('¿Está seguro de imprimir la etiqueta?', 'imprimir_etiqueta', this)">🖨️ Imprimir etiqueta</button>
        <div class="botones-fila">
          <button type="button" class="btn-accion btn-cierre-bulto" onclick="confirmarYEnviar('¿Está seguro de cerrar el bulto?', 'cierre_bulto', this)">📦 Cierre bulto</button>
          ${botonesResiduosHTML}
          <span class="separador-v"></span>
          <button type="button" class="btn-accion btn-no-conforme" onclick="confirmarYEnviar('¿Está seguro de marcar esta salida como no conforme?', 'no_conforme', this)">🚫 Salida no conforme</button>
          ${!pausaActiva ? `
          <span class="separador-v"></span>
          <button type="button" class="btn-accion btn-pausa" onclick="abrirPausa()">⏸ Pausa</button>` : ''}
        </div>
      </div>
    </div>` : '';

  // Especificaciones del elemento pedido para esta orden -- campos de SEL_OrdenProduccion, a
  // pedido del usuario (24/08/2026) para no tener que ir a Mirane a consultarlos. "Separador" se
  // quito (26/08/2026, esa columna va a eliminarse). "Lleva impresion" se resuelve por
  // INVElementosReferencia Categoria=12 (mismo criterio que Referencia.vb:175, ver TieneImpresion
  // en la consulta de arriba) -- de esto tambien depende si la pregunta "Impresion" aparece en el
  // modal de Calidad (ver scriptComandos).
  const tieneImpresion = orden.TieneImpresion === 1;

  // Condiciones que deciden que apartados/preguntas de Calidad aplican -- ver
  // construirApartadosCalidad(). "Sí" exacto para accesorios (no alcanza con no-NULL, ver
  // conversacion 26/08/2026); Troquelado != 'SinTroquelado'; Perforaciones != 0/NULL.
  const tieneAccesorios = ['Manija', 'Tula', 'Parche', 'CierreDeslizador', 'CierreHermetico', 'CintaAdhesiva']
    .some(campo => orden[campo] === 'Sí');
  const tieneTroquelado = !!orden.Troquelado && orden.Troquelado !== 'SinTroquelado';
  const tienePerforaciones = orden.Perforaciones != null && Number(orden.Perforaciones) !== 0;
  const calidadFlags = { tieneImpresion, tieneAccesorios, tieneTroquelado, tienePerforaciones };

  const especificaciones = [
    ['Tipo de sellado', orden.TipoSellado],
    ['Troquelado', orden.Troquelado],
    ['Uso previsto', orden.UsoPrevisto],
    ['Manija', orden.Manija],
    ['Color manija', orden.ManijaColor],
    ['Tula', orden.Tula],
    ['Color tula', orden.TulaColor],
    ['Parche', orden.Parche],
    ['Cierre deslizador', orden.CierreDeslizador],
    ['Perforaciones', orden.Perforaciones],
    ['Nombre impresión', tieneImpresion ? (orden.TipoImpresionDescripcion || 'Sí') : 'No']
  ].map(([label, valor]) => `<div><span class="label">${label}</span><span class="valor">${valor ?? '—'}</span></div>`).join('');

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
    ${acciones ? `<div class="orden-cola" style="margin-bottom:18px;"><div class="orden-acciones">${acciones}</div></div>` : ''}
    ${pesoBox}
    ${imprimirYAccionesBox}
    <div class="orden-cola" style="margin-bottom:18px;">
      <div class="orden-info">
        <div class="orden-pedido">Bultos producidos</div>
        <div class="orden-elemento">${totalBultos} bulto(s) en esta orden</div>
      </div>
      <div class="orden-acciones">
        <a class="btn-accion btn-info" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/bultos">📦 Ver bultos</a>
      </div>
    </div>
    <h2 style="font-size:15px;margin:0 0 10px;">Especificaciones</h2>
    <div class="ejecucion-box"><div class="ejecucion-grid">${especificaciones}</div></div>
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial de materia prima</h2>
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptConfirmarFinalizar()}</script>
  ${activa ? `<script>${scriptComandos(orden.IdOrden, maquinaCodigo, calidadFlags, pausaActiva)}</script><script>${scriptPesoEnVivo()}</script><script>${scriptResumenBultoActivo(orden.IdOrden, maquinaCodigo)}</script>` : ''}
</body>
</html>`;
}

// Tarjetas de bultos con su historial de paquetes (SEL_PesajeElemento) -- separada de
// renderBultosOrden para poder reusarla tal cual desde /bultos/fragmento (ver mas abajo), que le
// da al polling del cliente el mismo HTML sin reconstruir la pagina entera. El historial de
// paquetes va dentro de un <details> (desplegable al hacer click en el bulto, colapsado por
// defecto) porque con muchos paquetes la tarjeta se volvia demasiado larga.
function renderTarjetasBultos(bultos, pesajesPorBulto) {
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
        <div><span class="label">Potencia (W)</span><span class="valor">${b.Potencia ?? '—'}</span></div>
        <div><span class="label">Hora</span><span class="valor">${b.Hora ?? '—'}</span></div>
        <div class="full"><span class="label">Serial</span><span class="valor serial">${b.serialPadre ?? '—'}</span></div>
      </div>
      <details class="pesajes-box" data-bulto="${b.id}">
        <summary>Paquetes pesados (${pesajes.length})</summary>
        ${filasPesajes}
      </details>
    </div>`;
  }).join('');

  return bultos.length
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">Esta orden todavía no tiene bultos.</div>`;
}

// Script del cliente para /bultos: pide el fragmento renderizado con renderTarjetasBultos cada
// pocos segundos y reemplaza el contenedor -- asi el numero de paquetes pesados se ve actualizado
// sin que el operario tenga que recargar la pagina a mano (a pedido del usuario, 24/08/2026: en
// pruebas el conteo no se actualizaba solo). Guarda que bultos tenian el desplegable abierto antes
// de reemplazar el HTML y se lo vuelve a abrir despues, para no cerrarlo en cada actualizacion.
function scriptActualizarBultos() {
  return `
    (function() {
      var contenedor = document.getElementById('contenedor-bultos');
      if (!contenedor) return;

      async function actualizar() {
        try {
          const resp = await fetch(location.pathname + '/fragmento');
          if (!resp.ok) return;
          const html = await resp.text();
          const abiertos = new Set(
            Array.from(contenedor.querySelectorAll('details[open]')).map(function(d) { return d.dataset.bulto; })
          );
          contenedor.innerHTML = html;
          contenedor.querySelectorAll('details').forEach(function(d) {
            if (abiertos.has(d.dataset.bulto)) d.open = true;
          });
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }
      setInterval(actualizar, 4000);
    })();
  `;
}

// Bultos producidos de una orden puntual, con indice relativo (no el num_bulto crudo -- mismo
// criterio que EjecucionSelladora.vb:CargarBultos) y los pesajes/paquetes de cada uno
// (SEL_PesajeElemento, igual que CargarPesajes). Separada de renderOrdenDetalle -- ver comentario
// ahi arriba.
function renderBultosOrden(orden, bultos, pesajesPorBulto, usuario, maquinaCodigo) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bultos — Pedido ${orden.NumeroPedido || orden.IdOrden}</title>
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
      <a class="volver" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}">‹ Pedido ${orden.NumeroPedido || '—'}</a>
      <h1>📦 Bultos</h1>
      <div class="sub">${orden.Elemento}</div>
    </div>
  </header>
  <main>
    <div id="contenedor-bultos">${renderTarjetasBultos(bultos, pesajesPorBulto)}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptActualizarBultos()}</script>
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
      // FIX 31/08/2026 (a pedido del usuario): si este operario tenia alguna ejecucion Activa a su
      // nombre, queda "PendienteOperador" al cerrar sesion -- nadie la esta operando hasta que
      // alguien la retome. Solo toca SEL_EjecucionOrden.Estado, NO SEL_OrdenProduccion.Estado (esa
      // sigue en 'Activa' -- si se tocara, la orden desaparecería del dashboard/cola de la maquina,
      // que solo filtra por 'Activa'/'Pendiente'/'PendienteValidacion').
      if (usuario.codigoOperarioPRD) {
        await p.request().input('operario', usuario.codigoOperarioPRD).query(
          `UPDATE SEL_EjecucionOrden SET Estado = 'PendienteOperador' WHERE Operario = @operario AND Estado = 'Activa'`
        );
      }
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
  // El administrador nunca se auto-redirige a la maquina fija -- es el unico que puede entrar a
  // /admin/tablet-fija a cambiarla o quitarla, y para eso necesita ver el dashboard normal primero
  // (a pedido del usuario, 30/08/2026).
  const esAdmin = req.session.usuario.codigo === ADMIN_CODIGO;
  if (!esAdmin) {
    const maquinaFija = await resolverMaquinaFija(req);
    if (maquinaFija) return res.redirect('/selladora/' + encodeURIComponent(maquinaFija));
  }
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
    res.send(renderDashboard(result.recordset, req.session.usuario.nombre, null, esAdmin));
  } catch (err) {
    res.status(500).send(renderDashboard([], req.session.usuario.nombre, err.message, esAdmin));
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
    // (boton "Informacion" de cada fila) -- esta pagina es solo la lista. FIX 31/08/2026: se agrega
    // ej.Estado (EstadoEjecucion) -- una orden con ord.Estado='Activa' puede tener su ejecucion en
    // 'PendienteOperador' (ver /logout), y esta lista es donde se ofrece "Tomar control de la
    // ejecucion" para esas -- filtrar solo por ord.Estado no alcanza para distinguir ese caso. Se
    // trae tambien el operario/nombre que la dejo pendiente, para mostrarlo y para distinguir si
    // quien esta mirando ahora es el mismo (en ese caso el boton dice "Reanudar", no "Tomar control").
    const colaResult = await p.request().input('codigo', codigo).query(`
      SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
             ej.Estado AS EstadoEjecucion, ej.Operario AS OperarioEjecucionCodigo, op.Nombre AS OperarioEjecucionNombre
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      LEFT JOIN SEL_EjecucionOrden ej ON ej.IdOrden = ord.IdOrden
      LEFT JOIN PRDOperarios op ON op.Codigo = ej.Operario
      WHERE ord.Maquina = @codigo AND ord.Estado IN ('Activa','Pendiente','PendienteValidacion')
      ORDER BY CASE ord.Estado WHEN 'Activa' THEN 0 WHEN 'Pendiente' THEN 1 ELSE 2 END ASC,
               ISNULL(ord.Prioridad, 99999) ASC, ord.IdOrden ASC
    `);

    // FIX 31/08/2026: ?preguntarActividad=<idOrden> lo agrega el redirect de tomar-control-ejecucion
    // cuando la ejecucion retomada quedo Activa -- dispara la pregunta "¿va a hacer alguna actividad
    // antes de producir?" (preguntarActividadInicial, ver scriptPreguntaActividadInicial) apenas
    // carga la pagina. Se valida que sea un entero positivo antes de pasarlo al HTML.
    const idOrdenPreguntarActividad = /^\d+$/.test(req.query.preguntarActividad || '') ? Number(req.query.preguntarActividad) : null;

    res.send(renderPage(null, req.session.usuario.nombre, nombre, codigo, colaResult.recordset, req.session.usuario.codigoOperarioPRD, idOrdenPreguntarActividad));
  } catch (err) {
    res.status(500).send(renderPage(err.message, req.session.usuario.nombre, 'Selladora', codigo, [], req.session.usuario.codigoOperarioPRD, null));
  }
});

// Unico apartado para fijar/quitar la tablet -- restringido al administrador (requireAdmin).
// GET muestra el estado actual (si esta tablet -- por su cookie -- ya esta fija a alguna maquina)
// y un selector con todas las selladoras.
app.get('/admin/tablet-fija', requireLogin, requireAdmin, async (req, res) => {
  try {
    const p = await getPool();
    const maquinas = await p.request().query(
      `SELECT Codigo, Nombre FROM PRDMaquinas WHERE Tipo = 'SELLADORA' ORDER BY Nombre`
    );
    const codigoFija = await resolverMaquinaFija(req);
    const maquinaActual = codigoFija != null
      ? maquinas.recordset.find(m => String(m.Codigo) === String(codigoFija)) || { Codigo: codigoFija, Nombre: codigoFija }
      : null;
    res.send(renderTabletFija(req.session.usuario.nombre, maquinas.recordset, maquinaActual));
  } catch (err) {
    res.send(renderTabletFija(req.session.usuario.nombre, [], null, err.message));
  }
});

// Fija esta tablet a la maquina elegida -- genera un token opaco (UUID), lo guarda en
// SEL_TabletsFijas junto con la maquina, y la cookie (1 año) solo lleva ese token. Requiere haber
// corrido Source/Produccion/nueva produccion/agregar_tabletsfijas.sql (repo Mirane) contra la base
// primero.
app.post('/admin/tablet-fija', requireLogin, requireAdmin, async (req, res) => {
  const codigo = req.body.maquina;
  if (!codigo) return res.redirect('/admin/tablet-fija');
  try {
    const token = crypto.randomUUID();
    const p = await getPool();
    await p.request().input('token', token).input('maquina', codigo).query(
      `INSERT INTO SEL_TabletsFijas (Token, Maquina, FechaCreacion) VALUES (@token, @maquina, GETDATE())`
    );
    res.setHeader('Set-Cookie', `${COOKIE_MAQUINA_FIJA}=${encodeURIComponent(token)}; Max-Age=${60 * 60 * 24 * 365}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect('/admin/tablet-fija');
  } catch (err) {
    res.send(renderTabletFija(req.session.usuario.nombre, [], null, err.message));
  }
});

// Quita el vinculo -- borra la fila del token en SEL_TabletsFijas (ya no sirve para nada, no hace
// falta dejarla) y limpia la cookie.
app.post('/admin/tablet-fija/quitar', requireLogin, requireAdmin, async (req, res) => {
  const token = leerCookie(req, COOKIE_MAQUINA_FIJA);
  if (token) {
    try {
      const p = await getPool();
      await p.request().input('token', token).query(`DELETE FROM SEL_TabletsFijas WHERE Token = @token`);
    } catch (err) {
      // no bloquear -- si falla el DELETE, la fila queda huerfana en la tabla pero la cookie de
      // este navegador igual se limpia abajo y deja de usarse.
    }
  }
  res.setHeader('Set-Cookie', `${COOKIE_MAQUINA_FIJA}=; Max-Age=0; Path=/`);
  res.redirect('/admin/tablet-fija');
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
             maq.Nombre AS MaquinaNombre, maq.Tipo AS MaquinaTipo,
             ord.TipoSellado, ord.Troquelado, ord.UsoPrevisto, ord.Manija, ord.ManijaColor, ord.Tula,
             ord.TulaColor, ord.Parche, ord.CierreDeslizador, ord.Perforaciones,
             ord.CierreHermetico, ord.CintaAdhesiva,
             CASE WHEN er12.Valor IS NOT NULL THEN 1 ELSE 0 END AS TieneImpresion,
             ti.Descripcion AS TipoImpresionDescripcion
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      LEFT JOIN INVElementosReferencia er12 ON er12.Elemento = ord.Elemento AND er12.Categoria = 12
      LEFT JOIN INVElementosReferencia er13 ON er13.Elemento = ord.Elemento AND er13.Categoria = 13
      LEFT JOIN INVReferencia ti ON ti.Categoria = 13 AND ti.Codigo = er13.Valor
      WHERE ord.IdOrden = @idOrden
    `);
    if (ordenResult.recordset.length === 0) {
      return res.status(404).send(renderErrorSimple('Orden no encontrada.', `/selladora/${codigo}`));
    }
    const orden = ordenResult.recordset[0];

    // Pausa (SEL_TiempoMuerto/SEL_EjecucionOrden.Estado='En pausa') -- si la ejecucion de esta
    // orden esta pausada ahora mismo, se trae el motivo y la HoraInicio real (el cronometro del
    // cliente arranca desde ese valor, no desde que carga la pagina -- asi un refresh a mitad de
    // la pausa sigue mostrando el tiempo correcto en vez de reiniciar en 00:00:00).
    let idEjecucion = null;
    let pausaActiva = null;
    const dtEjecucion = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEjecucion.recordset.length > 0) {
      idEjecucion = dtEjecucion.recordset[0].IdEjecucion;
      if (dtEjecucion.recordset[0].Estado === 'En pausa') {
        const dtPausa = await p.request().input('idEjecucion', idEjecucion).query(
          `SELECT TOP 1 Tipo, Subtipo, Observaciones, HoraInicio FROM SEL_TiempoMuerto WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC`
        );
        if (dtPausa.recordset.length > 0) pausaActiva = dtPausa.recordset[0];
      }
    }

    // Los bultos producidos viven en su propia pagina (/selladora/:codigo/orden/:idOrden/bultos) --
    // aqui solo se necesita el conteo para el enlace, ver ese route para el detalle completo.
    const conteoBultos = await p.request().input('idOrden', idOrden).query(`
      SELECT COUNT(*) AS Total
      FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
    `);
    const totalBultos = conteoBultos.recordset[0].Total;

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

    res.send(renderOrdenDetalle(orden, totalBultos, historial, req.session.usuario.nombre, codigo, pausaActiva));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
  }
});

// Bultos (indice relativo) y sus pesajes/paquetes (SEL_PesajeElemento) de una orden -- compartida
// entre la pagina completa de /bultos y su /bultos/fragmento (el polling de scriptActualizarBultos
// pide solo el fragmento, para no reconstruir cabecera/estilos en cada actualizacion).
async function obtenerBultosYPesajes(p, idOrden) {
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

  return { bultos, pesajesPorBulto };
}

// Bultos producidos de una orden puntual -- separado de /selladora/:codigo/orden/:idOrden (que ya
// muestra relevo/peso/comandos/especificaciones/historial) porque con las columnas de
// especificaciones agregadas esa pagina ya tenia demasiada informacion para revisar bultos de
// paso; misma consulta de bultos/pesajes que antes vivia ahi.
app.get('/selladora/:codigo/orden/:idOrden/bultos', requireLogin, async (req, res) => {
  const { codigo, idOrden } = req.params;
  try {
    const p = await getPool();

    const ordenResult = await p.request().input('idOrden', idOrden).query(`
      SELECT ord.IdOrden, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
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

    const { bultos, pesajesPorBulto } = await obtenerBultosYPesajes(p, idOrden);

    res.send(renderBultosOrden(orden, bultos, pesajesPorBulto, req.session.usuario.nombre, codigo));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}/orden/${idOrden}`));
  }
});

// Fragmento HTML (solo las tarjetas, sin cabecera/estilos) que el polling del cliente en /bultos
// pide cada pocos segundos -- ver scriptActualizarBultos(). No devuelve pagina de error renderizada
// si falla: un 500 en texto plano es suficiente, el cliente simplemente descarta ese tick y reintenta.
app.get('/selladora/:codigo/orden/:idOrden/bultos/fragmento', requireLogin, async (req, res) => {
  const { idOrden } = req.params;
  try {
    const p = await getPool();
    const { bultos, pesajesPorBulto } = await obtenerBultosYPesajes(p, idOrden);
    res.send(renderTarjetasBultos(bultos, pesajesPorBulto));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Resumen del bulto Activo (paquetes pesados + peso acumulado) para la pagina de Informacion --
// a pedido del usuario (27/08/2026), en vivo via polling (ver scriptResumenBultoActivo()). Si la
// orden no tiene bulto Activo en este momento devuelve ceros, no un error (puede pasar entre que
// se cierra un bulto y se abre el siguiente).
app.get('/selladora/:codigo/orden/:idOrden/resumen-bulto-activo', requireLogin, async (req, res) => {
  const { idOrden } = req.params;
  try {
    const p = await getPool();
    const dtBultoActivo = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 b.id FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND b.estado = 'Activo'
      ORDER BY b.id DESC
    `);
    if (dtBultoActivo.recordset.length === 0) {
      return res.json({ ok: true, paquetes: 0, pesoTotalGr: 0 });
    }
    const idBulto = dtBultoActivo.recordset[0].id;
    const resumen = await p.request().input('idBulto', idBulto).query(`
      SELECT COUNT(*) AS Paquetes, ISNULL(SUM(PesoPaqueGr), 0) AS PesoTotalGr
      FROM SEL_PesajeElemento WHERE id_bulto = @idBulto
    `);
    res.json({ ok: true, paquetes: resumen.recordset[0].Paquetes, pesoTotalGr: Number(resumen.recordset[0].PesoTotalGr) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tomar control de la EJECUCION (SEL_EjecucionOrden) -- vive en la cola de ordenes de la maquina
// (renderColaOrdenes), no en Informacion (a pedido del usuario, 31/08/2026: el viejo boton "Tomar
// control" de Informacion, que solo tocaba SEL_OperarioActualMaquina, se elimino -- esta ruta
// ahora hace las dos cosas: retoma la ejecucion (SEL_EjecucionOrden.Operario/Estado) Y registra al
// operario actual de la maquina (SEL_OperarioActualMaquina, ver agregar_operarioactualmaquina.sql
// -- lo consulta trg_SEL_Bultos_CierreBulto para cada bulto nuevo que la maquina cree sola).
//
// FIX 01/09/2026: ya NO exige Estado='PendienteOperador' -- ese flag solo se pone si el operario
// anterior cerro sesion con el boton Salir; si el servidor se reinicia a mitad de turno, las
// sesiones se pierden pero esa fila nunca se marca. El chequeo real es simplemente "el Operario de
// la ejecucion es distinto al que esta pidiendo esto ahora", igual que en renderColaOrdenes. Si la
// ejecucion esta 'En pausa', el Estado NO se fuerza a 'Activa' -- solo se reasigna el Operario, la
// pausa sigue su curso normal (Reanudar) desde Informacion.
app.post('/api/selladora/orden/:idOrden/tomar-control-ejecucion', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const miOperario = req.session.usuario.codigoOperarioPRD;
  if (!miOperario || miOperario <= 0) {
    return res.status(400).send(renderErrorSimple('Su usuario no tiene un operario de planta asignado.', '/'));
  }
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado, Operario, Maquina FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEj.recordset.length === 0) {
      return res.status(404).send(renderErrorSimple('No se encontró la ejecución de esta orden.', '/'));
    }
    const { IdEjecucion, Estado, Operario, Maquina } = dtEj.recordset[0];
    // Mismo OR que renderColaOrdenes -- el flag 'PendienteOperador' cubre el logout explicito
    // (incluso si el operario coincide, sigue habiendo algo que confirmar: pasarla de vuelta a
    // Activa) y la comparacion de Operario cubre el reinicio del servidor sin logout.
    const hayAlgoQueTomar = Estado === 'PendienteOperador' || Operario !== miOperario;
    if (!hayAlgoQueTomar) {
      // Alguien mas se adelanto (o ya no aplica) -- no es un error, simplemente ya no hay nada que
      // tomar. Se vuelve a la cola de la maquina, que ya no deberia mostrar este boton.
      return res.redirect(`/selladora/${Maquina}`);
    }
    await p.request().input('idEjecucion', IdEjecucion).input('operario', miOperario).query(`
      UPDATE SEL_EjecucionOrden SET Operario = @operario, Estado = CASE WHEN Estado = 'En pausa' THEN Estado ELSE 'Activa' END
      WHERE IdEjecucion = @idEjecucion
    `);
    await p.request().input('maquina', Maquina).input('operario', miOperario).query(`
      MERGE SEL_OperarioActualMaquina AS destino
      USING (SELECT @maquina AS Maquina) AS origen ON destino.Maquina = origen.Maquina
      WHEN MATCHED THEN UPDATE SET Operario = @operario, FechaHora = GETDATE()
      WHEN NOT MATCHED THEN INSERT (Maquina, Operario, FechaHora) VALUES (@maquina, @operario, GETDATE());
    `);
    // FIX 31/08/2026: si la ejecucion NO estaba 'En pausa' (o sea, con este cambio quedo 'Activa' --
    // ver el CASE de arriba), se pregunta en la cola de la maquina si hay alguna actividad por hacer
    // antes de producir o si entra directo (a pedido del usuario). Si ya estaba 'En pausa', no se
    // pregunta -- el cronometro de esa pausa ya la cubre, se veria al entrar a Informacion.
    const destino = Estado === 'En pausa' ? `/selladora/${Maquina}` : `/selladora/${Maquina}?preguntarActividad=${idOrden}`;
    res.redirect(destino);
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, '/'));
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
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>
    const idOrden = ${JSON.stringify(idOrden)};
    const esNuevoRollo = ${nuevo ? 'true' : 'false'};
    const bolsasActual = ${Number(bolsasActual) || 0};
    // Al Iniciar (no al +Rollo), termine con actividad o directo a produccion, se entra a
    // Informacion de la orden -- no a la cola de la maquina (a pedido del usuario, 31/08/2026).
    const destinoTrasIniciar = ${JSON.stringify(`/selladora/${maquinaCodigo}/orden/${idOrden}`)};
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
        }).then(() => {
          // Al Iniciar (primer rollo, no al +Rollo de mitad de produccion) se pregunta si hay
          // alguna actividad de las que se registran como pausa por hacer antes de producir (a
          // pedido del usuario, 31/08/2026) -- ver scriptPreguntaActividadInicial().
          if (esNuevoRollo) { window.location.href = datos.redirect; }
          else { preguntarActividadInicial(idOrden, function() { window.location.href = destinoTrasIniciar; }); }
        });
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

// Botones "Imprimir etiqueta" / "Cierre bulto" / "Retal" / "Troquelado" / "Refilado" / "Calidad" /
// "Salida no conforme" de la pagina de Informacion (solo visibles con la orden Activa, ver
// renderOrdenDetalle) -- reenvia el comando a Node-RED via enviarComandoANodeRed(). El
// idOrden/maquinaCodigo vienen del propio navegador (ya los tiene la pagina renderizada), no se
// vuelven a consultar en BD: esto solo dispara la accion en Node-RED, no toca la BD directamente.
// `datos` es opcional -- lo usa 'calidad' para mandar las respuestas (Conforme/No conforme) del
// formulario, ver abrirCalidad() en scriptComandos(). FIX 26/08/2026: los comandos de residuo van
// sin prefijo ('retal'/'troquelado'/'refilado', no 'residuo:retal').
const COMANDOS_VALIDOS = new Set([
  'imprimir_etiqueta', 'cierre_bulto', 'retal', 'troquelado', 'refilado', 'calidad', 'no_conforme'
]);

// Pausa (SEL_TiempoMuerto) -- a diferencia de los comandos de arriba, esto SI escribe directo en
// esta BD (no pasa por Node-RED): es un simple cambio de estado + una fila de auditoria, no toca
// inventario/numeracion como Retal/Troquelado, asi que no hacia falta migrarlo. "SEL_EjecucionOrden
// debe quedar UN solo registro por orden" (mismo criterio que scan-rollo.js) -- se busca por
// IdOrden, no hay que resolver bulto activo para esto.
const MOTIVOS_PAUSA_VALIDOS = new Set(['descanso', 'mantenimiento', 'alistamiento', 'limpieza', 'otro']);
const SUBMOTIVOS_ALISTAMIENTO_VALIDOS = new Set(['materiales', 'mecanico', 'espacio_trabajo']);

app.post('/api/selladora/orden/:idOrden/pausar', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const { tipo, subtipo, observaciones } = req.body;
  if (!MOTIVOS_PAUSA_VALIDOS.has(tipo)) {
    return res.json({ ok: false, error: 'Motivo de pausa inválido.' });
  }
  if (tipo === 'alistamiento' && !SUBMOTIVOS_ALISTAMIENTO_VALIDOS.has(subtipo)) {
    return res.json({ ok: false, error: 'Seleccione el motivo de alistamiento.' });
  }
  if (tipo === 'otro' && !(observaciones && observaciones.trim())) {
    return res.json({ ok: false, error: 'Describa el motivo.' });
  }
  const operario = req.session.usuario.codigoOperarioPRD;
  if (!operario) {
    return res.json({ ok: false, error: 'Su usuario no tiene un operario de planta configurado.' });
  }
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    const { IdEjecucion, Estado } = dtEj.recordset[0];
    if (Estado === 'En pausa') {
      return res.json({ ok: false, error: 'Esta orden ya está en pausa.' });
    }

    const horaInicio = new Date();
    await p.request()
      .input('idEjecucion', IdEjecucion).input('operario', operario).input('tipo', tipo)
      .input('subtipo', tipo === 'alistamiento' ? subtipo : null)
      .input('horaInicio', horaInicio).input('observaciones', observaciones ? observaciones.trim() : null)
      .query(`
        INSERT INTO SEL_TiempoMuerto (id_ejecucion, Operario, Tipo, Subtipo, HoraInicio, Observaciones)
        VALUES (@idEjecucion, @operario, @tipo, @subtipo, @horaInicio, @observaciones)
      `);
    await p.request().input('idEjecucion', IdEjecucion).query(
      `UPDATE SEL_EjecucionOrden SET Estado = 'En pausa' WHERE IdEjecucion = @idEjecucion`
    );

    res.json({ ok: true, horaInicio: horaInicio.toISOString() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Cierra la fila abierta de SEL_TiempoMuerto (HoraFin + DuracionMinutos) y devuelve la ejecucion a
// 'Activa'. Si por algun motivo hay mas de una fila abierta (no deberia pasar, ver el chequeo de
// Estado en /pausar de arriba), cierra todas -- mejor eso que dejar una huerfana sin HoraFin.
app.post('/api/selladora/orden/:idOrden/reanudar', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    const { IdEjecucion, Estado } = dtEj.recordset[0];
    if (Estado !== 'En pausa') {
      return res.json({ ok: false, error: 'Esta orden no está en pausa.' });
    }

    // DuracionMinutos es una columna CALCULADA (AS DATEDIFF(MINUTE, HoraInicio, HoraFin) PERSISTED)
    // -- SQL Server la resuelve sola en cuanto se guarda HoraFin, no se puede asignar a mano
    // (por eso el error "cannot be modified because it is either a computed column...").
    await p.request().input('idEjecucion', IdEjecucion).query(`
      UPDATE SEL_TiempoMuerto SET HoraFin = GETDATE()
      WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL
    `);
    await p.request().input('idEjecucion', IdEjecucion).query(
      `UPDATE SEL_EjecucionOrden SET Estado = 'Activa' WHERE IdEjecucion = @idEjecucion`
    );

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/comando', requireLogin, async (req, res) => {
  const { comando, idOrden, maquinaCodigo, datos } = req.body;
  if (!COMANDOS_VALIDOS.has(comando)) {
    return res.status(400).json({ ok: false, error: 'Comando inválido.' });
  }
  try {
    await enviarComandoANodeRed({
      comando,
      idOrden: Number(idOrden),
      maquinaCodigo,
      usuario: req.session.usuario.codigo,
      datos: datos || null
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'No se pudo contactar a Node-RED: ' + err.message });
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
const server = http.createServer(app);
const wssPeso = new WebSocket.Server({ server, path: '/ws/peso' });
wssPeso.on('connection', (cliente) => {
  if (ultimoPeso != null) cliente.send(ultimoPeso);
});

server.listen(webPort, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${webPort} (y en la IP de este PC en la red local)`);
  conectarNodeRed();
});
