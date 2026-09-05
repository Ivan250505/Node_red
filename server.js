require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');
const { validarLogin, requireLogin, requireAdmin, ADMIN_CODIGO } = require('./auth');
const { registrarEvento } = require('./accesos');
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

// Formatea una fecha/hora de la BD (mssql devuelve DATETIME como objeto Date de JS) para mostrar en
// el HTML -- ej. "01/09/2026 14:32". Usado en la cola de ordenes para mostrar cuando se finalizo una
// orden (SEL_EjecucionOrden.HoraFinReal, ver renderColaOrdenes), a pedido del usuario (01/09/2026).
function formatearFechaHora(fecha) {
  if (!fecha) return '';
  return new Date(fecha).toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  });
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
      position: relative; overflow: hidden;
    }
    /* Misma trama de puntos del encabezado (ver estilosBase): el fondo del login es el mismo
    degradado azul, asi que lleva la misma textura en el mismo sentido (135deg). */
    body::before, body::after {
      content: ""; position: fixed; inset: 0; pointer-events: none;
      background-size: 11px 11px;
      background-position: 0 0, 5.5px 5.5px;
    }
    body::before {
      background-image:
        radial-gradient(circle at center, rgba(255,255,255,0.16) 0.7px, transparent 1.2px),
        radial-gradient(circle at center, rgba(255,255,255,0.16) 0.7px, transparent 1.2px);
      -webkit-mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
              mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
    }
    body::after {
      background-image:
        radial-gradient(circle at center, rgba(255,255,255,0.24) 1.7px, transparent 2.2px),
        radial-gradient(circle at center, rgba(255,255,255,0.24) 1.7px, transparent 2.2px);
      -webkit-mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
              mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
    }
    .caja {
      background: white; border-radius: 16px; padding: 32px 28px; width: 100%; max-width: 340px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25);
      position: relative; z-index: 1;
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
  </div>
  <script src="/sweetalert2.min.js"></script>
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'No se pudo ingresar', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
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
      --verde-logo: #76c04e; /* muestreado directo de "plast" en public/logo-carlixplast.png, 02/09/2026 */
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
      /* El verde plano se cambio por un degradado en 135deg -- el mismo sentido del encabezado --
      para que el cuerpo no se vea de un solo color (a pedido del usuario, 04/09/2026). */
      background: linear-gradient(135deg, #d9efcc 0%, var(--verde-fondo-suave) 55%, #b6dfa3 100%);
      background-attachment: fixed;
      color: var(--texto);
      position: relative;
    }
    /* La misma trama de puntos del encabezado, ahora en verde sobre el fondo del cuerpo: dos
    rejillas al tresbolillo de 11px recortadas con mask-image en 135deg (::before puntos finos que
    se apagan, ::after puntos mayores que aparecen). Van en position: fixed para que la textura no
    se corte ni se mueva al hacer scroll, y con z-index 0 -- header y main se elevan a z-index 1
    para quedar por encima. Misma construccion que header::before/::after, ver el comentario de
    header. */
    body::before, body::after {
      content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background-size: 11px 11px;
      background-position: 0 0, 5.5px 5.5px;
    }
    body::before {
      background-image:
        radial-gradient(circle at center, rgba(74,156,46,0.10) 0.7px, transparent 1.2px),
        radial-gradient(circle at center, rgba(74,156,46,0.10) 0.7px, transparent 1.2px);
      -webkit-mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
              mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
    }
    body::after {
      background-image:
        radial-gradient(circle at center, rgba(74,156,46,0.16) 1.7px, transparent 2.2px),
        radial-gradient(circle at center, rgba(74,156,46,0.16) 1.7px, transparent 2.2px);
      -webkit-mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
              mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
    }
    header {
      background: linear-gradient(135deg, var(--azul), var(--azul-osc));
      color: white;
      padding: 18px 20px 22px;
      position: relative;
      z-index: 1;
      overflow: hidden;
    }
    /* Trama de puntos (halftone) DENTRO del encabezado, para que no se vea tan plano: dos rejillas
    al tresbolillo -- ::before son puntos finos que se apagan, ::after son puntos algo mayores que
    aparecen -- recortadas cada una con mask-image en 135deg, el MISMO sentido del degradado azul
    del header. Va aca en estilosBase() y no en una pagina suelta para que salga igual en todas las
    pestanas (a pedido del usuario, 04/09/2026). Se hace con mask y no con una capa por fila de
    puntos porque asi la diagonal es real y se adapta sola al ancho de cualquier tableta (las
    paradas del mask van en %). header > * queda position: relative para que el contenido pinte por
    encima de las dos capas. Diseno acordado (opcion B):
    https://claude.ai/code/artifact/9bf9ae83-f817-4830-bc10-9afca04e83d2 */
    header::before, header::after {
      content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
      background-size: 11px 11px;
      background-position: 0 0, 5.5px 5.5px;
    }
    header::before {
      background-image:
        radial-gradient(circle at center, rgba(255,255,255,0.16) 0.7px, transparent 1.2px),
        radial-gradient(circle at center, rgba(255,255,255,0.16) 0.7px, transparent 1.2px);
      -webkit-mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
              mask-image: linear-gradient(135deg, #000 0%, transparent 65%);
    }
    header::after {
      background-image:
        radial-gradient(circle at center, rgba(255,255,255,0.24) 1.7px, transparent 2.2px),
        radial-gradient(circle at center, rgba(255,255,255,0.24) 1.7px, transparent 2.2px);
      -webkit-mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
              mask-image: linear-gradient(135deg, transparent 35%, #000 100%);
    }
    header > * { position: relative; z-index: 1; }
    header h1 { margin: 0 0 4px; font-size: 20px; }
    header .sub { font-size: 13px; opacity: 0.85; }
    header a.volver {
      color: white; background: var(--verde-logo); font-size: 16px; font-weight: 600;
      text-decoration: none; display: inline-block; padding: 8px 14px; border-radius: 8px; margin-bottom: 8px;
    }
    .header-top { text-align: center; }
    .header-inner { max-width: 960px; margin: 0 auto; }
    .logo-wrap {
      background: white; display: inline-block; padding: 10px 22px;
      border-radius: 12px; margin-bottom: 14px;
    }
    .logo { height: 40px; display: block; }
    .logo-login { height: 40px; display: block; margin: 0 auto 12px; }
    /* Encabezado -- fila de 3 partes, usada en TODAS las paginas con header (Dashboard,
    Programacion maquina, Informacion, Bultos -- a pedido del usuario, 04/09/2026, extendido desde
    Informacion donde se probo primero el 03/09/2026): header-info (titulo/referencia/volver,
    apiladas -- "Volver" debajo del titulo y la referencia) a la izquierda, la tarjeta de Avance de
    produccion en medio (solo existe en Informacion; en las demas paginas esa columna queda vacia),
    header-salir-grupo (usuario, con Cerrar sesion debajo) a la derecha, las 3 centradas
    verticalmente entre si. Es un grid de 3 columnas simetricas (1fr / auto / 1fr) y no flex, para
    que la tarjeta del medio quede centrada de verdad respecto a todo el ancho de la fila, sin
    importar que tan ancho sea lo que tiene a cada lado. header-salir-grupo se fija en la columna 3
    a proposito: en Informacion, cuando la orden no tiene meta configurada la tarjeta del medio no
    se renderiza, y sin eso el grupo se correria al centro (mismo motivo por el que las paginas sin
    ninguna tarjeta del medio tambien necesitan fijarlo en columna 3). Ver diseno acordado:
    https://claude.ai/code/artifact/17eae4be-abd7-4742-a5bf-c6d87970f2d7 */
    .header-fila { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; }
    .header-info { justify-self: start; min-width: 0; }
    .header-fila .volver { margin-top: 8px; margin-bottom: 0; }
    .header-salir-grupo { justify-self: end; grid-column: 3; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .header-salir-grupo .header-usuario { font-size: 12px; opacity: 0.9; }
    .avance-header-card {
      background: white; border-radius: 12px; padding: 10px 14px; justify-self: center; width: 260px; max-width: 100%;
      box-shadow: 0 1px 4px rgba(0,0,0,0.15); color: var(--texto);
    }
    .avance-header-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .avance-header-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--texto-suave); font-weight: 600; }
    .avance-header-porcentaje { font-size: 20px; font-weight: 700; }
    .avance-header-barra { height: 8px; border-radius: 999px; background: #eef0f2; overflow: hidden; margin-bottom: 6px; }
    .avance-header-relleno { height: 100%; border-radius: 999px; }
    .avance-header-stats { display: flex; justify-content: space-between; font-size: 12px; color: var(--texto-suave); font-weight: 600; }
    main { max-width: 960px; margin: 0 auto; padding: 16px 14px 30px; position: relative; z-index: 1; }
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
    a.salir {
      color: white;
      background: #c0392b;
      padding: 5px 12px;
      border-radius: 8px;
      font-weight: 600;
      text-decoration: none;
      flex-shrink: 0;
    }
    a.salir:active { background: #a53125; }
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
    .islas-fila { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
    .isla {
      background: white; border-radius: 14px; padding: 14px 16px; flex: 1 1 220px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .isla .label { margin-bottom: 8px; }
    .isla .orden-acciones { display: flex; gap: 8px; flex-wrap: wrap; }
    .isla .orden-acciones form { width: auto; }
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
      display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px;
      padding: 4px 0; color: var(--texto-suave);
    }
    .pesaje-vacio { font-size: 13px; color: var(--texto-suave); }
    .link-reimprimir {
      color: #00a2cb; text-decoration: underline; font-size: 13px; flex-shrink: 0; cursor: pointer;
    }
    .link-reimprimir.deshabilitado { pointer-events: none; opacity: 0.5; }
    .pesajes-nav {
      display: flex; align-items: center; justify-content: center; gap: 14px;
      margin-top: 8px; padding-top: 8px; border-top: 1px solid #eef0f2;
    }
    .btn-pesajes-nav {
      width: 48px; height: 48px; border-radius: 999px; border: 1px solid #d0d7de; background: white;
      font-size: 22px; font-weight: 700; color: var(--azul-osc); cursor: pointer; line-height: 1;
      padding: 0; flex-shrink: 0;
    }
    .btn-pesajes-nav:disabled { opacity: 0.35; cursor: not-allowed; }
    .pesajes-nav-indicador { font-size: 12px; color: var(--texto-suave); font-weight: 600; min-width: 46px; text-align: center; }
    .residuos-bulto { margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef0f2; }
    .residuo-bulto-fila { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0; }
    .residuo-bulto-badge {
      font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; color: white; background: var(--texto-suave);
    }
    .residuo-bulto-badge-alerta { background: #c00000; }
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
      .header-fila { grid-template-columns: 1fr; justify-items: stretch; }
      .header-info, .avance-header-card, .header-salir-grupo { justify-self: stretch; width: auto; grid-column: 1; }
      .header-salir-grupo { align-items: stretch; }
      .header-salir-grupo .header-usuario { text-align: center; }
      .header-salir-grupo a.salir { text-align: center; }
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
      <div class="header-fila">
        <div class="header-info">
          <div class="sub">Máquinas con producción activa en este momento</div>
          ${esAdmin ? `<a class="volver" href="/admin/tablet-fija">📌 Tablet fija a máquina</a>` : ''}
        </div>
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${usuario}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
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
    let infoFinalizada = '';
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
      acciones += `<button type="button" class="btn-accion btn-iniciar" onclick="abrirEscaneoRollo(${o.IdOrden}, false)">▶ Iniciar</button>`;
    } else if (o.Estado === 'Activa') {
      acciones += `
        <button type="button" class="btn-accion btn-anadir" onclick="abrirEscaneoRollo(${o.IdOrden}, true)">+ Rollo</button>
        <form method="post" action="/api/selladora/orden/${o.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
          <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
        </form>`;
    } else {
      acciones += `<span class="label">Esperando validación del digitador</span>`;
      // FIX 01/09/2026: se muestra la hora en la que se finalizo (SEL_EjecucionOrden.HoraFinReal,
      // la pone finalizarOrden() al dar "Finalizar") -- a pedido del usuario, para saber desde
      // cuando esta orden quedo esperando validacion, no solo que esta esperando. Debajo de la
      // referencia del pedido (orden-elemento), no pegado al texto de estado -- quedaba mal ahi.
      const horaFin = formatearFechaHora(o.HoraFinReal);
      if (horaFin) infoFinalizada = `<div class="orden-elemento">Finalizada: ${horaFin}</div>`;
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
          ${infoFinalizada}
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
// muestra tal cual, sin convertir. Es el mismo valor en kg que Node-RED guarda despues en
// SEL_PesajeElemento.PesoPaqueGr (columna mal nombrada, ver FIX 02/09/2026 mas abajo).
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

// Tarjeta de Avance de produccion del encabezado (ver obtenerAvanceProduccion) -- el servidor ya
// renderiza el valor inicial, esto solo lo refresca cada 4s pidiendo /avance-produccion, porque
// sube a medida que se van registrando paquetes nuevos (a pedido del usuario, 02/09/2026). Por eso
// el primer tick es a los 4s y no de una.
function scriptAvanceProduccion(idOrden, maquinaCodigo) {
  return `
    (function() {
      var elPorcentaje = document.getElementById('avance-porcentaje');
      var elRelleno = document.getElementById('avance-relleno');
      var elProducido = document.getElementById('avance-producido');
      var elProgramado = document.getElementById('avance-programado');
      if (!elPorcentaje || !elRelleno) return;

      function formatearCantidad(valor, tipo) {
        if (tipo === 'kg') return valor.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kg';
        return Math.round(valor).toLocaleString('es-CO') + ' uds';
      }

      async function actualizar() {
        try {
          const resp = await fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/orden/' + ${JSON.stringify(idOrden)} + '/avance-produccion');
          if (!resp.ok) return;
          const datos = await resp.json();
          if (!datos.ok || !datos.tipo) return;
          var color = datos.porcentaje >= 100 ? '#4a9c2e' : '#006984';
          elPorcentaje.textContent = datos.porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 }) + '%';
          elPorcentaje.style.color = color;
          elRelleno.style.width = Math.min(datos.porcentaje, 100) + '%';
          elRelleno.style.background = color;
          if (elProducido) elProducido.textContent = 'Producido: ' + formatearCantidad(datos.producido, datos.tipo);
          if (elProgramado) elProgramado.textContent = 'Programado: ' + formatearCantidad(datos.programado, datos.tipo);
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }
      setInterval(actualizar, 4000);
    })();
  `;
}

// Resumen del bulto Activo (paquetes pesados + peso acumulado) -- a pedido del usuario
// (27/08/2026), se actualiza solo cada 4s pidiendo /resumen-bulto-activo (no viene por el
// websocket de peso: ese es la lectura instantanea de la bascula, esto es la suma acumulada de
// los paquetes ya registrados en SEL_PesajeElemento para el bulto Activo).
// FIX 02/09/2026: SEL_PesajeElemento.PesoPaqueGr se llama "Gr" pero guarda KILOGRAMOS -- Node-RED
// inserta ahi el peso tal como sale de la bascula, que emite en kg (ej. 0.497 = 497 g). Antes esto
// se dividia entre 1000 asumiendo gramos, y el acumulado siempre terminaba mostrando "0,00". El
// nombre de la columna no se puede cambiar (la usan tambien Node-RED y el escritorio), pero aca
// dentro se maneja como kg y el campo del endpoint se llama pesoTotalKg para que no vuelva a
// confundirse.
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
          elPeso.textContent = datos.pesoTotalKg.toFixed(2);
          // Se guarda en window (no en una var local del IIFE) para que confirmarPesoYEnviar, que
          // vive en otro <script> (scriptComandos), pueda leer cual es el bulto Activo ahora mismo
          // al marcar un residuo/salida no conforme (01/09/2026, a pedido del usuario).
          window.idBultoActivo = datos.idBulto;
          // Mismo mecanismo para el ultimo paquete pesado -- lo usa confirmarCerrarBultoYReimprimir
          // (scriptComandos) para reimprimir su etiqueta al confirmar "Cierre bulto" (02/09/2026).
          window.ultimoPaqueteBultoActivo = (datos.ultimoConsecutivo != null)
            ? { consecutivo: datos.ultimoConsecutivo, pesoKg: datos.ultimoPesoKg }
            : null;
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }
      actualizar();
      setInterval(actualizar, 4000);
    })();
  `;
}

// Cola de ordenes de la maquina (renderPage/"Programacion máquina") -- se refresca sola cada 4s
// pidiendo el fragmento ya renderizado (/selladora/:codigo/cola-fragmento, ver obtenerColaOrdenes)
// y reemplazando el innerHTML del contenedor, en vez de depender de un boton "Actualizar" manual (a
// pedido del usuario, 01/09/2026). El contenido inicial ya viene renderizado por el servidor en la
// carga de la pagina, por eso el primer tick es a los 4s (no de una, a diferencia de
// scriptResumenBultoActivo que arranca con placeholders "—").
function scriptActualizarCola(maquinaCodigo) {
  return `
    (function() {
      var contenedor = document.getElementById('cola-ordenes');
      var elActualizado = document.getElementById('cola-actualizado');
      if (!contenedor) return;

      async function actualizar() {
        try {
          const resp = await fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/cola-fragmento');
          if (!resp.ok) return;
          const html = await resp.text();
          contenedor.innerHTML = html;
          if (elActualizado) elActualizado.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-CO');
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }
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

// Guarda el chequeo de Calidad ya respondido en SEL_ChequeoCalidad (cabecera) +
// SEL_ChequeoCalidadDetalle (una fila por pregunta) -- a pedido del usuario (03/09/2026), las
// tablas ya existian de una conversacion anterior sobre el diseno. Llamada desde POST /api/comando
// cuando comando==='calidad'. Reconstruye el mismo Apartado por clave que uso el modal
// (construirApartadosCalidad) en vez de depender de que el cliente lo mande -- asi no hay riesgo de
// que un cliente desactualizado guarde un Apartado distinto al que el CHECK de Pregunta espera.
// 'conforme'/'no_conforme' (los value= de los checkboxes, ver abrirCalidad en scriptComandos) se
// traducen a 'Conforme'/'NoConforme' -- CK_SEL_ChequeoCalidadDetalle_Respuesta exige exactamente
// esos dos valores. Errores no revientan el comando ya enviado a Node-RED -- se registran en
// consola nada mas (ver el catch en el llamador).
async function registrarChequeoCalidad(p, { idOrden, operarioCodigo, respuestas }) {
  const dtOrden = await p.request().input('idOrden', idOrden).query(`
    SELECT ord.Troquelado, ord.Perforaciones, ord.Manija, ord.Tula, ord.Parche, ord.CierreDeslizador,
           ord.CierreHermetico, ord.CintaAdhesiva,
           CASE WHEN er12.Valor IS NOT NULL THEN 1 ELSE 0 END AS TieneImpresion
    FROM SEL_OrdenProduccion ord
    LEFT JOIN INVElementosReferencia er12 ON er12.Elemento = ord.Elemento AND er12.Categoria = 12
    WHERE ord.IdOrden = @idOrden
  `);
  if (dtOrden.recordset.length === 0) return;
  const o = dtOrden.recordset[0];
  const calidadFlags = {
    tieneImpresion: o.TieneImpresion === 1,
    tieneAccesorios: ['Manija', 'Tula', 'Parche', 'CierreDeslizador', 'CierreHermetico', 'CintaAdhesiva']
      .some(campo => o[campo] === 'Sí'),
    tieneTroquelado: !!o.Troquelado && o.Troquelado !== 'SinTroquelado',
    tienePerforaciones: o.Perforaciones != null && Number(o.Perforaciones) !== 0
  };
  const claveApartado = new Map();
  construirApartadosCalidad(calidadFlags).forEach(ap => ap.preguntas.forEach(preg => claveApartado.set(preg.clave, ap.titulo)));

  const dtEjecucion = await p.request().input('idOrden', idOrden).query(
    `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
  );
  if (dtEjecucion.recordset.length === 0) return;
  const idEjecucion = dtEjecucion.recordset[0].IdEjecucion;

  // Bulto Activo en este momento -- mismo criterio que /resumen-bulto-activo. Puede no haber
  // ninguno (entre que se cierra un bulto y se abre el siguiente); id_bulto es nullable.
  const dtBulto = await p.request().input('idEjecucion', idEjecucion).query(
    `SELECT TOP 1 id FROM SEL_Bultos WHERE id_ejecucion = @idEjecucion AND estado = 'Activo' ORDER BY id DESC`
  );
  const idBulto = dtBulto.recordset.length > 0 ? dtBulto.recordset[0].id : null;

  const dtChequeo = await p.request()
    .input('idEjecucion', idEjecucion).input('idBulto', idBulto).input('operario', operarioCodigo)
    .query(`
      DECLARE @Insertados TABLE (Id INT);
      INSERT INTO SEL_ChequeoCalidad (id_ejecucion, id_bulto, Operario)
      OUTPUT INSERTED.IdChequeo INTO @Insertados
      VALUES (@idEjecucion, @idBulto, @operario);
      SELECT Id FROM @Insertados;
    `);
  const idChequeo = dtChequeo.recordset[0].Id;

  for (const [clave, respuesta] of Object.entries(respuestas || {})) {
    const apartado = claveApartado.get(clave);
    if (!apartado) continue; // clave desconocida para esta orden -- se ignora en vez de romper el guardado
    const respuestaTexto = respuesta === 'no_conforme' ? 'NoConforme' : 'Conforme';
    await p.request()
      .input('idChequeo', idChequeo).input('apartado', apartado).input('pregunta', clave).input('respuesta', respuestaTexto)
      .query(`INSERT INTO SEL_ChequeoCalidadDetalle (IdChequeo, Apartado, Pregunta, Respuesta) VALUES (@idChequeo, @apartado, @pregunta, @respuesta)`);
  }
}

// Botones "Imprimir etiqueta" / "Cierre bulto" / "Retal" / "Troquelado" -- publican en
// /api/comando (este servidor), que reenvia a Node-RED. idOrden/maquinaCodigo se cierran sobre el
// scope de la funcion (valores fijos de esta pagina), asi los botones no necesitan mas que el
// nombre del comando. `datos` es opcional -- lo usa el modal de Calidad para mandar las
// respuestas junto con el comando (ver abrirCalidad() mas abajo). `calidadFlags` decide que
// apartados/preguntas de Calidad aplican para esta orden, ver construirApartadosCalidad().
function scriptComandos(idOrden, maquinaCodigo, calidadFlags, pausaActiva, proximaCalidad) {
  const apartadosCalidad = construirApartadosCalidad(calidadFlags);
  return `
    // Devuelve la promesa (antes no la devolvia) para que confirmarCerrarBultoYReimprimir pueda
    // encadenar un segundo comando (reimprimir_etiqueta) solo si el primero (cierre_bulto)
    // funciono -- no cambia nada para el resto de llamadas, que siguen sin usar el valor devuelto.
    function enviarComando(comando, boton, datos) {
      if (boton) boton.disabled = true;
      return fetch('/api/comando', {
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
          return data;
        })
        .catch(function(err) {
          Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo enviar el comando: ' + err.message, confirmButtonColor: '#71bf44' });
          return { ok: false, error: err.message };
        })
        .finally(function() { if (boton) boton.disabled = false; });
    }

    // Confirmacion "¿Esta seguro de...?" antes de Imprimir etiqueta (30/08/2026) -- Calidad NO pasa
    // por aca, ya tiene su propia confirmacion (el formulario del modal con "Guardar"/"Cancelar").
    // Retal/Troquelado/Refilado/Salida no conforme usan confirmarPesoYEnviar (piden el peso), y
    // Cierre bulto usa confirmarCerrarBultoYReimprimir (reimprime la ultima etiqueta), ver ambas
    // mas abajo.
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

    // Al cerrar el bulto, ademas de mandar 'cierre_bulto' como siempre, reimprime de una la
    // etiqueta del ULTIMO paquete de ese bulto (a pedido del usuario, 02/09/2026) -- mismo
    // mecanismo que reimprimirPaquete() en la pagina de Bultos (comando 'reimprimir_etiqueta'),
    // solo que aca se dispara sola en vez de que el operario tenga que ir a buscarla. idBulto/el
    // ultimo paquete salen de window.idBultoActivo/window.ultimoPaqueteBultoActivo (los mantiene
    // scriptResumenBultoActivo cada 4s). Solo se reimprime si el cierre funciono Y el bulto de
    // verdad tenia algun paquete pesado (si se cierra vacio, no hay nada que reimprimir).
    function confirmarCerrarBultoYReimprimir(mensaje, boton) {
      Swal.fire({
        icon: 'warning',
        title: mensaje,
        showCancelButton: true,
        confirmButtonText: 'Sí',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        var idBulto = window.idBultoActivo || null;
        var ultimo = window.ultimoPaqueteBultoActivo;
        enviarComando('cierre_bulto', boton).then(function(data) {
          if (!data.ok || !idBulto || !ultimo) return;
          enviarComando('reimprimir_etiqueta', null, {
            idBulto: idBulto, consecutivoPaquete: ultimo.consecutivo, pesoGr: ultimo.pesoKg, serialBulto: null
          });
        });
      });
    }

    // Retal/Troquelado/Refilado/Salida no conforme (a pedido del usuario, 01/09/2026) piden el peso
    // del residuo/bulto en una ventana emergente (numerico, no un simple "¿Esta seguro?") -- al
    // confirmar, se manda igual que los demas por /api/comando pero con datos:{peso, idBulto} para
    // que Node-RED sepa a que bulto pertenece e imprima la etiqueta del residuo. idBulto sale de
    // window.idBultoActivo (lo actualiza scriptResumenBultoActivo cada 4s, ver ahi -- puede ser
    // null si no hay bulto Activo en este momento). inputValidator bloquea pesos vacios/no
    // numericos/<=0 sin llegar a enviar el comando.
    function confirmarPesoYEnviar(mensaje, comando, boton) {
      Swal.fire({
        icon: 'question',
        title: mensaje,
        input: 'number',
        inputLabel: 'Peso (kg)',
        inputAttributes: { min: '0', step: '0.01', inputmode: 'decimal' },
        showCancelButton: true,
        confirmButtonText: 'Confirmar peso',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b',
        inputValidator: function(valor) {
          var n = Number(valor);
          if (valor === '' || valor == null || isNaN(n) || n <= 0) return 'Ingrese un peso válido.';
          return null;
        }
      }).then(function(resultado) {
        if (resultado.isConfirmed) {
          enviarComando(comando, boton, { peso: Number(resultado.value), idBulto: window.idBultoActivo || null });
        }
      });
    }

    // Pausa (SEL_TiempoMuerto) -- pantalla emergente para elegir el motivo (Alistamiento
    // despliega sus 3 subopciones justo debajo, Otro pide una breve descripcion). Al confirmar,
    // escribe directo en la BD (Estado='En pausa' + fila en SEL_TiempoMuerto) y recarga la pagina
    // -- la recarga dispara abrirModalPausaActiva() mas abajo, que muestra el cronometro.
    var MOTIVOS_PAUSA = [
      { clave: 'descanso', titulo: '😴 Descanso' },
      { clave: 'mantenimiento', titulo: '🔧 Mantenimiento' },
      { clave: 'alistamiento', titulo: '⚙️ Alistamiento' },
      { clave: 'orden_aseo', titulo: '🧹 Orden y aseo' },
      { clave: 'limpieza', titulo: '🧼 Limpieza y desinfección' },
      { clave: 'otro', titulo: '❓ Otro' }
    ];
    var SUBMOTIVOS_ALISTAMIENTO = [
      { clave: 'materiales', titulo: '📦 Materiales' },
      { clave: 'mecanico', titulo: '🔩 Mecánico' },
      { clave: 'espacio_trabajo', titulo: '📐 Espacio de trabajo' }
    ];

    function abrirPausa() {
      // Texto y radio mas grandes que .calidad-opcion (a pedido del usuario, 01/09/2026) -- estilo
      // en linea, no una clase compartida, para no afectar tambien las opciones de Calidad
      // (Conforme/No conforme), que si siguen usando calidad-opcion tal cual.
      var htmlSubmotivos = SUBMOTIVOS_ALISTAMIENTO.map(function(s) {
        return '<label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:17px;"><input type="radio" name="subtipoPausa" value="' + s.clave + '" style="width:22px;height:22px;margin:0;flex-shrink:0;"> ' + s.titulo + '</label>';
      }).join('');

      // Las subopciones de Alistamiento van justo debajo de esa opcion (a pedido del usuario,
      // 31/08/2026), no en un bloque aparte al final de la lista.
      var htmlMotivos = MOTIVOS_PAUSA.map(function(m) {
        var item = '<label style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:18px;"><input type="radio" name="motivoPausa" value="' + m.clave + '" style="width:22px;height:22px;margin:0;flex-shrink:0;"> ' + m.titulo + '</label>';
        if (m.clave === 'alistamiento') {
          item += '<div id="pausa-submotivos" style="display:none;margin:0 0 8px 32px;">' + htmlSubmotivos + '</div>';
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

    // Pausa y Calidad ya no son mutuamente excluyentes (03/09/2026): el chequeo de Calidad ahora se
    // programa SIEMPRE que haya una ProximaCalidad (siga o no en pausa la ejecucion en este
    // momento) -- programarCalidadAleatoria() se encarga de no abrirlo mientras haya otra ventana
    // (la de pausa) abierta, ver esa funcion mas abajo.
    ${pausaActiva ? `abrirModalPausaActiva(${JSON.stringify(pausaActiva)});` : ''}
    ${proximaCalidad ? `programarCalidadAleatoria(${JSON.stringify(proximaCalidad)});` : ''}

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
        if (resultado.isConfirmed) {
          enviarComando('calidad', null, resultado.value);
          // El servidor ya guardo una ProximaCalidad nueva al recibir este comando (POST
          // /api/comando), pero no hace falta esperar a releerla para seguir contando en esta
          // misma carga de pagina -- se calcula el mismo rango aca mismo.
          programarCalidadAleatoria(new Date(Date.now() + 20 * 60 * 1000 + Math.random() * (10 * 60 * 1000)).toISOString());
        } else {
          // Se cancelo -- se reintenta pronto (5 min) en vez de esperar un ciclo completo nuevo: el
          // chequeo debe insistir, no desaparecer porque se cancelo una vez (a pedido del usuario,
          // 03/09/2026). El servidor no toco ProximaCalidad en este caso, sigue "vencida".
          programarCalidadAleatoria(new Date(Date.now() + 5 * 60 * 1000).toISOString());
        }
      });
    }

    // Calidad ya no tiene boton (a pedido del usuario, 31/08/2026) -- sale sola, en un momento
    // aleatorio entre 20 y 30 minutos desde que la orden esta Activa. FIX 03/09/2026: ese momento
    // (ProximaCalidad) ahora lo guarda el servidor en SEL_EjecucionOrden -- ya NO se calcula un
    // intervalo nuevo desde que carga la pagina (eso hacia que un refresh, cambiar de pestaña o
    // cualquier recarga del WebView reiniciara la cuenta a cero, y casi nunca llegaba a
    // completarse). El parametro es una fecha/hora absoluta (ISO), no una espera relativa.
    // Tampoco es mutuamente excluyente con Pausa: si al llegar la hora la ejecucion esta pausada
    // (o el operario esta justo eligiendo el motivo), NO compite por la pantalla con esa ventana
    // bloqueante -- reintenta cada minuto hasta que quede libre, en vez de forzarse encima.
    function programarCalidadAleatoria(proximaCalidadIso) {
      var espera = Math.max(0, new Date(proximaCalidadIso).getTime() - Date.now());
      setTimeout(intentarAbrirCalidad, espera);
    }

    function intentarAbrirCalidad() {
      if (Swal.isVisible()) {
        setTimeout(intentarAbrirCalidad, 60 * 1000);
        return;
      }
      abrirCalidad();
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

// Escaneo del rollo como ventana emergente (SweetAlert) sobre la misma pagina, en vez de la
// pantalla /escanear aparte que existio hasta el 04/09/2026: al quitarle la camara esa pantalla
// quedaba con un solo campo de texto, y a pedido del usuario se paso a modal para no navegar ni
// perder de vista la orden. Son dos pasos encadenados -- pedirSerialRollo() (la pistola escribe
// el serial y manda Enter, que confirma solo) y confirmarRolloModal() (vista previa del rollo y,
// al Iniciar, el campo Bolsas x golpe). Reusa TAL CUAL los endpoints que usaba la pantalla:
// /rollo/preparar (valida y trae las bolsas x golpe actuales), /rollo/consultar y /rollo. La
// pagina que lo cargue debe traer tambien scriptPreguntaActividadInicial(): al Iniciar se
// pregunta por la actividad antes de entrar a Informacion, igual que antes.
function scriptEscanearRollo(maquinaCodigo) {
  return `
    var MAQUINA_ESCANEO = ${JSON.stringify(maquinaCodigo)};

    function errorRollo(mensaje) {
      Swal.fire({ icon: 'error', title: 'No se pudo continuar', text: mensaje, confirmButtonColor: '#71bf44' });
    }

    function filaRollo(etiqueta, valor) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;font-size:14px;margin-bottom:6px;">' +
             '<span style="color:#64748b;">' + etiqueta + '</span><strong>' + valor + '</strong></div>';
    }

    function abrirEscaneoRollo(idOrden, esNuevoRollo) {
      var titulo = esNuevoRollo ? 'Añadir rollo' : 'Iniciar ejecución';
      fetch('/api/selladora/orden/' + idOrden + '/rollo/preparar?nuevo=' + (esNuevoRollo ? '1' : '0'))
        .then(function(r) { return r.json(); })
        .then(function(datos) {
          if (!datos.ok) { errorRollo(datos.error); return; }
          pedirSerialRollo(idOrden, esNuevoRollo, titulo, datos.bolsasActual || 0);
        })
        .catch(function(err) { errorRollo('Error de conexión: ' + err.message); });
    }

    function pedirSerialRollo(idOrden, esNuevoRollo, titulo, bolsasActual) {
      Swal.fire({
        title: titulo,
        html: '<div style="text-align:left;font-size:13px;color:#64748b;margin-bottom:10px;">' +
              'Escanee la etiqueta del rollo con la pistola (código de 19 dígitos) o escríbalo.</div>' +
              '<input id="rollo-serial" class="swal2-input" style="margin:0;width:100%;" inputmode="numeric" placeholder="Serial del rollo">',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        confirmButtonText: 'Buscar',
        confirmButtonColor: '#71bf44',
        showLoaderOnConfirm: true,
        allowOutsideClick: function() { return !Swal.isLoading(); },
        didOpen: function() {
          var campo = document.getElementById('rollo-serial');
          campo.focus();
          // La pistola escribe el serial como si fuera un teclado y manda Enter al terminar: con
          // eso se busca solo, sin que el operario tenga que tocar "Buscar" (mismo comportamiento
          // que tenia el input de la pantalla /escanear).
          campo.addEventListener('keydown', function(evento) {
            if (evento.key === 'Enter') { evento.preventDefault(); Swal.clickConfirm(); }
          });
        },
        preConfirm: function() {
          var serial = (document.getElementById('rollo-serial').value || '').trim();
          if (!serial) { Swal.showValidationMessage('Escanee o escriba el serial del rollo.'); return false; }
          return fetch('/api/selladora/orden/' + idOrden + '/rollo/consultar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serial: serial, esNuevoRollo: esNuevoRollo })
          }).then(function(r) { return r.json(); }).then(function(datos) {
            if (!datos.ok) { Swal.showValidationMessage(datos.error); return false; }
            return datos;
          }).catch(function(err) {
            Swal.showValidationMessage('Error de conexión: ' + err.message);
            return false;
          });
        }
      }).then(function(resultado) {
        if (resultado.isConfirmed) {
          confirmarRolloModal(idOrden, esNuevoRollo, titulo, bolsasActual, resultado.value);
        }
      });
    }

    function confirmarRolloModal(idOrden, esNuevoRollo, titulo, bolsasActual, rollo) {
      var detalle =
        filaRollo('Serial', rollo.serial) +
        filaRollo('Peso (Kg)', rollo.cantidad) +
        filaRollo('Lote', rollo.lote || '—') +
        filaRollo('Bodega', rollo.bodegaNombre) +
        filaRollo('Referencia', rollo.referencia);
      // Al +Rollo las bolsas x golpe ya vienen de la ejecucion en curso (solo se muestran); al
      // Iniciar las escribe el operario -- el servidor vuelve a decidir cual usar, esto es la UI.
      var campoBolsas = esNuevoRollo
        ? filaRollo('Bolsas x golpe', bolsasActual || '—')
        : '<label for="rollo-bolsas" style="display:block;text-align:left;font-size:13px;font-weight:600;margin:12px 0 6px;">Bolsas x golpe</label>' +
          '<input id="rollo-bolsas" class="swal2-input" style="margin:0;width:100%;" type="number" min="1" inputmode="numeric">';
      Swal.fire({
        title: titulo,
        html: '<div style="text-align:left;">' + detalle + campoBolsas + '</div>',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        confirmButtonText: esNuevoRollo ? 'Añadir rollo' : 'Iniciar',
        confirmButtonColor: '#71bf44',
        showLoaderOnConfirm: true,
        allowOutsideClick: function() { return !Swal.isLoading(); },
        didOpen: function() {
          var campo = document.getElementById('rollo-bolsas');
          if (campo) campo.focus();
        },
        preConfirm: function() {
          var bolsas = bolsasActual;
          if (!esNuevoRollo) {
            bolsas = parseInt(document.getElementById('rollo-bolsas').value, 10);
            if (!bolsas || bolsas <= 0) { Swal.showValidationMessage('Ingrese un número de bolsas x golpe válido.'); return false; }
          }
          return fetch('/api/selladora/orden/' + idOrden + '/rollo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serial: rollo.serial, esNuevoRollo: esNuevoRollo, bolsasXGolpe: bolsas })
          }).then(function(r) { return r.json(); }).then(function(datos) {
            if (!datos.ok) { Swal.showValidationMessage(datos.error); return false; }
            return datos;
          }).catch(function(err) {
            Swal.showValidationMessage('Error de conexión: ' + err.message);
            return false;
          });
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        Swal.fire({
          icon: 'success',
          title: esNuevoRollo ? 'Rollo añadido' : 'Ejecución iniciada',
          timer: 1000, showConfirmButton: false
        }).then(function() {
          if (esNuevoRollo) {
            // Se recarga la misma pagina en la que estaba (cola de la maquina o Informacion) --
            // antes la pantalla /escanear devolvia siempre a la cola de la maquina.
            window.location.reload();
          } else {
            // Al Iniciar, termine con actividad o directo a produccion, se entra a Informacion de
            // la orden (a pedido del usuario, 31/08/2026) -- ver scriptPreguntaActividadInicial().
            preguntarActividadInicial(idOrden, function() {
              window.location.href = '/selladora/' + encodeURIComponent(MAQUINA_ESCANEO) + '/orden/' + idOrden;
            });
          }
        });
      });
    }
  `;
}

// Antes de entrar a producir -- al Iniciar una orden con su primer rollo (scriptEscanearRollo,
// esNuevoRollo=false unicamente, NO aplica a +Rollo) o al Retomar/Reanudar una ejecucion tras un cambio de operario
// (confirmarTomarControlEjecucion arriba) -- se pregunta si hay alguna actividad de las que se
// registran como pausa (Alistamiento, Mantenimiento, etc.) por hacer primero, o si se entra directo
// a producir (a pedido del usuario, 31/08/2026). Si elige una actividad, queda registrada igual que
// si hubiera usado el boton "Pausa" normal (mismo POST /pausar) -- la ejecucion arranca/vuelve en
// 'En pausa' desde ese momento, en vez de tener que pausarla a mano despues de haber entrado.
// Comparte los mismos motivos/submotivos que abrirPausa() en scriptComandos(), pero se duplican aca
// (MOTIVOS_PAUSA_INICIAL) porque esta funcion se usa en paginas (renderPage) que no cargan
// scriptComandos.
function scriptPreguntaActividadInicial() {
  return `
    var MOTIVOS_PAUSA_INICIAL = [
      { clave: 'descanso', titulo: '😴 Descanso' },
      { clave: 'mantenimiento', titulo: '🔧 Mantenimiento' },
      { clave: 'alistamiento', titulo: '⚙️ Alistamiento' },
      { clave: 'orden_aseo', titulo: '🧹 Orden y aseo' },
      { clave: 'limpieza', titulo: '🧼 Limpieza y desinfección' },
      { clave: 'otro', titulo: '❓ Otro' }
    ];
    var SUBMOTIVOS_ALISTAMIENTO_INICIAL = [
      { clave: 'materiales', titulo: '📦 Materiales' },
      { clave: 'mecanico', titulo: '🔩 Mecánico' },
      { clave: 'espacio_trabajo', titulo: '📐 Espacio de trabajo' }
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
      // Mismo tamaño mas grande que abrirPausa() en scriptComandos (a pedido del usuario, 01/09/2026).
      var htmlSubmotivos = SUBMOTIVOS_ALISTAMIENTO_INICIAL.map(function(s) {
        return '<label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:17px;"><input type="radio" name="subtipoPausaInicial" value="' + s.clave + '" style="width:22px;height:22px;margin:0;flex-shrink:0;"> ' + s.titulo + '</label>';
      }).join('');
      var htmlMotivos = MOTIVOS_PAUSA_INICIAL.map(function(m) {
        var item = '<label style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:18px;"><input type="radio" name="motivoPausaInicial" value="' + m.clave + '" style="width:22px;height:22px;margin:0;flex-shrink:0;"> ' + m.titulo + '</label>';
        if (m.clave === 'alistamiento') {
          item += '<div id="pausa-inicial-submotivos" style="display:none;margin:0 0 8px 32px;">' + htmlSubmotivos + '</div>';
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
      <div class="header-fila">
        <div class="header-info">
          <h1>🏭 ${maquinaNombre}</h1>
          <div class="sub">Programación máquina</div>
          <a class="volver" href="/">‹ Selladoras</a>
        </div>
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${usuario}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
    </div>
  </header>
  <main>
    <div class="barra">
      <span class="actualizado" id="cola-actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
    </div>
    <div id="cola-ordenes">${renderColaOrdenes(colaOrdenes || [], maquinaCodigo, miOperario)}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <script>${scriptActualizarCola(maquinaCodigo)}</script>
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
        <a class="salir" href="/logout">Cerrar sesión</a>
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
function renderOrdenDetalle(orden, totalBultos, historial, usuario, maquinaCodigo, pausaActiva, avance, proximaCalidad) {
  const filasHistorial = historial.length
    ? historial.map(h => `
        <div class="hist-fila">
          <span class="valor serial">${h.Serial ?? '—'}</span>
          <span>${h.Referencia ?? '—'}</span>
          <span>${h.Lote ?? '—'}</span>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  // FIX 01/09/2026: el boton de Pausa se movio aca (junto a Finalizar) desde el bloque de Imprimir
  // etiqueta/Cierre bulto -- a pedido del usuario. Solo aparece si NO esta ya pausada (mientras esta
  // pausada, el cronometro sale como ventana emergente aparte, ver abrirModalPausaActiva).
  let acciones = '';
  const activa = orden.Estado === 'Activa';
  if (orden.Estado === 'Pendiente') {
    acciones = `<button type="button" class="btn-accion btn-iniciar" onclick="abrirEscaneoRollo(${orden.IdOrden}, false)">▶ Iniciar</button>`;
  } else if (activa) {
    acciones = `
      <button type="button" class="btn-accion btn-anadir" onclick="abrirEscaneoRollo(${orden.IdOrden}, true)">+ Rollo</button>
      <form method="post" action="/api/selladora/orden/${orden.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
        <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
      </form>
      ${!pausaActiva ? `<button type="button" class="btn-accion btn-pausa" onclick="abrirPausa()">⏸ Pausa</button>` : ''}`;
  }

  // Troquelado (SEL_OrdenProduccion.Troquelado != 'SinTroquelado') -- decide DOS cosas: si sale el
  // boton de residuo "Troquelado" (FIX 04/09/2026, a pedido del usuario: antes salia para toda
  // SELLADORA sin mirar si la orden de verdad lleva troquelado) y si aplica el apartado
  // Troquelado/Perforaciones de Calidad (ver calidadFlags mas abajo).
  const tieneTroquelado = !!orden.Troquelado && orden.Troquelado !== 'SinTroquelado';

  // Botones de residuos (Retal/Troquelado, segun BOTONES_RESIDUOS_POR_TIPO) + Salida no conforme --
  // van agrupados bajo un titulo "Residuos", en su propia isla separada de "Producción"
  // (+Rollo/Finalizar/Pausa) pero en la MISMA fila (a pedido del usuario, 01/09/2026 -- antes vivian
  // junto a Imprimir etiqueta/Cierre bulto). Usan confirmarPesoYEnviar (no confirmarYEnviar): piden
  // el peso del residuo/bulto en la ventana emergente antes de mandarlo, ver esa funcion en
  // scriptComandos(). FIX 26/08/2026 (sigue vigente): publican el comando en /api/comando para que
  // Node-RED lo lea -- ya no hacen ninguna escritura directa en esta BD.
  const botonesResiduosHabilitados = BOTONES_RESIDUOS_POR_TIPO[orden.MaquinaTipo] || [];
  const botonesResiduosHTML = activa ? [
    ...BOTONES_RESIDUOS
      .filter(b => botonesResiduosHabilitados.includes(b.clave))
      // "Troquelado" ademas exige que ESTA orden lleve troquelado -- los otros residuos no dependen
      // de ninguna columna de la orden, solo del tipo de maquina.
      .filter(b => b.clave !== 'troquelado' || tieneTroquelado)
      .map(b => `<button type="button" class="btn-accion btn-residuo" onclick="confirmarPesoYEnviar('¿Está seguro de marcar este bulto con ${b.label}?', '${b.clave}', this)">${b.label}</button>`),
    `<button type="button" class="btn-accion btn-no-conforme" onclick="confirmarPesoYEnviar('¿Está seguro de marcar esta salida como no conforme?', 'no_conforme', this)">🚫 Salida no conforme</button>`
  ].join('') : '';

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

  // Imprimir etiqueta + Cierre bulto van en la MISMA fila, en dos columnas (a pedido del usuario,
  // 31/08/2026). FIX 01/09/2026: Pausa se movio junto a Finalizar (ver `acciones` mas arriba), y
  // Retal/Troquelado/Salida no conforme al grupo "Residuos" (ver botonesResiduosHTML) -- ya no
  // quedan aca.
  const imprimirYAccionesBox = activa ? `
    <div class="peso-box">
      <div class="imprimir-acciones-grid">
        <button type="button" class="btn-accion btn-imprimir" onclick="confirmarYEnviar('¿Está seguro de imprimir la etiqueta?', 'imprimir_etiqueta', this)">🖨️ Imprimir etiqueta</button>
        <button type="button" class="btn-accion btn-cierre-bulto" onclick="confirmarCerrarBultoYReimprimir('¿Está seguro de cerrar el bulto?', this)">📦 Cierre bulto</button>
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
  // conversacion 26/08/2026); Perforaciones != 0/NULL. tieneTroquelado se calcula mas arriba
  // (tambien decide si sale el boton de residuo "Troquelado").
  const tieneAccesorios = ['Manija', 'Tula', 'Parche', 'CierreDeslizador', 'CierreHermetico', 'CintaAdhesiva']
    .some(campo => orden[campo] === 'Sí');
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

  // Tarjeta de Avance de produccion (encabezado) -- solo si la orden tiene meta configurada
  // (KilosSolicitados o UnidadesSolicitadas, ver obtenerAvanceProduccion). Se renderiza con el
  // valor real de una vez, y scriptAvanceProduccion lo va refrescando cada 4s -- por eso los ids.
  // Verde al llegar/pasar la meta, azul mientras va por debajo; la barra se corta en 100% aunque
  // el porcentaje siga subiendo.
  const avanceCard = (avance && avance.tipo) ? (() => {
    const color = avance.porcentaje >= 100 ? '#4a9c2e' : '#006984';
    return `
        <div class="avance-header-card">
          <div class="avance-header-top">
            <span class="avance-header-label">Avance de producción</span>
            <span class="avance-header-porcentaje" id="avance-porcentaje" style="color:${color};">${avance.porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</span>
          </div>
          <div class="avance-header-barra">
            <div class="avance-header-relleno" id="avance-relleno" style="width:${Math.min(avance.porcentaje, 100)}%;background:${color};"></div>
          </div>
          <div class="avance-header-stats">
            <span id="avance-producido">Producido: ${formatearCantidadAvance(avance.producido, avance.tipo)}</span>
            <span id="avance-programado">Programado: ${formatearCantidadAvance(avance.programado, avance.tipo)}</span>
          </div>
        </div>`;
  })() : '';

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
      <div class="header-fila">
        <div class="header-info">
          <h1>Pedido ${orden.NumeroPedido || '—'} ${badgeEstadoOrden(orden.Estado)}</h1>
          <div class="sub">${orden.Elemento}</div>
          <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${orden.MaquinaNombre}</a>
        </div>
        ${avanceCard}
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${usuario}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
    </div>
  </header>
  <main>
    ${acciones ? `<div class="islas-fila">
      <div class="isla">
        <div class="label">Producción</div>
        <div class="orden-acciones">${acciones}</div>
      </div>
      ${botonesResiduosHTML ? `<div class="isla">
        <div class="label">Residuos</div>
        <div class="orden-acciones">${botonesResiduosHTML}</div>
      </div>` : ''}
    </div>` : ''}
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
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  ${activa ? `<script>${scriptComandos(orden.IdOrden, maquinaCodigo, calidadFlags, pausaActiva, proximaCalidad)}</script><script>${scriptPesoEnVivo()}</script><script>${scriptResumenBultoActivo(orden.IdOrden, maquinaCodigo)}</script>` : ''}
  ${avanceCard ? `<script>${scriptAvanceProduccion(orden.IdOrden, maquinaCodigo)}</script>` : ''}
</body>
</html>`;
}

// Maximo de paquetes que se muestran a la vez en el desplegable de cada bulto -- con mas de esto
// se parte en "paginas" tipo carrusel (ver PAQUETES_POR_PAGINA mas abajo), en vez de una lista
// larga sin fin (a pedido del usuario, 02/09/2026).
const PAQUETES_POR_PAGINA = 10;

// Tarjetas de bultos con su historial de paquetes (SEL_PesajeElemento) -- separada de
// renderBultosOrden para poder reusarla tal cual desde /bultos/fragmento (ver mas abajo), que le
// da al polling del cliente el mismo HTML sin reconstruir la pagina entera. El historial de
// paquetes va dentro de un <details> (desplegable al hacer click en el bulto, colapsado por
// defecto) porque con muchos paquetes la tarjeta se volvia demasiado larga.
function renderTarjetasBultos(bultos, pesajesPorBulto, residuosPorBulto) {
  const tarjetas = bultos.map(b => {
    const pesajes = pesajesPorBulto.get(b.id) || [];

    // Residuos generados por ESTE bulto (Retal/Refilado/Troquelado/No conforme, ver
    // OFFSET_RESIDUO_POR_TIPO/obtenerBultosYPesajes) -- a pedido del usuario (02/09/2026), solo se
    // muestra la seccion si de verdad hay algo (la mayoria de bultos no generan ningun residuo). Si
    // el mismo tipo aparece mas de una vez se suma en una sola fila.
    const residuos = (residuosPorBulto && residuosPorBulto.get(b.id)) || [];
    let contenidoResiduos = '';
    if (residuos.length > 0) {
      const cantidadPorTipo = new Map();
      residuos.forEach(r => cantidadPorTipo.set(r.tipo, (cantidadPorTipo.get(r.tipo) || 0) + r.cantidad));
      const filasResiduos = Array.from(cantidadPorTipo.entries()).map(([tipo, cantidad]) => `
        <div class="residuo-bulto-fila">
          <span class="residuo-bulto-badge${tipo === 'No conforme' ? ' residuo-bulto-badge-alerta' : ''}">${tipo}</span>
          <span>${cantidad.toFixed(2)} kg</span>
        </div>`).join('');
      contenidoResiduos = `
      <div class="residuos-bulto">
        <div class="label">Residuos generados</div>
        ${filasResiduos}
      </div>`;
    }

    let contenidoPesajes;
    if (pesajes.length === 0) {
      contenidoPesajes = `<div class="pesaje-vacio">Sin paquetes pesados todavía.</div>`;
    } else {
      // "Slideboard": se parte en paginas de PAQUETES_POR_PAGINA, todas ya vienen en el HTML
      // (ocultas con display:none salvo la ultima, que es la que se ve por defecto -- los paquetes
      // mas recientes, lo que mas le importa al operario). Las flechas ‹ › solo cambian cual pagina
      // esta visible (cambiarPaginaPesajes, ver scriptPaginadorPesajes) -- no vuelven a pedir nada
      // al servidor, todas las paginas ya estan en el DOM.
      const totalPaginas = Math.ceil(pesajes.length / PAQUETES_POR_PAGINA);
      const paginaInicial = totalPaginas - 1;
      const paginasHtml = [];
      for (let i = 0; i < totalPaginas; i++) {
        const grupo = pesajes.slice(i * PAQUETES_POR_PAGINA, (i + 1) * PAQUETES_POR_PAGINA);
        const filasGrupo = grupo.map(pe => `
          <div class="pesaje-fila">
            <a href="javascript:void(0)" class="link-reimprimir" title="Reimprimir etiqueta de este paquete"
              onclick="reimprimirPaquete(this, ${JSON.stringify(b.id)}, ${JSON.stringify(pe.ConsecutivoPaquete)}, ${JSON.stringify(Number(pe.PesoPaqueGr))}, ${jsString(b.serialPadre).replace(/"/g, '&quot;')})">🖨️ Paquete ${pe.ConsecutivoPaquete}</a>
            <span>${pe.Hora}</span>
            <span>${Number(pe.PesoPaqueGr).toString()}</span>
          </div>`).join('');
        paginasHtml.push(
          `<div class="pesajes-pagina" data-pagina-idx="${i}"${i === paginaInicial ? '' : ' style="display:none;"'}>${filasGrupo}</div>`
        );
      }
      const nav = totalPaginas > 1 ? `
        <div class="pesajes-nav">
          <button type="button" class="btn-pesajes-nav" data-dir="-1" onclick="cambiarPaginaPesajes(this,-1)"${paginaInicial === 0 ? ' disabled' : ''}>‹</button>
          <span class="pesajes-nav-indicador">${paginaInicial + 1} / ${totalPaginas}</span>
          <button type="button" class="btn-pesajes-nav" data-dir="1" onclick="cambiarPaginaPesajes(this,1)"${paginaInicial === totalPaginas - 1 ? ' disabled' : ''}>›</button>
        </div>` : '';
      contenidoPesajes = `<div class="pesajes-paginador" data-bulto="${b.id}" data-pagina="${paginaInicial}" data-total-paginas="${totalPaginas}">${paginasHtml.join('')}${nav}</div>`;
    }

    return `
    <div class="card">
      <div class="card-top">
        <span class="bulto-num">Bulto ${b.numRelativo}</span>
        ${badgeEstado(b.estado)}
      </div>
      <div class="card-grid">
        <div><span class="label">Cant. Total (KG)</span><span class="valor">${b.CantidadTotal ?? '—'}</span></div>
        <div><span class="label">Hora inicio</span><span class="valor">${b.HoraInicio ?? '—'}</span></div>
        <div><span class="label">Potencia (W)</span><span class="valor">${b.Potencia ?? '—'}</span></div>
        <div><span class="label">Hora final</span><span class="valor">${b.HoraFin ?? '—'}</span></div>
        <div><span class="label">Golpes x minuto</span><span class="valor">${b.Golpes ?? '—'}</span></div>
        <div class="full"><span class="label">Serial</span><span class="valor serial">${b.serialPadre ?? '—'}</span></div>
      </div>
      <details class="pesajes-box" data-bulto="${b.id}">
        <summary>Paquetes pesados (${pesajes.length})</summary>
        ${contenidoPesajes}
      </details>
      ${contenidoResiduos}
    </div>`;
  }).join('');

  return bultos.length
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">Esta orden todavía no tiene bultos.</div>`;
}

// Boton "🖨️" de cada paquete ya pesado (dentro del desplegable "Paquetes pesados" de cada bulto,
// ver renderTarjetasBultos) -- a pedido del usuario (01/09/2026), reimprime la etiqueta de un
// paquete puntual del historial, no solo la del que la bascula tiene activo ahora mismo (eso ya lo
// cubre el boton "Imprimir etiqueta" de Informacion). Reusa el mismo comando 'reimprimir_etiqueta'
// (distinto de 'imprimir_etiqueta', ver COMANDOS_VALIDOS) via POST /api/comando -- no toca la BD
// directamente, solo publica el comando para que Node-RED lo lea. idOrden/maquinaCodigo quedan
// fijos en el closure (misma orden en toda la pagina de bultos), lo unico que cambia por boton es
// el paquete puntual (idBulto/consecutivoPaquete/pesoGr/serialBulto).
function scriptReimprimir(idOrden, maquinaCodigo) {
  return `
    function reimprimirPaquete(enlace, idBulto, consecutivoPaquete, pesoGr, serialBulto) {
      Swal.fire({
        icon: 'warning',
        title: '¿Reimprimir la etiqueta del paquete ' + consecutivoPaquete + '?',
        showCancelButton: true,
        confirmButtonText: 'Sí, reimprimir',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        enlace.classList.add('deshabilitado');
        fetch('/api/comando', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            comando: 'reimprimir_etiqueta',
            idOrden: ${JSON.stringify(idOrden)},
            maquinaCodigo: ${jsString(maquinaCodigo)},
            datos: { idBulto: idBulto, consecutivoPaquete: consecutivoPaquete, pesoGr: pesoGr, serialBulto: serialBulto }
          })
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
          .finally(function() { enlace.classList.remove('deshabilitado'); });
      });
    }
  `;
}

// "Slideboard" de paquetes de cada bulto (ver PAQUETES_POR_PAGINA/renderTarjetasBultos) -- todas
// las paginas ya vienen en el HTML (ocultas salvo la mas reciente), las flechas ‹ › solo cambian
// cual esta visible, sin pedir nada al servidor (a pedido del usuario, 02/09/2026).
function scriptPaginadorPesajes() {
  return `
    function mostrarPaginaPesajes(contenedor, idx) {
      var total = Number(contenedor.dataset.totalPaginas);
      contenedor.querySelectorAll('.pesajes-pagina').forEach(function(p) {
        p.style.display = (Number(p.dataset.paginaIdx) === idx) ? '' : 'none';
      });
      contenedor.dataset.pagina = idx;
      var indicador = contenedor.querySelector('.pesajes-nav-indicador');
      if (indicador) indicador.textContent = (idx + 1) + ' / ' + total;
      var btnPrev = contenedor.querySelector('.btn-pesajes-nav[data-dir="-1"]');
      var btnNext = contenedor.querySelector('.btn-pesajes-nav[data-dir="1"]');
      if (btnPrev) btnPrev.disabled = idx === 0;
      if (btnNext) btnNext.disabled = idx === total - 1;
    }

    function cambiarPaginaPesajes(boton, delta) {
      var contenedor = boton.closest('.pesajes-paginador');
      if (!contenedor) return;
      var total = Number(contenedor.dataset.totalPaginas);
      var actual = Number(contenedor.dataset.pagina);
      var nueva = Math.max(0, Math.min(total - 1, actual + delta));
      if (nueva !== actual) mostrarPaginaPesajes(contenedor, nueva);
    }
  `;
}

// Script del cliente para /bultos: pide el fragmento renderizado con renderTarjetasBultos cada
// pocos segundos y reemplaza el contenedor -- asi el numero de paquetes pesados se ve actualizado
// sin que el operario tenga que recargar la pagina a mano (a pedido del usuario, 24/08/2026: en
// pruebas el conteo no se actualizaba solo). Guarda que bultos tenian el desplegable abierto antes
// de reemplazar el HTML y se lo vuelve a abrir despues, para no cerrarlo en cada actualizacion.
// FIX 02/09/2026: hace lo mismo con la pagina del "slideboard" de cada bulto -- pero solo si el
// operario se habia movido a una pagina vieja (no la ultima); si estaba viendo la mas reciente, se
// deja que el nuevo render siga mostrando la mas reciente de verdad (puede haber una pagina nueva
// si llego un paquete), no la que antes era la ultima.
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
          const paginas = new Map(
            Array.from(contenedor.querySelectorAll('.pesajes-paginador')).map(function(el) {
              var pagina = Number(el.dataset.pagina);
              var total = Number(el.dataset.totalPaginas);
              return [el.dataset.bulto, { pagina: pagina, eraLaMasReciente: pagina === total - 1 }];
            })
          );
          contenedor.innerHTML = html;
          contenedor.querySelectorAll('details').forEach(function(d) {
            if (abiertos.has(d.dataset.bulto)) d.open = true;
          });
          contenedor.querySelectorAll('.pesajes-paginador').forEach(function(el) {
            var guardado = paginas.get(el.dataset.bulto);
            if (!guardado || guardado.eraLaMasReciente) return;
            var total = Number(el.dataset.totalPaginas);
            mostrarPaginaPesajes(el, Math.min(guardado.pagina, total - 1));
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
function renderBultosOrden(orden, bultos, pesajesPorBulto, residuosPorBulto, usuario, maquinaCodigo) {
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
      <div class="header-fila">
        <div class="header-info">
          <h1>📦 Bultos</h1>
          <div class="sub">${orden.Elemento}</div>
          <a class="volver" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}">‹ Pedido ${orden.NumeroPedido || '—'}</a>
        </div>
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${usuario}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
    </div>
  </header>
  <main>
    <div id="contenedor-bultos">${renderTarjetasBultos(bultos, pesajesPorBulto, residuosPorBulto)}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptReimprimir(orden.IdOrden, maquinaCodigo)}</script>
  <script>${scriptPaginadorPesajes()}</script>
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
  req.session.destroy(() => res.redirect('/login'));
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

// Cola de ordenes de una maquina, mismo criterio y orden que EjecucionSelladora.vb:CargarGrid.
// El detalle de bultos/pesajes/historial de cada orden vive en /selladora/:codigo/orden/:idOrden
// (boton "Informacion" de cada fila) -- esta pagina es solo la lista. FIX 31/08/2026: se agrega
// ej.Estado (EstadoEjecucion) -- una orden con ord.Estado='Activa' puede tener su ejecucion en
// 'PendienteOperador' (ver /logout), y esta lista es donde se ofrece "Retomar la ejecucion" para
// esas -- filtrar solo por ord.Estado no alcanza para distinguir ese caso. Se trae tambien el
// operario/nombre que la dejo pendiente, para mostrarlo y para distinguir si quien esta mirando
// ahora es el mismo (en ese caso el boton dice "Reanudar", no "Retomar"). Factorizada (01/09/2026)
// para reusarla desde /selladora/:codigo (carga completa) y /selladora/:codigo/cola-fragmento (el
// polling de scriptActualizarCola, que reemplazo al boton "Actualizar").
async function obtenerColaOrdenes(p, codigo) {
  const colaResult = await p.request().input('codigo', codigo).query(`
    SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
           ej.Estado AS EstadoEjecucion, ej.Operario AS OperarioEjecucionCodigo, op.Nombre AS OperarioEjecucionNombre,
           ej.HoraFinReal
    FROM SEL_OrdenProduccion ord
    INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
    LEFT JOIN SEL_EjecucionOrden ej ON ej.IdOrden = ord.IdOrden
    LEFT JOIN PRDOperarios op ON op.Codigo = ej.Operario
    WHERE ord.Maquina = @codigo AND ord.Estado IN ('Activa','Pendiente','PendienteValidacion')
    ORDER BY CASE ord.Estado WHEN 'Activa' THEN 0 WHEN 'Pendiente' THEN 1 ELSE 2 END ASC,
             ISNULL(ord.Prioridad, 99999) ASC, ord.IdOrden ASC
  `);
  return colaResult.recordset;
}

app.get('/selladora/:codigo', requireLogin, async (req, res) => {
  const codigo = req.params.codigo;
  try {
    const p = await getPool();

    const maquina = await p.request().input('codigo', codigo).query(`SELECT Nombre FROM PRDMaquinas WHERE Codigo = @codigo`);
    const nombre = maquina.recordset[0] ? maquina.recordset[0].Nombre : 'Selladora';

    const ordenes = await obtenerColaOrdenes(p, codigo);

    // FIX 31/08/2026: ?preguntarActividad=<idOrden> lo agrega el redirect de tomar-control-ejecucion
    // cuando la ejecucion retomada quedo Activa -- dispara la pregunta "¿va a hacer alguna actividad
    // antes de producir?" (preguntarActividadInicial, ver scriptPreguntaActividadInicial) apenas
    // carga la pagina. Se valida que sea un entero positivo antes de pasarlo al HTML.
    const idOrdenPreguntarActividad = /^\d+$/.test(req.query.preguntarActividad || '') ? Number(req.query.preguntarActividad) : null;

    res.send(renderPage(null, req.session.usuario.nombre, nombre, codigo, ordenes, req.session.usuario.codigoOperarioPRD, idOrdenPreguntarActividad));
  } catch (err) {
    res.status(500).send(renderPage(err.message, req.session.usuario.nombre, 'Selladora', codigo, [], req.session.usuario.codigoOperarioPRD, null));
  }
});

// Fragmento HTML de la cola de ordenes -- lo pide solo scriptActualizarCola (polling cada 4s, mismo
// criterio que scriptResumenBultoActivo) para refrescar la pagina sola, sin el boton "Actualizar"
// (a pedido del usuario, 01/09/2026). Devuelve el HTML ya renderizado por renderColaOrdenes (no
// JSON) para no duplicar ese marcado del lado del cliente -- se reemplaza tal cual el innerHTML del
// contenedor, los onsubmit inline de cada fila (confirmarTomarControlEjecucion, etc.) quedan
// funcionando porque son parte del HTML nuevo, no listeners agregados aparte.
app.get('/selladora/:codigo/cola-fragmento', requireLogin, async (req, res) => {
  const codigo = req.params.codigo;
  try {
    const p = await getPool();
    const ordenes = await obtenerColaOrdenes(p, codigo);
    res.type('html').send(renderColaOrdenes(ordenes, codigo, req.session.usuario.codigoOperarioPRD));
  } catch (err) {
    res.status(500).type('html').send('');
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
    // ProximaCalidad (03/09/2026): cuando debe salir el proximo chequeo de Calidad, guardado en BD
    // -- no en un setTimeout del navegador, que se reiniciaba cada vez que se recargaba la pagina o
    // se navegaba a otra pestaña y casi nunca llegaba a completar el conteo de 20-30 min. Si la
    // orden esta Activa y todavia no tiene una fecha programada (primera vez que se abre
    // Informacion desde que se inicio), se inicializa aca mismo.
    // FIX 03/09/2026: ahora tambien exige que la EJECUCION (no solo la orden) este realmente en
    // curso -- Activa o En pausa, nunca 'PendienteOperador' (nadie ha retomado el control todavia,
    // no tiene sentido pedir un chequeo de calidad sin un operario real detras). Si esta en
    // PendienteOperador no se inicializa una fecha nueva NI se manda la que ya hubiera guardada --
    // se retoma sola, sin perderse, la proxima vez que alguien la retome y vuelva Activa/En pausa.
    let proximaCalidad = null;
    const dtEjecucion = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado, ProximaCalidad FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEjecucion.recordset.length > 0) {
      idEjecucion = dtEjecucion.recordset[0].IdEjecucion;
      const estadoEjecucion = dtEjecucion.recordset[0].Estado;
      proximaCalidad = dtEjecucion.recordset[0].ProximaCalidad;
      if (estadoEjecucion === 'En pausa') {
        const dtPausa = await p.request().input('idEjecucion', idEjecucion).query(
          `SELECT TOP 1 Tipo, Subtipo, Observaciones, HoraInicio FROM SEL_TiempoMuerto WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC`
        );
        if (dtPausa.recordset.length > 0) pausaActiva = dtPausa.recordset[0];
      }
      if (orden.Estado === 'Activa' && estadoEjecucion !== 'PendienteOperador') {
        if (proximaCalidad == null) {
          proximaCalidad = calcularProximaCalidad();
          await p.request().input('idEjecucion', idEjecucion).input('proximaCalidad', proximaCalidad).query(
            `UPDATE SEL_EjecucionOrden SET ProximaCalidad = @proximaCalidad WHERE IdEjecucion = @idEjecucion`
          );
        }
      } else {
        proximaCalidad = null;
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

    const avance = await obtenerAvanceProduccion(p, idOrden);

    res.send(renderOrdenDetalle(orden, totalBultos, historial, req.session.usuario.nombre, codigo, pausaActiva, avance, proximaCalidad));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
  }
});

// Avance de produccion en vivo -- lo pide scriptAvanceProduccion cada 4s para refrescar la tarjeta
// del encabezado sin recargar la pagina, porque el acumulado sube con cada paquete que se registra
// (a pedido del usuario, 02/09/2026). Ver obtenerAvanceProduccion para las reglas del calculo.
app.get('/selladora/:codigo/orden/:idOrden/avance-produccion', requireLogin, async (req, res) => {
  const { idOrden } = req.params;
  try {
    const p = await getPool();
    const avance = await obtenerAvanceProduccion(p, idOrden);
    res.json({ ok: true, ...avance });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Offset de Linea que usa el flujo de Node-RED para marcar un residuo "hijo" de un bulto en
// PRDProduccion (ver el script nativo que arma ese INSERT/UPDATE, no vive en este repo) --
// LineaHijo = LineaPadre (= SEL_Bultos.num_bulto) + este offset segun el tipo. Confirmado con el
// usuario 02/09/2026 (Refilado no estaba en el script que compartio, pero sigue el mismo patron).
const OFFSET_RESIDUO_POR_TIPO = { 1000: 'Retal', 2000: 'Refilado', 3000: 'Troquelado', 4000: 'No conforme' };

// Bultos (indice relativo), sus pesajes/paquetes (SEL_PesajeElemento) y los residuos que hayan
// generado (Retal/Refilado/Troquelado/No conforme, ver OFFSET_RESIDUO_POR_TIPO) de una orden --
// compartida entre la pagina completa de /bultos y su /bultos/fragmento (el polling de
// scriptActualizarBultos pide solo el fragmento, para no reconstruir cabecera/estilos en cada
// actualizacion).
async function obtenerBultosYPesajes(p, idOrden) {
  const bultosResult = await p.request().input('idOrden', idOrden).query(`
    SELECT b.id, b.num_bulto, b.serialPadre, b.CantidadTotal, b.estado, ISNULL(b.Golpes,0) AS Golpes, b.Potencia,
           FORMAT(b.HoraInicio, 'dd/MM/yyyy HH:mm') AS HoraInicio,
           FORMAT(b.HoraFin, 'dd/MM/yyyy HH:mm') AS HoraFin
    FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden
    ORDER BY b.num_bulto ASC
  `);
  const bultos = bultosResult.recordset.map((b, idx) => ({ ...b, numRelativo: idx + 1 }));

  let pesajesPorBulto = new Map();
  let residuosPorBulto = new Map();
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

    // Mismo criterio de "fila padre" que el script de Node-RED (ResolverContextoBultoParaHijo):
    // Fecha/Lote/Elemento del bulto, buscando el/los hijo(s) en esos 4 Linea posibles. Un bulto
    // puede no tener ninguno (lo normal) o tener varios tipos a la vez.
    const residuosResult = await p.request().input('idOrden', idOrden).query(`
      SELECT b.id AS IdBulto, pp.Linea - b.num_bulto AS OffsetTipo, pp.Cantidad
      FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      INNER JOIN PRDProduccion pp
        ON pp.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
        AND pp.Lote = RIGHT('0' + CAST(b.mes AS VARCHAR(2)), 2) + RIGHT('0' + CAST(b.dia AS VARCHAR(2)), 2)
        AND pp.Elemento = b.refsalida
        AND pp.Linea IN (b.num_bulto + 1000, b.num_bulto + 2000, b.num_bulto + 3000, b.num_bulto + 4000)
      WHERE ej.IdOrden = @idOrden
    `);
    for (const row of residuosResult.recordset) {
      const tipo = OFFSET_RESIDUO_POR_TIPO[row.OffsetTipo];
      if (!tipo) continue; // offset desconocido -- no deberia pasar, se ignora en vez de romper la pagina
      if (!residuosPorBulto.has(row.IdBulto)) residuosPorBulto.set(row.IdBulto, []);
      residuosPorBulto.get(row.IdBulto).push({ tipo, cantidad: Number(row.Cantidad) });
    }
  }

  return { bultos, pesajesPorBulto, residuosPorBulto };
}

// Cada paquete producido cuenta como 100 unidades cuando la orden se mide en unidades (regla de
// negocio dada por el usuario, 02/09/2026 -- no sale de ninguna columna, es fija).
const UNIDADES_POR_PAQUETE = 100;

// Proximo momento en que debe salir el chequeo de Calidad -- entre 20 y 30 minutos desde ahora
// (mismo rango que antes, cuando era un setTimeout del navegador). Se llama al inicializar
// SEL_EjecucionOrden.ProximaCalidad por primera vez (ver GET /selladora/:codigo/orden/:idOrden) y
// para reprogramar el siguiente chequeo despues de que se responde uno (ver POST /api/comando,
// comando 'calidad').
function calcularProximaCalidad() {
  const minMs = 20 * 60 * 1000;
  const maxMs = 30 * 60 * 1000;
  return new Date(Date.now() + minMs + Math.random() * (maxMs - minMs));
}

// Avance de produccion de una orden: lo producido contra lo pedido (tarjeta del encabezado de
// Informacion, ver renderOrdenDetalle). Reglas acordadas con el usuario (02/09/2026):
//  - La meta sale de SEL_OrdenProduccion: KilosSolicitados manda si tiene valor (> 0) y el avance
//    se mide en kg; si no, UnidadesSolicitadas y se mide en unidades. Si ninguna tiene valor no hay
//    meta configurada (tipo null) y la tarjeta no se muestra.
//  - Lo producido es el acumulado de TODOS los bultos Activo + Cerrado de la orden (no solo el
//    bulto activo, a diferencia de /resumen-bulto-activo): en kg, la suma de PesoPaqueGr, que pese
//    a llamarse "Gr" guarda KILOGRAMOS (ver FIX 02/09/2026 en scriptResumenBultoActivo); en
//    unidades, la cantidad de paquetes x UNIDADES_POR_PAQUETE.
//    'Temporal' queda fuera a proposito -- son bultos sin ningun paquete pesado (ver finalizarOrden).
//  - El valor cambia solo a medida que se registran paquetes nuevos, por eso la pagina lo refresca
//    con polling (scriptAvanceProduccion), igual que el resumen del bulto activo.
async function obtenerAvanceProduccion(p, idOrden) {
  const dtOrden = await p.request().input('idOrden', idOrden).query(
    `SELECT KilosSolicitados, UnidadesSolicitadas FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`
  );
  if (dtOrden.recordset.length === 0) return { tipo: null };

  const kilosSolicitados = Number(dtOrden.recordset[0].KilosSolicitados) || 0;
  const unidadesSolicitadas = Number(dtOrden.recordset[0].UnidadesSolicitadas) || 0;
  const tipo = kilosSolicitados > 0 ? 'kg' : (unidadesSolicitadas > 0 ? 'unidades' : null);
  if (!tipo) return { tipo: null };

  const dtProducido = await p.request().input('idOrden', idOrden).query(`
    SELECT ISNULL(SUM(pe.PesoPaqueGr), 0) AS PesoTotalKg, COUNT(*) AS Paquetes
    FROM SEL_PesajeElemento pe
    INNER JOIN SEL_Bultos b ON b.id = pe.id_bulto
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.estado IN ('Activo', 'Cerrado')
  `);
  const paquetes = Number(dtProducido.recordset[0].Paquetes);
  const producido = tipo === 'kg'
    ? Number(dtProducido.recordset[0].PesoTotalKg)
    : paquetes * UNIDADES_POR_PAQUETE;
  const programado = tipo === 'kg' ? kilosSolicitados : unidadesSolicitadas;

  return { tipo, producido, programado, porcentaje: (producido / programado) * 100, paquetes };
}

// Formato de las cantidades de la tarjeta de avance -- kg con 2 decimales, unidades enteras, ambos
// con separador de miles en formato es-CO ("1.234,56 kg"). El cliente formatea igual en
// scriptAvanceProduccion para que el valor no cambie de forma al refrescarse solo.
function formatearCantidadAvance(valor, tipo) {
  if (tipo === 'kg') return valor.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kg';
  return Math.round(valor).toLocaleString('es-CO') + ' uds';
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

    const { bultos, pesajesPorBulto, residuosPorBulto } = await obtenerBultosYPesajes(p, idOrden);

    res.send(renderBultosOrden(orden, bultos, pesajesPorBulto, residuosPorBulto, req.session.usuario.nombre, codigo));
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
    const { bultos, pesajesPorBulto, residuosPorBulto } = await obtenerBultosYPesajes(p, idOrden);
    res.send(renderTarjetasBultos(bultos, pesajesPorBulto, residuosPorBulto));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Resumen del bulto Activo (paquetes pesados + peso acumulado) para la pagina de Informacion --
// a pedido del usuario (27/08/2026), en vivo via polling (ver scriptResumenBultoActivo()). Si la
// orden no tiene bulto Activo en este momento devuelve ceros, no un error (puede pasar entre que
// se cierra un bulto y se abre el siguiente). Tambien devuelve idBulto (01/09/2026) -- lo guarda
// scriptResumenBultoActivo en window.idBultoActivo para que confirmarPesoYEnviar (scriptComandos)
// lo mande junto con el peso al marcar un residuo/salida no conforme. FIX 02/09/2026: ademas
// devuelve el ULTIMO paquete pesado (consecutivo/peso) -- scriptResumenBultoActivo lo guarda en
// window.ultimoPaqueteBultoActivo para que, al confirmar "Cierre bulto", se reimprima de una la
// etiqueta de ese ultimo paquete (mismo mecanismo de reimprimirPaquete en Bultos, ver
// confirmarCerrarBultoYReimprimir en scriptComandos).
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
      return res.json({ ok: true, paquetes: 0, pesoTotalKg: 0, idBulto: null, ultimoConsecutivo: null, ultimoPesoKg: null });
    }
    const idBulto = dtBultoActivo.recordset[0].id;
    // PesoPaqueGr guarda kilogramos pese al nombre (ver FIX 02/09/2026 en scriptResumenBultoActivo),
    // por eso la suma sale ya en kg y no se convierte.
    const resumen = await p.request().input('idBulto', idBulto).query(`
      SELECT COUNT(*) AS Paquetes, ISNULL(SUM(PesoPaqueGr), 0) AS PesoTotalKg
      FROM SEL_PesajeElemento WHERE id_bulto = @idBulto
    `);
    const dtUltimo = await p.request().input('idBulto', idBulto).query(`
      SELECT TOP 1 ConsecutivoPaquete, PesoPaqueGr
      FROM SEL_PesajeElemento WHERE id_bulto = @idBulto
      ORDER BY ConsecutivoPaquete DESC
    `);
    const ultimo = dtUltimo.recordset[0] || null;
    res.json({
      ok: true,
      paquetes: resumen.recordset[0].Paquetes,
      pesoTotalKg: Number(resumen.recordset[0].PesoTotalKg),
      idBulto,
      ultimoConsecutivo: ultimo ? ultimo.ConsecutivoPaquete : null,
      ultimoPesoKg: ultimo ? Number(ultimo.PesoPaqueGr) : null
    });
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

// Valida que la orden pueda Iniciar / recibir +Rollo ANTES de abrir la ventana emergente de
// escaneo, y devuelve las bolsas x golpe en curso para mostrarlas en la vista previa. Reemplaza
// a GET /selladora/:codigo/orden/:idOrden/escanear (la pantalla aparte, eliminada el 04/09/2026):
// hace exactamente las mismas validaciones, solo que responde JSON en vez de una pagina. La
// escritura la sigue haciendo POST .../rollo, que vuelve a validar por su cuenta.
app.get('/api/selladora/orden/:idOrden/rollo/preparar', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const esNuevoRollo = req.query.nuevo === '1';
  const usuario = req.session.usuario;

  if (!usuario.codigoOperarioPRD) {
    return res.json({ ok: false, error: 'Su usuario no tiene un operario de planta configurado (CodigoOperarioPRD). Pida a sistemas que lo configure antes de usar Iniciar/Añadir Rollo.' });
  }

  try {
    const p = await getPool();
    const v = esNuevoRollo ? await validarPuedeAnadirRollo(p, idOrden) : await validarPuedeIniciar(p, idOrden);
    if (!v.ok) return res.json({ ok: false, error: v.error });
    res.json({ ok: true, bolsasActual: v.bolsasActual || 0 });
  } catch (err) {
    res.json({ ok: false, error: err.message });
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
// sin prefijo ('retal'/'troquelado'/'refilado', no 'residuo:retal'). 'reimprimir_etiqueta'
// (01/09/2026) es distinto de 'imprimir_etiqueta' a proposito -- ese ultimo imprime la etiqueta del
// paquete que la bascula esta pesando en este momento (Node-RED lo resuelve solo, sin `datos`);
// reimprimir_etiqueta va con `datos` describiendo un paquete YA pesado (idBulto/serialBulto/
// consecutivoPaquete/pesoGr, ver reimprimirPaquete() en renderBultosOrden) para que Node-RED sepa
// cual de todos hay que volver a imprimir, no necesariamente el que esta activo ahora.
// 'retal'/'troquelado'/'refilado'/'no_conforme' (01/09/2026) van con `datos: {peso, idBulto}` -- el
// peso lo escribe el operario en una ventana emergente (confirmarPesoYEnviar en scriptComandos)
// antes de enviarse; idBulto es el bulto Activo en ese momento (window.idBultoActivo, lo mantiene
// scriptResumenBultoActivo -- puede ser null si no hay bulto Activo). Ambos van para que Node-RED
// sepa a que bulto pertenece e imprima la etiqueta del residuo/salida no conforme.
const COMANDOS_VALIDOS = new Set([
  'imprimir_etiqueta', 'reimprimir_etiqueta', 'cierre_bulto', 'retal', 'troquelado', 'refilado', 'calidad', 'no_conforme'
]);

// Pausa (SEL_TiempoMuerto) -- a diferencia de los comandos de arriba, esto SI escribe directo en
// esta BD (no pasa por Node-RED): es un simple cambio de estado + una fila de auditoria, no toca
// inventario/numeracion como Retal/Troquelado, asi que no hacia falta migrarlo. "SEL_EjecucionOrden
// debe quedar UN solo registro por orden" (mismo criterio que scan-rollo.js) -- se busca por
// IdOrden, no hay que resolver bulto activo para esto.
const MOTIVOS_PAUSA_VALIDOS = new Set(['descanso', 'mantenimiento', 'alistamiento', 'orden_aseo', 'limpieza', 'otro']);
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
    // Al responder Calidad, se reprograma el proximo chequeo (otros 20-30 min desde ahora, ver
    // calcularProximaCalidad) y se guarda lo respondido en SEL_ChequeoCalidad/Detalle (ver
    // registrarChequeoCalidad, 03/09/2026) -- si cualquiera de las dos cosas fallara no se revienta
    // el comando ya enviado a Node-RED, solo se registra en consola.
    if (comando === 'calidad') {
      try {
        const p = await getPool();
        await p.request().input('idOrden', Number(idOrden)).input('proximaCalidad', calcularProximaCalidad()).query(
          `UPDATE SEL_EjecucionOrden SET ProximaCalidad = @proximaCalidad WHERE IdOrden = @idOrden`
        );
        const operarioCodigo = req.session.usuario.codigoOperarioPRD;
        if (operarioCodigo) {
          await registrarChequeoCalidad(p, { idOrden: Number(idOrden), operarioCodigo, respuestas: datos });
        } else {
          console.error('No se guardo el chequeo de Calidad: el usuario no tiene codigoOperarioPRD.');
        }
      } catch (errReprogramar) {
        console.error('Error reprogramando ProximaCalidad / guardando chequeo de Calidad:', errReprogramar.message);
      }
    }
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
