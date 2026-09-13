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
const { consultarSerial, confirmarRollo, alternarReferenciaGrupo } = require('./scan-rollo');
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

// Estado del bulto TAL COMO SE MUESTRA en pantalla. Un bulto solo puede VERSE como Activo,
// Temporal o Cerrado (a pedido del usuario, 10/09/2026): 'EnEspera' es un detalle interno del
// sellado en paralelo -- el bulto parqueado de una referencia que no esta recibiendo paquetes
// ahora mismo, ver alternarReferenciaGrupo -- y al operario no le dice nada. Se muestra como lo
// que en realidad es: Activo si ya tiene paquetes pesados, Temporal si esta vacio (misma
// distincion que usa el resto del sistema para 'Temporal'). El estado REAL no se toca: la BD
// sigue guardando 'EnEspera', que es lo que hace que el PLC nunca vea dos bultos a la vez.
function estadoVisibleBulto(estado, tienePaquetes) {
  if (estado !== 'EnEspera') return estado;
  return tienePaquetes ? 'Activo' : 'Temporal';
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
    /* Renglon de detalle dentro de una isla (ej. "3 bulto(s) en esta orden") -- .orden-elemento no
       sirve aca porque su estilo esta acotado a .orden-cola. */
    .isla .isla-detalle { font-size: 13px; color: var(--texto-suave); margin: -4px 0 10px; }
    /* Isla de "Bultos producidos": el texto a la izquierda y su boton a la DERECHA, en la misma
       linea (a pedido del usuario, 09/09/2026) -- antes el boton iba debajo del texto. Hasta el
       11/09/2026 al lado iba tambien la isla de "Reporte de produccion", que se elimino.
       La usan las DOS paginas -- la de una sola referencia y la del pedido con varias (a pedido
       del usuario, 11/09/2026: el boton tiene que verse igual en ambas). Justamente por eso el
       boton es de ancho FIJO (.isla .btn-isla, 140px) y no del 100%: las dos islas no miden lo
       mismo (en el pedido agrupado comparte fila con "Produccion" y en la otra va sola), asi que
       un boton al 100% saldria de un tamano distinto en cada pagina. */
    /* Base mas ancha que el resto de islas (220px): con el boton fijo de 140px al lado, a 220px al
       texto le quedaban ~36px. Asi no se aprieta si vuelve a acompanarla otra isla. */
    .isla-con-boton { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: 1 1 300px; }
    .isla-con-boton .isla-texto { min-width: 0; }
    .isla-con-boton .label { margin-bottom: 4px; }
    .isla-con-boton .isla-detalle { margin: 0; }
    /* Boton de una isla. Se fijan alto, ancho y display de forma explicita para que no herede el
       tamano de .btn-imprimir (el boton grande de "Imprimir etiqueta" del recuadro de peso, con
       min-height 110px y width 100% de toque grande para la tableta): cualquier boton de isla
       tiene que salir del mismo tamano, lleve la clase de color que lleve.
       flex-shrink:0 evita ademas que la fila de la isla lo apriete. */
    .isla .btn-isla {
      width: 140px; min-height: 0; padding: 10px 16px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center; text-align: center;
    }
    .isla .orden-acciones { display: flex; gap: 8px; flex-wrap: wrap; }
    .isla .orden-acciones form { width: auto; }
    .btn-accion {
      font-size: 14px; font-weight: 600; padding: 10px 16px; border: none; border-radius: 10px;
      cursor: pointer; text-decoration: none; display: inline-block; color: white;
      box-shadow: none; width: auto;
    }
    .btn-iniciar { background: #0078d7; }
    .btn-anadir { background: #0078d7; }
    .btn-traslado { background: #8e44ad; }
    .seccion-traslado { margin-top: 16px; }
    .seccion-traslado .traslado-campo { margin-bottom: 12px; }
    .seccion-traslado .traslado-campo:last-of-type { margin-bottom: 16px; }
    .grupo-sellado-box { margin-bottom: 16px; background: #f3e9f9; border: 1px solid #d9bfe8; }
    .grupo-sellado-actual { font-size: 13px; color: var(--texto-suave); margin-bottom: 4px; }
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
    /* La tarjeta ENTERA abre/cierra sus paquetes, no solo el renglon "Paquetes pesados" (a pedido
       del usuario, 09/09/2026) -- ver scriptTarjetaBultoInteractiva. Dos precisiones del selector:
         - va acotado a #contenedor-bultos porque la seccion "Trasladar paquete" (renderSeccionTraslado)
           tambien es un .card con .card-top, pero vive FUERA de ese contenedor y el clic ahi no
           pliega nada -- sin acotar, esa cabecera mostraria un cursor que promete algo que no pasa;
         - el cursor va en las dos zonas de cabecera (numero/estado y rejilla de datos) y no en
           .card entero, para no prometerlo tampoco sobre el desplegable ya abierto. */
    #contenedor-bultos .card-top, #contenedor-bultos .card-grid { cursor: pointer; }
    #contenedor-bultos .card:hover { box-shadow: 0 2px 10px rgba(0,0,0,0.13); }
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
    /* ===== Sellado en paralelo: tarjeta interactiva por referencia de salida (10/09/2026) =====
       Un pedido con VARIAS referencias de salida (ej. el 11410) tiene su propio apartado de
       informacion (ver renderGrupoSelladoDetalle): cada referencia es una tarjeta que se abre y
       cierra sola -- todas colapsadas al entrar, a pedido del usuario -- y trae adentro lo que
       antes solo existia en la pagina de UNA referencia (peso/paquetes/acumulado propios, Imprimir
       etiqueta, Cierre bulto y sus Especificaciones). El color de --color-ref lo pone el servidor
       por referencia (ver COLORES_REFERENCIA_GRUPO) y es el MISMO en la pagina de bultos del
       grupo, para que el operario asocie color <-> referencia de un vistazo. */
    .ref-card { background: white; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 12px; }
    .ref-card > summary { list-style: none; cursor: pointer; }
    .ref-card > summary::-webkit-details-marker { display: none; }
    .ref-card-cabecera {
      display: flex; align-items: center; gap: 14px; padding: 14px 16px;
      border-bottom: 4px solid var(--color-ref, var(--azul-osc));
      border-radius: 14px 14px 0 0;
    }
    /* Contraida, la tarjeta ES solo su encabezado: el subrayado de color tiene que seguir el
       contorno redondeado de la tarjeta (a pedido del usuario, 10/09/2026) -- recto se sale por
       las esquinas de abajo. Abierta vuelve a ser recto, que ahi si separa encabezado y cuerpo. */
    .ref-card:not([open]) .ref-card-cabecera { border-radius: 14px; }
    .ref-card-id { flex: 1 1 160px; min-width: 0; }
    .ref-card-codigo { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ref-card-nombre { font-size: 13px; color: var(--texto-suave); margin-top: 2px; }
    .ref-card-avance { flex: 0 1 210px; min-width: 130px; }
    .ref-card-avance .avance-header-top { margin-bottom: 4px; }
    .ref-card-chevron { font-size: 15px; color: var(--texto-suave); flex-shrink: 0; transition: transform 0.15s; }
    .ref-card[open] .ref-card-chevron { transform: rotate(90deg); }
    .ref-card-cuerpo { padding: 16px; }
    .ref-card-cuerpo .peso-top { margin-bottom: 16px; }
    .ref-card-cuerpo .imprimir-acciones-grid { margin-bottom: 14px; }
    .ref-card-extras { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .ref-card-extras .btn-accion { width: auto; margin-top: 0; }
    /* Residuos DENTRO de la tarjeta de cada referencia (10/09/2026, a pedido del usuario): se
       registran contra el bulto de esa referencia, por eso ya no viven en una isla aparte como en
       la pagina de una orden de una sola referencia. */
    .ref-residuos { border-top: 1px solid #eef0f2; padding-top: 12px; margin-bottom: 14px; }
    .ref-residuos .orden-acciones { display: flex; gap: 8px; flex-wrap: wrap; }
    .ref-especificaciones { border-top: 1px solid #eef0f2; padding-top: 12px; }
    .ref-especificaciones > summary {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--texto-suave);
      cursor: pointer; margin-bottom: 10px; list-style: none;
    }
    .ref-especificaciones > summary::-webkit-details-marker { display: none; }

    /* Bultos del grupo: filtro por referencia (una lista desplegable, a pedido del usuario
       10/09/2026 -- antes eran botones tipo chip) e identificacion de cada bulto con el color de
       SU referencia. Ver renderBultosGrupo. El punto de color y el borde del desplegable toman el
       color de la referencia elegida (lo pone scriptFiltroReferencias al cambiar la seleccion). */
    .filtro-refs {
      background: white; border-radius: 14px; padding: 12px 14px; margin-bottom: 14px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .filtro-refs .label { margin: 0; flex-shrink: 0; }
    .filtro-refs-punto {
      width: 14px; height: 14px; border-radius: 999px; flex-shrink: 0;
      background: var(--color-ref, var(--texto-suave));
    }
    .filtro-refs-select {
      flex: 1 1 260px; width: auto; min-width: 0; cursor: pointer;
      font-size: 15px; font-weight: 600; padding: 10px 12px;
      border: 2px solid var(--color-ref, #cfd4da);
    }
    .filtro-refs-conteo { font-size: 13px; color: var(--texto-suave); font-weight: 600; flex-shrink: 0; }
    .bulto-encabezado { flex: 1 1 auto; min-width: 0; }
    .bulto-ref { margin-top: 8px; }
    .bulto-ref-subrayado { height: 4px; border-radius: 999px; background: var(--color-ref, var(--azul-osc)); margin-bottom: 6px; }
    .bulto-ref-nombre { font-size: 12px; color: var(--texto-suave); font-weight: 600; }
    .oculto { display: none !important; }
    @media (max-width: 480px) {
      .ref-card-cabecera { flex-wrap: wrap; }
      .ref-card-avance { flex: 1 1 100%; }
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
  <script>${scriptAvisoPedidoNuevo(null)}</script>
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

  // Sellado en paralelo (08/09/2026, ampliado 09/09/2026 -- ver DISENO_SELLADO_PARALELO_08092026.md):
  // las órdenes de un mismo grupo (IdGrupoSellado) que TODAS comparten el mismo Estado -- ya sea
  // 'Pendiente' (nadie las ha iniciado) o 'Activa' (todas en curso, tras el Iniciar que las arranca
  // de una vez) -- se fusionan en UNA sola tarjeta -- es un solo proceso físico, no tiene sentido
  // mostrar 3 tarjetas sueltas ni para arrancarlo ni mientras corre. FIX 09/09/2026 (a pedido del
  // usuario, reportando el Pedido 11408 listado en 2 tarjetas Activa sueltas): antes solo se
  // fusionaba en 'Pendiente' -- al pasar a Activa se "desfusionaba" y volvían a verse sueltas. Ahora
  // la tarjeta Activa fusionada trae UN "Información" (a la página de grupo, con Alternar/Finalizar
  // por referencia) y UN "Finalizar" (finaliza TODO el grupo junto, da igual desde cuál se llame).
  // FIX 09/09/2026 (a pedido del usuario, screenshot de las 2 tarjetas "Pend. validación" sueltas
  // del Pedido 11408): también se fusiona en 'PendienteValidacion' -- las 3 referencias siempre
  // terminan el Finalizar juntas (finalizarOrden las pasa a las 3 a la vez), así que mostrarlas
  // sueltas ahí no aporta nada y rompe la uniformidad con las tarjetas Pendiente/Activa. Si algún
  // miembro necesita "tomar control" de su ejecución (ver necesitaTomarControlMiembro más abajo),
  // NO se fusiona -- se muestra cada una individual, para no esconder esa acción puntual.
  const gruposFusionables = new Map(); // IdGrupoSellado -> [ordenes]
  ordenes.forEach(o => {
    if (o.IdGrupoSellado == null) return;
    if (!gruposFusionables.has(o.IdGrupoSellado)) gruposFusionables.set(o.IdGrupoSellado, []);
    gruposFusionables.get(o.IdGrupoSellado).push(o);
  });
  const necesitaTomarControlMiembro = (m) => {
    const flag = m.Estado === 'Activa' && m.EstadoEjecucion === 'PendienteOperador';
    const distinto = m.Estado === 'Activa' && m.EstadoEjecucion != null && !!miOperario && m.OperarioEjecucionCodigo !== miOperario;
    return flag || distinto;
  };
  for (const [idGrupo, miembros] of gruposFusionables) {
    const estadoComun = miembros[0].Estado;
    const todosMismoEstado = miembros.every(m => m.Estado === estadoComun);
    const estadoFusionable = estadoComun === 'Pendiente' || estadoComun === 'Activa' || estadoComun === 'PendienteValidacion';
    const algunoNecesitaControl = estadoComun === 'Activa' && miembros.some(necesitaTomarControlMiembro);
    if (!todosMismoEstado || !estadoFusionable || algunoNecesitaControl) gruposFusionables.delete(idGrupo);
  }

  const idsYaFusionados = new Set();
  const filas = ordenes.map(o => {
    if (o.IdGrupoSellado != null && gruposFusionables.has(o.IdGrupoSellado)) {
      if (idsYaFusionados.has(o.IdGrupoSellado)) return ''; // ya se pintó la tarjeta fusionada de este grupo
      idsYaFusionados.add(o.IdGrupoSellado);
      const miembros = gruposFusionables.get(o.IdGrupoSellado).sort((a, b) => a.IdOrden - b.IdOrden);
      const ancla = miembros[0];
      // Una referencia por renglon (a pedido del usuario, 10/09/2026) -- antes iban en una sola
      // linea separadas por " + ", que con nombres largos ("LPBTRSTA30C0.25N1 PANADERÍAS ROLLO
      // ALIÑADO 70grs-P DEL FONCE") era ilegible en la tableta.
      const referencias = miembros.map(m => `<div>${m.Elemento}</div>`).join('');
      let accionesGrupo, infoFinalizadaGrupo = '';
      if (ancla.Estado === 'Pendiente') {
        // Iniciar un grupo entra por el mismo protocolo de arranque que una orden suelta (ver
        // scriptProtocoloArranque): es un solo proceso fisico -- una sola limpieza, un solo
        // chequeo de peligro quimico, un solo rollo y un solo alistamiento para las 3 referencias.
        // El protocolo corre sobre la ANCLA, que es la orden que confirmarRollo usa para arrancar
        // a los hermanos del grupo.
        accionesGrupo = `<button type="button" class="btn-accion btn-iniciar" onclick="iniciarProtocoloArranque(${ancla.IdOrden})">▶ Iniciar</button>`;
      } else if (ancla.Estado === 'PendienteValidacion') {
        accionesGrupo = `<span class="label">Esperando validación del digitador</span>`;
        const horaFinGrupo = formatearFechaHora(ancla.HoraFinReal);
        if (horaFinGrupo) infoFinalizadaGrupo = `<div class="orden-elemento">Finalizada: ${horaFinGrupo}</div>`;
      } else {
        accionesGrupo = `<form method="post" action="/api/selladora/orden/${ancla.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
             <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
           </form>`;
      }
      return `
        <div class="orden-cola">
          <div class="orden-info">
            <div class="orden-pedido">🔗 Pedido ${ancla.NumeroPedido || '—'} ${badgeEstadoOrden(ancla.Estado)}</div>
            <div class="orden-elemento">${referencias}</div>
            <div class="orden-elemento" style="color:var(--texto-suave);">Un solo proceso -- ${miembros.length} referencias de salida</div>
            ${infoFinalizadaGrupo}
          </div>
          <div class="orden-acciones">
            <a class="btn-accion btn-info" href="/selladora/${maquinaCodigo}/grupo/${o.IdGrupoSellado}">ℹ Información</a>
            ${accionesGrupo}
          </div>
        </div>`;
    }
    // FIX 09/09/2026 (a pedido del usuario): para una orden que pertenece a un grupo SELLADORA,
    // "Información" ya no lleva directo a la página tradicional de una sola referencia -- lleva
    // primero a /selladora/:codigo/grupo/:idGrupo (ver renderGrupoSelladoDetalle), que lista las
    // referencias del grupo con su avance y los botones Alternar/Finalizar. Solo para agrupadas --
    // una orden normal sigue yendo directo como siempre.
    const hrefInformacion = o.IdGrupoSellado != null
      ? `/selladora/${maquinaCodigo}/grupo/${o.IdGrupoSellado}`
      : `/selladora/${maquinaCodigo}/orden/${o.IdOrden}`;
    let acciones = `<a class="btn-accion btn-info" href="${hrefInformacion}">ℹ Información</a>`;
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
      // Iniciar ya no abre el escaneo del rollo de una: entra al protocolo de arranque
      // (limpieza -> peligro quimico -> rollo -> chequeo del rollo -> alistamiento -> temperatura),
      // ver scriptProtocoloArranque. El escaneo sigue estando, pero como paso 3.
      acciones += `<button type="button" class="btn-accion btn-iniciar" onclick="iniciarProtocoloArranque(${o.IdOrden})">▶ Iniciar</button>`;
    } else if (o.Estado === 'Activa') {
      // Sellado en paralelo (08/09/2026): "+Rollo" no aplica a una orden agrupada -- el rollo de
      // entrada ya quedó registrado UNA sola vez para las 3 referencias al dar "Iniciar" en la
      // ancla, no hay "rollo adicional" que agregar por separado en cada una.
      acciones += `
        ${o.IdGrupoSellado == null ? `<button type="button" class="btn-accion btn-anadir" onclick="abrirEscaneoRollo(${o.IdOrden}, true, { antesDeConfirmar: preguntarEstadoRolloNuevo })">+ Rollo</button>` : ''}
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
// Peso en vivo de la bascula (/ws/peso). CAMBIO 10/09/2026: ya no escribe en UN par de elementos
// con id fijo sino en TODOS los que lleven .peso-vivo-numero/.peso-vivo-estado -- la pagina de un
// pedido con varias referencias de salida muestra el mismo peso dentro de la tarjeta de CADA
// referencia (la bascula es una sola, ver renderGrupoSelladoDetalle), y ahi hay tantos recuadros
// como referencias. Con una sola referencia el resultado es identico a antes: un solo elemento.
function scriptPesoEnVivo() {
  return `
    (function() {
      var pesoNumeros = document.querySelectorAll('.peso-vivo-numero');
      var pesoEstados = document.querySelectorAll('.peso-vivo-estado');
      if (pesoNumeros.length === 0) return;

      function fijarEstado(conectado, texto) {
        pesoEstados.forEach(function(el) {
          el.textContent = texto;
          el.className = 'peso-estado peso-vivo-estado ' + (conectado ? 'conectado' : 'desconectado');
        });
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
          pesoNumeros.forEach(function(el) { el.textContent = texto; });
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

// Aviso de "Programación pidió suspender esta orden" (a pedido del usuario, 07/09/2026 -- reunión
// Germán/Ángela/Carlos, alternativa A: la decisión de reprorizar es de Programación/escritorio, el
// operario solo decide el detalle físico de terminar o no el bulto en curso).
//
// Sondea /selladora/:codigo/estado-suspension cada 5s (mismo criterio de "nunca pisar un modal
// abierto" que ya usa intentarAbrirCalidad -- reintenta en vez de forzarse encima). Si el servidor
// contesta que hay una orden con SEL_EjecucionOrden.Estado='PendienteSuspension' para esta máquina,
// muestra un modal con dos botones y el mismo pitido/vibración que ya usa scriptAvisoPedidoNuevo
// (WebAudio, sin archivo de sonido -- no repetir esa lógica aparte, se duplica acá porque cada
// script de esta app vive en su propia función aislada, no hay un modulo compartido entre ellos).
//
// "Sí, terminar el bulto": no hace falta que el cliente haga nada más ahí mismo -- el servidor pasa
// la bandera a 'SuspensionEnCurso' (deja de preguntar) y cuando el PLC cierre el bulto por su
// cuenta, el trigger nuevo (trg_SEL_Bultos_SuspenderTemporal, ver nueva produccion/SQL) hace la
// transición sola, sin que el operario tenga que volver a tocar nada.
// "No, suspender ahora": el servidor corta el bulto Activo ya mismo (sin esperar al PLC).
function scriptAvisoSuspension(maquinaCodigo) {
  return `
    (function() {
      var MAQUINA = ${jsString(maquinaCodigo)};
      var idPreguntado = null; // no repreguntar por la MISMA orden en lo que dure la sesión de la pestaña
      var audio = null;

      function contexto() {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audio) audio = new Ctx();
        return audio;
      }
      function pitar() {
        try {
          var ctx = contexto();
          if (!ctx || ctx.state !== 'running') return;
          [0, 0.26].forEach(function(retraso) {
            var osc = ctx.createOscillator();
            var vol = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = 660;
            vol.gain.value = 0.22;
            osc.connect(vol); vol.connect(ctx.destination);
            osc.start(ctx.currentTime + retraso);
            osc.stop(ctx.currentTime + retraso + 0.18);
          });
        } catch (e) {}
      }

      async function responder(idOrden, terminarBulto) {
        try {
          await fetch('/api/selladora/orden/' + idOrden + '/responder-suspension', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ terminarBulto: terminarBulto })
          });
        } catch (e) {}
        location.reload();
      }

      function preguntar(datos) {
        if (typeof Swal === 'undefined') { setTimeout(function() { revisar(); }, 2000); return; }
        if (Swal.isVisible()) { setTimeout(function() { revisar(); }, 5000); return; }

        idPreguntado = datos.idOrden;
        pitar();
        if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200, 100, 200]); } catch (e) {} }
        Swal.fire({
          icon: 'warning',
          title: 'Programación pidió suspender esta orden',
          html: 'Pedido <strong>' + (datos.numeroPedido || '—') + '</strong> · ' + (datos.elemento || '') +
                '<br><br>¿Desea terminar el bulto que está llenando ahora antes de suspender?',
          showDenyButton: true,
          confirmButtonText: 'Sí, terminar el bulto',
          denyButtonText: 'No, suspender ya',
          confirmButtonColor: '#71bf44',
          denyButtonColor: '#c00000',
          allowOutsideClick: false,
          allowEscapeKey: false
        }).then(function(resultado) {
          if (resultado.isConfirmed) { responder(datos.idOrden, true); }
          else if (resultado.isDenied) { responder(datos.idOrden, false); }
        });
      }

      async function revisar() {
        try {
          var resp = await fetch('/selladora/' + MAQUINA + '/estado-suspension');
          if (!resp.ok) return;
          var datos = await resp.json();
          if (!datos.ok || !datos.pendiente) return;
          if (idPreguntado === datos.idOrden) return; // ya se le preguntó por esta misma orden
          preguntar(datos);
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }

      revisar();
      setInterval(revisar, 5000);
    })();
  `;
}

// Aviso de "entro un pedido nuevo a la cola" (a pedido del usuario, 06/09/2026). Va en TODAS las
// paginas con sesion -- Dashboard, Programacion maquina, Informacion, Bultos y Tablet fija -- para
// que le llegue al operario este donde este, no solo en la pantalla de la cola.
//
// No es una notificacion push del sistema operativo: la WebView de Android no implementa la
// Notification API, y el Push API de verdad ademas exigiria HTTPS y salida a FCM, que esta
// instalacion no tiene (sirve por HTTP en la red local). Esto es un sondeo cada 10s contra
// /api/cola/novedades comparando contra la ultima foto de la cola guardada en localStorage. Si mas
// adelante la carcasa de Android Studio expone un @JavascriptInterface, el punto donde engancharlo
// es mostrar(), junto al pitido y la vibracion.
function scriptAvisoPedidoNuevo(maquinaCodigo) {
  return `
    (function() {
      var MAQUINA = ${JSON.stringify(maquinaCodigo || '')};
      // La foto de la cola se guarda por maquina: la tableta de la 05 no se entera de lo que le
      // programen a la 07. Al ser localStorage la comparten todas las pestanas del mismo WebView,
      // asi que navegar entre Informacion/Bultos/Programacion no reinicia el aviso ni lo repite.
      var CLAVE = 'carlixplast.cola.vistas.' + (MAQUINA || 'todas');
      var INTERVALO_MS = 10000;
      var pendientes = [];
      var audio = null;

      function leerVistas() {
        try { var v = JSON.parse(localStorage.getItem(CLAVE)); return Array.isArray(v) ? v : null; }
        catch (e) { return null; }
      }
      function guardarVistas(ids) {
        try { localStorage.setItem(CLAVE, JSON.stringify(ids)); } catch (e) {}
      }
      function escapar(texto) {
        return String(texto == null ? '' : texto)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      // Dos pitidos cortos generados con WebAudio -- no hace falta servir un archivo de sonido ni
      // depender de internet. El navegador no deja sonar hasta que hubo un toque en la pagina, por
      // eso se intenta reanudar el contexto en el primer toque y, si aun esta suspendido, se deja
      // pasar en silencio: el modal y la vibracion igual avisan.
      function contexto() {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audio) audio = new Ctx();
        return audio;
      }
      function desbloquearAudio() {
        var ctx = contexto();
        if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
        window.removeEventListener('pointerdown', desbloquearAudio);
        window.removeEventListener('keydown', desbloquearAudio);
      }
      window.addEventListener('pointerdown', desbloquearAudio);
      window.addEventListener('keydown', desbloquearAudio);

      function pitar() {
        try {
          var ctx = contexto();
          if (!ctx || ctx.state !== 'running') return;
          [0, 0.26].forEach(function(retraso) {
            var osc = ctx.createOscillator();
            var vol = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 880;
            vol.gain.value = 0.22;
            osc.connect(vol); vol.connect(ctx.destination);
            osc.start(ctx.currentTime + retraso);
            osc.stop(ctx.currentTime + retraso + 0.18);
          });
        } catch (e) {}
      }

      // CAMBIO 09/09/2026 (a pedido del usuario): el aviso dejo de ser un modal de SweetAlert2 y
      // pasa a ser una notificacion emergente tipo la del sistema -- baja desde arriba, se lee
      // sola y se esconde a los 7s. Dos motivos: el modal obligaba a tocar "Entendido" para poder
      // seguir trabajando (con las manos ocupadas en la maquina eso estorba), y ademas tenia que
      // esperar a que la pantalla estuviera libre para no pisar Calidad/pausa/escaneo. Al no
      // bloquear nada, esta version aparece siempre y de una: se dibuja por encima del backdrop de
      // SweetAlert2 (z-index 1060), asi que se ve incluso durante el chequeo de Calidad sin
      // robarle el toque al operario. Por eso ya no hay reintentos ni dependencia de Swal.
      var SEGUNDOS_VISIBLE = 7;
      var MAX_LINEAS = 3;
      var contenedorAvisos = null;

      function obtenerContenedor() {
        if (contenedorAvisos && document.body.contains(contenedorAvisos)) return contenedorAvisos;
        if (!document.getElementById('estilo-aviso-pedido')) {
          var estilo = document.createElement('style');
          estilo.id = 'estilo-aviso-pedido';
          estilo.textContent =
            '.avisos-pedido{position:fixed;top:0;left:0;right:0;z-index:2000;display:flex;' +
              'flex-direction:column;align-items:center;gap:8px;padding:10px 10px 0;pointer-events:none;}' +
            '.aviso-pedido{pointer-events:auto;width:min(520px,100%);background:#fff;border-radius:14px;' +
              'box-shadow:0 8px 26px rgba(28,39,51,0.30);border-left:5px solid #71bf44;padding:12px 14px;' +
              'display:flex;gap:12px;align-items:flex-start;cursor:pointer;opacity:0;transform:translateY(-140%);' +
              'transition:transform .38s cubic-bezier(.16,.84,.44,1),opacity .30s ease;}' +
            '.aviso-pedido.visible{opacity:1;transform:translateY(0);}' +
            '.aviso-pedido-icono{flex:0 0 auto;width:38px;height:38px;border-radius:11px;color:#fff;' +
              'background:linear-gradient(135deg,#00a2cb,#006984);display:flex;align-items:center;' +
              'justify-content:center;font-size:19px;}' +
            '.aviso-pedido-cuerpo{flex:1;min-width:0;}' +
            '.aviso-pedido-titulo{display:flex;justify-content:space-between;gap:10px;align-items:baseline;' +
              'font-weight:700;font-size:14.5px;color:#1c2733;}' +
            '.aviso-pedido-hora{font-weight:500;font-size:12px;color:#64748b;white-space:nowrap;}' +
            '.aviso-pedido-linea{font-size:13.5px;color:#1c2733;margin-top:4px;line-height:1.35;}' +
            '.aviso-pedido-linea .ref{color:#64748b;}' +
            '.aviso-pedido-mas{font-size:12.5px;color:#64748b;margin-top:5px;}' +
            '@media (prefers-reduced-motion: reduce){.aviso-pedido{transform:none;transition:opacity .2s ease;}}';
          document.head.appendChild(estilo);
        }
        contenedorAvisos = document.createElement('div');
        contenedorAvisos.className = 'avisos-pedido';
        document.body.appendChild(contenedorAvisos);
        return contenedorAvisos;
      }

      function esconder(tarjeta) {
        if (!tarjeta.parentNode) return;
        tarjeta.classList.remove('visible');
        setTimeout(function() { if (tarjeta.parentNode) tarjeta.parentNode.removeChild(tarjeta); }, 420);
      }

      function mostrar() {
        if (pendientes.length === 0) return;
        if (!document.body) { setTimeout(mostrar, 500); return; }

        var lote = pendientes;
        pendientes = [];
        var titulo = lote.length === 1 ? 'Nuevo pedido en la cola' : lote.length + ' pedidos nuevos en la cola';
        // Con muchos pedidos de golpe la tarjeta no crece sin fin: se listan los primeros y el
        // resto se resume en una linea ("y 2 más"). La cola completa siempre esta a un toque.
        var visibles = lote.slice(0, MAX_LINEAS);
        var lineas = visibles.map(function(o) {
          var maquina = MAQUINA ? '' : ' <span class="ref">· ' + escapar(o.maquinaNombre) + '</span>';
          return '<div class="aviso-pedido-linea"><strong>Pedido ' + escapar(o.numeroPedido || '—') + '</strong>' +
                 maquina + '<br><span class="ref">' + escapar(o.elemento) + '</span></div>';
        }).join('');
        if (lote.length > visibles.length) {
          lineas += '<div class="aviso-pedido-mas">y ' + (lote.length - visibles.length) + ' más</div>';
        }
        var hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });

        var tarjeta = document.createElement('div');
        tarjeta.className = 'aviso-pedido';
        tarjeta.setAttribute('role', 'status');
        tarjeta.innerHTML =
          '<div class="aviso-pedido-icono">📦</div>' +
          '<div class="aviso-pedido-cuerpo">' +
            '<div class="aviso-pedido-titulo">' + escapar(titulo) + '<span class="aviso-pedido-hora">' + hora + '</span></div>' +
            lineas +
          '</div>';
        // Un toque la cierra de una -- el operario no tiene que esperar los 7s si ya la leyo.
        tarjeta.addEventListener('click', function() { esconder(tarjeta); });
        obtenerContenedor().appendChild(tarjeta);
        requestAnimationFrame(function() { tarjeta.classList.add('visible'); });
        setTimeout(function() { esconder(tarjeta); }, SEGUNDOS_VISIBLE * 1000);

        pitar();
        if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) {} }
      }

      async function revisar() {
        try {
          var url = '/api/cola/novedades' + (MAQUINA ? '?maquina=' + encodeURIComponent(MAQUINA) : '');
          var resp = await fetch(url);
          if (!resp.ok) return;
          var datos = await resp.json();
          if (!datos.ok || !Array.isArray(datos.ordenes)) return;

          var ids = datos.ordenes.map(function(o) { return o.idOrden; });
          var vistas = leerVistas();
          // Primera vez en esta tableta: solo se toma la foto, sin avisar de toda la cola que ya
          // estaba ahi. Se guarda la cola COMPLETA (no se acumulan ids historicos), asi una orden
          // que salio y volvio a la cola vuelve a avisar.
          if (vistas === null) { guardarVistas(ids); return; }

          var nuevos = datos.ordenes.filter(function(o) {
            // PendienteValidacion es una orden que esta terminando, no trabajo nuevo: entra a la
            // foto para no avisar despues, pero no dispara el aviso.
            return vistas.indexOf(o.idOrden) === -1 && (o.estado === 'Pendiente' || o.estado === 'Activa');
          });
          guardarVistas(ids);
          if (nuevos.length > 0) { pendientes = pendientes.concat(nuevos); mostrar(); }
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }

      revisar();
      setInterval(revisar, INTERVALO_MS);
    })();
  `;
}

// Medidas de la bolsa, para las preguntas de Calidad del apartado "Medidas" (a pedido del usuario,
// 11/09/2026). No hay columnas de medida en SEL_OrdenProduccion: cada medida es una fila de
// INVElementosReferencia (Elemento + Categoria + Valor), y el catalogo de categorias esta en
// INVReferenciaCategoria (comprobado contra la base el 11/09/2026):
//     5 Ancho · 6 Fuelle Izquierdo · 7 Fuelle Derecho · 8 Alto · 9 Fuelle Superior ("solapa")
//    10 Fuelle Fondo · 16 Medida = la UNIDAD de todas ellas (PUL/CM/MT/KG, ver INVReferencia)
// Los valores vienen como texto con ceros a la izquierda ('010.00', '00.00'), por eso se convierten
// a numero antes de mostrarlos. Un 0 significa que la bolsa NO lleva ese fuelle/solapa -- esa
// pregunta simplemente no sale (por eso el apartado es dinamico y cambia de una referencia a otra).
const MEDIDAS_BOLSA = [
  { clave: 'medida_ancho',            campo: 'MedidaAncho',           articulo: 'El', etiqueta: 'ancho' },
  { clave: 'medida_alto',             campo: 'MedidaAlto',            articulo: 'El', etiqueta: 'alto' },
  { clave: 'medida_fuelle_izquierdo', campo: 'MedidaFuelleIzquierdo', articulo: 'El', etiqueta: 'fuelle izquierdo' },
  { clave: 'medida_fuelle_derecho',   campo: 'MedidaFuelleDerecho',   articulo: 'El', etiqueta: 'fuelle derecho' },
  { clave: 'medida_fuelle_fondo',     campo: 'MedidaFuelleFondo',     articulo: 'El', etiqueta: 'fuelle de fondo' },
  { clave: 'medida_solapa',           campo: 'MedidaSolapa',          articulo: 'La', etiqueta: 'solapa (fuelle superior)' }
];

// Categoria 16 de INVReferencia -- se escribe en palabras dentro de la pregunta ("es de 10
// pulgadas"), que se lee mejor en la tableta que la sigla. En singular y plural, para que una
// medida de 1 no salga como "es de 1 pulgadas". Si llegara una unidad nueva que no este aca, se
// usa el codigo tal cual en vez de dejar la pregunta sin unidad.
const UNIDADES_MEDIDA_BOLSA = {
  PUL: ['pulgada', 'pulgadas'],
  CM: ['centímetro', 'centímetros'],
  MT: ['metro', 'metros'],
  KG: ['kilogramo', 'kilogramos']
};

// Columnas y OUTER APPLY que traen esas medidas en las consultas de la orden. Ambas asumen que la
// tabla SEL_OrdenProduccion viene con el alias `ord`, que es como se llama en las tres consultas
// que las usan (GET /selladora/:codigo/orden/:idOrden, obtenerMiembrosGrupoSellado y
// registrarChequeoCalidad).
//
// El pivote (un MAX(CASE...) por categoria) es el de la consulta de apoyo que dio el usuario
// (11/09/2026) y hace UNA sola pasada por las filas del elemento, en vez de un LEFT JOIN a
// INVElementosReferencia por cada medida.
//
// Los valores se traen TAL CUAL, como texto, y se convierten en calcularMedidasBolsa(). La consulta
// de apoyo los castea en SQL (CAST(... AS decimal(9,2))) porque mira un elemento a la vez; aca no
// se puede: hay filas de esas categorias con texto no numerico en la base (comprobado el
// 11/09/2026 -- un CONVERT sobre toda la tabla revienta con "Error converting data type varchar to
// float"). Si una de esas cayera en una orden que se esta sellando, el CAST tumbaria la consulta
// ENTERA de la pagina; convirtiendo en JS lo unico que pasa es que esa medida da NaN y su pregunta
// no se hace, que es el mismo camino que ya siguen las medidas en cero.
const COLUMNAS_MEDIDAS_BOLSA = `med.Ancho AS MedidaAncho, med.Alto AS MedidaAlto,
             med.FuelleIzquierdo AS MedidaFuelleIzquierdo, med.FuelleDerecho AS MedidaFuelleDerecho,
             med.FuelleFondo AS MedidaFuelleFondo, med.FuelleSuperior AS MedidaSolapa,
             med.Unidad AS MedidaUnidad`;
const JOINS_MEDIDAS_BOLSA = `
      OUTER APPLY (
        SELECT MAX(CASE WHEN r.Categoria = 16 THEN r.Valor END) AS Unidad,
               MAX(CASE WHEN r.Categoria =  5 THEN r.Valor END) AS Ancho,
               MAX(CASE WHEN r.Categoria =  8 THEN r.Valor END) AS Alto,
               MAX(CASE WHEN r.Categoria =  6 THEN r.Valor END) AS FuelleIzquierdo,
               MAX(CASE WHEN r.Categoria =  7 THEN r.Valor END) AS FuelleDerecho,
               MAX(CASE WHEN r.Categoria =  9 THEN r.Valor END) AS FuelleSuperior,
               MAX(CASE WHEN r.Categoria = 10 THEN r.Valor END) AS FuelleFondo
        FROM INVElementosReferencia r
        WHERE r.Elemento = ord.Elemento
      ) med`;

// Preguntas de medida que aplican a UNA orden, ya redactadas ("¿El ancho de la bolsa es de 10
// pulgadas?"). `orden` es una fila que traiga las columnas de COLUMNAS_MEDIDAS_BOLSA. Se devuelve
// tambien valorEsperado ("10 pulgadas") aparte del titulo, porque es lo que se guarda en la base
// junto con la respuesta: dentro de un mes la referencia puede haber cambiado de medida y el
// registro tiene que seguir diciendo contra que se comparo ese dia.
function calcularMedidasBolsa(orden) {
  const codigoUnidad = String(orden.MedidaUnidad || '').toUpperCase();
  const formasUnidad = UNIDADES_MEDIDA_BOLSA[codigoUnidad] || [codigoUnidad, codigoUnidad];
  return MEDIDAS_BOLSA.map(m => {
    const n = Number(orden[m.campo]);
    // Sin valor, no numerico o en cero: la bolsa no lleva esa medida -- no se pregunta por ella.
    if (!isFinite(n) || n === 0) return null;
    const valor = n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
    const unidad = formasUnidad[n === 1 ? 0 : 1];
    const valorEsperado = unidad ? `${valor} ${unidad}` : valor;
    return {
      clave: m.clave,
      titulo: `¿${m.articulo} ${m.etiqueta} de la bolsa es de ${valorEsperado}?`,
      valorEsperado
    };
  }).filter(Boolean);
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
// - Medidas: apartado DINAMICO (11/09/2026, a pedido del usuario) -- una pregunta redactada por
//   cada medida que la referencia realmente tenga (ancho, alto, los tres fuelles y la solapa), con
//   su valor y su unidad adentro: "¿El ancho de la bolsa es de 10 pulgadas?". Va primero porque es
//   lo que el operario puede medir de una con el flexometro, antes de mirar pelicula o sellado.
//   `medidas` lo arma calcularMedidasBolsa() a partir de INVElementosReferencia; si no se pasa
//   (o viene vacio) el apartado sencillamente no sale, que es lo que pasa con una referencia sin
//   ninguna medida registrada.
function construirApartadosCalidad({ tieneImpresion, tieneAccesorios, tieneTroquelado, tienePerforaciones, medidas }) {
  const apartados = [];

  if (medidas && medidas.length > 0) {
    apartados.push({ titulo: 'Medidas', preguntas: medidas });
  }

  apartados.push(
    { titulo: 'Película', preguntas: [{ clave: 'color_pelicula', titulo: 'Color de la película' }] },
    { titulo: 'Deslizamiento', preguntas: [{ clave: 'deslizamiento', titulo: 'Deslizamiento (caras de película separadas)' }] }
  );

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
// SEL_ChequeoCalidadDetalle (una fila por pregunta) -- a pedido del usuario (03/09/2026); las dos
// tablas las crea agregar_calidad_por_bulto_y_medidas.sql donde falten. Llamada desde
// POST /api/comando cuando comando==='calidad'.
//
// Reconstruye el Apartado (y el ValorEsperado de las preguntas de medida) por clave, con los
// MISMOS datos de la orden que uso el modal, en vez de depender de que el cliente los mande: asi
// un cliente desactualizado no puede guardar un apartado que no existe ni una medida inventada.
// 'conforme'/'no_conforme' (los value= de los checkboxes, ver abrirCalidad en scriptComandos) se
// traducen a 'Conforme'/'NoConforme' -- CK_SEL_ChequeoCalidadDetalle_Respuesta exige exactamente
// esos dos valores. Errores no revientan el comando ya enviado a Node-RED -- se registran en
// consola nada mas (ver el catch en el llamador).
//
// OJO (11/09/2026): la fila de SEL_ChequeoCalidad que se escribe aca es lo que marca el bulto como
// revisado -- /calidad-pendiente no vuelve a pedir el chequeo de un bulto que ya tenga una. Por eso
// el bulto que se guarda en id_bulto tiene que salir del MISMO criterio que usa ese endpoint.
async function registrarChequeoCalidad(p, { idOrden, operarioCodigo, respuestas }) {
  const dtOrden = await p.request().input('idOrden', idOrden).query(`
    SELECT ord.Troquelado, ord.Perforaciones, ord.Manija, ord.Tula, ord.Parche, ord.CierreDeslizador,
           ord.CierreHermetico, ord.CintaAdhesiva,
           CASE WHEN er12.Valor IS NOT NULL THEN 1 ELSE 0 END AS TieneImpresion,
           ${COLUMNAS_MEDIDAS_BOLSA}
    FROM SEL_OrdenProduccion ord
    LEFT JOIN INVElementosReferencia er12 ON er12.Elemento = ord.Elemento AND er12.Categoria = 12${JOINS_MEDIDAS_BOLSA}
    WHERE ord.IdOrden = @idOrden
  `);
  if (dtOrden.recordset.length === 0) return;
  const o = dtOrden.recordset[0];
  // calcularFlagsCalidad sirve tal cual: la fila de arriba trae las mismas columnas que las
  // consultas de las dos paginas (incluidas las de COLUMNAS_MEDIDAS_BOLSA, para el apartado
  // dinamico "Medidas"), asi que los apartados que se reconstruyen aca son exactamente los que vio
  // el operario en la tableta.
  const calidadFlags = calcularFlagsCalidad(o);
  // Ademas del Apartado, se guarda el ValorEsperado de las preguntas de medida ("10 pulgadas"):
  // es el dato contra el que el operario comparo, y sin el la fila 'medida_ancho | Conforme' no
  // diria nada dentro de unos meses (la referencia puede haber cambiado de medida desde entonces).
  const claveApartado = new Map();
  const claveValorEsperado = new Map();
  construirApartadosCalidad(calidadFlags).forEach(ap => ap.preguntas.forEach(preg => {
    claveApartado.set(preg.clave, ap.titulo);
    if (preg.valorEsperado) claveValorEsperado.set(preg.clave, preg.valorEsperado);
  }));

  const dtEjecucion = await p.request().input('idOrden', idOrden).query(
    `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
  );
  if (dtEjecucion.recordset.length === 0) return;
  const idEjecucion = dtEjecucion.recordset[0].IdEjecucion;

  // Bulto Activo en este momento -- mismo criterio que /calidad-pendiente (ver el OJO de arriba).
  // Puede no haber ninguno (entre que se cierra un bulto y se abre el siguiente); id_bulto es
  // nullable, y en ese caso el chequeo queda guardado pero sin bulto al que marcar.
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
      .input('valorEsperado', claveValorEsperado.get(clave) || null)
      .query(`INSERT INTO SEL_ChequeoCalidadDetalle (IdChequeo, Apartado, Pregunta, Respuesta, ValorEsperado)
              VALUES (@idChequeo, @apartado, @pregunta, @respuesta, @valorEsperado)`);
  }
}

// Botones "Imprimir etiqueta" / "Cierre bulto" / "Retal" / "Troquelado" -- publican en
// /api/comando (este servidor), que reenvia a Node-RED. idOrden/maquinaCodigo se cierran sobre el
// scope de la funcion (valores fijos de esta pagina), asi los botones no necesitan mas que el
// nombre del comando. `datos` es opcional -- lo usa el modal de Calidad para mandar las
// respuestas junto con el comando (ver abrirCalidad() mas abajo). `calidadFlags` decide que
// apartados/preguntas de Calidad aplican para esta orden, ver construirApartadosCalidad().
function scriptComandos(idOrden, maquinaCodigo, calidadFlags, pausaActiva, calidadHabilitada) {
  const apartadosCalidad = construirApartadosCalidad(calidadFlags);
  return `
    // Devuelve la promesa (antes no la devolvia) para que confirmarCerrarBultoYReimprimir pueda
    // encadenar un segundo comando (reimprimir_etiqueta) solo si el primero (cierre_bulto)
    // funciono -- no cambia nada para el resto de llamadas, que siguen sin usar el valor devuelto.
    // idOrdenDestino (10/09/2026) es opcional y solo lo usa la pagina de un pedido con varias
    // referencias de salida: ahi el mismo script maneja las N referencias del grupo y cada boton
    // tiene que mandar el comando contra SU orden, no contra la que quedo fija en el closure.
    // Sin ese parametro se comporta exactamente como antes.
    function enviarComando(comando, boton, datos, idOrdenDestino) {
      if (boton) boton.disabled = true;
      return fetch('/api/comando', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comando: comando, idOrden: idOrdenDestino || ${JSON.stringify(idOrden)}, maquinaCodigo: ${jsString(maquinaCodigo)}, datos: datos })
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
    function confirmarYEnviar(mensaje, comando, boton, idOrdenDestino) {
      Swal.fire({
        icon: 'warning',
        title: mensaje,
        showCancelButton: true,
        confirmButtonText: 'Sí',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (resultado.isConfirmed) enviarComando(comando, boton, null, idOrdenDestino);
      });
    }

    // Al cerrar el bulto, ademas de mandar 'cierre_bulto' como siempre, reimprime de una la
    // etiqueta del ULTIMO paquete de ese bulto (a pedido del usuario, 02/09/2026) -- mismo
    // mecanismo que reimprimirPaquete() en la pagina de Bultos (comando 'reimprimir_etiqueta'),
    // solo que aca se dispara sola en vez de que el operario tenga que ir a buscarla. idBulto/el
    // ultimo paquete salen de window.idBultoActivo/window.ultimoPaqueteBultoActivo (los mantiene
    // scriptResumenBultoActivo cada 4s). Solo se reimprime si el cierre funciono Y el bulto de
    // verdad tenia algun paquete pesado (si se cierra vacio, no hay nada que reimprimir).
    // idOrdenDestino: igual que en enviarComando, solo lo usa la pagina de un pedido con varias
    // referencias de salida -- ahi el bulto/ultimo paquete NO salen de window.idBultoActivo (que
    // es de una sola orden) sino de window.resumenPorOrden[idOrden], que mantiene el mismo
    // sondeo pero por referencia (ver scriptTarjetasReferencia).
    function confirmarCerrarBultoYReimprimir(mensaje, boton, idOrdenDestino) {
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
        var resumenRef = (idOrdenDestino && window.resumenPorOrden) ? window.resumenPorOrden[idOrdenDestino] : null;
        var idBulto = resumenRef ? resumenRef.idBulto : (window.idBultoActivo || null);
        var ultimo = resumenRef ? resumenRef.ultimo : window.ultimoPaqueteBultoActivo;
        enviarComando('cierre_bulto', boton, null, idOrdenDestino).then(function(data) {
          if (!data.ok || !idBulto || !ultimo) return;
          enviarComando('reimprimir_etiqueta', null, {
            idBulto: idBulto, consecutivoPaquete: ultimo.consecutivo, pesoGr: ultimo.pesoKg, serialBulto: null
          }, idOrdenDestino);
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

    // Pausa y Calidad ya no son mutuamente excluyentes (03/09/2026): el chequeo de Calidad se
    // vigila SIEMPRE que la ejecucion este en curso (siga o no en pausa en este momento) --
    // revisarCalidadDelBulto() se encarga de no abrirlo mientras haya otra ventana (la de pausa)
    // abierta, ver esa funcion mas abajo. Ojo: el arranque de esa vigilancia va al FINAL de este
    // script, no aca -- necesita las variables que se declaran junto con ella.
    ${pausaActiva ? `abrirModalPausaActiva(${JSON.stringify(pausaActiva)});` : ''}

    // Apartado de Calidad: pantalla emergente con las preguntas agrupadas por apartado (Pelicula,
    // Sellado, Accesorios, Troquelado/Perforaciones -- ver construirApartadosCalidad() en
    // server.js, que decide cuales apartados/preguntas aplican segun los datos reales de esta
    // orden). Cada pregunta es Conforme/No conforme via checkbox (los dos checkboxes de una misma
    // pregunta son mutuamente excluyentes -- marcar uno desmarca el otro). No deja confirmar si
    // falta alguna respuesta. Publica comando 'calidad' con TODAS las respuestas (de todos los
    // apartados) en 'datos', mismo mecanismo que los demas botones.
    var APARTADOS_CALIDAD = ${JSON.stringify(apartadosCalidad)};

    function abrirCalidad() {
      calidadEnPantalla = true;
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
          // calidadEnPantalla se libera cuando el POST termina, no cuando se cierra la ventana: si
          // se liberara antes, el sondeo de 5s podria alcanzar al guardado a medio camino (el
          // servidor todavia no ha escrito el chequeo, /calidad-pendiente sigue diciendo que si) y
          // volveria a abrir el mismo chequeo encima.
          enviarComando('calidad', null, resultado.value)
            .then(function(data) {
              // Si no se pudo guardar (Node-RED caido, red intermitente) el chequeo sigue
              // pendiente -- se reintenta en 5 minutos, no cada 5 segundos.
              if (!data || !data.ok) calidadReintentarDesde = Date.now() + 5 * 60 * 1000;
            })
            .finally(function() { calidadEnPantalla = false; });
        } else {
          // Se cancelo -- se reintenta pronto (5 min) en vez de desaparecer: el chequeo debe
          // insistir, no perderse porque se cancelo una vez (a pedido del usuario, 03/09/2026).
          calidadReintentarDesde = Date.now() + 5 * 60 * 1000;
          calidadEnPantalla = false;
        }
      });
    }

    // Calidad no tiene boton (a pedido del usuario, 31/08/2026) -- sale sola.
    //
    // CAMBIO 11/09/2026 (a pedido del usuario): ya NO sale cada 20-30 minutos. Sale UNA VEZ POR
    // BULTO, apenas se registra el PRIMER paquete de ese bulto -- que es el momento en que de
    // verdad hay producto nuevo que revisar. Con esto desaparece la ProximaCalidad que se guardaba
    // en SEL_EjecucionOrden (era la hora del proximo chequeo aleatorio) y el temporizador del
    // navegador: quien decide es el servidor, en /calidad-pendiente, mirando el bulto que esta
    // recibiendo paquetes -- si ya tiene paquetes y todavia no tiene un chequeo, hay que pedirlo.
    // Al vivir del lado del servidor, recargar la pagina o cambiar de pestaña no pierde ni repite
    // nada: el chequeo del bulto 3 se pide una sola vez, la haga quien la haga.
    //
    // Sigue sin ser mutuamente excluyente con Pausa: si al tocar el turno hay otra ventana
    // bloqueante abierta (pausa, escaneo de rollo, protocolo de arranque), NO se fuerza encima --
    // se salta ese sondeo y lo vuelve a intentar 5 segundos despues, hasta que la pantalla quede
    // libre.
    var CALIDAD_SONDEO_MS = 5000;
    var calidadEnPantalla = false;      // hay un chequeo abierto/guardandose ahora mismo
    var calidadReintentarDesde = 0;     // se cancelo o fallo el guardado: no insistir antes de esta hora

    function vigilarCalidadDelBulto() {
      revisarCalidadDelBulto();
      setInterval(revisarCalidadDelBulto, CALIDAD_SONDEO_MS);
    }

    function revisarCalidadDelBulto() {
      if (calidadEnPantalla || Date.now() < calidadReintentarDesde) return;
      fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/orden/' + ${JSON.stringify(idOrden)} + '/calidad-pendiente')
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(datos) {
          if (!datos || !datos.ok || !datos.pendiente) return;
          if (calidadEnPantalla || Swal.isVisible()) return;
          abrirCalidad();
        })
        .catch(function() { /* red intermitente -- se reintenta en el proximo sondeo */ });
    }

    // Arranque de la vigilancia. Va al final a proposito: CALIDAD_SONDEO_MS y las dos banderas de
    // arriba se declaran con var, o sea que mas arriba en el script existen pero valen undefined
    // -- llamar a vigilarCalidadDelBulto() desde el principio dejaba un setInterval(fn, undefined),
    // que es un setInterval de 0 ms sondeando sin parar.
    ${calidadHabilitada ? `vigilarCalidadDelBulto();` : ''}
  `;
}

// El boton suelto "Alternar aquí" (scriptAlternarReferencia/confirmarAlternarReferencia) se quito
// el 10/09/2026 a pedido del usuario: ya no hace falta un boton propio para cambiar de referencia,
// porque "Imprimir etiqueta" y "Cierre bulto" de una referencia que no esta recibiendo paquetes
// alternan solos antes de mandar el comando (ver accionReferencia en scriptAccionesReferencia).
// El endpoint POST /alternar-referencia sigue siendo el mismo y lo llama esa funcion.

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

    // El parametro ganchos (09/09/2026) es opcional y solo lo manda el protocolo de arranque -- ver
    // scriptProtocoloArranque. Sin el, esta pantalla se comporta exactamente como siempre:
    //   antesDeConfirmar(idOrden, rollo, seguir) : corre con el rollo ya consultado y ANTES de la
    //       ventana de confirmacion; decide con seguir('confirmar'|'reescanear'|'salir'). Ahi es
    //       donde el protocolo mete las preguntas 4.1/4.2 (estado del rollo / peligro fisico).
    //   alIniciar(idOrden) : reemplaza a preguntarActividadInicial() despues de que la ejecucion
    //       arranco (el protocolo sigue con su propio alistamiento, paso 5).
    function abrirEscaneoRollo(idOrden, esNuevoRollo, ganchos) {
      var titulo = esNuevoRollo ? 'Añadir rollo' : 'Iniciar ejecución';
      fetch('/api/selladora/orden/' + idOrden + '/rollo/preparar?nuevo=' + (esNuevoRollo ? '1' : '0'))
        .then(function(r) { return r.json(); })
        .then(function(datos) {
          if (!datos.ok) { errorRollo(datos.error); return; }
          pedirSerialRollo(idOrden, esNuevoRollo, titulo, datos.bolsasActual || 0, ganchos);
        })
        .catch(function(err) { errorRollo('Error de conexión: ' + err.message); });
    }

    function pedirSerialRollo(idOrden, esNuevoRollo, titulo, bolsasActual, ganchos) {
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
        if (!resultado.isConfirmed) return;
        var rollo = resultado.value;
        if (ganchos && ganchos.antesDeConfirmar) {
          ganchos.antesDeConfirmar(idOrden, rollo, function(decision) {
            if (decision === 'confirmar') confirmarRolloModal(idOrden, esNuevoRollo, titulo, bolsasActual, rollo, ganchos);
            else if (decision === 'reescanear') pedirSerialRollo(idOrden, esNuevoRollo, titulo, bolsasActual, ganchos);
          });
          return;
        }
        confirmarRolloModal(idOrden, esNuevoRollo, titulo, bolsasActual, rollo, ganchos);
      });
    }

    function confirmarRolloModal(idOrden, esNuevoRollo, titulo, bolsasActual, rollo, ganchos) {
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
          } else if (ganchos && ganchos.alIniciar) {
            // Protocolo de arranque: sigue el paso 5 (alistamiento), no la vieja pregunta.
            ganchos.alIniciar(idOrden);
          } else {
            // Camino viejo, sin protocolo -- hoy solo queda como respaldo (todos los botones
            // Iniciar entran por iniciarProtocoloArranque). Ver scriptPreguntaActividadInicial().
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

// Protocolo de arranque (09/09/2026, a pedido del usuario) -- lo que pasa al dar "▶ Iniciar" una
// orden. Ya no se abre directo el escaneo del rollo: se recorre una secuencia fija de pasos que no
// se pueden saltar ni reordenar.
//
//   1) Limpieza y desinfeccion -- se registra como actividad (SEL_TiempoMuerto, igual que el boton
//      de Pausa), se avisa y arranca el cronometro.
//   2) Al terminarla: "¿Detecta algun peligro quimico (aceites y lubricantes)?" -- si SI, sale el
//      aviso de comunicarse con el jefe de planta y no se puede seguir; si NO, sigue.
//   3) Se abre el escaneo del rollo (el de siempre, scriptEscanearRollo).
//   4) Con el rollo ya consultado y ANTES de confirmarlo: "¿El rollo esta en buen estado?" y
//      "¿Identifica algun peligro fisico?". Si el rollo esta mal o hay peligro fisico, se vuelve a
//      pedir otro serial; solo con rollo bueno y sin peligro se confirma y arranca la ejecucion.
//   5) Arranca el cronometro del alistamiento (SEL_TiempoMuerto, Tipo alistamiento/arranque).
//   6) Al terminarlo se pide la temperatura de la perilla -- por eso ya no existe el boton
//      "🌡️ Temperatura perilla" de la pagina de Informacion, este paso lo reemplaza.
//
// Nada de esto vive en el navegador: cada paso queda en la BASE apenas se responde (actividades en
// SEL_TiempoMuerto, respuestas en SEL_ProtocoloArranque). Por eso si la tableta se recarga, se
// apaga o se bloquea a mitad del protocolo, al volver a entrar se retoma en el mismo paso con el
// cronometro en la hora real -- ver obtenerProtocoloPendiente() del lado del servidor y
// reanudarProtocoloArranque() aca abajo.
function scriptProtocoloArranque(maquinaCodigo) {
  return `
    var MAQUINA_PROTOCOLO = ${JSON.stringify(maquinaCodigo)};

    function protocoloDestino(idOrden) {
      return '/selladora/' + encodeURIComponent(MAQUINA_PROTOCOLO) + '/orden/' + idOrden;
    }

    function protocoloPost(url, cuerpo) {
      return fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo || {})
      })
        .then(function(r) { return r.json(); })
        .catch(function(err) { return { ok: false, error: 'Error de conexión: ' + err.message }; });
    }

    // Ningun paso del protocolo se puede saltar: si la escritura falla (sin red, falta el script
    // SQL, el usuario no tiene operario de planta configurado...) se muestra el error tal cual y se
    // ofrece reintentar. "Salir" no marca el paso como hecho -- deja el protocolo donde estaba,
    // para retomarlo despues desde el mismo boton Iniciar.
    function protocoloIntentar(accion, alLograr) {
      accion().then(function(datos) {
        if (datos && datos.ok) { alLograr(datos); return; }
        Swal.fire({
          icon: 'error', title: 'No se pudo continuar',
          text: (datos && datos.error) || 'Error desconocido.',
          showCancelButton: true,
          confirmButtonText: 'Reintentar', confirmButtonColor: '#71bf44',
          cancelButtonText: 'Salir', cancelButtonColor: '#c0392b',
          allowOutsideClick: false, allowEscapeKey: false
        }).then(function(resultado) {
          if (resultado.isConfirmed) protocoloIntentar(accion, alLograr);
        });
      });
    }

    function guardarPasoProtocolo(idOrden, datos, alLograr) {
      protocoloIntentar(function() {
        return protocoloPost('/api/selladora/orden/' + idOrden + '/protocolo/respuesta', datos);
      }, alLograr);
    }

    // Cronometro de las dos actividades del protocolo (limpieza del paso 1, alistamiento del paso
    // 5). Mismo comportamiento bloqueante que el de Pausa: sin cancelar, sin cerrar por click
    // afuera ni Escape -- la unica salida es el boton de terminar, y solo si /reanudar funciono.
    // Arranca desde la HoraInicio real guardada en la base, no desde que se abre la ventana.
    function cronometroProtocolo(idOrden, opciones) {
      var inicio = new Date(opciones.horaInicio).getTime();
      var intervalId;
      Swal.fire({
        title: opciones.titulo,
        html: '<div style="font-size:13px;color:#64748b;margin-bottom:10px;">' + opciones.subtitulo + '</div>' +
              '<div style="font-size:36px;font-weight:700;color:#006984;" id="protocolo-cronometro">00:00:00</div>',
        confirmButtonText: opciones.textoBoton,
        confirmButtonColor: '#4a9c2e',
        showCancelButton: false, showCloseButton: false,
        allowOutsideClick: false, allowEscapeKey: false,
        didOpen: function() {
          var el = document.getElementById('protocolo-cronometro');
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
          return protocoloPost('/api/selladora/orden/' + idOrden + '/reanudar', {}).then(function(datos) {
            if (!datos.ok) { Swal.showValidationMessage(datos.error || 'No se pudo terminar la actividad.'); return false; }
            return true;
          });
        }
      }).then(function(resultado) {
        if (resultado.isConfirmed) opciones.alTerminar();
      });
    }

    // ---------------- Paso 1: limpieza y desinfeccion ----------------
    function comenzarProtocoloArranque(idOrden) {
      Swal.fire({
        icon: 'info',
        title: 'Protocolo de arranque',
        html: '<div style="text-align:left;font-size:15px;line-height:1.7;">' +
                '<b>1.</b> Limpieza y desinfección<br>' +
                '<b>2.</b> Chequeo de peligro químico<br>' +
                '<b>3.</b> Escaneo del rollo<br>' +
                '<b>4.</b> Chequeo del rollo y de peligro físico<br>' +
                '<b>5.</b> Alistamiento y temperatura de la perilla' +
              '</div>' +
              '<div style="text-align:left;font-size:13px;color:#64748b;margin-top:12px;">' +
                'Al continuar, la limpieza y desinfección queda registrada como actividad y empieza a contar el tiempo.' +
              '</div>',
        showCancelButton: true,
        confirmButtonText: '🧼 Comenzar limpieza y desinfección', confirmButtonColor: '#71bf44',
        cancelButtonText: 'Cancelar', cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        protocoloIntentar(
          function() { return protocoloPost('/api/selladora/orden/' + idOrden + '/pausar', { tipo: 'limpieza' }); },
          function(datos) {
            guardarPasoProtocolo(idOrden, { paso: 'limpieza', respuesta: 'Iniciada' }, function() {
              Swal.fire({
                icon: 'success', title: 'Limpieza y desinfección iniciada',
                text: 'Quedó registrada como actividad. El tiempo ya está corriendo.',
                timer: 2200, showConfirmButton: false
              }).then(function() { cronometroLimpieza(idOrden, datos.horaInicio); });
            });
          });
      });
    }

    function cronometroLimpieza(idOrden, horaInicio) {
      cronometroProtocolo(idOrden, {
        titulo: '🧼 Limpieza y desinfección',
        subtitulo: 'Protocolo de arranque · paso 1 de 5',
        horaInicio: horaInicio,
        textoBoton: '■ Terminar limpieza y desinfección',
        alTerminar: function() { preguntarPeligroQuimico(idOrden); }
      });
    }

    // ---------------- Paso 2: peligro quimico ----------------
    function preguntarPeligroQuimico(idOrden) {
      Swal.fire({
        icon: 'question',
        title: '¿Detecta algún peligro químico?',
        html: '<div style="font-size:15px;color:#64748b;">Aceites y lubricantes</div>',
        showCancelButton: true,
        confirmButtonText: 'Sí, detecto peligro', confirmButtonColor: '#c0392b',
        cancelButtonText: 'No, no hay peligro', cancelButtonColor: '#4a9c2e',
        allowOutsideClick: false, allowEscapeKey: false
      }).then(function(resultado) {
        if (resultado.isConfirmed) {
          guardarPasoProtocolo(idOrden, { paso: 'peligro_quimico', respuesta: 'Si' }, function() {
            Swal.fire({
              icon: 'error',
              title: 'Comuníquese con el jefe de planta',
              text: 'Se detectó un peligro químico (aceites y lubricantes). No se puede continuar con el arranque de la orden hasta que el jefe de planta lo autorice.',
              showCancelButton: true,
              confirmButtonText: 'Ya se resolvió', confirmButtonColor: '#71bf44',
              cancelButtonText: 'Salir', cancelButtonColor: '#c0392b',
              allowOutsideClick: false, allowEscapeKey: false
            }).then(function(r2) {
              if (r2.isConfirmed) preguntarPeligroQuimico(idOrden);
            });
          });
          return;
        }
        if (resultado.dismiss === Swal.DismissReason.cancel) {
          guardarPasoProtocolo(idOrden, { paso: 'peligro_quimico', respuesta: 'No' }, function() {
            pasoEscanearRolloProtocolo(idOrden);
          });
        }
      });
    }

    // ---------------- Pasos 3 y 4: escaneo y chequeo del rollo ----------------
    // El escaneo es el mismo de siempre (abrirEscaneoRollo); el protocolo solo le mete dos ganchos:
    // uno entre consultar el serial y confirmarlo (las preguntas 4.1/4.2) y otro para lo que sigue
    // despues de que la ejecucion arranca (el alistamiento del paso 5, en vez de la vieja pregunta
    // "¿va a realizar alguna actividad antes de producir?").
    function pasoEscanearRolloProtocolo(idOrden) {
      abrirEscaneoRollo(idOrden, false, {
        antesDeConfirmar: preguntarEstadoRollo,
        alIniciar: pasoAlistamientoProtocolo
      });
    }

    function preguntaSiNoProtocolo(nombre, titulo, ayuda) {
      return '<div style="margin-bottom:14px;">' +
               '<div style="font-weight:600;font-size:16px;margin-bottom:2px;">' + titulo + '</div>' +
               (ayuda ? '<div style="font-size:13px;color:#64748b;margin-bottom:8px;">' + ayuda + '</div>' : '') +
               '<label style="display:inline-flex;align-items:center;gap:8px;font-size:16px;margin-right:22px;">' +
                 '<input type="radio" name="' + nombre + '" value="si" style="width:22px;height:22px;margin:0;"> Sí</label>' +
               '<label style="display:inline-flex;align-items:center;gap:8px;font-size:16px;">' +
                 '<input type="radio" name="' + nombre + '" value="no" style="width:22px;height:22px;margin:0;"> No</label>' +
             '</div>';
    }

    // seguir('confirmar') -> se confirma el rollo (arranca la ejecucion, o se añade el rollo)
    // seguir('reescanear') -> se vuelve a pedir un serial (rollo malo o con peligro fisico)
    // seguir('salir')      -> se corta aca; el protocolo se retoma despues desde Iniciar
    //
    // Se usa en DOS sitios (el segundo a pedido del usuario, 09/09/2026):
    //   preguntarEstadoRollo     -> paso 4 del protocolo de arranque (lleva la numeracion 4.1/4.2)
    //   preguntarEstadoRolloNuevo -> "+ Rollo" en una orden ya en curso (mismas dos preguntas, sin
    //       numerar: ahi no hay pasos 1..5, es un rollo suelto que entra a mitad de la orden)
    // Las respuestas de los dos casos van a la misma tabla y siempre con el serial del rollo
    // evaluado, que es lo que permite distinguirlas despues.
    function preguntarEstadoRollo(idOrden, rollo, seguir) {
      chequeoRollo(idOrden, rollo, seguir, true);
    }

    function preguntarEstadoRolloNuevo(idOrden, rollo, seguir) {
      chequeoRollo(idOrden, rollo, seguir, false);
    }

    function chequeoRollo(idOrden, rollo, seguir, conNumeros) {
      var html =
        '<div style="text-align:left;">' +
          '<div style="font-size:13px;color:#64748b;margin-bottom:14px;">Rollo <b>' + rollo.serial + '</b> · ' + rollo.referencia + '</div>' +
          preguntaSiNoProtocolo('protocolo-rollo-estado', (conNumeros ? '4.1 ' : '') + '¿El rollo está en buen estado?') +
          preguntaSiNoProtocolo('protocolo-peligro-fisico', (conNumeros ? '4.2 ' : '') + '¿Identifica algún peligro físico?', 'Cabellos, insectos, material extraño, material particulado') +
        '</div>';
      Swal.fire({
        title: 'Chequeo del rollo',
        html: html,
        showCancelButton: true,
        confirmButtonText: 'Confirmar chequeo', confirmButtonColor: '#71bf44',
        cancelButtonText: 'Cancelar', cancelButtonColor: '#c0392b',
        focusConfirm: false,
        allowOutsideClick: false, allowEscapeKey: false,
        preConfirm: function() {
          var contenedor = Swal.getHtmlContainer();
          var estado = contenedor.querySelector('input[name="protocolo-rollo-estado"]:checked');
          var peligro = contenedor.querySelector('input[name="protocolo-peligro-fisico"]:checked');
          if (!estado) { Swal.showValidationMessage('Responda si el rollo está en buen estado.'); return false; }
          if (!peligro) { Swal.showValidationMessage('Responda si identifica algún peligro físico.'); return false; }
          return { buenEstado: estado.value, peligroFisico: peligro.value };
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) { seguir('salir'); return; }
        var v = resultado.value;
        guardarPasoProtocolo(idOrden, { paso: 'rollo_estado', respuesta: v.buenEstado === 'si' ? 'Si' : 'No', serial: rollo.serial }, function() {
          guardarPasoProtocolo(idOrden, { paso: 'peligro_fisico', respuesta: v.peligroFisico === 'si' ? 'Si' : 'No', serial: rollo.serial }, function() {
            if (v.buenEstado === 'si' && v.peligroFisico === 'no') { seguir('confirmar'); return; }
            var motivo = v.buenEstado !== 'si'
              ? 'El rollo no está en buen estado.'
              : 'Se identificó un peligro físico en el rollo.';
            Swal.fire({
              icon: 'warning', title: 'Escanee otro rollo',
              text: motivo + ' Retire este rollo y escanee otro para continuar.',
              confirmButtonText: 'Escanear otro rollo', confirmButtonColor: '#71bf44',
              allowOutsideClick: false, allowEscapeKey: false
            }).then(function() { seguir('reescanear'); });
          });
        });
      });
    }

    // ---------------- Paso 5: alistamiento ----------------
    function pasoAlistamientoProtocolo(idOrden) {
      protocoloIntentar(
        function() { return protocoloPost('/api/selladora/orden/' + idOrden + '/pausar', { tipo: 'alistamiento', subtipo: 'arranque' }); },
        function(datos) {
          guardarPasoProtocolo(idOrden, { paso: 'alistamiento', respuesta: 'Iniciada' }, function() {
            Swal.fire({
              icon: 'success', title: 'Alistamiento iniciado',
              text: 'Quedó registrado como actividad. El tiempo ya está corriendo.',
              timer: 2200, showConfirmButton: false
            }).then(function() { cronometroAlistamiento(idOrden, datos.horaInicio); });
          });
        });
    }

    function cronometroAlistamiento(idOrden, horaInicio) {
      cronometroProtocolo(idOrden, {
        titulo: '⚙️ Alistamiento',
        subtitulo: 'Protocolo de arranque · paso 5 de 5',
        horaInicio: horaInicio,
        textoBoton: '■ Terminar alistamiento',
        alTerminar: function() { pasoTemperaturaProtocolo(idOrden); }
      });
    }

    // ---------------- Paso 6: temperatura de la perilla ----------------
    // Reemplaza al boton "🌡️ Temperatura perilla" que vivia en la pagina de Informacion: la
    // temperatura se pide una sola vez, al terminar el alistamiento, antes de empezar a producir.
    function pasoTemperaturaProtocolo(idOrden) {
      Swal.fire({
        icon: 'question',
        title: 'Temperatura de trabajo',
        input: 'number',
        inputLabel: '¿A qué porcentaje de la perilla va a trabajar? (0 a 100)',
        inputAttributes: { min: '0', max: '100', step: '1', inputmode: 'numeric' },
        confirmButtonText: 'Guardar y empezar a producir', confirmButtonColor: '#71bf44',
        showCancelButton: false, showCloseButton: false,
        allowOutsideClick: false, allowEscapeKey: false,
        inputValidator: function(valor) {
          if (valor === '' || valor === null) return 'Escriba el porcentaje.';
          var n = Number(valor);
          if (!isFinite(n) || n < 0 || n > 100) return 'Debe ser un número entre 0 y 100.';
          return null;
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        var valor = Number(resultado.value);
        // A proposito NO se guarda desde un preConfirm: esta ventana no tiene boton de cancelar (la
        // temperatura es obligatoria para arrancar), y con preConfirm un error que se repita -- por
        // ejemplo que falte ejecutar agregar_temperatura_perilla.sql en esta base -- dejaria al
        // operario encerrado en una ventana que no se puede cerrar. Con protocoloIntentar el error
        // sale con "Reintentar" y con "Salir"; si sale, el paso queda pendiente y se vuelve a pedir
        // al entrar de nuevo a la orden (la maquina ya esta produciendo, no hay nada trancado).
        protocoloIntentar(
          function() { return protocoloPost('/api/selladora/orden/' + idOrden + '/temperatura', { porcentaje: valor }); },
          function(datosTemp) {
            guardarPasoProtocolo(idOrden, { paso: 'temperatura', respuesta: String(valor) }, function() {
              Swal.fire({
                icon: 'success', title: 'Protocolo de arranque completo',
                text: 'Temperatura registrada: ' + valor + ' %. Ya puede producir.',
                timer: 2200, showConfirmButton: false
              }).then(function() {
                // El servidor decide el destino: si esta orden es de un grupo de sellado en
                // paralelo manda a la pagina del grupo (las 3 referencias, con Alternar), si no a
                // la de la orden. protocoloDestino queda de respaldo por si no vino redirect.
                window.location.href = (datosTemp && datosTemp.redirect) || protocoloDestino(idOrden);
              });
            });
          });
      });
    }

    // ---------------- Entrada y retomada ----------------
    // El boton "▶ Iniciar" entra siempre por aca: antes de empezar de cero le pregunta al servidor
    // si esta orden ya tiene un protocolo a medias, para retomarlo en el paso que iba en vez de
    // volver a cronometrar una limpieza que ya se hizo.
    function iniciarProtocoloArranque(idOrden) {
      fetch('/api/selladora/orden/' + idOrden + '/protocolo/estado')
        .then(function(r) { return r.json(); })
        .then(function(datos) {
          if (datos.ok && datos.pendiente) { reanudarProtocoloArranque(datos.pendiente, true); return; }
          comenzarProtocoloArranque(idOrden);
        })
        .catch(function() { comenzarProtocoloArranque(idOrden); });
    }

    // pedido = true cuando el operario acaba de pulsar Iniciar (se entra derecho al paso); false
    // cuando lo dispara sola la carga de la pagina, y ahi los pasos que NO tienen cronometro
    // corriendo avisan primero, para no secuestrar la pantalla sin explicar por que.
    function reanudarProtocoloArranque(pendiente, pedido) {
      if (!pendiente || !pendiente.paso) return;
      var idOrden = pendiente.idOrden;
      if (pendiente.paso === 'limpieza') { cronometroLimpieza(idOrden, pendiente.horaInicio); return; }
      if (pendiente.paso === 'alistamiento') { cronometroAlistamiento(idOrden, pendiente.horaInicio); return; }
      if (pendiente.paso === 'temperatura') { pasoTemperaturaProtocolo(idOrden); return; }

      var textos = {
        peligro_quimico: 'Falta responder el chequeo de peligro químico para poder seguir.',
        rollo: 'Falta escanear el rollo y responder su chequeo para poder seguir.'
      };
      var continuar = function() {
        if (pendiente.paso === 'peligro_quimico') preguntarPeligroQuimico(idOrden);
        else pasoEscanearRolloProtocolo(idOrden);
      };
      if (pedido) { continuar(); return; }
      Swal.fire({
        icon: 'info', title: 'Protocolo de arranque sin terminar',
        text: textos[pendiente.paso] || 'El protocolo de arranque de esta orden quedó a medias.',
        showCancelButton: true,
        confirmButtonText: 'Continuar protocolo', confirmButtonColor: '#71bf44',
        cancelButtonText: 'Ahora no', cancelButtonColor: '#64748b'
      }).then(function(resultado) { if (resultado.isConfirmed) continuar(); });
    }
  `;
}

// Solo la cola de ordenes de la maquina -- el detalle de bultos/pesajes/historial de cada orden
// vive en /selladora/:codigo/orden/:idOrden (boton "Informacion").
function renderPage(error, usuario, maquinaNombre, maquinaCodigo, colaOrdenes, miOperario, idOrdenPreguntarActividad, protocoloPendiente) {
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
    <div class="islas-fila">
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Bitácora de turno</div>
          <div class="isla-detalle">Bultos, rollos y unidades del turno en curso</div>
        </div>
        <a class="btn-accion btn-isla btn-info" href="/selladora/${maquinaCodigo}/bitacora">📋 Bitácora</a>
      </div>
    </div>
    <div class="barra">
      <span class="actualizado" id="cola-actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
    </div>
    <div id="cola-ordenes">${renderColaOrdenes(colaOrdenes || [], maquinaCodigo, miOperario)}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <script>${scriptProtocoloArranque(maquinaCodigo)}</script>
  <script>${scriptActualizarCola(maquinaCodigo)}</script>
  <script>${scriptAvisoSuspension(maquinaCodigo)}</script>
  ${protocoloPendiente ? `<script>
    // Protocolo de arranque a medias en esta maquina (la tableta se recargo/apago a mitad): se
    // retoma en el paso que iba, con el cronometro corriendo desde la hora real de la base.
    reanudarProtocoloArranque(${JSON.stringify(protocoloPendiente)}, false);
  </script>` : ''}
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
  <script>${scriptAvisoPedidoNuevo(null)}</script>
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

// Especificaciones del elemento pedido (columnas de SEL_OrdenProduccion) -- se sacaron de
// renderOrdenDetalle a su propia funcion (10/09/2026) porque ahora tambien se muestran dentro de
// la tarjeta de CADA referencia en la pagina de un pedido con varias referencias de salida (ver
// renderTarjetaReferenciaGrupo). "Lleva impresion" se resuelve por INVElementosReferencia
// Categoria=12 (TieneImpresion, mismo criterio que Referencia.vb:175) -- ojo: la consulta que
// alimente esta funcion tiene que traer esas mismas columnas.
function filasEspecificaciones(orden) {
  const tieneImpresion = orden.TieneImpresion === 1;
  return [
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
}

// Condiciones que deciden que apartados/preguntas de Calidad aplican para una orden -- ver
// construirApartadosCalidad(). "Sí" exacto para accesorios (no alcanza con no-NULL, ver
// conversacion 26/08/2026); Perforaciones != 0/NULL; Troquelado distinto de 'SinTroquelado' (eso
// mismo decide si sale el boton de residuo "Troquelado", ver botonesResiduos). Se saco a su propia
// funcion el 10/09/2026: el chequeo de Calidad ahora tambien sale en el apartado de un pedido con
// varias referencias de salida, contra la referencia que este recibiendo paquetes.
function calcularFlagsCalidad(orden) {
  return {
    tieneImpresion: orden.TieneImpresion === 1,
    tieneAccesorios: ['Manija', 'Tula', 'Parche', 'CierreDeslizador', 'CierreHermetico', 'CintaAdhesiva']
      .some(campo => orden[campo] === 'Sí'),
    tieneTroquelado: !!orden.Troquelado && orden.Troquelado !== 'SinTroquelado',
    tienePerforaciones: orden.Perforaciones != null && Number(orden.Perforaciones) !== 0,
    // Apartado "Medidas" (11/09/2026): sale de las columnas de COLUMNAS_MEDIDAS_BOLSA, que las dos
    // consultas de orden ya traen. Si la fila no las trae (o la referencia no tiene ninguna medida
    // registrada) queda un arreglo vacio y el apartado no aparece.
    medidas: calcularMedidasBolsa(orden)
  };
}

// Botones de residuos de UNA orden: los que aplican al tipo de maquina (BOTONES_RESIDUOS_POR_TIPO)
// mas "Salida no conforme". Piden el peso del residuo en una ventana emergente antes de mandar el
// comando por /api/comando para que Node-RED lo lea (FIX 26/08/2026: no escriben en esta BD).
//
// `refGrupo` ({ idOrden, referencia }) es el modo "pedido con varias referencias de salida"
// (10/09/2026, a pedido del usuario: "esos botones registran los residuos al bulto de esa
// referencia"). Cambia a que funcion del cliente llaman:
//   - sin refGrupo: confirmarPesoYEnviar (scriptComandos) -- el residuo va al bulto activo de la
//     unica orden de la pagina, que es lo que hay en window.idBultoActivo.
//   - con refGrupo: residuoReferencia (scriptAccionesReferencia) -- el residuo va al bulto de ESA
//     referencia (window.resumenPorOrden[idOrden]), este o no recibiendo paquetes en ese momento.
function botonesResiduos(orden, refGrupo) {
  const habilitados = BOTONES_RESIDUOS_POR_TIPO[orden.MaquinaTipo] || [];
  // "Troquelado" ademas exige que ESTA orden lleve troquelado -- los otros residuos no dependen de
  // ninguna columna de la orden, solo del tipo de maquina.
  const tieneTroquelado = !!orden.Troquelado && orden.Troquelado !== 'SinTroquelado';
  const refJs = refGrupo ? jsString(refGrupo.referencia).replace(/"/g, '&quot;') : null;
  const llamada = (label, clave) => refGrupo
    ? `residuoReferencia('${label}', '${clave}', this, ${refGrupo.idOrden}, ${refJs})`
    : `confirmarPesoYEnviar('${clave === 'no_conforme' ? '¿Está seguro de marcar esta salida como no conforme?' : `¿Está seguro de marcar este bulto con ${label}?`}', '${clave}', this)`;

  return [
    ...BOTONES_RESIDUOS
      .filter(b => habilitados.includes(b.clave))
      .filter(b => b.clave !== 'troquelado' || tieneTroquelado)
      .map(b => `<button type="button" class="btn-accion btn-residuo" onclick="${llamada(b.label, b.clave)}">${b.label}</button>`),
    `<button type="button" class="btn-accion btn-no-conforme" onclick="${llamada('Salida no conforme', 'no_conforme')}">🚫 Salida no conforme</button>`
  ].join('');
}

// Un color por referencia de salida de un pedido agrupado (a pedido del usuario, 10/09/2026:
// "cada referencia tendra un subrayado propio con colores diferentes"). El color se asigna por
// POSICION dentro del grupo (siempre el mismo orden: obtenerMiembrosGrupoSellado ordena por
// IdOrden), asi la referencia que en la tarjeta interactiva sale con el subrayado naranja es la
// misma que en la pagina de bultos del grupo tiene el chip y el subrayado naranja. Un grupo son 2
// o 3 referencias en la practica -- la lista alcanza de sobra, pero se cicla por si acaso.
const COLORES_REFERENCIA_GRUPO = ['#006984', '#b46200', '#8e44ad', '#0b8457', '#c0392b'];
function colorReferenciaGrupo(indice) {
  return COLORES_REFERENCIA_GRUPO[indice % COLORES_REFERENCIA_GRUPO.length];
}

function renderOrdenDetalle(orden, totalBultos, historial, usuario, maquinaCodigo, pausaActiva, avance, calidadHabilitada, grupoSellado, protocoloPendiente) {
  // Sellado en paralelo (ver DISENO_SELLADO_PARALELO_08092026.md): si esta orden comparte máquina
  // con otras (mismo rollo, hasta 3 referencias de salida distintas), grupoSellado trae TODAS las
  // referencias del grupo (incluida esta misma) -- solo se usa para saber si hay que ocultar
  // "+Rollo" (no aplica a una orden agrupada). El selector para alternar cuál referencia está
  // recibiendo paquetes ahora YA NO vive aquí -- se movió a /selladora/:codigo/grupo/:idGrupo
  // (renderGrupoSelladoDetalle), la página intermedia a la que ahora apunta "Información" para
  // órdenes agrupadas (ver renderColaOrdenes) -- FIX 09/09/2026 a pedido del usuario.
  const grupoSelladoOtras = (grupoSellado || []).filter(g => g.IdOrden !== orden.IdOrden);

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
    // Mismo protocolo de arranque que el boton Iniciar de la cola, ver renderColaOrdenes.
    acciones = `<button type="button" class="btn-accion btn-iniciar" onclick="iniciarProtocoloArranque(${orden.IdOrden})">▶ Iniciar</button>`;
  } else if (activa) {
    // Sellado en paralelo (08/09/2026): "+Rollo" no aplica a una orden agrupada -- el rollo de
    // entrada ya quedó registrado UNA sola vez para las 3 referencias al dar "Iniciar" en la ancla.
    acciones = `
      ${grupoSelladoOtras.length === 0 ? `<button type="button" class="btn-accion btn-anadir" onclick="abrirEscaneoRollo(${orden.IdOrden}, true, { antesDeConfirmar: preguntarEstadoRolloNuevo })">+ Rollo</button>` : ''}
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
  // junto a Imprimir etiqueta/Cierre bulto). Ver botonesResiduos().
  const botonesResiduosHTML = activa ? botonesResiduos(orden, null) : '';

  // Peso en vivo + Imprimir etiqueta/Cierre bulto/Residuos: solo tienen sentido con la orden
  // Activa (bascula/impresora actuando sobre el bulto que se esta armando en este momento).
  // Peso en vivo + resumen del bulto actual (paquetes/acumulado) van juntos, uno al lado del otro
  // (a pedido del usuario, 27/08/2026) -- ya no comparten caja con los botones de accion.
  const pesoBox = activa ? `
    <div class="peso-box">
      <div class="peso-top">
        <div>
          <div class="label">Peso paquete (báscula)</div>
          <div class="peso-valor"><span id="peso-numero" class="peso-vivo-numero">—</span><span class="unidad">kg</span></div>
        </div>
        <div>
          <div class="label">Paquetes bulto actual</div>
          <div class="peso-valor"><span id="resumen-paquetes">—</span></div>
        </div>
        <div>
          <div class="label">Peso acumulado</div>
          <div class="peso-valor"><span id="resumen-peso-acumulado">—</span><span class="unidad">kg</span></div>
        </div>
        <span class="peso-estado peso-vivo-estado desconectado" id="peso-estado">Conectando…</span>
      </div>
    </div>` : '';

  // Imprimir etiqueta + Cierre bulto van en la MISMA fila, en dos columnas (a pedido del usuario,
  // 31/08/2026). FIX 01/09/2026: Pausa se movio junto a Finalizar (ver `acciones` mas arriba), y
  // Retal/Troquelado/Salida no conforme al grupo "Residuos" (ver botonesResiduosHTML) -- ya no
  // quedan aca. FIX 09/09/2026: tampoco esta ya el boton "🌡️ Temperatura perilla" -- la
  // temperatura la pide el paso 6 del protocolo de arranque, al terminar el alistamiento y antes
  // de empezar a producir (a pedido del usuario, ver scriptProtocoloArranque).
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
  const calidadFlags = calcularFlagsCalidad(orden);

  const especificaciones = filasEspecificaciones(orden);

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
    <div class="islas-fila">
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Bultos producidos</div>
          <div class="isla-detalle">${totalBultos} bulto(s) en esta orden</div>
        </div>
        <a class="btn-accion btn-isla btn-info" href="/selladora/${maquinaCodigo}/orden/${orden.IdOrden}/bultos">📦 Ver bultos</a>
      </div>
    </div>
    <h2 style="font-size:15px;margin:0 0 10px;">Especificaciones</h2>
    <div class="ejecucion-box"><div class="ejecucion-grid">${especificaciones}</div></div>
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial de materia prima</h2>
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <script>${scriptProtocoloArranque(maquinaCodigo)}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptAvisoSuspension(maquinaCodigo)}</script>
  ${activa ? `<script>${scriptComandos(orden.IdOrden, maquinaCodigo, calidadFlags, protocoloPendiente ? null : pausaActiva, calidadHabilitada)}</script><script>${scriptPesoEnVivo()}</script><script>${scriptResumenBultoActivo(orden.IdOrden, maquinaCodigo)}</script>` : ''}
  ${protocoloPendiente ? `<script>
    // Protocolo de arranque a medias en esta orden: se retoma en el paso que iba. Ojo con el
    // orden -- va DESPUES de scriptComandos, y a ese se le pasa pausaActiva en null cuando hay
    // protocolo pendiente, para que no se abran dos ventanas bloqueantes encima de la otra (la
    // pausa del protocolo ya la muestra el cronometro de aca).
    reanudarProtocoloArranque(${JSON.stringify(protocoloPendiente)}, false);
  </script>` : ''}
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
// `opciones` (10/09/2026) solo lo usa la pagina de bultos de un pedido con VARIAS referencias de
// salida (renderBultosGrupo), que llama a esta misma funcion una vez por referencia y pega los
// resultados: { referencia, nombreReferencia, color, idOrden, soloTarjetas }. En ese modo cada
// tarjeta lleva ademas el subrayado del color de SU referencia con el nombre debajo (a pedido del
// usuario) y un data-ref para que el filtro por referencia pueda esconderla. Sin `opciones` se
// comporta igual que siempre (una sola orden, sin subrayado ni filtro).
function renderTarjetasBultos(bultos, pesajesPorBulto, residuosPorBulto, opciones) {
  const modoGrupo = !!(opciones && opciones.referencia);
  const idOrdenTarjetas = (opciones && opciones.idOrden) || null;
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
            <a href="javascript:void(0)" class="link-reimprimir" title="Reimprimir etiqueta o volver a pesar este paquete"
              onclick="abrirAccionesPaquete(this, ${JSON.stringify(pe.id_paquete)}, ${JSON.stringify(b.id)}, ${JSON.stringify(pe.ConsecutivoPaquete)}, ${JSON.stringify(Number(pe.PesoPaqueGr))}, ${jsString(b.serialPadre).replace(/"/g, '&quot;')}, ${jsString(b.estado).replace(/"/g, '&quot;')}, ${JSON.stringify(idOrdenTarjetas)})">📦 Paquete ${pe.ConsecutivoPaquete}</a>
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

    // Encabezado "Bulto #N" con el subrayado del color de la referencia y su nombre debajo -- solo
    // en modo grupo (a pedido del usuario, 10/09/2026). En una orden normal el encabezado queda
    // exactamente como estaba.
    const encabezadoBulto = modoGrupo ? `
        <div class="bulto-encabezado">
          <span class="bulto-num">Bulto #${b.numRelativo}</span>
          <div class="bulto-ref">
            <div class="bulto-ref-subrayado"></div>
            <div class="bulto-ref-nombre">${opciones.referencia}${opciones.nombreReferencia ? ' · ' + opciones.nombreReferencia : ''}</div>
          </div>
        </div>` : `<span class="bulto-num">Bulto ${b.numRelativo}</span>`;

    return `
    <div class="card"${modoGrupo ? ` data-ref="${opciones.referencia}" style="--color-ref:${opciones.color};"` : ''}>
      <div class="card-top">
        ${encabezadoBulto}
        ${badgeEstado(estadoVisibleBulto(b.estado, pesajes.length > 0))}
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

  // En modo grupo el que arma el `<div class="grid">` (y el mensaje de vacio) es renderBultosGrupo,
  // que junta las tarjetas de TODAS las referencias en una sola rejilla.
  if (opciones && opciones.soloTarjetas) return tarjetas;
  return bultos.length
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">Esta orden todavía no tiene bultos.</div>`;
}

// Sección "Trasladar paquete" (reunión 07/09/2026, líneas 279-288): cuando al operario le quedan
// paquetes sueltos que no alcanzan a completar un bulto, los mueve a un bulto ya existente en vez de
// dejarlos huérfanos. Sección fija debajo de las tarjetas (NO se regenera con el polling de
// /bultos/fragmento -- ver renderBultosOrden -- para no perder la selección de los desplegables a
// medio llenar). Las opciones se arman server-side con los mismos datos que ya trae la página
// (bultos/pesajesPorBulto), sin pedir nada aparte. La lógica real vive en
// dbo.sp_SEL_TrasladarPaquete (ver crear_sp_trasladar_paquete.sql), este bloque solo arma el
// formulario -- scriptTraslado() hace el fetch y dispara la reimpresión.
// `opciones` (10/09/2026, mismo criterio que renderTarjetasBultos): en un pedido con varias
// referencias de salida hay UNA seccion de traslado por referencia -- un paquete solo puede
// moverse entre bultos de SU MISMA referencia (son elementos distintos: mover un paquete de la
// 7002 a un bulto de la 7015 seria un error de datos, no un traslado). Por eso la pagina de grupo
// renderiza varias secciones y el filtro por referencia las muestra/esconde junto con sus bultos.
function renderSeccionTraslado(bultos, pesajesPorBulto, opciones) {
  const modoGrupo = !!(opciones && opciones.referencia);
  if (bultos.length < 2) return ''; // hace falta al menos un bulto origen y uno destino

  const opcionesPaquete = [];
  bultos.forEach(b => {
    const pesajes = pesajesPorBulto.get(b.id) || [];
    pesajes.forEach(pe => {
      opcionesPaquete.push(
        `<option value="${pe.id_paquete}">Bulto ${b.numRelativo} — Paquete ${pe.ConsecutivoPaquete} (${Number(pe.PesoPaqueGr)} kg)</option>`
      );
    });
  });
  if (opcionesPaquete.length === 0) return ''; // sin paquetes pesados todavía, nada que trasladar

  const opcionesBulto = bultos.map(b => `<option value="${b.id}">Bulto ${b.numRelativo}</option>`).join('');

  return `
  <div class="card seccion-traslado"${modoGrupo ? ` data-ref="${opciones.referencia}" data-orden="${opciones.idOrden}" style="--color-ref:${opciones.color};"` : ''}>
    <div class="card-top"><span class="bulto-num">🔀 Trasladar paquete entre bultos${modoGrupo ? ` — ${opciones.referencia}` : ''}</span></div>
    ${modoGrupo ? `<div class="bulto-ref"><div class="bulto-ref-subrayado"></div><div class="bulto-ref-nombre">${opciones.nombreReferencia || ''}</div></div>` : ''}
    <div class="traslado-campo">
      <label>Paquete a mover</label>
      <select class="sel-paquete-origen">
        <option value="">Seleccione…</option>
        ${opcionesPaquete.join('')}
      </select>
    </div>
    <div class="traslado-campo">
      <label>Bulto destino</label>
      <select class="sel-bulto-destino">
        <option value="">Seleccione…</option>
        ${opcionesBulto}
      </select>
    </div>
    <button type="button" class="btn-accion btn-traslado" onclick="confirmarTraslado(this)">🔀 Trasladar</button>
  </div>`;
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
    // CAMBIO 09/09/2026 (a pedido del usuario): tocar un paquete ya no reimprime de una -- primero
    // sale este menu, porque ahora hay dos cosas que se pueden hacer con un paquete ya registrado.
    // "Volver a pesar" es la nueva (ver volverAPesarPaquete); reimprimir es lo que hacia antes.
    // idOrdenBulto (10/09/2026): en la pagina de bultos de un pedido con varias referencias de
    // salida, cada bulto pertenece a UNA de ellas -- la reimpresion tiene que ir contra esa orden y
    // no contra la que quedo fija en el closure. En la pagina de una sola orden llega null y se usa
    // la de siempre.
    function abrirAccionesPaquete(enlace, idPaquete, idBulto, consecutivoPaquete, pesoGr, serialBulto, estadoBulto, idOrdenBulto) {
      Swal.fire({
        title: 'Paquete ' + consecutivoPaquete,
        html: '<div style="font-size:14px;color:#64748b;">Peso registrado: <b>' + pesoGr + ' kg</b></div>',
        showCancelButton: true,
        showDenyButton: true,
        confirmButtonText: '🖨️ Reimprimir etiqueta', confirmButtonColor: '#71bf44',
        denyButtonText: '⚖️ Volver a pesar', denyButtonColor: '#006984',
        cancelButtonText: 'Cancelar', cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (resultado.isConfirmed) { reimprimirPaquete(enlace, idBulto, consecutivoPaquete, pesoGr, serialBulto, idOrdenBulto); return; }
        if (resultado.isDenied) { volverAPesarPaquete(enlace, idPaquete, idBulto, consecutivoPaquete, pesoGr, serialBulto, estadoBulto, idOrdenBulto); }
      });
    }

    // Ventana con el peso EN VIVO de la bascula -- el mismo /ws/peso que usa la pagina de
    // Informacion (scriptPesoEnVivo), solo que aca la conexion se abre y se cierra con la ventana,
    // no con la pagina. El operario vuelve a poner el paquete en la bascula, mira el numero y
    // guarda; no se puede guardar sin una lectura real (no hay campo para escribirlo a mano).
    // Al guardar se reimprime sola la etiqueta con el peso corregido y se recarga la pagina.
    function volverAPesarPaquete(enlace, idPaquete, idBulto, consecutivoPaquete, pesoGr, serialBulto, estadoBulto, idOrdenBulto) {
      var ultimoPeso = null;
      var ws = null;
      var avisoCerrado = (estadoBulto === 'Cerrado')
        ? '<div style="text-align:left;font-size:12px;color:#b46200;background:#fff7ed;border-radius:8px;padding:8px 10px;margin-top:12px;">' +
          '⚠️ Este bulto ya está cerrado. Se corrigen el peso del paquete, el total del bulto y las ' +
          'cantidades de producción, pero <b>el saldo de inventario de este bulto no se toca</b>: ' +
          'queda con el peso viejo hasta que alguien lo ajuste.</div>'
        : '';
      Swal.fire({
        title: 'Volver a pesar el paquete ' + consecutivoPaquete,
        html: '<div style="font-size:13px;color:#64748b;margin-bottom:10px;">Peso registrado hoy: <b>' + pesoGr + ' kg</b>. ' +
                'Vuelva a poner el paquete en la báscula.</div>' +
              '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.03em;color:#64748b;">Báscula en vivo</div>' +
              '<div style="font-size:40px;font-weight:700;color:#006984;line-height:1.2;">' +
                '<span id="repesar-peso">—</span><span style="font-size:18px;color:#64748b;"> kg</span></div>' +
              '<div id="repesar-estado" style="font-size:12px;color:#c0392b;">Conectando con la báscula…</div>' +
              avisoCerrado,
        showCancelButton: true,
        confirmButtonText: '⚖️ Guardar este peso', confirmButtonColor: '#006984',
        cancelButtonText: 'Cancelar', cancelButtonColor: '#c0392b',
        allowOutsideClick: function() { return !Swal.isLoading(); },
        didOpen: function() {
          var elPeso = document.getElementById('repesar-peso');
          var elEstado = document.getElementById('repesar-estado');
          var protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
          ws = new WebSocket(protocolo + '//' + location.host + '/ws/peso');
          ws.onopen = function() { elEstado.textContent = 'Conectada'; elEstado.style.color = '#4a9c2e'; };
          ws.onclose = function() { elEstado.textContent = 'Sin conexión con la báscula'; elEstado.style.color = '#c0392b'; };
          ws.onerror = function() { try { ws.close(); } catch (e) {} };
          ws.onmessage = function(evento) {
            try {
              var json = JSON.parse(evento.data);
              if (json && typeof json.peso === 'number') {
                ultimoPeso = json.peso;
                elPeso.textContent = json.peso.toFixed(2);
              }
            } catch (e) { /* mensaje no valido -- se ignora, se queda la ultima lectura buena */ }
          };
        },
        // La ventana se cierra siempre por aca (guardando o cancelando), asi que el socket nunca
        // queda abierto de fondo consumiendo mensajes de la bascula.
        willClose: function() { try { if (ws) ws.close(); } catch (e) {} },
        preConfirm: function() {
          if (ultimoPeso === null) {
            Swal.showValidationMessage('Todavía no llega ninguna lectura de la báscula.');
            return false;
          }
          if (!(ultimoPeso > 0)) {
            Swal.showValidationMessage('La báscula marca ' + ultimoPeso.toFixed(2) + ' kg. Ponga el paquete en la báscula.');
            return false;
          }
          var pesoNuevo = ultimoPeso;
          return fetch('/api/selladora/paquete/repesar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idPaquete: idPaquete, pesoGr: pesoNuevo })
          })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.ok) { Swal.showValidationMessage(data.error || 'No se pudo guardar el peso.'); return false; }
              return data;
            })
            .catch(function(err) {
              Swal.showValidationMessage('No se pudo guardar el peso: ' + err.message);
              return false;
            });
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        var datos = resultado.value;
        // Reimpresion automatica con el peso YA corregido (a pedido del usuario) -- no se vuelve a
        // preguntar, el operario acaba de confirmar el repesaje un paso antes. Es el mismo comando
        // 'reimprimir_etiqueta' de reimprimirPaquete, igual que hace el traslado de paquetes.
        fetch('/api/comando', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            comando: 'reimprimir_etiqueta',
            idOrden: idOrdenBulto || ${JSON.stringify(idOrden)},
            maquinaCodigo: ${jsString(maquinaCodigo)},
            datos: { idBulto: datos.idBulto, consecutivoPaquete: datos.consecutivoPaquete, pesoGr: datos.pesoNuevo, serialBulto: datos.serialBulto }
          })
        })
          .then(function(r) { return r.json(); })
          .then(function(cmd) {
            return Swal.fire({
              icon: cmd.ok ? 'success' : 'warning',
              title: 'Peso corregido',
              html: '<div style="font-size:14px;">' + datos.pesoAnterior + ' kg → <b>' + datos.pesoNuevo + ' kg</b></div>' +
                    '<div style="font-size:13px;color:#64748b;margin-top:6px;">' +
                      (cmd.ok ? 'Se mandó a reimprimir la etiqueta.' : 'El peso quedó guardado, pero no se pudo reimprimir: ' + (cmd.error || '')) +
                    '</div>',
              confirmButtonText: 'Entendido', confirmButtonColor: '#71bf44'
            });
          })
          .catch(function(err) {
            return Swal.fire({
              icon: 'warning', title: 'Peso corregido',
              text: 'El peso quedó guardado, pero no se pudo reimprimir: ' + err.message,
              confirmButtonText: 'Entendido', confirmButtonColor: '#71bf44'
            });
          })
          .then(function() { location.reload(); });
      });
    }

    function reimprimirPaquete(enlace, idBulto, consecutivoPaquete, pesoGr, serialBulto, idOrdenBulto) {
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
            idOrden: idOrdenBulto || ${JSON.stringify(idOrden)},
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

// "Trasladar paquete" (ver renderSeccionTraslado): pide confirmación, llama a
// /api/selladora/paquete/trasladar (dbo.sp_SEL_TrasladarPaquete hace todo el trabajo transaccional
// en la BD) y, si sale bien, reimprime de una la etiqueta del paquete YA en su bulto nuevo -- mismo
// comando 'reimprimir_etiqueta' que ya usa reimprimirPaquete() en scriptReimprimir, sin pedir
// confirmación de nuevo (el operario ya confirmó el traslado un paso antes). Al final recarga la
// página -- más simple y confiable que parchar a mano las tarjetas y los dos desplegables a la vez.
function scriptTraslado(idOrden, maquinaCodigo) {
  return `
    // El boton se pasa a si mismo (10/09/2026) porque ahora puede haber MAS DE UNA seccion de
    // traslado en la misma pagina -- una por referencia de salida, ver renderSeccionTraslado. Los
    // desplegables se buscan dentro de la seccion del boton que se toco, no por id global.
    function confirmarTraslado(boton) {
      var seccion = boton ? boton.closest('.seccion-traslado') : document;
      var selOrigen = seccion.querySelector('.sel-paquete-origen');
      var selDestino = seccion.querySelector('.sel-bulto-destino');
      var idOrdenSeccion = (seccion.dataset && seccion.dataset.orden) ? Number(seccion.dataset.orden) : null;
      var idPaquete = selOrigen.value;
      var idBultoDestino = selDestino.value;
      if (!idPaquete || !idBultoDestino) {
        Swal.fire({ icon: 'warning', title: 'Seleccione el paquete y el bulto destino.', confirmButtonColor: '#71bf44' });
        return;
      }
      var textoPaquete = selOrigen.options[selOrigen.selectedIndex].text;
      var textoBulto = selDestino.options[selDestino.selectedIndex].text;
      Swal.fire({
        icon: 'warning',
        title: '¿Trasladar ' + textoPaquete + ' a ' + textoBulto + '?',
        text: 'El paquete queda reetiquetado con el serial del bulto destino.',
        showCancelButton: true,
        confirmButtonText: 'Sí, trasladar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        Swal.fire({ title: 'Trasladando…', allowOutsideClick: false, didOpen: function() { Swal.showLoading(); } });
        fetch('/api/selladora/paquete/trasladar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idPaquete: idPaquete, idBultoDestino: idBultoDestino })
        })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.ok) {
              Swal.fire({ icon: 'error', title: 'No se pudo trasladar', text: data.error || '', confirmButtonColor: '#71bf44' });
              return;
            }
            // Reimprime de una la etiqueta del paquete, ya con sus datos nuevos.
            return fetch('/api/comando', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                comando: 'reimprimir_etiqueta',
                idOrden: idOrdenSeccion || ${JSON.stringify(idOrden)},
                maquinaCodigo: ${jsString(maquinaCodigo)},
                datos: {
                  idBulto: data.idBultoDestino,
                  consecutivoPaquete: data.consecutivoNuevo,
                  pesoGr: data.pesoGr,
                  serialBulto: data.serialPadreDestino
                }
              })
            }).then(function() {
              Swal.fire({
                icon: 'success', title: 'Paquete trasladado', text: 'Etiqueta reimpresa. Nuevo serial: ' + data.detalleNuevo,
                confirmButtonColor: '#71bf44'
              }).then(function() { location.reload(); });
            });
          })
          .catch(function(err) {
            Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo trasladar: ' + err.message, confirmButtonColor: '#71bf44' });
          });
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
// Abrir/cerrar los paquetes de un bulto tocando la TARJETA entera, no solo el renglon "Paquetes
// pesados" (a pedido del usuario, 09/09/2026) -- en la tableta, con las manos ocupadas, acertarle a
// ese renglon de 11px era innecesariamente fino. El <details>/<summary> se conserva tal cual: sigue
// funcionando por su cuenta y es lo que guarda el estado abierto/cerrado que respeta el polling.
function scriptTarjetaBultoInteractiva() {
  return `
    (function() {
      var contenedor = document.getElementById('contenedor-bultos');
      if (!contenedor) return;

      // Delegado en el contenedor y NO en cada tarjeta: scriptActualizarBultos reemplaza el
      // innerHTML entero cada 4s, asi que cualquier listener puesto sobre una tarjeta concreta se
      // perderia en el primer refresco.
      contenedor.addEventListener('click', function(evento) {
        var origen = evento.target;

        // Cosas que ya tienen dueño: el enlace de cada paquete (menu reimprimir / volver a pesar),
        // las flechas del paginador y el propio summary. Si no se sale aca, un toque en "Paquete 3"
        // abriria su menu Y ademas plegaria la tarjeta debajo.
        if (origen.closest('a, button, summary, input, select, label')) return;

        // Dentro del desplegable ya abierto tampoco se pliega: ahi el operario esta leyendo la
        // lista de paquetes, no queriendo cerrarla.
        if (origen.closest('.pesajes-box')) return;

        var tarjeta = origen.closest('.card');
        if (!tarjeta) return;

        // Si el toque venia de seleccionar texto (tipico: copiar el serial del bulto), no cuenta
        // como clic -- si no, seleccionar el serial cerraria la tarjeta.
        var seleccion = window.getSelection && window.getSelection();
        if (seleccion && String(seleccion).length > 0) return;

        var desplegable = tarjeta.querySelector('details.pesajes-box');
        if (desplegable) desplegable.open = !desplegable.open;
      });
    })();
  `;
}

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
          // Pagina de bultos de un pedido con varias referencias: el filtro por referencia se
          // acaba de perder con el reemplazo del HTML, hay que volver a aplicarlo (en la pagina de
          // una sola orden no existe y esto no hace nada).
          if (window.reaplicarFiltroReferencias) window.reaplicarFiltroReferencias();
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
    ${renderSeccionTraslado(bultos, pesajesPorBulto)}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptReimprimir(orden.IdOrden, maquinaCodigo)}</script>
  <script>${scriptTraslado(orden.IdOrden, maquinaCodigo)}</script>
  <script>${scriptPaginadorPesajes()}</script>
  <script>${scriptTarjetaBultoInteractiva()}</script>
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
  // IdGrupoSellado (08/09/2026, Sellado en paralelo -- ver DISENO_SELLADO_PARALELO_08092026.md):
  // NULL si esta orden no comparte máquina con otras -- ver renderColaOrdenes, que fusiona en una
  // sola tarjeta las órdenes de un mismo grupo que TODAS sigan 'Pendiente' (nadie las ha iniciado).
  // FIX 08/09/2026: la llave real del grupo es ord.Elemento (la referencia), no ord.Linea -- si se
  // reasigna la referencia de una línea ya agrupada, esa línea deja de pertenecer al grupo solo.
  const colaResult = await p.request().input('codigo', codigo).query(`
    SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
           ej.Estado AS EstadoEjecucion, ej.Operario AS OperarioEjecucionCodigo, op.Nombre AS OperarioEjecucionNombre,
           ej.HoraFinReal,
           (SELECT TOP 1 g.IdGrupo FROM PRDGrupoEtapasCompartidasLineas gl
            INNER JOIN PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo AND g.CategoriaMaquina = 'SELLADORA'
            -- FIX 09/09/2026 (bug real: Pedido 11085 se coló en el grupo del Pedido 11408 porque
            -- ambos usan el mismo Elemento de salida en fechas distintas) -- Elemento por sí solo
            -- NO es llave suficiente: dos pedidos DISTINTOS pueden compartir la misma referencia de
            -- salida en momentos distintos. Hay que exigir también que sea el MISMO pedido (g.Numero
            -- es el Numero del pedido para el que se armó ese grupo, ver crear_grupoetapascompartidas.sql).
            WHERE gl.Elemento = ord.Elemento AND g.Numero = ord.NumeroPedido) AS IdGrupoSellado
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

    // Protocolo de arranque a medias en alguna orden de esta maquina (la tableta se recargo o se
    // apago a mitad) -- ver obtenerProtocoloPendienteMaquina/reanudarProtocoloArranque.
    const protocoloPendiente = await obtenerProtocoloPendienteMaquina(p, codigo);

    res.send(renderPage(null, req.session.usuario.nombre, nombre, codigo, ordenes, req.session.usuario.codigoOperarioPRD, idOrdenPreguntarActividad, protocoloPendiente));
  } catch (err) {
    res.status(500).send(renderPage(err.message, req.session.usuario.nombre, 'Selladora', codigo, [], req.session.usuario.codigoOperarioPRD, null, null));
  }
});

// Cola actual en JSON, para el sondeo de scriptAvisoPedidoNuevo. Mismo filtro de estados que
// obtenerColaOrdenes, pero sin renderizar HTML y sin el JOIN de operario: lo unico que necesita el
// cliente es que orden esta en la cola para compararla con la foto anterior. Sin ?maquina (el
// Dashboard y Tablet fija, que no estan parados en ninguna) devuelve la cola de todas.
app.get('/api/cola/novedades', requireLogin, async (req, res) => {
  const maquina = (req.query.maquina || '').trim();
  try {
    const p = await getPool();
    const peticion = p.request();
    if (maquina) peticion.input('maquina', maquina);
    const resultado = await peticion.query(`
      SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido, '') AS NumeroPedido,
             ie.Referencia AS Elemento, ord.Maquina, ISNULL(maq.Nombre, ord.Maquina) AS MaquinaNombre
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      LEFT JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      WHERE ord.Estado IN ('Activa','Pendiente','PendienteValidacion')
        ${maquina ? 'AND ord.Maquina = @maquina' : ''}
      ORDER BY ord.IdOrden ASC
    `);

    res.json({
      ok: true,
      ordenes: resultado.recordset.map(o => ({
        idOrden: o.IdOrden,
        estado: o.Estado,
        numeroPedido: o.NumeroPedido,
        elemento: o.Elemento,
        maquina: o.Maquina,
        maquinaNombre: o.MaquinaNombre
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
// Sellado en paralelo (ver DISENO_SELLADO_PARALELO_08092026.md): si la orden pertenece a un grupo
// SELLADORA (Agrupar Etapas en Liberación de Pedidos), devuelve TODAS las referencias del grupo --
// [] si no está agrupada. EstadoBultoActual (Activo/Temporal/EnEspera/null) indica si esa
// referencia ya se activó al menos una vez en esta máquina.
// FIX 09/09/2026 (a pedido del usuario): partido en dos -- obtenerIdGrupoSelladoDeOrden resuelve
// solo el IdGrupo (lo necesita también la nueva página /selladora/:codigo/grupo/:idGrupo y el
// endpoint de alternar, para saber a dónde redirigir), obtenerMiembrosGrupoSellado trae los
// miembros de un IdGrupo ya conocido (evita repetir el primer lookup cuando el grupo ya se tiene).
// FIX 09/09/2026 (bug real, Pedido 11085 colado en el grupo del Pedido 11408): Elemento por sí solo
// NO es llave suficiente para expandir un grupo -- dos pedidos DISTINTOS pueden usar la misma
// referencia de salida en momentos distintos, y sin exigir también el mismo Numero de pedido
// (g.Numero, el pedido para el que se armó ESE grupo puntual), la expansión "todos los miembros de
// este IdGrupo" termina trayendo órdenes de OTRO pedido que nunca tuvo nada que ver -- eso bloqueaba
// Finalizar (contaba un bulto Activo ajeno) y corrompía la página de grupo/alternar. Todas las
// consultas de aquí para abajo que expanden un IdGrupo a sus miembros reales exigen
// `ord.NumeroPedido = g.Numero`.
async function obtenerIdGrupoSelladoDeOrden(p, idOrden) {
  const dtGrupo = await p.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 g.IdGrupo
    FROM SEL_OrdenProduccion ord
    INNER JOIN PRDGrupoEtapasCompartidasLineas gl ON gl.Elemento = ord.Elemento
    INNER JOIN PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo AND g.CategoriaMaquina = 'SELLADORA'
      AND g.Numero = ord.NumeroPedido
    WHERE ord.IdOrden = @idOrden
  `);
  return dtGrupo.recordset.length > 0 ? dtGrupo.recordset[0].IdGrupo : null;
}

// Las columnas de especificaciones (TipoSellado/Troquelado/.../TipoImpresionDescripcion) se
// agregaron el 10/09/2026 -- son las mismas columnas y los mismos LEFT JOIN que la consulta de
// GET /selladora/:codigo/orden/:idOrden, porque la tarjeta interactiva de cada referencia hace
// ahora lo mismo que esa pagina, sin salir del pedido:
//   - muestra SUS especificaciones (filasEspecificaciones),
//   - saca SUS botones de residuos (botonesResiduos necesita MaquinaTipo y Troquelado),
//   - y decide que preguntas de Calidad aplican (calcularFlagsCalidad necesita ademas
//     CierreHermetico/CintaAdhesiva).
async function obtenerMiembrosGrupoSellado(p, idGrupo) {
  const dtMiembros = await p.request().input('idGrupo', idGrupo).query(`
    SELECT ord.IdOrden, ie.Referencia, ie.Nombre, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido,
           ord.TipoSellado, ord.Troquelado, ord.UsoPrevisto, ord.Manija, ord.ManijaColor, ord.Tula,
           ord.TulaColor, ord.Parche, ord.CierreDeslizador, ord.Perforaciones,
           ord.CierreHermetico, ord.CintaAdhesiva, maq.Tipo AS MaquinaTipo,
           CASE WHEN er12.Valor IS NOT NULL THEN 1 ELSE 0 END AS TieneImpresion,
           ti.Descripcion AS TipoImpresionDescripcion,
           ${COLUMNAS_MEDIDAS_BOLSA},
           (SELECT TOP 1 b.estado FROM SEL_Bultos b
            INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
            WHERE ej.IdOrden = ord.IdOrden ORDER BY b.id DESC) AS EstadoBultoActual
    FROM PRDGrupoEtapasCompartidasLineas gl
    INNER JOIN PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo
    INNER JOIN SEL_OrdenProduccion ord ON ord.Elemento = gl.Elemento AND ord.NumeroPedido = g.Numero
    INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
    INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
    LEFT JOIN INVElementosReferencia er12 ON er12.Elemento = ord.Elemento AND er12.Categoria = 12
    LEFT JOIN INVElementosReferencia er13 ON er13.Elemento = ord.Elemento AND er13.Categoria = 13
    LEFT JOIN INVReferencia ti ON ti.Categoria = 13 AND ti.Codigo = er13.Valor${JOINS_MEDIDAS_BOLSA}
    WHERE gl.IdGrupo = @idGrupo
    ORDER BY ord.IdOrden
  `);
  return dtMiembros.recordset;
}

async function obtenerGrupoSelladoDeOrden(p, idOrden) {
  const nIdGrupo = await obtenerIdGrupoSelladoDeOrden(p, idOrden);
  if (nIdGrupo == null) return [];
  return obtenerMiembrosGrupoSellado(p, nIdGrupo);
}

// FIX 09/09/2026 (a pedido del usuario, confirmado vía AskUserQuestion: "+ Rollo" es UNA sola
// acción por grupo, el mismo rollo físico compartido -- se registra contra la referencia que esté
// "Activa ahora" en el momento de escanearlo, igual que ya hace el Iniciar original). Consecuencia:
// la materia prima de un grupo puede terminar repartida entre varios miembros distintos (el rollo
// del Iniciar bajo la ancla, un +Rollo posterior bajo la que estaba activa en ese momento, etc.) --
// el historial de UN miembro puntual (renderOrdenDetalle) nunca lo va a mostrar completo. Esta
// función junta el historial de TODOS los miembros del grupo (mismo criterio de
// EjecucionSelladora.vb:btnVerHistorial_Click por miembro, ver el bloque idéntico en
// GET /selladora/:codigo/orden/:idOrden) para la página de grupo.
async function obtenerHistorialMPGrupo(p, miembros) {
  let historial = [];
  for (const m of miembros) {
    const ultimoBulto = await p.request().input('idOrden', m.IdOrden).query(`
      SELECT TOP 1 b.refsalida, b.mes, b.dia FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY b.num_bulto DESC
    `);
    if (ultimoBulto.recordset.length === 0) continue;
    const { refsalida: nElemento, mes, dia } = ultimoBulto.recordset[0];
    const tLote = String(mes).padStart(2, '0') + String(dia).padStart(2, '0');
    const nLineaOriginal = await obtenerLineaOriginalControlSellado(p, m.IdOrden, 0);
    const historialResult = await p.request()
      .input('elemento', nElemento).input('lote', tLote).input('lineaOriginal', nLineaOriginal)
      .query(`
        SELECT mp.Detalle AS Serial, e.Nombre AS Referencia, mp.LoteMP AS Lote
        FROM PRDProduccionMateriaPrima mp
        INNER JOIN INVElementos e ON mp.MateriaPrima = e.Codigo
        WHERE mp.Elemento = @elemento AND mp.Lote = @lote AND mp.Linea = @lineaOriginal
        ORDER BY mp.Linea
      `);
    historial.push(...historialResult.recordset.map(h => ({ ...h, ReferenciaSalida: m.Referencia })));
  }
  return historial;
}

// Sondeo por referencia de la pagina de un pedido agrupado: el % de avance del ENCABEZADO de cada
// tarjeta (siempre visible, por eso se refresca siempre) y, solo si la tarjeta esta abierta, los
// paquetes/peso acumulado de SU bulto. Son los mismos endpoints por orden que ya usa la pagina de
// una sola referencia (/avance-produccion y /resumen-bulto-activo) -- aca se llaman una vez por
// referencia en vez de una sola vez.
//
// window.resumenPorOrden[idOrden] guarda {idBulto, ultimo} de cada referencia: es lo que lee
// confirmarCerrarBultoYReimprimir (scriptComandos) para reimprimir la etiqueta del ultimo paquete
// al cerrar el bulto -- el equivalente por referencia de window.idBultoActivo, que solo servia
// cuando la pagina hablaba de una sola orden.
function scriptTarjetasReferencia(maquinaCodigo) {
  return `
    (function() {
      var tarjetas = Array.prototype.slice.call(document.querySelectorAll('.ref-card'));
      if (tarjetas.length === 0) return;
      window.resumenPorOrden = window.resumenPorOrden || {};

      function formatearCantidad(valor, tipo) {
        if (tipo === 'kg') return valor.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kg';
        return Math.round(valor).toLocaleString('es-CO') + ' uds';
      }

      function fijar(tarjeta, selector, texto) {
        var el = tarjeta.querySelector(selector);
        if (el) el.textContent = texto;
      }

      async function actualizarAvance(tarjeta) {
        try {
          const resp = await fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/orden/' + tarjeta.dataset.orden + '/avance-produccion');
          if (!resp.ok) return null;
          const datos = await resp.json();
          if (!datos.ok || !datos.tipo) return null;
          var color = datos.porcentaje >= 100 ? '#4a9c2e' : '#006984';
          var elPorcentaje = tarjeta.querySelector('.ref-avance-porcentaje');
          var elRelleno = tarjeta.querySelector('.ref-avance-relleno');
          if (elPorcentaje) {
            elPorcentaje.textContent = datos.porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 }) + '%';
            elPorcentaje.style.color = color;
          }
          if (elRelleno) {
            elRelleno.style.width = Math.min(datos.porcentaje, 100) + '%';
            elRelleno.style.background = color;
          }
          fijar(tarjeta, '.ref-avance-producido', 'Producido: ' + formatearCantidad(datos.producido, datos.tipo));
          fijar(tarjeta, '.ref-avance-programado', 'Programado: ' + formatearCantidad(datos.programado, datos.tipo));
          return datos;
        } catch (e) { return null; /* red intermitente -- se reintenta en el proximo tick */ }
      }

      // Avance TOTAL del pedido (tarjeta del encabezado): se arma sumando lo que ya se pidio por
      // referencia, no con un endpoint aparte. Misma regla que calcularAvanceTotalGrupo en el
      // servidor: se suma solo si todas las referencias miden en la misma unidad; si el pedido
      // mezcla kg con unidades, se muestra el promedio de los porcentajes y no hay cantidades.
      function actualizarAvanceTotal(avances) {
        var elPorcentaje = document.getElementById('avance-porcentaje');
        var elRelleno = document.getElementById('avance-relleno');
        if (!elPorcentaje || !elRelleno) return;

        var conMeta = avances.filter(function(a) { return a && a.tipo; });
        if (conMeta.length === 0) return;

        var mismaUnidad = conMeta.every(function(a) { return a.tipo === conMeta[0].tipo; });
        var producido = 0, programado = 0, porcentaje;
        if (mismaUnidad) {
          conMeta.forEach(function(a) { producido += a.producido; programado += a.programado; });
          porcentaje = programado > 0 ? (producido / programado) * 100 : 0;
        } else {
          porcentaje = conMeta.reduce(function(suma, a) { return suma + a.porcentaje; }, 0) / conMeta.length;
        }

        var color = porcentaje >= 100 ? '#4a9c2e' : '#006984';
        elPorcentaje.textContent = porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 }) + '%';
        elPorcentaje.style.color = color;
        elRelleno.style.width = Math.min(porcentaje, 100) + '%';
        elRelleno.style.background = color;

        if (!mismaUnidad) return; // el encabezado ya dice "metas en unidades distintas"
        var elProducido = document.getElementById('avance-producido');
        var elProgramado = document.getElementById('avance-programado');
        if (elProducido) elProducido.textContent = 'Producido: ' + formatearCantidad(producido, conMeta[0].tipo);
        if (elProgramado) elProgramado.textContent = 'Programado: ' + formatearCantidad(programado, conMeta[0].tipo);
      }

      async function actualizarResumen(tarjeta) {
        var idOrden = tarjeta.dataset.orden;
        try {
          const resp = await fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/orden/' + idOrden + '/resumen-bulto-activo');
          if (!resp.ok) return;
          const datos = await resp.json();
          if (!datos.ok) return;
          fijar(tarjeta, '.ref-paquetes', datos.paquetes);
          fijar(tarjeta, '.ref-peso-acumulado', datos.pesoTotalKg.toFixed(2));
          window.resumenPorOrden[idOrden] = {
            idBulto: datos.idBulto,
            ultimo: (datos.ultimoConsecutivo != null) ? { consecutivo: datos.ultimoConsecutivo, pesoKg: datos.ultimoPesoKg } : null
          };
        } catch (e) { /* red intermitente -- se reintenta en el proximo tick */ }
      }

      // La usa accionReferencia despues de alternar: al cambiar de referencia el bulto que recibe
      // paquetes es otro, y el cierre necesita el idBulto bueno antes de mandar el comando.
      window.refrescarResumenReferencia = function(idOrden) {
        var tarjeta = document.querySelector('.ref-card[data-orden="' + idOrden + '"]');
        return tarjeta ? actualizarResumen(tarjeta) : Promise.resolve();
      };

      function actualizar() {
        Promise.all(tarjetas.map(function(t) {
          if (t.open) actualizarResumen(t);
          return actualizarAvance(t);
        })).then(actualizarAvanceTotal);
      }

      // Al abrir una tarjeta se pide su resumen de una, sin esperar al proximo tick de 4s (si no,
      // los paquetes/acumulado salen en "—" durante unos segundos).
      tarjetas.forEach(function(t) {
        t.addEventListener('toggle', function() { if (t.open) actualizarResumen(t); });
      });
      actualizar();
      setInterval(actualizar, 4000);
    })();
  `;
}

// Botones "Imprimir etiqueta"/"Cierre bulto" DENTRO de la tarjeta de cada referencia.
//
// Decision del usuario (10/09/2026): si la referencia que se toca NO es la que esta recibiendo
// paquetes en ese momento, el boton NO se bloquea -- primero alterna a esa referencia (con UNA
// sola confirmacion, no dos) y despues manda el comando. Asi el comando siempre le llega a
// Node-RED con la maquina ya puesta en la referencia correcta. Al terminar se recarga la pagina
// para que la insignia de "Recibiendo paquetes" quede donde corresponde.
// Botones "Imprimir etiqueta"/"Cierre bulto" y los de residuos DENTRO de la tarjeta de cada
// referencia.
//
// CAMBIO 10/09/2026 (a pedido del usuario): estos botones preguntan lo MISMO que en la pagina de
// una sola referencia ("¿Está seguro de imprimir la etiqueta?"), sin ninguna ventana extra de
// "cambiar referencia" -- si el operario se metio a la tarjeta de una referencia, ya dijo con eso
// en cual va a trabajar. Si esa referencia no era la que estaba recibiendo paquetes, el cambio se
// hace igual, pero solo (alternarSilencioso) y despues de que confirma, no como una pregunta
// aparte. idOrdenActivaAhora arranca con la que trae el servidor y se actualiza sola en cuanto se
// alterna, para no volver a alternar de gratis si se toca dos veces la misma tarjeta.
function scriptAccionesReferencia(maquinaCodigo, idOrdenActivaAhora) {
  return `
    window.refActivaAhora = ${JSON.stringify(idOrdenActivaAhora ?? null)};

    // Cambia la referencia que recibe paquetes sin preguntar nada. Devuelve true solo si quedo
    // hecho -- si falla, el comando NO se manda (habria quedado contra la referencia equivocada).
    function alternarSilencioso(idOrden) {
      Swal.fire({ title: 'Cambiando a esta referencia…', allowOutsideClick: false, didOpen: function() { Swal.showLoading(); } });
      return fetch('/api/selladora/orden/' + idOrden + '/alternar-referencia', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.ok) {
            Swal.fire({ icon: 'error', title: 'No se pudo cambiar de referencia', text: data.error || '', confirmButtonColor: '#71bf44' });
            return false;
          }
          window.refActivaAhora = idOrden;
          Swal.close();
          // El bulto que recibe paquetes es otro: hay que releer su resumen antes de cerrar
          // (cierre_bulto necesita el idBulto bueno para reimprimir la ultima etiqueta).
          return window.refrescarResumenReferencia(idOrden).then(function() { return true; });
        })
        .catch(function(err) {
          Swal.fire({ icon: 'error', title: 'Error', text: 'No se pudo cambiar de referencia: ' + err.message, confirmButtonColor: '#71bf44' });
          return false;
        });
    }

    // Cierre de bulto: ademas del comando, reimprime la etiqueta del ultimo paquete de ESA
    // referencia (mismo comportamiento que confirmarCerrarBultoYReimprimir en una orden suelta).
    function ejecutarComandoReferencia(comando, boton, idOrden) {
      if (comando !== 'cierre_bulto') return enviarComando(comando, boton, null, idOrden);
      var resumen = window.resumenPorOrden[idOrden] || {};
      return enviarComando('cierre_bulto', boton, null, idOrden).then(function(cmd) {
        if (!cmd.ok || !resumen.idBulto || !resumen.ultimo) return;
        return enviarComando('reimprimir_etiqueta', null, {
          idBulto: resumen.idBulto, consecutivoPaquete: resumen.ultimo.consecutivo,
          pesoGr: resumen.ultimo.pesoKg, serialBulto: null
        }, idOrden);
      });
    }

    // Cierra la tarjeta desplegable (<details class="ref-card">) de UNA referencia. A pedido del
    // usuario (11/09/2026): despues de imprimir la etiqueta, la tarjeta de esa referencia se cierra
    // sola -- da igual si era la que estaba recibiendo paquetes o una que hubo que alternar antes.
    // Asi la pantalla vuelve a la lista de referencias y no queda una tarjeta abierta de una
    // referencia con la que ya se termino de operar.
    function cerrarTarjetaReferencia(idOrden) {
      var tarjeta = document.querySelector('.ref-card[data-orden="' + idOrden + '"]');
      if (tarjeta) tarjeta.open = false;
    }

    function accionReferencia(comando, boton, idOrden) {
      var esCierre = comando === 'cierre_bulto';
      Swal.fire({
        icon: 'warning',
        title: esCierre ? '¿Está seguro de cerrar el bulto?' : '¿Está seguro de imprimir la etiqueta?',
        showCancelButton: true,
        confirmButtonText: 'Sí',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#71bf44',
        cancelButtonColor: '#c0392b'
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        var hayQueAlternar = window.refActivaAhora !== idOrden;
        var preparado = hayQueAlternar ? alternarSilencioso(idOrden) : Promise.resolve(true);
        preparado.then(function(listo) {
          if (!listo) return;
          return Promise.resolve(ejecutarComandoReferencia(comando, boton, idOrden)).then(function(data) {
            // Imprimir etiqueta: la tarjeta de ESA referencia se cierra apenas el comando sale
            // (11/09/2026). Si el comando fallo se deja abierta -- el operario todavia tiene algo
            // que hacer ahi. Cierre bulto no cierra la tarjeta: despues del cierre se sigue
            // operando la misma referencia con el bulto nuevo.
            if (!esCierre && data && data.ok) cerrarTarjetaReferencia(idOrden);
            // Solo si se cambio de referencia: la pagina se recarga para que "+ Rollo" y el avance
            // queden apuntando a la referencia correcta. El retraso deja ver "Comando enviado".
            if (hayQueAlternar) setTimeout(function() { location.reload(); }, 1600);
          });
        });
      });
    }
    // Residuos de UNA referencia (Retal/Troquelado/Refilado/Salida no conforme, ver botonesResiduos):
    // piden el peso y lo registran contra el bulto de ESA referencia -- no contra el que este
    // recibiendo paquetes en ese momento (a pedido del usuario, 10/09/2026). Por eso NO alterna
    // como accionReferencia: el idBulto va explicito en el comando, asi que la referencia puede
    // estar parqueada y el residuo igual queda donde debe.
    //
    // El idBulto se relee antes de mandar (refrescarResumenReferencia) por si la tarjeta se acaba
    // de abrir y el sondeo de 4s todavia no ha traido el resumen de esta referencia.
    function residuoReferencia(etiqueta, comando, boton, idOrden, referencia) {
      var esNoConforme = comando === 'no_conforme';
      Swal.fire({
        icon: 'question',
        title: esNoConforme
          ? '¿Marcar esta salida de ' + referencia + ' como no conforme?'
          : '¿Marcar el bulto de ' + referencia + ' con ' + etiqueta + '?',
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
        if (!resultado.isConfirmed) return;
        var peso = Number(resultado.value);
        window.refrescarResumenReferencia(idOrden).then(function() {
          var resumen = window.resumenPorOrden[idOrden] || {};
          enviarComando(comando, boton, { peso: peso, idBulto: resumen.idBulto || null }, idOrden);
        });
      });
    }
  `;
}

// Filtro por referencia de la pagina de bultos de un pedido agrupado (a pedido del usuario,
// 10/09/2026: "en esta ventana puedo filtrar que bultos por referencia quiero ver"; la lista
// desplegable reemplazo a los botones tipo chip el mismo dia). Esconde y muestra cualquier
// elemento con data-ref -- las tarjetas de bulto y tambien las secciones de "Trasladar paquete",
// que son una por referencia. Se expone en window porque scriptActualizarBultos reemplaza el HTML
// de las tarjetas cada 4s y tiene que volver a aplicar el filtro elegido.
function scriptFiltroReferencias() {
  return `
    (function() {
      var selector = document.getElementById('filtro-referencia');
      if (!selector) return;
      var punto = document.querySelector('.filtro-refs-punto');
      var conteo = document.getElementById('filtro-referencia-conteo');

      function aplicar() {
        var refActual = selector.value;
        document.querySelectorAll('[data-ref]').forEach(function(el) {
          el.classList.toggle('oculto', refActual !== '' && el.dataset.ref !== refActual);
        });
        // El punto y el borde del desplegable toman el color de la referencia elegida (gris con
        // "Todas") -- el mismo codigo de color de los subrayados de las tarjetas.
        var opcion = selector.options[selector.selectedIndex];
        var color = opcion ? (opcion.dataset.color || '') : '';
        if (punto) punto.style.setProperty('--color-ref', color);
        selector.style.setProperty('--color-ref', color);
        if (conteo && opcion) conteo.textContent = (opcion.dataset.conteo || '0') + ' bulto(s)';
      }
      window.reaplicarFiltroReferencias = aplicar;

      selector.addEventListener('change', aplicar);
      aplicar();
    })();
  `;
}

// Avance TOTAL de un pedido con varias referencias de salida -- la tarjeta del encabezado que la
// variante de UNA sola referencia siempre tuvo y esta no (a pedido del usuario, 10/09/2026).
//
// Regla: la meta de cada referencia sale de SU orden y puede estar en kg o en unidades
// (KilosSolicitados manda sobre UnidadesSolicitadas, ver obtenerAvanceProduccion). Mientras todas
// midan en la MISMA unidad se suma lo producido y lo programado, y el total es esa division. Si el
// pedido mezcla kg con unidades no se puede sumar (serian peras con manzanas): en ese caso no se
// muestran cantidades, solo el porcentaje, y es el promedio de los de cada referencia -- cada meta
// pesa igual. Las referencias sin meta configurada no entran en la cuenta.
function calcularAvanceTotalGrupo(miembros) {
  const conMeta = miembros.map(m => m.avance).filter(a => a && a.tipo);
  if (conMeta.length === 0) return { tipo: null };

  const tipos = new Set(conMeta.map(a => a.tipo));
  if (tipos.size > 1) {
    const porcentaje = conMeta.reduce((suma, a) => suma + a.porcentaje, 0) / conMeta.length;
    return { tipo: 'mixto', producido: null, programado: null, porcentaje };
  }

  const producido = conMeta.reduce((suma, a) => suma + a.producido, 0);
  const programado = conMeta.reduce((suma, a) => suma + a.programado, 0);
  return {
    tipo: conMeta[0].tipo, producido, programado,
    porcentaje: programado > 0 ? (producido / programado) * 100 : 0
  };
}

// Tarjeta interactiva de UNA referencia de salida dentro de un pedido agrupado (a pedido del
// usuario, 10/09/2026). Encabezado: la referencia, su nombre en gris y su avance individual, con
// el subrayado del color propio de esa referencia. Adentro (colapsada al entrar, tambien a pedido
// del usuario): peso de bascula, paquetes del bulto actual y peso acumulado DE ESA REFERENCIA,
// Imprimir etiqueta, Cierre bulto y sus Especificaciones. Los botones de operar solo salen si la
// orden de esa referencia esta Activa.
function renderTarjetaReferenciaGrupo(m, indice) {
  const color = colorReferenciaGrupo(indice);
  const refJs = jsString(m.Referencia).replace(/"/g, '&quot;');
  const activa = m.Estado === 'Activa';
  const avance = (m.avance && m.avance.tipo) ? m.avance : null;
  const colorAvance = (avance && avance.porcentaje >= 100) ? '#4a9c2e' : '#006984';

  const avanceHeader = avance ? `
          <div class="ref-card-avance">
            <div class="avance-header-top">
              <span class="avance-header-label">Avance</span>
              <span class="avance-header-porcentaje ref-avance-porcentaje" style="font-size:17px;color:${colorAvance};">${avance.porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</span>
            </div>
            <div class="avance-header-barra">
              <div class="avance-header-relleno ref-avance-relleno" style="width:${Math.min(avance.porcentaje, 100)}%;background:${colorAvance};"></div>
            </div>
          </div>` : '';

  const statsAvance = avance ? `
        <div class="avance-header-stats" style="margin-bottom:14px;">
          <span class="ref-avance-producido">Producido: ${formatearCantidadAvance(avance.producido, avance.tipo)}</span>
          <span class="ref-avance-programado">Programado: ${formatearCantidadAvance(avance.programado, avance.tipo)}</span>
        </div>` : '';

  // Peso en vivo: la bascula es UNA sola para toda la maquina, asi que ese numero es el mismo en
  // todas las tarjetas (lo escribe scriptPesoEnVivo en cada .peso-vivo-numero). Lo que si es propio
  // de cada referencia son los paquetes y el peso acumulado de SU bulto (scriptTarjetasReferencia).
  const bloqueOperar = activa ? `
        <div class="peso-top">
          <div>
            <div class="label">Peso paquete (báscula)</div>
            <div class="peso-valor"><span class="peso-vivo-numero">—</span><span class="unidad">kg</span></div>
          </div>
          <div>
            <div class="label">Paquetes bulto actual</div>
            <div class="peso-valor"><span class="ref-paquetes">—</span></div>
          </div>
          <div>
            <div class="label">Peso acumulado</div>
            <div class="peso-valor"><span class="ref-peso-acumulado">—</span><span class="unidad">kg</span></div>
          </div>
          <span class="peso-estado peso-vivo-estado desconectado">Conectando…</span>
        </div>
        <div class="imprimir-acciones-grid">
          <button type="button" class="btn-accion btn-imprimir" onclick="accionReferencia('imprimir_etiqueta', this, ${m.IdOrden})">🖨️ Imprimir etiqueta</button>
          <button type="button" class="btn-accion btn-cierre-bulto" onclick="accionReferencia('cierre_bulto', this, ${m.IdOrden})">📦 Cierre bulto</button>
        </div>
        <div class="ref-residuos">
          <div class="label">Residuos</div>
          <div class="orden-acciones">${botonesResiduos(m, { idOrden: m.IdOrden, referencia: m.Referencia })}</div>
        </div>` : `
        <div class="pesaje-vacio">Esta referencia no está activa (${m.Estado}) — no se puede imprimir ni cerrar bultos.</div>`;

  return `
    <details class="ref-card" data-orden="${m.IdOrden}" data-ref="${m.Referencia}" style="--color-ref:${color};">
      <summary>
        <div class="ref-card-cabecera">
          <div class="ref-card-id">
            <div class="ref-card-codigo">${m.Referencia}</div>
            <div class="ref-card-nombre">${m.Nombre || ''}</div>
          </div>
          ${avanceHeader}
          <span class="ref-card-chevron">▶</span>
        </div>
      </summary>
      <div class="ref-card-cuerpo">
        ${statsAvance}
        ${bloqueOperar}
        <details class="ref-especificaciones">
          <summary>Especificaciones</summary>
          <div class="ejecucion-grid">${filasEspecificaciones(m)}</div>
        </details>
      </div>
    </details>`;
}

// Apartado de informacion PROPIO de un pedido con VARIAS referencias de salida (Sellado en
// paralelo) -- a pedido del usuario, 10/09/2026. Antes esta pagina era una lista de filas sueltas,
// una por referencia (Alternar/Finalizar/Mas informacion). Ahora replica el apartado de una orden
// normal, pero repartido:
//   - Isla "Producción" del pedido entero: + Rollo (el mismo rollo fisico compartido, se registra
//     contra la referencia que este recibiendo paquetes), Finalizar (cierra TODO el grupo, da
//     igual desde cual referencia se llame) y Pausa.
//   - En el lugar donde una orden normal tiene "Residuos" va la isla de Ver bultos -- los residuos
//     siguen siendo del escritorio/digitador y no aplican por referencia.
//   - Una tarjeta interactiva por referencia (ver renderTarjetaReferenciaGrupo).
// "Ver bultos" lleva a la pagina de bultos del GRUPO (/grupo/:idGrupo/bultos), con el filtro por
// referencia -- no a la de una sola orden.
function renderGrupoSelladoDetalle(idGrupo, numeroPedido, maquinaNombre, maquinaCodigo, miembros, usuario, historial, totalBultos, pausaActiva, calidadHabilitada, protocoloPendiente) {
  // "Activo ahora" es el que esta recibiendo paquetes en este momento (su bulto esta Activo o
  // Temporal). Si ninguno lo esta (grupo recien creado, nadie ha dado Iniciar) no se ofrece
  // "+ Rollo": el rollo se registra siempre contra la referencia activa.
  const miembroActivoAhora = miembros.find(m => m.EstadoBultoActual === 'Activo' || m.EstadoBultoActual === 'Temporal');
  // Ancla para las acciones que son del PEDIDO y no de una referencia puntual (Finalizar y Pausa,
  // que escriben contra SEL_EjecucionOrden): la que este recibiendo paquetes, o la primera Activa.
  const miembroAncla = miembroActivoAhora || miembros.find(m => m.Estado === 'Activa') || null;

  const filasHistorial = (historial || []).length
    ? historial.map(h => `
        <div class="hist-fila">
          <span class="valor serial">${h.Serial ?? '—'}</span>
          <span>${h.Referencia ?? '—'}</span>
          <span>${h.Lote ?? '—'}</span>
          <span style="color:var(--texto-suave);">${h.ReferenciaSalida ?? '—'}</span>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  const accionesProduccion = [
    miembroActivoAhora
      ? `<button type="button" class="btn-accion btn-anadir" onclick="abrirEscaneoRollo(${miembroActivoAhora.IdOrden}, true, { antesDeConfirmar: preguntarEstadoRolloNuevo })">+ Rollo</button>`
      : '',
    miembroAncla
      ? `<form method="post" action="/api/selladora/orden/${miembroAncla.IdOrden}/finalizar" onsubmit="return confirmarFinalizar(event, this);">
          <button type="submit" class="btn-accion btn-finalizar">■ Finalizar</button>
        </form>`
      : '',
    (miembroAncla && !pausaActiva)
      ? `<button type="button" class="btn-accion btn-pausa" onclick="abrirPausa()">⏸ Pausa</button>`
      : ''
  ].join('');

  const tarjetasReferencia = miembros.map((m, i) => renderTarjetaReferenciaGrupo(m, i)).join('');

  // Tarjeta de avance TOTAL del pedido en el encabezado -- los mismos ids que usa la pagina de una
  // sola referencia (avance-porcentaje/relleno/producido/programado), porque quien la refresca cada
  // 4s es scriptTarjetasReferencia con la suma de lo que ya pide por referencia: no hace falta un
  // endpoint aparte para el total.
  const avanceTotal = calcularAvanceTotalGrupo(miembros);
  const avanceCard = avanceTotal.tipo ? (() => {
    const color = avanceTotal.porcentaje >= 100 ? '#4a9c2e' : '#006984';
    const stats = avanceTotal.tipo === 'mixto'
      ? `<div class="avance-header-stats"><span id="avance-producido">${miembros.length} referencias</span><span id="avance-programado">metas en unidades distintas</span></div>`
      : `<div class="avance-header-stats">
            <span id="avance-producido">Producido: ${formatearCantidadAvance(avanceTotal.producido, avanceTotal.tipo)}</span>
            <span id="avance-programado">Programado: ${formatearCantidadAvance(avanceTotal.programado, avanceTotal.tipo)}</span>
          </div>`;
    return `
        <div class="avance-header-card">
          <div class="avance-header-top">
            <span class="avance-header-label">Avance del pedido</span>
            <span class="avance-header-porcentaje" id="avance-porcentaje" style="color:${color};">${avanceTotal.porcentaje.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</span>
          </div>
          <div class="avance-header-barra">
            <div class="avance-header-relleno" id="avance-relleno" style="width:${Math.min(avanceTotal.porcentaje, 100)}%;background:${color};"></div>
          </div>
          ${stats}
        </div>`;
  })() : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pedido ${numeroPedido || idGrupo} — ${maquinaNombre}</title>
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
          <h1>🔗 Pedido ${numeroPedido || '—'}</h1>
          <div class="sub">Sellado en paralelo -- un solo proceso, ${miembros.length} referencias de salida</div>
          <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${maquinaNombre}</a>
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
    <div class="islas-fila">
      ${accionesProduccion ? `<div class="isla">
        <div class="label">Producción</div>
        <div class="orden-acciones">${accionesProduccion}</div>
      </div>` : ''}
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Bultos producidos</div>
          <div class="isla-detalle">${totalBultos} bulto(s) en las ${miembros.length} referencias</div>
        </div>
        <a class="btn-accion btn-isla btn-info" href="/selladora/${maquinaCodigo}/grupo/${idGrupo}/bultos">📦 Ver bultos</a>
      </div>
    </div>
    <h2 style="font-size:15px;margin:0 0 10px;">Referencias de salida</h2>
    ${tarjetasReferencia}
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial de materia prima (todo el grupo)</h2>
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <!-- Los tres avisos automaticos que antes solo estaban en la pagina de una referencia suelta se
       agregaron aca el 10/09/2026, junto con quitar el boton "Más información" de cada tarjeta (a
       pedido del usuario): este apartado tiene que bastarse solo, y sin ellos el operario que se
       quedara aca no se enteraba de un pedido nuevo, de una suspension pedida por Programación ni
       de un protocolo de arranque a medias. -->
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <!-- scriptProtocoloArranque aporta preguntarEstadoRolloNuevo, el chequeo del rollo (buen estado /
       peligro fisico) que el boton "+ Rollo" de arriba exige antes de confirmar el rollo -- y
       reanudarProtocoloArranque, que retoma el protocolo a medias mas abajo. -->
  <script>${scriptProtocoloArranque(maquinaCodigo)}</script>
  <script>${scriptAvisoSuspension(maquinaCodigo)}</script>
  ${miembroAncla ? `<!-- scriptComandos con la orden ancla: aporta enviarComando (la base de
       accionReferencia y de residuoReferencia, que le pasan el IdOrden de cada referencia),
       abrirPausa, el cronometro de la pausa activa y el chequeo de Calidad.
       CAMBIO 10/09/2026 (a pedido del usuario): el chequeo de Calidad ahora tambien sale en este
       apartado, no solo en la pagina de una referencia suelta. Sale contra la orden ANCLA -- la
       que este recibiendo paquetes -- y con SUS preguntas (calcularFlagsCalidad de esa
       referencia): es la que se esta sellando en ese momento, y es su bulto el que se revisa en
       /calidad-pendiente (11/09/2026: el chequeo sale en el primer paquete de cada bulto). Si se
       alterna de referencia, esta pagina se recarga y el ancla pasa a ser la nueva.
       pausaActiva va en null si hay protocolo pendiente -- mismo cuidado que en renderOrdenDetalle:
       si no, se encimarian dos ventanas bloqueantes (la pausa del protocolo ya la muestra el). -->
  <script>${scriptComandos(miembroAncla.IdOrden, maquinaCodigo, calcularFlagsCalidad(miembroAncla), protocoloPendiente ? null : pausaActiva, calidadHabilitada)}</script>
  <script>${scriptPesoEnVivo()}</script>` : ''}
  <script>${scriptTarjetasReferencia(maquinaCodigo)}</script>
  <script>${scriptAccionesReferencia(maquinaCodigo, miembroActivoAhora ? miembroActivoAhora.IdOrden : null)}</script>
  ${protocoloPendiente ? `<script>
    // Protocolo de arranque a medias en la referencia ancla: se retoma en el paso que iba, igual
    // que en la pagina de una referencia suelta.
    reanudarProtocoloArranque(${JSON.stringify(protocoloPendiente)}, false);
  </script>` : ''}
</body>
</html>`;
}

// Bultos de TODAS las referencias de un pedido agrupado, en una sola rejilla y con filtro por
// referencia (a pedido del usuario, 10/09/2026). Cada tarjeta lleva "Bulto #N" con el subrayado
// del color de su referencia y el nombre debajo (ver renderTarjetasBultos en modo grupo). La
// numeracion es la RELATIVA de cada referencia -- el "Bulto #1" de la 7002 y el "Bulto #1" de la
// 7015 son dos bultos distintos, por eso el color y el nombre van pegados al numero.
function renderTarjetasBultosGrupo(datosPorReferencia) {
  const tarjetas = datosPorReferencia.map(d => renderTarjetasBultos(d.bultos, d.pesajesPorBulto, d.residuosPorBulto, {
    referencia: d.referencia, nombreReferencia: d.nombre, color: d.color, idOrden: d.idOrden, soloTarjetas: true
  })).join('');
  return tarjetas.trim()
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">Este pedido todavía no tiene bultos.</div>`;
}

function renderBultosGrupo(idGrupo, numeroPedido, maquinaCodigo, datosPorReferencia, usuario) {
  // Filtro por referencia como lista desplegable (a pedido del usuario, 10/09/2026 -- antes eran
  // botones tipo chip). Cada opcion lleva su color en data-color: el punto y el borde del
  // desplegable se pintan con el de la referencia elegida, para que el filtro use el mismo codigo
  // de color que los subrayados de las tarjetas.
  const totalBultos = datosPorReferencia.reduce((suma, d) => suma + d.bultos.length, 0);
  const opcionesFiltro = [
    `<option value="" data-color="" data-conteo="${totalBultos}">Todas las referencias</option>`,
    ...datosPorReferencia.map(d =>
      `<option value="${d.referencia}" data-color="${d.color}" data-conteo="${d.bultos.length}">${d.referencia}${d.nombre ? ' · ' + d.nombre : ''}</option>`)
  ].join('');
  const filtro = `
      <span class="filtro-refs-punto"></span>
      <label class="label" for="filtro-referencia">Referencia</label>
      <select id="filtro-referencia" class="filtro-refs-select">${opcionesFiltro}</select>
      <span class="filtro-refs-conteo" id="filtro-referencia-conteo">${totalBultos} bulto(s)</span>`;

  // Una seccion de traslado por referencia: un paquete solo puede moverse entre bultos de su misma
  // referencia. Van fuera de #contenedor-bultos (igual que en la pagina de una orden) para que el
  // sondeo de cada 4s no borre un desplegable a medio llenar.
  const traslados = datosPorReferencia.map(d => renderSeccionTraslado(d.bultos, d.pesajesPorBulto, {
    referencia: d.referencia, nombreReferencia: d.nombre, color: d.color, idOrden: d.idOrden
  })).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bultos — Pedido ${numeroPedido || idGrupo}</title>
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
          <div class="sub">${datosPorReferencia.length} referencias de salida</div>
          <a class="volver" href="/selladora/${maquinaCodigo}/grupo/${idGrupo}">‹ Pedido ${numeroPedido || '—'}</a>
        </div>
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${usuario}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
    </div>
  </header>
  <main>
    <div class="filtro-refs">${filtro}</div>
    <div id="contenedor-bultos">${renderTarjetasBultosGrupo(datosPorReferencia)}</div>
    ${traslados}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <!-- El idOrden que reciben estos dos es solo el de respaldo: cada tarjeta de bulto y cada
       seccion de traslado traen el IdOrden de SU referencia, y ese es el que se usa. -->
  <script>${scriptReimprimir(datosPorReferencia[0] ? datosPorReferencia[0].idOrden : 0, maquinaCodigo)}</script>
  <script>${scriptTraslado(datosPorReferencia[0] ? datosPorReferencia[0].idOrden : 0, maquinaCodigo)}</script>
  <script>${scriptPaginadorPesajes()}</script>
  <script>${scriptTarjetaBultoInteractiva()}</script>
  <script>${scriptFiltroReferencias()}</script>
  <script>${scriptActualizarBultos()}</script>
</body>
</html>`;
}

// Bultos/pesajes/residuos de CADA referencia del grupo, ya con el color que le toca a cada una
// (mismo indice que las tarjetas de la pagina del pedido, ver colorReferenciaGrupo).
async function obtenerBultosGrupo(p, miembros) {
  const datos = [];
  for (let i = 0; i < miembros.length; i++) {
    const m = miembros[i];
    const { bultos, pesajesPorBulto, residuosPorBulto } = await obtenerBultosYPesajes(p, m.IdOrden);
    datos.push({
      idOrden: m.IdOrden, referencia: m.Referencia, nombre: m.Nombre || '', color: colorReferenciaGrupo(i),
      bultos, pesajesPorBulto, residuosPorBulto
    });
  }
  return datos;
}

app.get('/selladora/:codigo/grupo/:idGrupo', requireLogin, async (req, res) => {
  const { codigo, idGrupo } = req.params;
  try {
    const p = await getPool();
    const miembros = await obtenerMiembrosGrupoSellado(p, idGrupo);
    if (miembros.length === 0) {
      return res.status(404).send(renderErrorSimple('Grupo no encontrado.', `/selladora/${codigo}`));
    }
    // Bultos de TODAS las referencias (el conteo de la isla "Bultos producidos") y avance de cada
    // una (el % del encabezado de su tarjeta).
    let totalBultos = 0;
    for (const m of miembros) {
      m.avance = await obtenerAvanceProduccion(p, m.IdOrden);
      const dtConteo = await p.request().input('idOrden', m.IdOrden).query(`
        SELECT COUNT(*) AS Total
        FROM SEL_Bultos b
        INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
        WHERE ej.IdOrden = @idOrden AND b.estado <> 'Anulado'
      `);
      totalBultos += dtConteo.recordset[0].Total;
    }

    // Pausa (10/09/2026): el boton de Pausa ahora vive en la isla "Producción" de esta pagina, asi
    // que hay que saber si la ejecucion ya esta pausada -- si lo esta, en vez del boton sale el
    // cronometro bloqueante (abrirModalPausaActiva, ver scriptComandos). Es una pausa del PROCESO
    // compartido: se mira la orden ancla, la misma contra la que se pausa/reanuda (la que este
    // recibiendo paquetes o, si ninguna, la primera Activa) -- mismo criterio que
    // renderGrupoSelladoDetalle.
    const miembroAncla = miembros.find(m => m.EstadoBultoActual === 'Activo' || m.EstadoBultoActual === 'Temporal')
      || miembros.find(m => m.Estado === 'Activa') || null;
    //
    // Chequeo de Calidad (10/09/2026, a pedido del usuario: "el registro de calidad debe salir en
    // esta variante"): mismo mecanismo que la pagina de una referencia suelta -- desde el
    // 11/09/2026 sale en el primer paquete de cada bulto, y quien lo decide es el servidor en
    // /calidad-pendiente. Aca solo se resuelve si esta pagina debe vigilarlo o no, contra la MISMA
    // orden ancla: es la referencia que se esta sellando, la duena del bulto que recibe paquetes y
    // la que recibe el comando 'calidad' al responder.
    let pausaActiva = null;
    let calidadHabilitada = false;
    if (miembroAncla) {
      const dtEjecucion = await p.request().input('idOrden', miembroAncla.IdOrden).query(
        `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
      );
      if (dtEjecucion.recordset.length > 0) {
        const { IdEjecucion: idEjecucion, Estado: estadoEjecucion } = dtEjecucion.recordset[0];
        if (estadoEjecucion === 'En pausa') {
          const dtPausa = await p.request().input('idEjecucion', idEjecucion).query(
            `SELECT TOP 1 Tipo, Subtipo, Observaciones, HoraInicio FROM SEL_TiempoMuerto WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC`
          );
          if (dtPausa.recordset.length > 0) pausaActiva = dtPausa.recordset[0];
        }
        // Igual que en la pagina de una referencia: nunca en 'PendienteOperador' (nadie ha retomado
        // el control todavia, no tiene sentido pedir un chequeo sin un operario real detras).
        calidadHabilitada = miembroAncla.Estado === 'Activa' && estadoEjecucion !== 'PendienteOperador';
      }
    }

    const historial = await obtenerHistorialMPGrupo(p, miembros);
    const maquinaResult = await p.request().input('codigo', codigo).query(
      `SELECT Nombre FROM PRDMaquinas WHERE Codigo = @codigo`
    );
    const maquinaNombre = maquinaResult.recordset.length > 0 ? maquinaResult.recordset[0].Nombre : codigo;
    // Protocolo de arranque a medias en la referencia ancla -- se retoma solo al abrir este
    // apartado, igual que en la pagina de una referencia suelta (10/09/2026: este apartado tiene
    // que bastarse solo, ya no hay boton "Más información" que lleve a la otra pagina).
    const protocoloPendiente = miembroAncla ? await obtenerProtocoloPendiente(p, miembroAncla.IdOrden) : null;

    res.send(renderGrupoSelladoDetalle(idGrupo, miembros[0].NumeroPedido, maquinaNombre, codigo, miembros, req.session.usuario.nombre, historial, totalBultos, pausaActiva, calidadHabilitada, protocoloPendiente));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
  }
});

// Bultos de TODAS las referencias de un pedido agrupado, con filtro por referencia (a pedido del
// usuario, 10/09/2026) -- es a donde lleva "Ver bultos" desde la pagina del pedido. La de una sola
// orden (/orden/:idOrden/bultos) sigue existiendo tal cual: es a donde llega "Más información" de
// una referencia puntual.
app.get('/selladora/:codigo/grupo/:idGrupo/bultos', requireLogin, async (req, res) => {
  const { codigo, idGrupo } = req.params;
  try {
    const p = await getPool();
    const miembros = await obtenerMiembrosGrupoSellado(p, idGrupo);
    if (miembros.length === 0) {
      return res.status(404).send(renderErrorSimple('Grupo no encontrado.', `/selladora/${codigo}`));
    }
    const datosPorReferencia = await obtenerBultosGrupo(p, miembros);
    res.send(renderBultosGrupo(idGrupo, miembros[0].NumeroPedido, codigo, datosPorReferencia, req.session.usuario.nombre));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}/grupo/${idGrupo}`));
  }
});

// Fragmento del sondeo de esa pagina (mismo mecanismo que el de una orden, ver
// scriptActualizarBultos): solo las tarjetas, sin cabecera ni estilos.
app.get('/selladora/:codigo/grupo/:idGrupo/bultos/fragmento', requireLogin, async (req, res) => {
  const { idGrupo } = req.params;
  try {
    const p = await getPool();
    const miembros = await obtenerMiembrosGrupoSellado(p, idGrupo);
    const datosPorReferencia = await obtenerBultosGrupo(p, miembros);
    res.send(renderTarjetasBultosGrupo(datosPorReferencia));
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

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
             ti.Descripcion AS TipoImpresionDescripcion,
             ${COLUMNAS_MEDIDAS_BOLSA}
      FROM SEL_OrdenProduccion ord
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      LEFT JOIN INVElementosReferencia er12 ON er12.Elemento = ord.Elemento AND er12.Categoria = 12
      LEFT JOIN INVElementosReferencia er13 ON er13.Elemento = ord.Elemento AND er13.Categoria = 13
      LEFT JOIN INVReferencia ti ON ti.Categoria = 13 AND ti.Codigo = er13.Valor${JOINS_MEDIDAS_BOLSA}
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
    // Chequeo de Calidad (03/09/2026, reescrito el 11/09/2026 a pedido del usuario): ya no se
    // programa una hora futura (la vieja columna SEL_EjecucionOrden.ProximaCalidad, que era un
    // chequeo aleatorio cada 20-30 min). Ahora sale en el PRIMER PAQUETE de cada bulto y quien lo
    // decide es el servidor, en /calidad-pendiente -- aca solo se resuelve si esta pagina tiene que
    // vigilarlo.
    // Se mantiene el FIX 03/09/2026: exige que la EJECUCION (no solo la orden) este realmente en
    // curso -- Activa o En pausa, nunca 'PendienteOperador' (nadie ha retomado el control todavia,
    // no tiene sentido pedir un chequeo de calidad sin un operario real detras). Nada se pierde por
    // no vigilarlo ahora: el chequeo de ese bulto sigue pendiente y sale apenas alguien retome el
    // control y vuelva a abrir esta pagina.
    let calidadHabilitada = false;
    const dtEjecucion = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden`
    );
    if (dtEjecucion.recordset.length > 0) {
      idEjecucion = dtEjecucion.recordset[0].IdEjecucion;
      const estadoEjecucion = dtEjecucion.recordset[0].Estado;
      if (estadoEjecucion === 'En pausa') {
        const dtPausa = await p.request().input('idEjecucion', idEjecucion).query(
          `SELECT TOP 1 Tipo, Subtipo, Observaciones, HoraInicio FROM SEL_TiempoMuerto WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC`
        );
        if (dtPausa.recordset.length > 0) pausaActiva = dtPausa.recordset[0];
      }
      calidadHabilitada = orden.Estado === 'Activa' && estadoEjecucion !== 'PendienteOperador';
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
    const grupoSellado = await obtenerGrupoSelladoDeOrden(p, idOrden);

    // Protocolo de arranque a medias en ESTA orden -- se retoma solo al abrir la pagina, y ademas
    // apaga el modal de pausa normal (ver renderOrdenDetalle) para no encimar dos ventanas.
    const protocoloPendiente = await obtenerProtocoloPendiente(p, Number(idOrden));

    res.send(renderOrdenDetalle(orden, totalBultos, historial, req.session.usuario.nombre, codigo, pausaActiva, avance, calidadHabilitada, grupoSellado, protocoloPendiente));
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
  // FIX 08/09/2026 (traslado de paquetes entre bultos, ver sp_SEL_TrasladarPaquete): un bulto que
  // queda sin ningun paquete tras un traslado se marca 'Anulado' (nunca se borra, queda de
  // auditoria) -- se excluye aca para que no aparezca como una tarjeta vacia mas en la pagina.
  const bultosResult = await p.request().input('idOrden', idOrden).query(`
    SELECT b.id, b.num_bulto, b.serialPadre, b.CantidadTotal, b.estado, ISNULL(b.Golpes,0) AS Golpes, b.Potencia,
           FORMAT(b.HoraInicio, 'dd/MM/yyyy HH:mm') AS HoraInicio,
           FORMAT(b.HoraFin, 'dd/MM/yyyy HH:mm') AS HoraFin
    FROM SEL_Bultos b
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.estado <> 'Anulado'
    ORDER BY b.num_bulto ASC
  `);
  const bultos = bultosResult.recordset.map((b, idx) => ({ ...b, numRelativo: idx + 1 }));

  let pesajesPorBulto = new Map();
  let residuosPorBulto = new Map();
  if (bultos.length > 0) {
    // id_paquete (PK real de SEL_PesajeElemento) se necesita para identificar sin ambigüedad UN
    // paquete puntual al trasladarlo (ver /api/selladora/paquete/trasladar) -- ConsecutivoPaquete
    // solo es único DENTRO de un bulto, no en toda la orden.
    const pesajesResult = await p.request().input('idOrden', idOrden).query(`
      SELECT pe.id_paquete, pe.id_bulto, pe.ConsecutivoPaquete, FORMAT(pe.FechaHora,'dd/MM/yyyy HH:mm:ss') AS Hora, pe.PesoPaqueGr
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

  // FIX 09/09/2026 (a pedido del usuario -- Sellado en paralelo): faltaba 'EnEspera' -- una
  // referencia hermana parqueada (con paquetes reales ya pesados antes de alternar a otra) quedaba
  // fuera de esta suma, así que su % de avance en la página de grupo salía en 0 aunque sí tuviera
  // producción real. 'Temporal' se agrega por si acaso (normalmente nunca tiene paquetes).
  const dtProducido = await p.request().input('idOrden', idOrden).query(`
    SELECT ISNULL(SUM(pe.PesoPaqueGr), 0) AS PesoTotalKg, COUNT(*) AS Paquetes
    FROM SEL_PesajeElemento pe
    INNER JOIN SEL_Bultos b ON b.id = pe.id_bulto
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.estado IN ('Activo', 'Cerrado', 'EnEspera', 'Temporal')
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

// Traslado de un paquete de un bulto a otro (reunion 07/09/2026, seccion nueva en /bultos, ver
// scriptTraslado() y el <details> "Trasladar paquete" en renderTarjetasBultos). Toda la logica
// transaccional vive en dbo.sp_SEL_TrasladarPaquete (ver crear_sp_trasladar_paquete.sql) -- este
// endpoint solo valida la sesion, llama al SP y devuelve los datos del paquete YA en su bulto nuevo
// para que el cliente dispare la reimpresion de su etiqueta (mismo comando 'reimprimir_etiqueta' que
// ya usa reimprimirPaquete() en scriptReimprimir).
app.post('/api/selladora/paquete/trasladar', requireLogin, async (req, res) => {
  const { idPaquete, idBultoDestino } = req.body;
  if (!idPaquete || !idBultoDestino) {
    return res.json({ ok: false, error: 'Falta idPaquete o idBultoDestino.' });
  }
  try {
    const p = await getPool();
    const result = await p.request()
      .input('idPaquete', idPaquete)
      .input('idBultoDestino', idBultoDestino)
      .execute('sp_SEL_TrasladarPaquete');
    const fila = result.recordset && result.recordset[0];
    if (!fila) {
      return res.json({ ok: false, error: 'El traslado no devolvió datos -- revise manualmente.' });
    }
    res.json({
      ok: true,
      detalleNuevo: fila.DetalleNuevo,
      idBultoDestino: fila.IdBultoDestino,
      serialPadreDestino: fila.SerialPadreDestino,
      consecutivoNuevo: fila.ConsecutivoNuevo,
      pesoGr: Number(fila.PesoGr),
      idBultoOrigen: fila.IdBultoOrigen
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// "Volver a pesar" un paquete ya registrado (09/09/2026, a pedido del usuario) -- el operario lo
// vuelve a poner en la bascula desde la pagina de Bultos y el peso en vivo reemplaza al que quedo
// guardado. Ver agregar_repesaje_paquete.sql para el detalle de que se toca y que no.
//
// Todo va en una transaccion: o queda corregido el paquete, recalculado el total del bulto y
// escrito el rastro, o no queda nada. El UPDATE de SEL_Bultos NO dispara nada raro: los dos
// triggers de esa tabla que reaccionan a UPDATE arrancan con IF UPDATE(estado) / se saltan cuando
// no hubo INSERT, y aca solo se toca CantidadTotal.
app.post('/api/selladora/paquete/repesar', requireLogin, async (req, res) => {
  const idPaquete = Number(req.body && req.body.idPaquete);
  const pesoGr = Number(req.body && req.body.pesoGr);
  if (!Number.isFinite(idPaquete) || idPaquete <= 0) {
    return res.json({ ok: false, error: 'Falta idPaquete.' });
  }
  if (!Number.isFinite(pesoGr) || pesoGr <= 0) {
    return res.json({ ok: false, error: 'El peso debe ser un número mayor que cero.' });
  }
  try {
    const p = await getPool();
    const dtPaquete = await p.request().input('idPaquete', idPaquete).query(`
      SELECT TOP 1 pe.id_paquete, pe.id_bulto, pe.ConsecutivoPaquete, pe.PesoPaqueGr,
             b.estado AS EstadoBulto, b.serialPadre, b.CantidadTotal, ord.Estado AS EstadoOrden
      FROM SEL_PesajeElemento pe
      LEFT JOIN SEL_Bultos b ON b.id = pe.id_bulto
      LEFT JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      LEFT JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
      WHERE pe.id_paquete = @idPaquete
    `);
    if (dtPaquete.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró ese paquete.' });
    }
    const paq = dtPaquete.recordset[0];
    const pesoAnterior = Number(paq.PesoPaqueGr);

    // Tope: 'Finalizada' es el estado que deja "Cerrar Definitivo" del escritorio -- ahi ya se
    // calculo la Merma del proceso (frmValidacionSelladora.vb) a partir de estos mismos pesos.
    // Corregir un paquete despues de eso descuadra una merma ya cerrada, y esta pantalla no tiene
    // como recalcularla: se bloquea y lo ajusta el digitador. Mientras la orden esta Activa o en
    // PendienteValidacion si se puede corregir (Finalizar desde la tableta no calcula merma).
    if (paq.EstadoOrden === 'Finalizada') {
      return res.json({
        ok: false,
        error: 'Esta orden ya fue cerrada definitivamente por el digitador y su merma ya está calculada. El peso de este paquete solo se puede corregir desde el escritorio.'
      });
    }

    let totalBulto = null;
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      await tx.request()
        .input('idPaquete', idPaquete).input('idBulto', paq.id_bulto)
        .input('estadoBulto', paq.EstadoBulto || null)
        .input('pesoAnterior', pesoAnterior).input('pesoNuevo', pesoGr)
        .input('operario', req.session.usuario.codigoOperarioPRD || null)
        .query(`
          INSERT INTO SEL_RepesajePaquete (id_paquete, id_bulto, EstadoBulto, PesoAnterior, PesoNuevo, Operario)
          VALUES (@idPaquete, @idBulto, @estadoBulto, @pesoAnterior, @pesoNuevo, @operario)
        `);
      await tx.request().input('idPaquete', idPaquete).input('peso', pesoGr)
        .query(`UPDATE SEL_PesajeElemento SET PesoPaqueGr = @peso WHERE id_paquete = @idPaquete`);

      // Todo lo que sigue aplica SOLO a los bultos que ya tenian total calculado (los que pasaron
      // por 'Cerrado'). En un bulto todavia abierto no hay nada que rehacer: CantidadTotal la
      // escribe trg_SEL_Bultos_CierreBulto al cerrar y PRDProduccion tiene una fila reservada en
      // Cantidad=0 que ese mismo trigger llena -- para ese momento ya suman el valor corregido.
      if (paq.id_bulto != null && paq.CantidadTotal != null) {
        const dtTotal = await tx.request().input('idBulto', paq.id_bulto).query(
          `SELECT ISNULL(SUM(PesoPaqueGr), 0) AS Total FROM SEL_PesajeElemento WHERE id_bulto = @idBulto`
        );
        totalBulto = Number(dtTotal.recordset[0].Total);

        await tx.request().input('idBulto', paq.id_bulto).input('total', totalBulto)
          .query(`UPDATE SEL_Bultos SET CantidadTotal = @total WHERE id = @idBulto`);

        // Cantidades de produccion: se replica exactamente lo que hacen trg_SEL_Bultos_CierreBulto
        // (al cerrar el bulto) y finalizarControlParcialSellado (al Finalizar la orden) -- las dos
        // sacan estos dos valores de SEL_Bultos.CantidadTotal, que es la que se acaba de rehacer.
        // No se toca Unidades ni Duracion/HoraFinal: repesar no cambia ni el numero de paquetes ni
        // las horas del bulto.
        await tx.request().input('serialPadre', paq.serialPadre).input('total', totalBulto).query(`
          UPDATE PRDProduccion SET Cantidad = @total, FechaModificado = GETDATE()
          WHERE Detalle = @serialPadre
        `);
        // Mismo emparejamiento (Elemento/Linea/Fecha/Lote) que usa el trigger de cierre.
        await tx.request().input('idBulto', paq.id_bulto).input('total', totalBulto).query(`
          UPDATE er SET er.PesoBrutoKg = @total
          FROM PRDExtrusionRollos er
          INNER JOIN SEL_Bultos b
            ON b.refsalida = er.Elemento AND b.num_bulto = er.Linea
            AND er.Fecha = DATEFROMPARTS(b.agno, b.mes, b.dia)
            AND er.Lote = RIGHT('0' + CAST(b.mes AS varchar(2)), 2) + RIGHT('0' + CAST(b.dia AS varchar(2)), 2)
          WHERE b.id = @idBulto
        `);

        // INVExistencias y la linea del movimiento Tipo 35 se dejan COMO ESTAN, a pedido expreso
        // del usuario (09/09/2026: "No toques inventario"). Las escribe
        // trg_SEL_Bultos_GenerarEntradaInventario en el momento en que el bulto cierra y nadie mas
        // las reescribe, asi que tras un repesaje el saldo de ese serial queda con el peso viejo.
        // La ventana de la tableta lo avisa, y SEL_RepesajePaquete guarda el rastro exacto por si
        // despues se decide ajustarlo.
      }
      await tx.commit();
    } catch (errTx) {
      await tx.rollback();
      throw errTx;
    }

    res.json({
      ok: true,
      pesoAnterior,
      pesoNuevo: pesoGr,
      idBulto: paq.id_bulto,
      consecutivoPaquete: paq.ConsecutivoPaquete,
      serialBulto: paq.serialPadre,
      // Lo usa la tableta para avisar que el saldo de inventario de un bulto ya cerrado NO se
      // reajusta (ver agregar_repesaje_paquete.sql).
      bultoCerrado: paq.CantidadTotal != null,
      totalBulto
    });
  } catch (err) {
    const falta = /Invalid object name/i.test(err.message);
    res.json({ ok: false, error: falta ? 'Falta crear la tabla SEL_RepesajePaquete (ejecute agregar_repesaje_paquete.sql).' : err.message });
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
    // FIX 09/09/2026 (a pedido del usuario -- Sellado en paralelo): antes solo miraba estado='Activo',
    // así que una referencia hermana parqueada en 'EnEspera' (con paquetes reales ya pesados antes de
    // alternar a otra) salía siempre en 0/0 -- el resumen debe reflejar el bulto propio de ESTA orden,
    // sea el que esté recibiendo paquetes ahora ('Activo'/'Temporal') o el que quedó parqueado
    // ('EnEspera') -- nunca puede haber más de uno de estos a la vez para la misma orden.
    const dtBultoActivo = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 b.id FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND b.estado IN ('Activo', 'Temporal', 'EnEspera')
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

// ¿Hay que pedirle el chequeo de Calidad al operario ahora mismo? (a pedido del usuario,
// 11/09/2026: "el registro de calidad ya no sale cada media hora, debe aparecer en el primer
// paquete registrado de cada bulto"). Lo sondea la tableta cada 5s, ver revisarCalidadDelBulto()
// en scriptComandos.
//
// La regla es de una sola frase: el bulto que esta recibiendo paquetes YA tiene al menos uno
// pesado y TODAVIA no tiene una fila en SEL_ChequeoCalidad. Con eso el chequeo:
//   - sale en el primer paquete de cada bulto, no cada 20-30 min como hasta ahora (esa era la
//     columna SEL_EjecucionOrden.ProximaCalidad, que quedo sin uso),
//   - sale UNA sola vez por bulto -- la fila del chequeo es la marca de "este bulto ya se reviso",
//     asi que recargar la pagina, cambiar de pestaña o abrirla en otra tableta no lo repite,
//   - y no se pierde si el operario cancela: el bulto sigue sin chequeo y se vuelve a pedir (el
//     cliente espera 5 minutos antes de insistir).
// Criterio del bulto identico al de registrarChequeoCalidad (estado='Activo', el mas reciente):
// tiene que ser el MISMO bulto que termine en la columna id_bulto del chequeo, si no se volveria
// a pedir para siempre.
app.get('/selladora/:codigo/orden/:idOrden/calidad-pendiente', requireLogin, async (req, res) => {
  const { idOrden } = req.params;
  try {
    const p = await getPool();
    const dtBulto = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 b.id FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden AND b.estado = 'Activo'
      ORDER BY b.id DESC
    `);
    if (dtBulto.recordset.length === 0) {
      return res.json({ ok: true, pendiente: false, idBulto: null, paquetes: 0 });
    }
    const idBulto = dtBulto.recordset[0].id;
    const dtEstado = await p.request().input('idBulto', idBulto).query(`
      SELECT (SELECT COUNT(*) FROM SEL_PesajeElemento WHERE id_bulto = @idBulto) AS Paquetes,
             (SELECT COUNT(*) FROM SEL_ChequeoCalidad WHERE id_bulto = @idBulto) AS Chequeos
    `);
    const { Paquetes, Chequeos } = dtEstado.recordset[0];
    res.json({ ok: true, pendiente: Paquetes > 0 && Chequeos === 0, idBulto, paquetes: Paquetes });
  } catch (err) {
    // Mismo blindaje que el resto de tablas nuevas: SEL_ChequeoCalidad puede no existir todavia en
    // la base contra la que se este probando (ver agregar_calidad_por_bulto_y_medidas.sql). Sin esa
    // tabla no hay forma de saber que bultos ya se revisaron, y pedir el chequeo cada 5 segundos
    // seria peor que no pedirlo: se contesta que no hay nada pendiente y se deja el aviso en
    // consola.
    console.error('No se pudo revisar el chequeo de Calidad del bulto (¿falta ejecutar agregar_calidad_por_bulto_y_medidas.sql?):', err.message);
    res.json({ ok: true, pendiente: false, idBulto: null, paquetes: 0 });
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
    // Bitacora de turno (12/09/2026): este es EL punto donde se abre -- el mismo en que la maquina
    // cambia de dueno. Si el que toma control es el mismo operario y sigue el mismo turno, no abre
    // otra: reusa la que ya esta abierta (un corte de red o un retome no pueden partir la bitacora
    // en dos, requisito del usuario). Si es otro operario, cierra la anterior por 'relevo'.
    // No revienta hacia afuera: si falla, el operario igual toma control -- ver abrirOReanudarBitacora.
    await abrirOReanudarBitacora(p, Maquina, miOperario);
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

// Sellado en paralelo (08/09/2026 -- ver DISENO_SELLADO_PARALELO_08092026.md): alterna cuál
// referencia del grupo (mismo pedido, vinculadas por PRDGrupoEtapasCompartidas CategoriaMaquina=
// 'SELLADORA') está recibiendo paquetes ahora mismo en esta máquina. idOrden en la URL es la
// referencia a la que se quiere cambiar -- alternarReferenciaGrupo() se encarga de bajar la que
// estaba activa y subir esta.
app.post('/api/selladora/orden/:idOrden/alternar-referencia', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const usuario = req.session.usuario;

  if (!usuario.codigoOperarioPRD) {
    return res.json({ ok: false, error: 'Su usuario no tiene un operario de planta configurado.' });
  }

  try {
    const p = await getPool();
    const maquinaCodigo = await obtenerCodigoMaquinaDeOrden(p, idOrden);

    const dtBolsas = await p.request().input('maquina', maquinaCodigo).query(`
      SELECT TOP 1 ej.BolsasxGolpe FROM SEL_EjecucionOrden ej
      INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
      WHERE ord.Maquina = @maquina AND ej.Estado = 'Activa'
      ORDER BY ej.IdEjecucion DESC
    `);
    const nBolsasXGolpe = dtBolsas.recordset.length > 0 ? dtBolsas.recordset[0].BolsasxGolpe : 0;

    await alternarReferenciaGrupo(p, {
      idOrdenDestino: idOrden,
      codOperario: usuario.codigoOperarioPRD,
      bolsasXGolpe: nBolsasXGolpe,
      generadoPor: usuario.generadoPor
    });

    // FIX 09/09/2026 (a pedido del usuario): "Alternar" ahora se dispara desde la página de grupo
    // (/selladora/:codigo/grupo/:idGrupo), no desde la página tradicional de una sola referencia --
    // al terminar, vuelve ahí (con el estado ya actualizado) en vez de a la orden puntual.
    const nIdGrupo = await obtenerIdGrupoSelladoDeOrden(p, idOrden);
    const redirect = nIdGrupo != null
      ? `/selladora/${maquinaCodigo}/grupo/${nIdGrupo}`
      : `/selladora/${maquinaCodigo}/orden/${idOrden}`;
    res.json({ ok: true, redirect });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ============================ Bitacora de turno ============================
// "Un registro unico" por (maquina, operario, turno) -- a pedido del usuario, 12/09/2026, en
// reemplazo de la planilla por orden que se elimino el 11/09/2026. Ver agregar_bitacora_turno.sql
// para el porque de la tabla y de que se abre/cierra cuando.
//
// La tabla SEL_BitacoraTurno guarda SOLO la cabecera. Los renglones (bulto, horas, rollo, hora de
// registro, unidades) se leen en vivo de SEL_Bultos / SEL_RolloEjecucion / SEL_PesajeElemento con
// un JOIN por ventana de tiempo -- decision del usuario: nada se copia, para que no haya dos
// versiones del mismo dato.

// OJO CON LA ZONA HORARIA (comprobado 09/09/2026 contra la base): SQL Server guarda y devuelve
// hora LOCAL de Colombia (GETDATE() = 14:39 cuando aca son las 14:39), pero el driver mssql la
// entrega como Date de JS interpretandola como UTC. Si se formatea con toLocaleTimeString a secas,
// el navegador le vuelve a restar 5 horas y un paquete pesado a las 14:39 se muestra "09:39".
// Por eso se formatea con timeZone 'UTC': asi se ve tal como esta guardado, que es justo la hora de
// pared que vio el operario.
function horaCorta(fecha) {
  if (!fecha) return '—';
  return new Date(fecha).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
}

function fechaHoraLocalBD(fecha) {
  if (!fecha) return '—';
  return new Date(fecha).toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC'
  });
}

// Turnos que se usan cuando la maquina no tiene ninguno cargado en TURHorariosMaquinas (en
// produccion pasa con 4 de las 16 selladoras: 03, 08, 09 y 12 -- comprobado el 12/09/2026). Son los
// tres de 8 horas que si tienen asignados las otras 12, todas con las mismas cinco franjas.
// Ver la NOTA SOBRE EL TURNO en agregar_bitacora_turno.sql.
const TURNOS_BASE_SELLADORA = [6, 7, 8];

// 'HH:MM' -> minutos desde medianoche. NOMTurnos.HoraInicial/HoraFinal y
// TURHorariosMaquinas.HoraInicio/HoraFin son varchar, no time.
function minutosDelDia(hhmm) {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  const minutos = Number(m[1]) * 60 + Number(m[2]);
  return minutos >= 0 && minutos < 1440 ? minutos : null;
}

// Fecha local en 'YYYY-MM-DD'. Se manda como TEXTO a la columna DATE: pasar un Date de JS deja que
// el driver lo convierta a UTC y un turno abierto a las 21:30 terminaria imputado al dia siguiente.
function fechaISOLocal(fecha) {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Turno en el que cae `momento` para una maquina, deducido de su horario (decision del usuario,
// 12/09/2026). Devuelve { turno, descripcion, fechaTurno } -- turno/descripcion en null si no hay
// ninguna franja que contenga esa hora (la bitacora igual se abre: tiene operario, maquina y horas).
//
// Las DOS reglas que no salen de ninguna tabla y que hay que conocer antes de tocar esto:
//   - Los horarios SE SOLAPAN (la SELLADORA 04 tiene Tarde 14:00-22:00 y Pleno Noche 18:00-05:45 a
//     la vez). Desempata la franja MAS CORTA: los turnos "Pleno" son jornadas extendidas montadas
//     encima de los tres turnos normales de 8 horas, y el ordinario es el que la planta usa por
//     defecto.
//   - Si la maquina no tiene horarios, se usan los tres turnos base (TURNOS_BASE_SELLADORA).
// Si alguna de las dos no es lo que quiere la planta, lo correcto es arreglar los DATOS antes que
// este codigo -- ver agregar_bitacora_turno.sql.
async function resolverTurnoMaquina(p, maquinaCodigo, momento) {
  const cuando = momento ? new Date(momento) : new Date();
  const dtHorarios = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT th.CodigoTurno AS Codigo, t.Descripcion, th.HoraInicio, th.HoraFin
    FROM TURHorariosMaquinas th
    INNER JOIN NOMTurnos t ON t.Codigo = th.CodigoTurno
    WHERE th.CodigoMaquina = @maquina
  `);
  let franjas = dtHorarios.recordset;
  if (franjas.length === 0) {
    const dtBase = await p.request().query(`
      SELECT Codigo, Descripcion, HoraInicial AS HoraInicio, HoraFinal AS HoraFin
      FROM NOMTurnos WHERE Codigo IN (${TURNOS_BASE_SELLADORA.join(',')})
    `);
    franjas = dtBase.recordset;
  }

  const minutosAhora = cuando.getHours() * 60 + cuando.getMinutes();
  const candidatas = franjas.map(f => {
    const ini = minutosDelDia(f.HoraInicio);
    const fin = minutosDelDia(f.HoraFin);
    if (ini == null || fin == null) return null;
    // fin <= ini => la franja cruza medianoche (22:00-06:00).
    const cruzaMedianoche = fin <= ini;
    const contiene = cruzaMedianoche ? (minutosAhora >= ini || minutosAhora < fin) : (minutosAhora >= ini && minutosAhora < fin);
    if (!contiene) return null;
    return {
      codigo: f.Codigo,
      descripcion: f.Descripcion,
      duracion: cruzaMedianoche ? (1440 - ini + fin) : (fin - ini),
      // Estamos en el pedazo DESPUES de medianoche de un turno que empezo ayer.
      despuesDeMedianoche: cruzaMedianoche && minutosAhora < fin
    };
  }).filter(Boolean);

  if (candidatas.length === 0) {
    return { turno: null, descripcion: null, fechaTurno: fechaISOLocal(cuando) };
  }
  candidatas.sort((a, b) => a.duracion - b.duracion);
  const elegida = candidatas[0];

  // El turno de la noche que arranco ayer se imputa a AYER, no al dia del reloj: los bultos de las
  // 2 a.m. son del turno de anoche, que es como los cuenta la planta.
  const fechaBase = new Date(cuando);
  if (elegida.despuesDeMedianoche) fechaBase.setDate(fechaBase.getDate() - 1);

  return { turno: elegida.codigo, descripcion: elegida.descripcion, fechaTurno: fechaISOLocal(fechaBase) };
}

async function cerrarBitacora(p, idBitacora, motivo) {
  await p.request().input('id', idBitacora).input('motivo', motivo).query(
    `UPDATE SEL_BitacoraTurno SET HoraCierre = GETDATE(), MotivoCierre = @motivo
     WHERE IdBitacora = @id AND HoraCierre IS NULL`
  );
}

// Abre la bitacora del turno, o REUSA la que ya este abierta si es del mismo operario y del mismo
// turno. Se llama desde "tomar control de la maquina".
//
// Lo de reusar es un requisito explicito del usuario (12/09/2026): "no cuando el operario cierra
// sesion porque puede pasar que se vaya el internet o retome la orden". Un corte de red, un
// re-login o volver a tomar control a mitad del turno NO pueden partir la bitacora en dos.
// Por eso tampoco hay nada que cierre la bitacora en /logout: solo la cierra un RELEVO (otro
// operario toma la maquina) o el CAMBIO DE TURNO.
//
// Nunca revienta hacia afuera: si algo falla, se registra en consola y el operario igual toma
// control de la maquina. La bitacora es un registro, no puede bloquear la produccion.
async function abrirOReanudarBitacora(p, maquinaCodigo, operarioCodigo) {
  try {
    const turnoAhora = await resolverTurnoMaquina(p, maquinaCodigo);

    const dtAbierta = await p.request().input('maquina', maquinaCodigo).query(`
      SELECT TOP 1 IdBitacora, Operario, Turno, CONVERT(varchar(10), FechaTurno, 23) AS FechaTurno
      FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL
      ORDER BY IdBitacora DESC
    `);

    if (dtAbierta.recordset.length > 0) {
      const abierta = dtAbierta.recordset[0];
      const mismoOperario = abierta.Operario === operarioCodigo;
      // Turno en null a los dos lados tambien cuenta como "el mismo" -- si no, una maquina sin
      // horarios abriria una bitacora nueva en cada toma de control.
      const mismoTurno = (abierta.Turno == null ? null : Number(abierta.Turno)) === turnoAhora.turno
        && abierta.FechaTurno === turnoAhora.fechaTurno;
      if (mismoOperario && mismoTurno) return abierta.IdBitacora;  // retome: la misma bitacora sigue
      await cerrarBitacora(p, abierta.IdBitacora, mismoOperario ? 'cambio_turno' : 'relevo');
    }

    const dtNueva = await p.request()
      .input('maquina', maquinaCodigo).input('operario', operarioCodigo)
      .input('turno', turnoAhora.turno).input('fechaTurno', turnoAhora.fechaTurno)
      .query(`
        DECLARE @Insertados TABLE (Id INT);
        INSERT INTO SEL_BitacoraTurno (Maquina, Operario, Turno, FechaTurno)
        OUTPUT INSERTED.IdBitacora INTO @Insertados
        VALUES (@maquina, @operario, @turno, @fechaTurno);
        SELECT Id FROM @Insertados;
      `);
    return dtNueva.recordset[0].Id;
  } catch (err) {
    console.error('No se pudo abrir/reanudar la bitacora de turno (¿falta ejecutar agregar_bitacora_turno.sql?):', err.message);
    return null;
  }
}

// Cabecera + renglones de una bitacora. `idBitacora` opcional: sin el se toma la que este ABIERTA
// en esa maquina y, si no hay ninguna, la ultima que se cerro.
async function obtenerBitacora(p, maquinaCodigo, idBitacora) {
  const dtCabecera = await p.request().input('maquina', maquinaCodigo).input('id', idBitacora || null).query(`
    SELECT TOP 1 bi.IdBitacora, bi.Maquina, bi.Operario, bi.Turno,
           CONVERT(varchar(10), bi.FechaTurno, 23) AS FechaTurno,
           bi.HoraApertura, bi.HoraCierre, bi.MotivoCierre,
           maq.Nombre AS MaquinaNombre, op.Nombre AS OperarioNombre,
           tu.Descripcion AS TurnoDescripcion
    FROM SEL_BitacoraTurno bi
    LEFT JOIN PRDMaquinas maq ON maq.Codigo = bi.Maquina
    LEFT JOIN PRDOperarios op ON op.Codigo = bi.Operario
    LEFT JOIN NOMTurnos tu ON tu.Codigo = bi.Turno
    WHERE bi.Maquina = @maquina AND (@id IS NULL OR bi.IdBitacora = @id)
    -- Sin @id: manda la abierta (HoraCierre NULL ordena primero con este CASE) y si no, la ultima.
    ORDER BY CASE WHEN bi.HoraCierre IS NULL THEN 0 ELSE 1 END, bi.HoraApertura DESC
  `);
  if (dtCabecera.recordset.length === 0) return null;
  const cabecera = dtCabecera.recordset[0];

  // Un bulto es de esta bitacora si salio de ESTA maquina dentro de la ventana del turno. Se usa
  // HoraInicio y, cuando esta en NULL (pasa: 5 de 38 bultos en la base de pruebas), la hora del
  // primer paquete pesado, que es lo mas cercano a "cuando empezo este bulto".
  const dtRenglones = await p.request()
    .input('maquina', cabecera.Maquina)
    .input('apertura', cabecera.HoraApertura)
    .input('cierre', cabecera.HoraCierre)
    .query(`
      SELECT b.id AS IdBulto, b.num_bulto, b.estado, b.HoraInicio, b.HoraFin,
             b.number_paqu, b.CantidadTotal, ISNULL(b.NumeroPedido, '') AS NumeroPedido,
             ie.Referencia, ie.Nombre AS NombreElemento,
             pk.PrimerPaquete, pk.UltimoPaquete, pk.Paquetes, pk.PesoPaquetes,
             ro.Seriales AS SerialesRollo
      FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      OUTER APPLY (
        SELECT MIN(pe.FechaHora) AS PrimerPaquete, MAX(pe.FechaHora) AS UltimoPaquete,
               COUNT(*) AS Paquetes, SUM(pe.PesoPaqueGr) AS PesoPaquetes
        FROM SEL_PesajeElemento pe WHERE pe.id_bulto = b.id
      ) pk
      OUTER APPLY (
        SELECT STRING_AGG(re.Serial, ' · ') AS Seriales
        FROM SEL_RolloEjecucion re WHERE re.id_bulto = b.id
      ) ro
      WHERE b.id_maquina = @maquina
        AND COALESCE(b.HoraInicio, pk.PrimerPaquete) >= @apertura
        AND (@cierre IS NULL OR COALESCE(b.HoraInicio, pk.PrimerPaquete) < @cierre)
      ORDER BY COALESCE(b.HoraInicio, pk.PrimerPaquete), b.id
    `);

  // Rollos montados durante el turno. Van aparte de los renglones porque SEL_RolloEjecucion.id_bulto
  // es nullable: el rollo del arranque se registra ANTES de que exista el primer bulto, asi que si
  // solo se listaran los atados a un bulto, ese se perderia.
  let rollos = [];
  try {
    const dtRollos = await p.request()
      .input('maquina', cabecera.Maquina)
      .input('apertura', cabecera.HoraApertura)
      .input('cierre', cabecera.HoraCierre)
      .query(`
        SELECT re.Serial, re.FechaHora, re.Cantidad, re.LoteMP, re.EsInicio, re.id_bulto
        FROM SEL_RolloEjecucion re
        INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = re.id_ejecucion
        INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
        WHERE ord.Maquina = @maquina AND re.FechaHora >= @apertura
          AND (@cierre IS NULL OR re.FechaHora < @cierre)
        ORDER BY re.FechaHora
      `);
    rollos = dtRollos.recordset;
  } catch (err) {
    console.error('Bitacora: no se pudo leer SEL_RolloEjecucion (¿falta ejecutar agregar_rollo_ejecucion.sql?):', err.message);
  }

  return { cabecera, renglones: dtRenglones.recordset, rollos };
}

// Las ultimas bitacoras de la maquina, para el desplegable que permite mirar turnos anteriores.
async function obtenerBitacorasRecientes(p, maquinaCodigo) {
  const dt = await p.request().input('maquina', maquinaCodigo).query(`
    SELECT TOP 20 bi.IdBitacora, CONVERT(varchar(10), bi.FechaTurno, 23) AS FechaTurno,
           bi.HoraApertura, bi.HoraCierre, op.Nombre AS OperarioNombre, tu.Descripcion AS TurnoDescripcion
    FROM SEL_BitacoraTurno bi
    LEFT JOIN PRDOperarios op ON op.Codigo = bi.Operario
    LEFT JOIN NOMTurnos tu ON tu.Codigo = bi.Turno
    WHERE bi.Maquina = @maquina
    ORDER BY bi.HoraApertura DESC
  `);
  return dt.recordset;
}

// Pagina de la bitacora. Una fila por BULTO, en orden cronologico, con lo que pidio el usuario
// (12/09/2026): hora de inicio y fin del bulto, serial del rollo, a que hora se registro y las
// unidades. "Registrado" es la franja entre el primer y el ultimo paquete pesado de ese bulto --
// que es, literalmente, cuando se registro.
function renderBitacora(datos, recientes, maquinaCodigo, usuario) {
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { cabecera: c, renglones, rollos } = datos;

  // Unidades: misma regla que el resto de la app (100 bolsas por paquete, ver UNIDADES_POR_PAQUETE).
  const unidadesDe = (r) => (r.number_paqu || 0) * UNIDADES_POR_PAQUETE;
  const totalPaquetes = renglones.reduce((s, r) => s + (r.number_paqu || 0), 0);
  const totalUnidades = renglones.reduce((s, r) => s + unidadesDe(r), 0);
  // PesoPaqueGr guarda KILOGRAMOS pese al nombre (ver FIX 02/09/2026 en scriptResumenBultoActivo).
  const totalKg = renglones.reduce((s, r) => s + Number(r.PesoPaquetes || 0), 0);

  const abierta = c.HoraCierre == null;
  const filas = renglones.length ? renglones.map(r => `
      <tr>
        <td class="cen"><strong>${r.num_bulto}</strong></td>
        <td>
          <div>${esc(r.NumeroPedido) || '—'}</div>
          <div class="bit-sub">${esc(r.Referencia)}</div>
        </td>
        <td class="cen">${horaCorta(r.HoraInicio)}</td>
        <td class="cen">${horaCorta(r.HoraFin)}</td>
        <td class="cen">${r.PrimerPaquete ? horaCorta(r.PrimerPaquete) + ' – ' + horaCorta(r.UltimoPaquete) : '—'}</td>
        <td>${esc(r.SerialesRollo) || '—'}</td>
        <td class="cen">${r.number_paqu || 0}</td>
        <td class="num">${unidadesDe(r).toLocaleString('es-CO')}</td>
        <td class="num">${r.PesoPaquetes != null ? Number(r.PesoPaquetes).toFixed(2) : '—'}</td>
        <td class="cen">${esc(r.estado)}</td>
      </tr>`).join('')
    : `<tr><td colspan="10" class="bit-vacio">Todavía no hay bultos en este turno.</td></tr>`;

  const filasRollos = rollos.length ? rollos.map(ro => `
      <div class="hist-fila">
        <span class="valor serial">${esc(ro.Serial)}</span>
        <span>${horaCorta(ro.FechaHora)}</span>
        <span>${ro.Cantidad != null ? Number(ro.Cantidad).toFixed(2) + ' kg' : '—'}</span>
        <span style="color:var(--texto-suave);">${ro.EsInicio ? 'Arranque' : 'Añadido'}${ro.LoteMP ? ' · Lote ' + esc(ro.LoteMP) : ''}</span>
      </div>`).join('')
    : `<div class="pesaje-vacio">Sin rollos montados en este turno.</div>`;

  const opcionesRecientes = recientes.map(b => {
    const etiqueta = `${b.FechaTurno} · ${b.TurnoDescripcion || 'Sin turno'} · ${b.OperarioNombre || 'Operario ' + b.IdBitacora}` +
      (b.HoraCierre == null ? ' · ABIERTA' : '');
    return `<option value="${b.IdBitacora}" ${b.IdBitacora === c.IdBitacora ? 'selected' : ''}>${esc(etiqueta)}</option>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bitácora — ${esc(c.MaquinaNombre)}</title>
  <style>${estilosBase()}
    .bit-cabecera { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
    .bit-dato { background: white; border-radius: 14px; padding: 12px 16px; flex: 1 1 160px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .bit-dato .label { margin-bottom: 4px; }
    .bit-dato .valor { font-size: 16px; font-weight: 700; }
    .bit-estado { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .bit-abierta { background: var(--verde-fondo); color: var(--verde); }
    .bit-cerrada { background: var(--naranja-fondo); color: var(--naranja); }
    /* La tabla es lo unico que puede ser mas ancho que la pantalla de la tableta: se desplaza
       sola en horizontal en vez de apretar las columnas hasta romperlas. */
    .bit-scroll { overflow-x: auto; background: white; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    table.bitacora { border-collapse: collapse; width: 100%; min-width: 820px; font-size: 13px; }
    table.bitacora th, table.bitacora td { border-bottom: 1px solid #e6e9ee; padding: 9px 10px; text-align: left; }
    table.bitacora th { background: #f4f6f8; font-size: 12px; text-transform: uppercase;
                        letter-spacing: .3px; color: var(--texto-suave); white-space: nowrap; }
    table.bitacora tfoot td { font-weight: 700; border-top: 2px solid #cfd4da; border-bottom: none; }
    table.bitacora .cen { text-align: center; white-space: nowrap; }
    table.bitacora .num { text-align: right; white-space: nowrap; }
    .bit-sub { font-size: 11px; color: var(--texto-suave); }
    .bit-vacio { text-align: center; color: var(--texto-suave); padding: 22px 0; }
    .bit-selector { margin-bottom: 16px; }
    .bit-selector select { width: 100%; max-width: 520px; padding: 10px 12px; border-radius: 10px;
                           border: 2px solid #cfd4da; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
    </div>
    <div class="header-inner">
      <div class="header-fila">
        <div class="header-info">
          <h1>📋 Bitácora de turno</h1>
          <div class="sub">${esc(c.MaquinaNombre)}</div>
          <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${esc(c.MaquinaNombre)}</a>
        </div>
        <div class="header-salir-grupo">
          <div class="header-usuario">👤 ${esc(usuario)}</div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>
      </div>
    </div>
  </header>
  <main>
    <div class="bit-selector">
      <div class="label" style="margin-bottom:6px;">Turno</div>
      <select id="selector-bitacora" onchange="location.href='/selladora/${maquinaCodigo}/bitacora/' + this.value;">
        ${opcionesRecientes}
      </select>
    </div>

    <div class="bit-cabecera">
      <div class="bit-dato">
        <div class="label">Operario</div>
        <div class="valor">${esc(c.OperarioNombre) || ('Código ' + c.Operario)}</div>
      </div>
      <div class="bit-dato">
        <div class="label">Turno</div>
        <div class="valor">${esc(c.TurnoDescripcion) || 'Sin turno asignado'}</div>
        <div class="bit-sub">${esc(c.FechaTurno)}</div>
      </div>
      <div class="bit-dato">
        <div class="label">Desde / hasta</div>
        <div class="valor">${horaCorta(c.HoraApertura)} – ${abierta ? '…' : horaCorta(c.HoraCierre)}</div>
        <div class="bit-sub">
          <span class="bit-estado ${abierta ? 'bit-abierta' : 'bit-cerrada'}">${abierta ? 'Abierta' : 'Cerrada'}</span>
          ${!abierta && c.MotivoCierre ? ' · ' + esc(c.MotivoCierre === 'relevo' ? 'Relevo de operario' : (c.MotivoCierre === 'cambio_turno' ? 'Cambio de turno' : c.MotivoCierre)) : ''}
        </div>
      </div>
      <div class="bit-dato">
        <div class="label">Producido</div>
        <div class="valor">${totalUnidades.toLocaleString('es-CO')} und</div>
        <div class="bit-sub">${renglones.length} bulto(s) · ${totalPaquetes} paquete(s) · ${totalKg.toFixed(2)} kg</div>
      </div>
    </div>

    <div class="bit-scroll">
      <table class="bitacora">
        <thead>
          <tr>
            <th class="cen">Bulto</th>
            <th>Pedido / referencia</th>
            <th class="cen">Hora inicio</th>
            <th class="cen">Hora fin</th>
            <th class="cen">Registrado</th>
            <th>Serial del rollo</th>
            <th class="cen">Paquetes</th>
            <th class="num">Unidades</th>
            <th class="num">Peso (kg)</th>
            <th class="cen">Estado</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
        ${renglones.length ? `<tfoot>
          <tr>
            <td colspan="6">Total del turno</td>
            <td class="cen">${totalPaquetes}</td>
            <td class="num">${totalUnidades.toLocaleString('es-CO')}</td>
            <td class="num">${totalKg.toFixed(2)}</td>
            <td></td>
          </tr>
        </tfoot>` : ''}
      </table>
    </div>

    <h2 style="font-size:15px;margin:22px 0 10px;">Rollos montados en el turno</h2>
    <div class="ejecucion-box">${filasRollos}</div>
  </main>
</body>
</html>`;
}

app.get('/selladora/:codigo/bitacora/:idBitacora?', requireLogin, async (req, res) => {
  const { codigo, idBitacora } = req.params;
  try {
    const p = await getPool();
    const datos = await obtenerBitacora(p, codigo, idBitacora ? Number(idBitacora) : null);
    if (!datos) {
      return res.status(404).send(renderErrorSimple(
        'Esta máquina todavía no tiene ninguna bitácora. Se abre sola cuando un operario toma control de la máquina.',
        `/selladora/${codigo}`));
    }
    const recientes = await obtenerBitacorasRecientes(p, codigo);
    res.send(renderBitacora(datos, recientes, codigo, req.session.usuario.nombre));
  } catch (err) {
    res.status(500).send(renderErrorSimple(err.message, `/selladora/${codigo}`));
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
// Temperatura de la perilla que digita el operario (ver agregar_temperatura_perilla.sql). Se
// guarda con la hora, para saber que valor estaba puesto en cada momento de la orden.
app.post('/api/selladora/orden/:idOrden/temperatura', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const porcentaje = Number(req.body && req.body.porcentaje);
  if (!Number.isFinite(porcentaje) || porcentaje < 0 || porcentaje > 100) {
    return res.json({ ok: false, error: 'La temperatura debe ser un porcentaje entre 0 y 100.' });
  }
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion ASC`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    await p.request()
      .input('idEjecucion', dtEj.recordset[0].IdEjecucion)
      .input('operario', req.session.usuario.codigoOperarioPRD || null)
      .input('porcentaje', porcentaje)
      .query(`INSERT INTO SEL_TemperaturaPerilla (id_ejecucion, Operario, Porcentaje) VALUES (@idEjecucion, @operario, @porcentaje)`);

    // A donde mandar al operario cuando este es el ULTIMO paso del protocolo de arranque (ver
    // pasoTemperaturaProtocolo). Se resuelve aca y no en la tableta porque solo el servidor sabe si
    // esta orden pertenece a un grupo de sellado en paralelo: si pertenece, el sitio correcto es la
    // pagina del GRUPO (que lista las 3 referencias con Alternar/Finalizar), no la de la referencia
    // suelta -- si no, seria imposible alternar despues de arrancar.
    const maquinaCodigo = await obtenerCodigoMaquinaDeOrden(p, idOrden);
    const idGrupo = await obtenerIdGrupoSelladoDeOrden(p, idOrden);
    const redirect = idGrupo != null
      ? `/selladora/${maquinaCodigo}/grupo/${idGrupo}`
      : `/selladora/${maquinaCodigo}/orden/${idOrden}`;
    res.json({ ok: true, redirect });
  } catch (err) {
    // Mensaje util si todavia no se ejecuto el script SQL en esta base.
    const falta = /Invalid object name/i.test(err.message);
    res.json({ ok: false, error: falta ? 'Falta crear la tabla SEL_TemperaturaPerilla (ejecute agregar_temperatura_perilla.sql).' : err.message });
  }
});

const COMANDOS_VALIDOS = new Set([
  'imprimir_etiqueta', 'reimprimir_etiqueta', 'cierre_bulto', 'retal', 'troquelado', 'refilado', 'calidad', 'no_conforme'
]);

// Pausa (SEL_TiempoMuerto) -- a diferencia de los comandos de arriba, esto SI escribe directo en
// esta BD (no pasa por Node-RED): es un simple cambio de estado + una fila de auditoria, no toca
// inventario/numeracion como Retal/Troquelado, asi que no hacia falta migrarlo. "SEL_EjecucionOrden
// debe quedar UN solo registro por orden" (mismo criterio que scan-rollo.js) -- se busca por
// IdOrden, no hay que resolver bulto activo para esto.
const MOTIVOS_PAUSA_VALIDOS = new Set(['descanso', 'mantenimiento', 'alistamiento', 'orden_aseo', 'limpieza', 'otro']);
// 'arranque' (09/09/2026) es el submotivo del alistamiento del paso 5 del protocolo de arranque
// (ver scriptProtocoloArranque): no lo elige el operario -- arranca solo apenas se acepta el rollo,
// por eso no aparece en la lista de SUBMOTIVOS_ALISTAMIENTO del boton de Pausa, solo aca en la
// validacion. Requiere el ALTER de CK_SEL_TiempoMuerto_Subtipo de agregar_protocolo_arranque.sql.
const SUBMOTIVOS_ALISTAMIENTO_VALIDOS = new Set(['materiales', 'mecanico', 'espacio_trabajo', 'arranque']);

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
      `SELECT TOP 1 ej.IdEjecucion, ej.Estado, ord.Estado AS EstadoOrden
       FROM SEL_EjecucionOrden ej
       INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
       WHERE ej.IdOrden = @idOrden`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    const { IdEjecucion, Estado, EstadoOrden } = dtEj.recordset[0];
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
    // FIX 09/09/2026: al reanudar ya no se pone 'Activa' a ciegas. El paso 1 del protocolo de
    // arranque (limpieza y desinfeccion) pausa la ejecucion cuando la orden TODAVIA esta Pendiente
    // -- su registro en SEL_EjecucionOrden sigue siendo el placeholder que creo Programacion.vb, y
    // dejarlo en 'Activa' sin que se haya escaneado ningun rollo lo hacia aparecer como una
    // ejecucion en curso (el /logout, por ejemplo, lo marcaba 'PendienteOperador'). La ejecucion
    // vuelve al estado que le corresponde segun la ORDEN: solo es 'Activa' si la orden ya arranco.
    await p.request().input('idEjecucion', IdEjecucion)
      .input('estado', EstadoOrden === 'Activa' ? 'Activa' : 'Pendiente')
      .query(`UPDATE SEL_EjecucionOrden SET Estado = @estado WHERE IdEjecucion = @idEjecucion`);

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ======================= Protocolo de arranque de una orden (09/09/2026) =======================
//
// Secuencia obligatoria que reemplaza al viejo "Iniciar -> escanear rollo -> ¿va a hacer alguna
// actividad?" (a pedido del usuario). El guion completo vive en el cliente
// (scriptProtocoloArranque), aca solo estan las dos piezas que necesitan la base:
//
//   - POST .../protocolo/respuesta : deja constancia de cada respuesta en SEL_ProtocoloArranque.
//   - obtenerProtocoloPendiente()  : deduce en que paso iba un protocolo a medias, para retomarlo
//                                    si la tableta se recargo/apago (el tiempo sigue corriendo en
//                                    la base, no en el navegador).
//
// Las dos actividades cronometradas del protocolo (limpieza del paso 1, alistamiento del paso 5)
// NO tienen endpoint propio: usan los mismos /pausar y /reanudar del boton de Pausa, para que
// queden en SEL_TiempoMuerto exactamente igual que cualquier otra actividad -- que era justo lo
// pedido ("queda registrado de la misma manera como actividad").
const PASOS_PROTOCOLO_VALIDOS = new Set([
  'limpieza', 'peligro_quimico', 'rollo_estado', 'peligro_fisico', 'alistamiento', 'temperatura'
]);

app.post('/api/selladora/orden/:idOrden/protocolo/respuesta', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const { paso, respuesta, serial, observaciones } = req.body || {};
  if (!PASOS_PROTOCOLO_VALIDOS.has(paso)) {
    return res.json({ ok: false, error: 'Paso de protocolo inválido.' });
  }
  const recorte = (valor, largo) => (valor == null || String(valor).trim() === '') ? null : String(valor).trim().slice(0, largo);
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion ASC`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    await p.request()
      .input('idEjecucion', dtEj.recordset[0].IdEjecucion)
      .input('idOrden', idOrden)
      .input('operario', req.session.usuario.codigoOperarioPRD || null)
      .input('paso', paso)
      .input('respuesta', recorte(respuesta, 20))
      .input('serial', recorte(serial, 30))
      .input('observaciones', recorte(observaciones, 255))
      .query(`
        INSERT INTO SEL_ProtocoloArranque (id_ejecucion, IdOrden, Operario, Paso, Respuesta, Serial, Observaciones)
        VALUES (@idEjecucion, @idOrden, @operario, @paso, @respuesta, @serial, @observaciones)
      `);
    res.json({ ok: true });
  } catch (err) {
    // Mismo criterio que /temperatura: si todavia no se corrio el script SQL en esta base, el
    // mensaje dice exactamente que falta en vez de un "Invalid object name" crudo.
    const falta = /Invalid object name/i.test(err.message);
    res.json({ ok: false, error: falta ? 'Falta crear la tabla SEL_ProtocoloArranque (ejecute agregar_protocolo_arranque.sql).' : err.message });
  }
});

// En que paso quedo un protocolo a medias, o null si no hay ninguno pendiente para esta orden.
// Se deduce de lo que hay en la BASE (no de nada guardado en el navegador), para que el protocolo
// se retome igual aunque la tableta se haya recargado, apagado o cambiado de manos:
//   - Hay una actividad del protocolo SIN HoraFin -> el cronometro de ese paso sigue corriendo.
//   - La orden sigue Pendiente y ya hay respuestas guardadas -> falta el peligro quimico (si la
//     ultima respuesta no fue 'No') o el escaneo del rollo.
//   - La orden ya esta Activa y el alistamiento del protocolo quedo registrado pero la temperatura
//     no -> falta el paso 6.
// Nunca revienta la pagina: ante cualquier error (tipico: falta ejecutar el script SQL) devuelve
// null y la orden se comporta como antes -- el protocolo vuelve a empezar desde el boton Iniciar.
async function obtenerProtocoloPendiente(p, idOrden) {
  try {
    const dtEj = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 ej.IdEjecucion, ord.Estado AS EstadoOrden
      FROM SEL_EjecucionOrden ej
      INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = ej.IdOrden
      WHERE ej.IdOrden = @idOrden ORDER BY ej.IdEjecucion ASC
    `);
    if (dtEj.recordset.length === 0) return null;
    const { IdEjecucion, EstadoOrden } = dtEj.recordset[0];
    if (EstadoOrden !== 'Pendiente' && EstadoOrden !== 'Activa') return null;

    const dtAbierta = await p.request().input('idEjecucion', IdEjecucion).query(`
      SELECT TOP 1 Tipo, Subtipo, HoraInicio FROM SEL_TiempoMuerto
      WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC
    `);
    const abierta = dtAbierta.recordset[0];
    const tipoAbierto = abierta ? String(abierta.Tipo || '').toLowerCase() : '';
    const subtipoAbierto = abierta ? String(abierta.Subtipo || '').toLowerCase() : '';
    if (tipoAbierto === 'limpieza' && EstadoOrden === 'Pendiente') {
      return { idOrden: Number(idOrden), paso: 'limpieza', horaInicio: abierta.HoraInicio };
    }
    if (tipoAbierto === 'alistamiento' && subtipoAbierto === 'arranque') {
      return { idOrden: Number(idOrden), paso: 'alistamiento', horaInicio: abierta.HoraInicio };
    }

    const dtPasos = await p.request().input('idEjecucion', IdEjecucion).query(
      `SELECT Paso, Respuesta FROM SEL_ProtocoloArranque WHERE id_ejecucion = @idEjecucion ORDER BY Id ASC`
    );
    const pasos = dtPasos.recordset;
    if (pasos.length === 0) return null; // este protocolo nunca arranco -- boton Iniciar normal

    if (EstadoOrden === 'Pendiente') {
      const quimico = [...pasos].reverse().find(x => x.Paso === 'peligro_quimico');
      if (!quimico || quimico.Respuesta !== 'No') return { idOrden: Number(idOrden), paso: 'peligro_quimico' };
      return { idOrden: Number(idOrden), paso: 'rollo' };
    }

    if (pasos.some(x => x.Paso === 'alistamiento') && !pasos.some(x => x.Paso === 'temperatura')) {
      return { idOrden: Number(idOrden), paso: 'temperatura' };
    }
    return null;
  } catch (err) {
    console.error('No se pudo leer el protocolo de arranque (¿falta ejecutar agregar_protocolo_arranque.sql?):', err.message);
    return null;
  }
}

// Lo consulta el boton "▶ Iniciar" antes de arrancar el protocolo desde cero (ver
// iniciarProtocoloArranque): si esta orden ya lo tiene a medias, la tableta lo retoma en el paso
// que iba en vez de volver a cronometrar una limpieza que ya se hizo.
app.get('/api/selladora/orden/:idOrden/protocolo/estado', requireLogin, async (req, res) => {
  try {
    const p = await getPool();
    res.json({ ok: true, pendiente: await obtenerProtocoloPendiente(p, Number(req.params.idOrden)) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Igual que la anterior pero para la pagina de la cola, donde no hay una orden fija: busca cual de
// las ordenes de esta maquina (si alguna) tiene el protocolo a medias. Primero acota con una sola
// consulta a las que tienen rastro de protocolo, y solo sobre esa resuelve el paso exacto.
async function obtenerProtocoloPendienteMaquina(p, codigo) {
  try {
    const dt = await p.request().input('codigo', codigo).query(`
      SELECT TOP 1 ord.IdOrden
      FROM SEL_OrdenProduccion ord
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdOrden = ord.IdOrden
      WHERE ord.Maquina = @codigo AND ord.Estado IN ('Pendiente','Activa')
        AND (
          EXISTS (SELECT 1 FROM SEL_TiempoMuerto tm
                  WHERE tm.id_ejecucion = ej.IdEjecucion AND tm.HoraFin IS NULL
                    AND (tm.Tipo = 'limpieza' OR (tm.Tipo = 'alistamiento' AND tm.Subtipo = 'arranque')))
          OR EXISTS (SELECT 1 FROM SEL_ProtocoloArranque pa WHERE pa.id_ejecucion = ej.IdEjecucion)
        )
      ORDER BY CASE ord.Estado WHEN 'Activa' THEN 0 ELSE 1 END, ord.IdOrden ASC
    `);
    if (dt.recordset.length === 0) return null;
    return await obtenerProtocoloPendiente(p, dt.recordset[0].IdOrden);
  } catch (err) {
    console.error('No se pudo buscar el protocolo de arranque de la máquina:', err.message);
    return null;
  }
}

// GET: para el sondeo de scriptAvisoSuspension -- por MÁQUINA (no por orden), así sirve tanto en la
// página de la cola (renderPage) como en el detalle de la orden (renderOrdenDetalle) sin que el
// cliente necesite saber de antemano cuál es la orden activa (07/09/2026, reunión Germán/Ángela/
// Carlos, alternativa A: Programación pone la bandera, el operario solo responde).
app.get('/selladora/:codigo/estado-suspension', requireLogin, async (req, res) => {
  const maquinaCodigo = req.params.codigo;
  try {
    const p = await getPool();
    const dt = await p.request().input('maquina', maquinaCodigo).query(`
      SELECT TOP 1 ord.IdOrden, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento
      FROM SEL_OrdenProduccion ord
      INNER JOIN SEL_EjecucionOrden eo ON eo.IdOrden = ord.IdOrden
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      WHERE ord.Maquina = @maquina AND eo.Estado = 'PendienteSuspension' AND eo.HoraFinReal IS NULL
      ORDER BY eo.IdEjecucion DESC
    `);
    if (dt.recordset.length === 0) {
      return res.json({ ok: true, pendiente: false });
    }
    const fila = dt.recordset[0];
    res.json({ ok: true, pendiente: true, idOrden: fila.IdOrden, numeroPedido: fila.NumeroPedido, elemento: fila.Elemento });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST: respuesta del operario al aviso de suspensión (ver scriptAvisoSuspension).
//  terminarBulto=true  -> solo reconoce el aviso (pasa a 'SuspensionEnCurso') para dejar de
//                         preguntar; el bulto Activo sigue llenándose normal y cuando el PLC lo
//                         cierre solo, el trigger nuevo trg_SEL_Bultos_SuspenderTemporal hace la
//                         transición a Suspendido/Suspendida sin que nadie más intervenga (ver
//                         nueva produccion/crear_trigger_suspender_temporal.sql).
//  terminarBulto=false -> corta YA MISMO el bulto Activo (sin esperar al PLC) y deja la orden
//                         Suspendida de una vez.
app.post('/api/selladora/orden/:idOrden/responder-suspension', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const terminarBulto = !!(req.body && req.body.terminarBulto);
  try {
    const p = await getPool();
    const dtEj = await p.request().input('idOrden', idOrden).query(
      `SELECT TOP 1 IdEjecucion, Estado FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion DESC`
    );
    if (dtEj.recordset.length === 0) {
      return res.json({ ok: false, error: 'No se encontró la ejecución de esta orden.' });
    }
    const { IdEjecucion, Estado } = dtEj.recordset[0];
    if (Estado !== 'PendienteSuspension') {
      return res.json({ ok: false, error: 'Esta orden no tiene una suspensión pendiente.' });
    }

    if (terminarBulto) {
      await p.request().input('idEjecucion', IdEjecucion).query(
        `UPDATE SEL_EjecucionOrden SET Estado = 'SuspensionEnCurso' WHERE IdEjecucion = @idEjecucion`
      );
      return res.json({ ok: true });
    }

    await p.request().input('idEjecucion', IdEjecucion).query(`
      UPDATE SEL_Bultos SET estado = 'Suspendido' WHERE id_ejecucion = @idEjecucion AND estado = 'Activo'
    `);
    await p.request().input('idEjecucion', IdEjecucion).query(
      `UPDATE SEL_EjecucionOrden SET Estado = 'Suspendida' WHERE IdEjecucion = @idEjecucion`
    );
    await p.request().input('idOrden', idOrden).query(
      `UPDATE SEL_OrdenProduccion SET Estado = 'Suspendida' WHERE IdOrden = @idOrden`
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
    // Al responder Calidad se guarda lo respondido en SEL_ChequeoCalidad/Detalle (ver
    // registrarChequeoCalidad, 03/09/2026) -- si eso fallara no se revienta el comando ya enviado a
    // Node-RED, solo se registra en consola.
    // Desde el 11/09/2026 ya no hay nada mas que reprogramar: la fila de SEL_ChequeoCalidad que
    // escribe registrarChequeoCalidad ES lo que marca el bulto como revisado, y es justo lo que
    // /calidad-pendiente consulta para no volver a pedirlo. Ojo con eso: si el chequeo no se
    // guarda, la tableta lo vuelve a pedir a los 5 minutos (asi debe ser -- el bulto sigue sin
    // registro de calidad).
    if (comando === 'calidad') {
      try {
        const p = await getPool();
        const operarioCodigo = req.session.usuario.codigoOperarioPRD;
        if (operarioCodigo) {
          await registrarChequeoCalidad(p, { idOrden: Number(idOrden), operarioCodigo, respuestas: datos });
        } else {
          console.error('No se guardo el chequeo de Calidad: el usuario no tiene codigoOperarioPRD.');
        }
      } catch (errGuardar) {
        console.error('Error guardando el chequeo de Calidad:', errGuardar.message);
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
