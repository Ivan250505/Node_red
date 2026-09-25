require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');
const { validarLogin, requireLogin, requireAdmin, ADMIN_CODIGO,
        validarAutorizadorPedido, CARGOS_AUTORIZAN_PEDIDO } = require('./auth');
const { registrarEvento } = require('./accesos');
const { consultarSerial, confirmarRollo, alternarReferenciaGrupo, materializarInicioOrden } = require('./scan-rollo');
const { validarPuedeIniciar, validarPuedeAnadirRollo, finalizarOrden } = require('./ejecucion-selladora');
const {
  obtenerLineaOriginalControlSellado, resolverTurnoMaquina, cerrarBitacora, cerrarBitacorasPorFinTurno,
  abrirOReanudarBitacora, suspenderOTDeOrden,
  obtenerAnclaGrupoSellado, obtenerEstadoAjusteConsumo, ajustarConsumoRollo
} = require('./sel-inventario-mp');

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

// Identidad de la base conectada, para colgarla de las claves de localStorage del navegador
// (21/09/2026, a pedido del usuario: "el apartado de notificaciones solo debe mirar los nuevos
// pedidos segun la base de datos que este conectada, a pesar de que se cambie").
//
// EL PROBLEMA: las notificaciones y la foto de la cola viven en la tableta, no en la base, y hasta
// ahora se guardaban solo POR MAQUINA. Al cambiar de base en el .env (produccion <-> pruebas, o
// una copia en otro servidor) el navegador seguia leyendo la misma lista: el panel mostraba
// pedidos que en la base nueva no existen, y la foto de la cola de la base vieja hacia que medio
// listado de la nueva saliera de golpe como "pedido nuevo" (los IdOrden no coinciden entre bases).
//
// LA SOLUCION: servidor+puerto+base entran en la clave. Cada base tiene su propio historial y su
// propia foto, sin mezclarse. Va el servidor y no solo el nombre porque dos maquinas distintas
// suelen tener una base llamada igual ('carlixplast' en las dos) con datos que no tienen nada que
// ver. Se sanea a [a-z0-9_-] para que la clave siga siendo legible en devtools.
const CLAVE_BASE_DATOS = [process.env.DB_SERVER, process.env.DB_PORT || 1433, process.env.DB_DATABASE]
  .map(function (parte) { return String(parte == null ? '' : parte).trim().toLowerCase(); })
  .join('_')
  .replace(/[^a-z0-9_-]+/g, '-') || 'sin-base';

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

// Simulador de PLC: sus enlaces estan ESCONDIDOS por defecto (a pedido del usuario, 15/09/2026).
// Era un apoyo para probar sin PLC conectado y no tiene por que estar a la vista en planta.
//
// Se esconde con una bandera y no borrando el codigo porque la herramienta sigue sirviendo: para
// volver a verla basta poner SIMULADOR_PLC_VISIBLE=1 en el .env y reiniciar, sin tocar nada.
//
// OJO: esto solo controla que se VEAN los enlaces. Las rutas /admin/simulador-plc siguen
// existiendo y siguen protegidas por requireAdmin, asi que un administrador que escriba la URL a
// mano puede seguir entrando. Si se quiere cerrar del todo, hay que guardar tambien las rutas con
// esta misma bandera.
const SIMULADOR_PLC_VISIBLE = process.env.SIMULADOR_PLC_VISIBLE === '1';

// Bitacora de turno: su isla esta ESCONDIDA por defecto (a pedido del usuario, 15/09/2026), con el
// mismo criterio que el simulador de PLC. Para volver a mostrarla: BITACORA_VISIBLE=1 en el .env.
//
// Lo que se esconde es SOLO la isla de la pantalla de la maquina. La ruta /selladora/:codigo/bitacora
// sigue existiendo y sigue pidiendo sesion, asi que quien tenga el enlace puede entrar. Y, sobre
// todo, la bitacora SE SIGUE ABRIENDO Y CERRANDO SOLA: abrirOReanudarBitacora() corre al tomar
// control de la maquina pase lo que pase con esta bandera. Eso es a proposito -- si dejara de
// registrarse, los turnos que pasen mientras este escondida quedarian sin bitacora y ese hueco no
// se puede rellenar despues.
const BITACORA_VISIBLE = process.env.BITACORA_VISIBLE === '1';

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
    /* Ancho util de la pagina (18/09/2026, a pedido del usuario: "la interfaz corre en una tableta
    de 11 pulgadas y aun hay espacio en los laterales"). Estaba en 960px, que en la tableta del
    taller (1280 px de ancho en horizontal) dejaba ~160px de margen muerto a cada lado. A 1200px
    queda un margen de ~40px por lado -- suficiente para no pegarse al bisel -- y todo lo de adentro
    aprovecha el espacio solo, porque ya es fluido: .grid mete una columna mas de tarjetas
    (auto-fill de 280px), las islas se reparten la fila y las filas de la cola le dan mas aire a los
    botones. En pantallas mas angostas (telefono, tableta en vertical) no cambia nada: max-width
    solo pone un techo. Los dos valores -- este y el de main -- tienen que ir siempre iguales, si no
    el encabezado y el contenido quedan desalineados. */
    .header-inner { max-width: 1200px; margin: 0 auto; }
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
    /* Orden de Trabajo encima del titulo del pedido, en el encabezado de Informacion (a pedido del
    usuario, 16/09/2026 -- antes solo salia en el titulo del Historial rollo, al final de
    la pagina, y tocaba bajar hasta alla para verla). Pastilla BLANCA con la letra verde de la marca
    y el MISMO tamano que el h1 del pedido (a pedido del usuario, 16/09/2026): es el dato que manda
    en la pantalla, asi que se lee igual de grande que el pedido y no como una etiqueta chiquita.
    Se usa --verde (#4a9c2e, el verde oscuro de la paleta) y no --verde-logo/--verde-marca porque
    esos dos, sobre blanco, quedan casi ilegibles a contraluz en la tableta del taller. Solo se
    pinta si la OT ya existe (mientras la orden esta Pendiente no hay ejecucion ni bulto, ver
    obtenerOCrearOrdenProduccion en sel-inventario-mp.js). Va SOLO el codigo, sin la etiqueta "OT"
    delante (a pedido del usuario, 16/09/2026): el codigo ya arranca con el prefijo de la Orden de
    Trabajo y la pastilla terminaba leyendose "OT OT...". */
    .header-ot {
      display: inline-block; margin: 0 0 6px; padding: 3px 12px; border-radius: 999px;
      background: white; color: var(--verde);
      font-size: 20px; font-weight: 700; line-height: 1.25;
    }
    .header-fila .volver { margin-top: 8px; margin-bottom: 0; }
    .header-salir-grupo { justify-self: end; grid-column: 3; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .header-salir-grupo .header-usuario { font-size: 12px; opacity: 0.9; }
    /* Campana de notificaciones, al lado del nombre del usuario (18/09/2026, a pedido del usuario).
    El bloque del usuario pasa de ser una columna de dos renglones a "usuario + campana" en el
    primero y "Cerrar sesion" en el segundo. */
    .header-usuario-fila { display: flex; align-items: center; gap: 8px; }
    .btn-campana {
      position: relative; width: auto; min-width: 0; padding: 4px 8px; font-size: 16px; line-height: 1;
      background: rgba(255,255,255,0.18); color: white; border-radius: 10px; box-shadow: none;
    }
    .btn-campana:active { background: rgba(255,255,255,0.3); }
    /* Contador de no leidas. Rojo sobre el azul del encabezado para que se vea de reojo desde la
    maquina, que es donde esta el operario cuando entra un pedido. */
    .campana-punto {
      position: absolute; top: -5px; right: -5px; min-width: 17px; height: 17px; padding: 0 4px;
      border-radius: 999px; background: #c00000; color: white;
      font-size: 11px; font-weight: 700; line-height: 17px; text-align: center;
    }
    /* El panel NO puede vivir dentro de <header>: ese tiene overflow: hidden por la trama de puntos
    y lo recortaria. Se cuelga de <body> en position: fixed y el script lo coloca debajo de la
    campana con getBoundingClientRect (mismo camino que la tarjeta de "pedido nuevo", que tambien se
    dibuja fuera del encabezado). z-index 1050: por encima del backdrop de SweetAlert2 (1040) y por
    debajo de la tarjeta de pedido nuevo (1060), que es la unica que debe tapar a todo lo demas. */
    .notif-panel {
      position: fixed; z-index: 1050; width: min(340px, calc(100vw - 24px));
      background: white; color: var(--texto); border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.25); overflow: hidden;
    }
    .notif-cabecera {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid #eef0f2;
      font-size: 14px; font-weight: 700;
    }
    .notif-limpiar {
      width: auto; padding: 4px 10px; font-size: 12px; font-weight: 600;
      background: var(--gris-fondo); color: var(--texto-suave); box-shadow: none; border-radius: 8px;
    }
    /* Con muchos pedidos anotados el listado se desplaza dentro del panel (21/09/2026, a pedido
    del usuario). El max-height de aca es el de partida: el script lo recalcula al abrir con el
    alto que de verdad queda libre bajo la campana, para que el panel nunca se salga por abajo de
    la pantalla. overscroll-behavior: contain corta el encadenamiento -- al llegar al final del
    listado el gesto NO pasa a desplazar la pagina de atras (que ademas cerraria el panel). */
    .notif-lista {
      max-height: min(60vh, 420px); overflow-y: auto;
      overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    }
    .notif-item { display: flex; gap: 10px; padding: 11px 14px; border-bottom: 1px solid #f4f6f8; }
    .notif-item:last-child { border-bottom: none; }
    .notif-item.no-leida { background: #f0f8ff; }
    .notif-icono { flex: 0 0 auto; font-size: 17px; line-height: 1.3; }
    .notif-cuerpo { flex: 1; min-width: 0; }
    .notif-titulo { font-size: 13px; font-weight: 700; }
    .notif-detalle { font-size: 12px; color: var(--texto-suave); margin-top: 2px; word-break: break-word; }
    .notif-hora { font-size: 11px; color: var(--texto-suave); margin-top: 3px; }
    .notif-vacio { padding: 26px 14px; text-align: center; color: var(--texto-suave); font-size: 13px; }
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
    /* Mismo ancho que .header-inner -- ver el comentario de arriba. */
    main { max-width: 1200px; margin: 0 auto; padding: 16px 14px 30px; position: relative; z-index: 1; }
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
    /* Historial rollo (18/09/2026): la fila pasa de rejilla de 3 columnas a dos bloques -- los
    datos del rollo a la izquierda y los kilos consumidos a la derecha. El serial tiene 19+ digitos
    y en la tableta no cabe en una rejilla junto a la cantidad sin partirse en pedazos ilegibles.
    Ver AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md. */
    .hist-rollo {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 0; border-bottom: 1px solid #eef0f2;
    }
    .hist-rollo:last-child { border-bottom: none; }
    .hist-rollo-datos { min-width: 0; }
    .hist-rollo-serial { font-size: 13px; font-family: monospace; font-weight: 500; word-break: break-all; }
    .hist-rollo-meta { font-size: 12px; color: var(--texto-suave); margin-top: 2px; }
    .hist-rollo-kg { font-size: 16px; font-weight: 700; white-space: nowrap; }
    .hist-rollo-kg small { font-size: 11px; font-weight: 600; color: var(--texto-suave); display: block; text-align: right; }
    /* Ventanas del ajuste de consumo. Van en la hoja de la pagina y no en estilos sueltos dentro del
    HTML de cada Swal porque son tres ventanas encadenadas (lista -> teclado -> resultado) que
    comparten el mismo resumen de kilos. Los botones de rollo se tocan con el dedo en la tableta:
    area grande y separacion generosa. */
    .swal-ajuste-resumen { background: #f6f8f9; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .swal-ajuste-resumen > div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 3px 0; font-size: 13px; }
    .swal-ajuste-resumen span { color: var(--texto-suave); }
    .swal-ajuste-resumen b { font-size: 15px; white-space: nowrap; }
    .swal-ajuste-ayuda { font-size: 12.5px; color: var(--texto-suave); margin: 10px 0 12px; line-height: 1.45; }
    .swal-ajuste-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--texto-suave); margin: 12px 0 5px; }
    .swal-rollo-item {
      display: block; width: 100%; text-align: left; background: white; border: 1px solid #e3e7ea;
      border-radius: 10px; padding: 11px 13px; margin-bottom: 9px; cursor: pointer; font: inherit;
    }
    .swal-rollo-item:hover { border-color: var(--verde); background: #f7fbf4; }
    .swal-rollo-serial { font-family: monospace; font-size: 13px; font-weight: 500; word-break: break-all; }
    .swal-rollo-meta { font-size: 12px; color: var(--texto-suave); margin-top: 3px; }
    .swal-rollo-kg { font-size: 15px; font-weight: 700; margin-top: 5px; }
    .swal-rollo-orig { font-size: 12px; font-weight: 500; color: var(--texto-suave); text-decoration: line-through; }
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
    /* Fila de islas cuyo ancho lo manda el CONTENIDO de cada una, no un reparto a partes iguales
    (18/09/2026, a pedido del usuario, para "Produccion / Residuos / Autorizacion" de Informacion).
    Con el flex normal de .isla (1 1 220px) las tres salen del MISMO ancho, porque flex-grow reparte
    el sobrante a partes iguales sin mirar lo que cada una necesita: Produccion, que solo lleva 3
    botones, quedaba con un hueco grande al lado, y Residuos partia los suyos en dos lineas.
    Con flex-basis auto la base de cada isla es el ancho de sus botones y el sobrante se reparte
    desde ahi: la que mas lleva sale mas ancha, la de un solo boton mas angosta.
    Se mide SOLO, sin anchos escritos a mano, que es justo lo que hace falta aca: los botones de
    Residuos cambian segun la orden y la maquina (Troquelado solo aparece si la orden lo lleva, y
    BOTONES_RESIDUOS_POR_TIPO decide el resto) -- si esa isla pierde o gana un boton, las otras dos
    se reacomodan sin tocar nada. */
    .islas-fila-ajustada > .isla { flex: 1 1 auto; }
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
    /* ===== Calidad, un apartado por pantalla (15/09/2026, a pedido del usuario) =====
       Al mostrar un solo apartado a la vez sobra sitio, y eso se gasta en agrandar el texto y los
       checkbox: la tableta se opera de pie, con guantes y a un brazo de distancia, asi que el
       tamano de toque es lo que decide si el operario acierta a la primera. */
    .calidad-paso .calidad-pregunta { padding: 16px 4px; }
    .calidad-paso .calidad-titulo { font-size: 18px; margin-bottom: 14px; line-height: 1.35; }
    .calidad-paso .calidad-opciones { gap: 12px; }
    .calidad-paso .calidad-opcion {
      flex: 1 1 0; justify-content: center; gap: 10px; font-size: 17px; font-weight: 600;
      border: 2px solid #cfd4da; border-radius: 12px; padding: 14px 10px; background: white;
    }
    /* El recuadro entero se pinta al marcarlo: a distancia se ve el color, no el checkbox. */
    .calidad-paso .calidad-opcion:has(input:checked) { border-color: var(--verde); background: var(--verde-fondo); color: var(--verde); }
    .calidad-paso .calidad-opcion.no-conforme:has(input:checked) { border-color: #c0392b; background: #fdecea; color: #c0392b; }
    .calidad-paso .calidad-opcion input { width: 26px; height: 26px; accent-color: currentColor; }
    /* Cuantos apartados van y cual es este. */
    .calidad-progreso { font-size: 13px; color: var(--texto-suave); font-weight: 600; margin-bottom: 10px; }
    .calidad-progreso-barra { height: 6px; border-radius: 999px; background: #e6e9ee; margin-top: 6px; overflow: hidden; }
    .calidad-progreso-relleno { height: 100%; background: var(--verde); border-radius: 999px; transition: width .2s; }
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
      .islas-fila-ajustada > .isla { flex: 1 1 220px; }
      .grid { grid-template-columns: 1fr; }
      .imprimir-acciones-grid { grid-template-columns: 1fr; }
      header h1 { font-size: 18px; }
      .barra { flex-direction: column; align-items: stretch; }
      .actualizado { text-align: center; }
      .header-fila { grid-template-columns: 1fr; justify-items: stretch; }
      .header-info, .avance-header-card, .header-salir-grupo { justify-self: stretch; width: auto; grid-column: 1; }
      .header-salir-grupo { align-items: stretch; }
      .header-salir-grupo .header-usuario { text-align: center; }
      .header-usuario-fila { justify-content: center; }
      .header-salir-grupo a.salir { text-align: center; }
    }
  `;
}

// Bloque del usuario en el encabezado: el nombre, la campana de notificaciones y "Cerrar sesion".
// Estaba copiado igual en las SEIS paginas con encabezado (Selladoras, cola de la maquina,
// Informacion, pedido agrupado, Bultos de una orden y Bultos del grupo). Se saco aca el 18/09/2026
// al agregar la campana: el boton lleva id, y seis copias de un id son seis sitios donde se puede
// desincronizar. Si alguna pagina necesita un encabezado distinto, que reciba un parametro -- no
// que vuelva a copiarse el bloque.
function bloqueUsuarioHeader(usuario) {
  return `<div class="header-salir-grupo">
          <div class="header-usuario-fila">
            <div class="header-usuario">👤 ${usuario}</div>
            <button type="button" class="btn-campana" id="btn-notificaciones"
                    title="Notificaciones" aria-label="Notificaciones"
                    onclick="alternarNotificaciones(this)">🔔<span class="campana-punto oculto" id="campana-punto">0</span></button>
          </div>
          <a class="salir" href="/logout">Cerrar sesión</a>
        </div>`;
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
          ${esAdmin && SIMULADOR_PLC_VISIBLE ? `<a class="volver" href="/admin/simulador-plc">🧪 Simulador de PLC</a>` : ''}
        </div>
        ${bloqueUsuarioHeader(usuario)}
      </div>
    </div>
  </header>
  <main>
    ${contenido}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptNotificaciones(null)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
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
            ${ancla.OrdenProduccion ? `<div class="orden-elemento" style="color:var(--texto-suave);">OP: ${ancla.OrdenProduccion}</div>` : ''}
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
          ${o.OrdenProduccion ? `<div class="orden-elemento" style="color:var(--texto-suave);">OP: ${o.OrdenProduccion}</div>` : ''}
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

      // FIX 16/09/2026 (bug real, reportado por el usuario: "en la parte del protocolo de calibrar
      // la bascula no esta leyendo el peso que llega por ws/peso"). Antes aca habia un
      //     if (pesoNumeros.length === 0) return;
      // que cortaba el script entero cuando la pagina no tenia donde MOSTRAR el peso. Eso tenia
      // sentido cuando el unico consumidor era el recuadro de la pantalla de Informacion, pero
      // desde que existe la verificacion de bascula hay un segundo consumidor que NO pinta nada:
      // verificarBascula() lee window.ultimoPesoBascula. Y el protocolo de arranque corre en la
      // pantalla de la COLA de la maquina, que no tiene ningun .peso-vivo-numero -- asi que la
      // conexion no se abria y la ventana decia siempre "La bascula no esta reportando peso".
      // Ahora la conexion se abre SIEMPRE; lo unico que se salta, si no hay donde pintar, es
      // pintar.
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
            if (json && typeof json.peso === 'number') {
              texto = json.peso.toFixed(2);
              // Ultimo peso recibido, en window para que lo pueda CAPTURAR la verificacion de
              // bascula del protocolo (14/09/2026). Hasta ahora este numero solo se pintaba en el
              // HTML y no quedaba en ninguna variable, asi que no habia forma de leerlo desde otro
              // script. Se guarda tambien CUANDO llego: una lectura vieja (la bascula se
              // desconecto hace rato) no sirve para verificar nada y hay que rechazarla.
              window.ultimoPesoBascula = json.peso;
              window.ultimoPesoBasculaEn = Date.now();
            }
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
// Apartado de notificaciones (18/09/2026, a pedido del usuario: "al lado del nombre de usuario
// quiero un boton donde pueda acceder a un apartado de notificaciones").
//
// QUE GUARDA: los avisos que la tableta ya mostraba y se perdian al cerrarse -- pedido nuevo en la
// cola, suspension pedida por Programacion, chequeo de calidad y protocolo de arranque a medias.
// El operario que cerro sin querer el aviso, o que no estaba mirando la tableta, puede volver a
// leerlo. Los avisos siguen saliendo igual que siempre: esto es el historial, no los reemplaza.
//
// DONDE SE GUARDA: en la tableta (localStorage), no en la base. No hace falta tabla nueva ni
// endpoint -- todos estos avisos los detecta ya el propio navegador. Misma convencion de clave que
// el aviso de pedido nuevo: una lista POR BASE Y POR MAQUINA, para que la tableta de la 05 no
// mezcle su historial con el de la 07. Las paginas sin maquina (Selladoras) usan la lista 'todas',
// asi que lo anotado ahi no sale en el panel de una maquina concreta, ni al reves.
//
// POR BASE (21/09/2026, a pedido del usuario): si se cambia la base del .env, el panel arranca
// limpio contra la base nueva en vez de seguir mostrando pedidos que ahi no existen -- y lo que
// quedo anotado contra la base anterior se borra, no se guarda para cuando se vuelva. Ver
// CLAVE_BASE_DATOS arriba para el por que de meter tambien el servidor en la clave.
//
// Si algun dia esto tiene que ser multiusuario de verdad (que Programacion le mande un mensaje a un
// operario concreto), el cambio es sustituir leerNotificaciones/guardarNotificaciones por un par de
// endpoints contra una tabla -- el resto del panel no se entera.
function scriptNotificaciones(maquinaCodigo) {
  return `
    var NOTIF_PREFIJO = 'carlixplast.notificaciones.';
    var NOTIF_PREFIJO_BASE = NOTIF_PREFIJO + ${jsString(CLAVE_BASE_DATOS)} + '.';
    var NOTIF_CLAVE = NOTIF_PREFIJO_BASE + (${jsString(maquinaCodigo || '')} || 'todas');
    var NOTIF_MAXIMO = 50;                // se descartan las mas viejas, no crece sin fin
    var NOTIF_ANTIRREPETIDO_MS = 1800000; // 30 min -- ver registrarNotificacion
    var notifPanel = null;

    // Lo anotado contra OTRAS bases (y lo de antes del 21/09/2026, cuando la clave no llevaba
    // base) ya no se va a leer nunca: el panel solo mira la clave de la base conectada. Se borra
    // para que no se quede ocupando el localStorage de la tableta para siempre.
    //
    // Se compara contra el prefijo CON base, no solo con el de la familia: las otras maquinas de
    // esta misma base tienen que sobrevivir -- el mismo navegador abre el Dashboard ('todas') y la
    // pagina de una maquina, y cada uno lleva su propia lista.
    try {
      for (var notifI = localStorage.length - 1; notifI >= 0; notifI--) {
        var notifK = localStorage.key(notifI);
        if (notifK && notifK.indexOf(NOTIF_PREFIJO) === 0 && notifK.indexOf(NOTIF_PREFIJO_BASE) !== 0) {
          localStorage.removeItem(notifK);
        }
      }
    } catch (e) {}

    var NOTIF_ICONOS = {
      pedido: '📦', suspension: '⏸', calidad: '✅', calidad_alerta: '⚠️', protocolo: '⚙️'
    };

    function notifEscapar(texto) {
      return String(texto == null ? '' : texto)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function leerNotificaciones() {
      try { var v = JSON.parse(localStorage.getItem(NOTIF_CLAVE)); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    }

    function guardarNotificaciones(lista) {
      try { localStorage.setItem(NOTIF_CLAVE, JSON.stringify(lista)); } catch (e) {}
    }

    // La llaman los avisos que ya existian. SIEMPRE con typeof desde el otro lado: hay paginas que
    // cargan un aviso pero no este script, y un aviso no se puede caer por no poder anotarse.
    //
    // clave (opcional) es el antirrepetido: hay avisos que vuelven a salir en cada carga de pagina
    // mientras la condicion siga ahi -- el protocolo a medias es el caso claro. Con la misma clave
    // dentro de la ultima media hora no se anota otra vez; si no, el panel se llenaria del mismo
    // renglon repetido y el contador no pararia de subir.
    window.registrarNotificacion = function(tipo, titulo, detalle, clave) {
      try {
        var lista = leerNotificaciones();
        if (clave) {
          var limite = Date.now() - NOTIF_ANTIRREPETIDO_MS;
          var repetida = lista.some(function(n) {
            return n.clave === clave && new Date(n.hora).getTime() > limite;
          });
          if (repetida) return;
        }
        lista.unshift({
          tipo: tipo || '', titulo: String(titulo == null ? '' : titulo),
          detalle: String(detalle == null ? '' : detalle),
          hora: new Date().toISOString(), leida: false, clave: clave || null
        });
        if (lista.length > NOTIF_MAXIMO) lista.length = NOTIF_MAXIMO;
        guardarNotificaciones(lista);
        pintarContadorNotificaciones();
        if (notifPanel) pintarListaNotificaciones();
      } catch (e) {}
    };

    function pintarContadorNotificaciones() {
      var punto = document.getElementById('campana-punto');
      if (!punto) return;
      var sinLeer = leerNotificaciones().filter(function(n) { return !n.leida; }).length;
      punto.textContent = sinLeer > 9 ? '9+' : String(sinLeer);
      punto.classList.toggle('oculto', sinLeer === 0);
    }

    // "hace 5 min" mientras es reciente y la fecha con hora cuando ya no lo es: a las 3 horas
    // "hace 180 min" no le dice nada a nadie.
    function notifHaceCuanto(iso) {
      var ms = Date.now() - new Date(iso).getTime();
      if (!isFinite(ms) || ms < 0) return '';
      var min = Math.floor(ms / 60000);
      if (min < 1) return 'ahora mismo';
      if (min < 60) return 'hace ' + min + ' min';
      var horas = Math.floor(min / 60);
      if (horas < 6) return 'hace ' + horas + ' h';
      return new Date(iso).toLocaleString('es-CO', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      });
    }

    function pintarListaNotificaciones() {
      if (!notifPanel) return;
      var lista = leerNotificaciones();
      var cuerpo = notifPanel.querySelector('.notif-lista');
      if (lista.length === 0) {
        cuerpo.innerHTML = '<div class="notif-vacio">No hay notificaciones</div>';
        return;
      }
      cuerpo.innerHTML = lista.map(function(n) {
        return '<div class="notif-item' + (n.leida ? '' : ' no-leida') + '">' +
                 '<div class="notif-icono">' + (NOTIF_ICONOS[n.tipo] || '🔔') + '</div>' +
                 '<div class="notif-cuerpo">' +
                   '<div class="notif-titulo">' + notifEscapar(n.titulo) + '</div>' +
                   (n.detalle ? '<div class="notif-detalle">' + notifEscapar(n.detalle) + '</div>' : '') +
                   '<div class="notif-hora">' + notifEscapar(notifHaceCuanto(n.hora)) + '</div>' +
                 '</div>' +
               '</div>';
      }).join('');
    }

    function cerrarNotificaciones() {
      if (!notifPanel) return;
      notifPanel.remove();
      notifPanel = null;
      document.removeEventListener('pointerdown', notifClicFuera, true);
      document.removeEventListener('keydown', notifTecla, true);
      window.removeEventListener('resize', cerrarNotificaciones);
      window.removeEventListener('scroll', notifScroll, true);
    }

    // El panel se cierra si la PAGINA se mueve debajo (quedaria flotando lejos de la campana, que
    // es de donde cuelga). Pero desplazar el listado de adentro tambien dispara este evento --va en
    // fase de captura--, y hasta el 21/09/2026 eso cerraba el panel al primer arrastre: con mas
    // notificaciones de las que caben en pantalla no habia forma de llegar a las de abajo.
    function notifScroll(evento) {
      var destino = evento.target;
      if (notifPanel && destino && destino.nodeType === 1 && notifPanel.contains(destino)) return;
      cerrarNotificaciones();
    }

    function notifClicFuera(evento) {
      if (!notifPanel) return;
      var boton = document.getElementById('btn-notificaciones');
      if (notifPanel.contains(evento.target)) return;
      if (boton && boton.contains(evento.target)) return; // de cerrarlo se encarga su propio onclick
      cerrarNotificaciones();
    }

    function notifTecla(evento) {
      if (evento.key === 'Escape') cerrarNotificaciones();
    }

    // Se coloca debajo de la campana, y pegado al borde si no cabe: en la tableta el boton esta en
    // la esquina derecha, asi que sin este ajuste el panel se saldria de la pantalla.
    function colocarPanelNotificaciones(boton) {
      var caja = boton.getBoundingClientRect();
      var ancho = notifPanel.offsetWidth;
      var izquierda = Math.min(Math.max(12, caja.right - ancho), window.innerWidth - ancho - 12);
      var arriba = caja.bottom + 8;
      notifPanel.style.top = arriba + 'px';
      notifPanel.style.left = izquierda + 'px';

      // El listado se queda con el alto que de verdad sobra entre la campana y el borde de abajo,
      // y lo que no quepa se desplaza. El 60vh del CSS no alcanzaba: el panel arranca ya bajo el
      // encabezado, asi que con la pantalla apaisada de la tableta el final del listado quedaba
      // fuera de la vista y no habia como llegar a el. Piso de 140px para que, aunque el hueco sea
      // minimo, siempre se vea al menos una notificacion entera.
      var lista = notifPanel.querySelector('.notif-lista');
      var cabecera = notifPanel.querySelector('.notif-cabecera');
      var libre = window.innerHeight - arriba - 12 - (cabecera ? cabecera.offsetHeight : 0);
      lista.style.maxHeight = Math.max(140, libre) + 'px';
    }

    function alternarNotificaciones(boton) {
      if (notifPanel) { cerrarNotificaciones(); return; }
      notifPanel = document.createElement('div');
      notifPanel.className = 'notif-panel';
      notifPanel.innerHTML =
        '<div class="notif-cabecera"><span>Notificaciones</span>' +
          '<button type="button" class="notif-limpiar" onclick="limpiarNotificaciones()">Limpiar</button>' +
        '</div>' +
        '<div class="notif-lista"></div>';
      document.body.appendChild(notifPanel);
      pintarListaNotificaciones();
      colocarPanelNotificaciones(boton);

      // Abrirlo es haberlas visto: se marcan leidas y el contador se apaga. La lista ya quedo
      // pintada arriba con el resaltado de las que estaban sin leer, para que de un vistazo se
      // distinga lo nuevo de lo que ya se habia visto.
      var lista = leerNotificaciones();
      if (lista.some(function(n) { return !n.leida; })) {
        lista.forEach(function(n) { n.leida = true; });
        guardarNotificaciones(lista);
      }
      pintarContadorNotificaciones();

      document.addEventListener('pointerdown', notifClicFuera, true);
      document.addEventListener('keydown', notifTecla, true);
      window.addEventListener('resize', cerrarNotificaciones);
      window.addEventListener('scroll', notifScroll, true);
    }

    function limpiarNotificaciones() {
      guardarNotificaciones([]);
      pintarListaNotificaciones();
      pintarContadorNotificaciones();
    }

    // Otra pestana del mismo WebView anoto algo (el operario navega entre Informacion y Bultos):
    // el contador se pone al dia sin tener que recargar.
    window.addEventListener('storage', function(evento) {
      if (evento.key !== NOTIF_CLAVE) return;
      pintarContadorNotificaciones();
      if (notifPanel) pintarListaNotificaciones();
    });

    pintarContadorNotificaciones();
  `;
}

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
        // Historial de notificaciones (18/09/2026). Con clave: el sondeo corre cada 5s y la
        // pregunta puede volver a salir al recargar la tableta -- sin ella se anotaria en bucle.
        if (typeof registrarNotificacion === 'function') {
          registrarNotificacion('suspension',
            'Programación pidió suspender el pedido ' + (datos.numeroPedido || '—'),
            datos.elemento || '', 'suspension:' + datos.idOrden);
        }
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
      // La foto de la cola se guarda por base y por maquina: la tableta de la 05 no se entera de lo
      // que le programen a la 07. Al ser localStorage la comparten todas las pestanas del mismo
      // WebView, asi que navegar entre Informacion/Bultos/Programacion no reinicia el aviso ni lo
      // repite.
      //
      // La base entra en la clave (21/09/2026, ver CLAVE_BASE_DATOS) porque los IdOrden no
      // coinciden entre bases: con una sola foto compartida, al cambiar de base en el .env la cola
      // entera de la base nueva salia de golpe como "pedido nuevo" -- ordenes viejas que llevaban
      // dias ahi, avisadas como recien entradas. Con la clave por base eso no pasa: la base nueva
      // no tiene foto todavia, y sin foto previa revisar() solo la toma (ver mas abajo) sin avisar
      // de nada.
      var PREFIJO = 'carlixplast.cola.vistas.';
      var PREFIJO_BASE = PREFIJO + ${jsString(CLAVE_BASE_DATOS)} + '.';
      var CLAVE = PREFIJO_BASE + (MAQUINA || 'todas');
      var INTERVALO_MS = 10000;

      // Fotos de otras bases (y las de antes del 21/09/2026, sin base en la clave): ya no se leen,
      // se borran, para no dejar basura en el localStorage de la tableta. Mismo criterio que el
      // panel de notificaciones -- se respeta el prefijo CON base para no pisar la foto de las
      // otras maquinas de ESTA base.
      //
      // Consecuencia buscada: volver a una base ya usada no es "seguir donde iba", es empezar de
      // cero contra ella -- foto nueva en silencio. Se prefiere eso a guardar una foto de hace
      // dias que, al volver, soltaria de golpe todo lo que se programo mientras tanto.
      try {
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PREFIJO) === 0 && k.indexOf(PREFIJO_BASE) !== 0) localStorage.removeItem(k);
        }
      } catch (e) {}
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
            '.aviso-pedido{position:relative;padding-top:16px;pointer-events:auto;width:min(520px,100%);background:#fff;border-radius:14px;' +
              'box-shadow:0 8px 26px rgba(28,39,51,0.30);border-left:5px solid #71bf44;padding:12px 14px;' +
              'display:flex;gap:12px;align-items:flex-start;cursor:pointer;opacity:0;transform:translateY(-140%);' +
              'transition:transform .38s cubic-bezier(.16,.84,.44,1),opacity .30s ease;}' +
            '.aviso-pedido.visible{opacity:1;transform:translateY(0);}' +
            // touch-action:none es lo que permite arrastrar la tarjeta: sin el, el navegador se
            // queda el gesto vertical para desplazar la pagina y el dedo nunca llega al handler.
            '.aviso-pedido{touch-action:none;}' +
            // Manija: al quitar el cierre por toque (17/09/2026) hace falta que se vea que la
            // tarjeta se puede arrastrar. Es la barrita corta de siempre, arriba y centrada.
            '.aviso-pedido-manija{position:absolute;top:6px;left:50%;transform:translateX(-50%);' +
              'width:38px;height:4px;border-radius:999px;background:#cfd4da;}' +
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
        // Historial de notificaciones (18/09/2026): la tarjeta se va sola a los 7 segundos, el
        // renglon del panel se queda. Una por pedido y no una por lote -- en el panel lo que
        // importa es CUAL entro, no cuantos llegaron juntos.
        if (typeof registrarNotificacion === 'function') {
          lote.forEach(function(o) {
            registrarNotificacion('pedido', 'Pedido ' + (o.numeroPedido || '—') + ' en la cola',
              (o.elemento || '') + (!MAQUINA && o.maquinaNombre ? ' · ' + o.maquinaNombre : ''));
          });
        }
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
          '<div class="aviso-pedido-manija"></div>' +
          '<div class="aviso-pedido-icono">📦</div>' +
          '<div class="aviso-pedido-cuerpo">' +
            '<div class="aviso-pedido-titulo">' + escapar(titulo) + '<span class="aviso-pedido-hora">' + hora + '</span></div>' +
            lineas +
          '</div>';
        // DESLIZAR HACIA ARRIBA para descartarla (a pedido del usuario, 17/09/2026). Sustituye al
        // cierre por toque que habia antes: un toque ya no hace nada.
        //
        // La tarjeta sigue al dedo mientras se arrastra en vez de esperar a soltar. Es deliberado:
        // si no se moviera, el operario no sabria que el gesto esta funcionando y acabaria
        // tocandola -- que es justo lo que ya no cierra nada.
        //
        // Solo hacia ARRIBA (Math.min con 0): hacia abajo no hace nada, para no descartarla sin
        // querer al intentar desplazar la pagina.
        var UMBRAL_DESCARTE = 40;   // px que hay que recorrer para que se descarte al soltar
        var RECORRIDO_OPACIDAD = 120;
        var arrastrando = false, inicioY = 0, recorrido = 0;

        tarjeta.addEventListener('pointerdown', function(e) {
          arrastrando = true; inicioY = e.clientY; recorrido = 0;
          tarjeta.style.transition = 'none';   // durante el arrastre va 1:1 con el dedo
          try { tarjeta.setPointerCapture(e.pointerId); } catch (err) {}
        });

        tarjeta.addEventListener('pointermove', function(e) {
          if (!arrastrando) return;
          recorrido = Math.min(0, e.clientY - inicioY);
          tarjeta.style.transform = 'translateY(' + recorrido + 'px)';
          tarjeta.style.opacity = String(Math.max(0, 1 + recorrido / RECORRIDO_OPACIDAD));
        });

        function soltar() {
          if (!arrastrando) return;
          arrastrando = false;
          // Se quitan los estilos en linea ANTES de decidir: asi, si se descarta, manda la
          // transicion de .visible (sube y se desvanece), y si no, vuelve solo a su sitio.
          tarjeta.style.transition = '';
          tarjeta.style.transform = '';
          tarjeta.style.opacity = '';
          if (-recorrido >= UMBRAL_DESCARTE) esconder(tarjeta);
        }
        tarjeta.addEventListener('pointerup', soltar);
        tarjeta.addEventListener('pointercancel', soltar);
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

// Tolerancia de las medidas (21/09/2026, a pedido del usuario). SUSTITUYE a la tabla fija de
// +-1/4 pulgada / +-7 mm que rigio entre el 15 y el 21/09/2026. El criterio nuevo, textual:
// "menor al 10% de la medida, pero si el 10% es igual o mayor a 1 pulgada, menor a 1 pulgada".
//
// O sea: tolerancia = 10% de la medida, con TOPE de 1 pulgada. El tope entra a partir de las 10
// pulgadas -- justo ahi el 10% vale 1 pulgada exacta, y de esa medida en adelante manda el tope.
// Para que sirve el tope: el 10% crece con la medida y, sin techo, una bolsa de 30 pulgadas
// aceptaria +-3 pulgadas, que ya no es la holgura de un sellado sino otra bolsa.
//
// QUE CAMBIA FRENTE A LA TABLA FIJA (no es una interpolacion de la anterior, es otro criterio):
// las dos se cruzan donde el 10% igualaba la tolerancia vieja -- 2,5 pulgadas y 7 cm. Por DEBAJO
// de eso el criterio nuevo es mas estricto (el 10% de 2 pulgadas son 0,2, antes se aceptaba 0,25)
// y por ENCIMA mas holgado, hasta toparse en 1 pulgada.
//
// El 10% no depende de la unidad -- es una proporcion --, pero el TOPE si: 1 pulgada son 2,54 cm y
// 0,0254 m. Es el mismo criterio fisico escrito en cada sistema, no tres criterios distintos
// (mismo espiritu que la tabla que reemplaza). En produccion solo se usan PUL y CM (comprobado
// 15/09/2026).
//
// KG se queda fuera a proposito, igual que antes: no es una medida de longitud, no hay forma de
// aplicarle un tope en pulgadas, y su pregunta sigue siendo por el valor exacto. Aplicarle el 10%
// seria inventarse un criterio de peso que nadie ha pedido -- ver calcularMedidasBolsa().
const PORCENTAJE_TOLERANCIA_MEDIDA = 10;
const TOPE_TOLERANCIA_MEDIDA_POR_UNIDAD = { PUL: 1, CM: 2.54, MT: 0.0254 };

// Tolerancia que aplica a UNA medida concreta, en su propia unidad. null = esa unidad no tiene
// criterio de rango (KG, o una unidad nueva que no este en la tabla de topes): quien llama vuelve
// a preguntar por el valor exacto.
//
// El criterio del usuario es "MENOR a" -- el limite no entra. No se resta ningun epsilon a
// proposito: nadie mide a mano hasta la milesima, y la app no calcula la conformidad (el operario
// responde Conforme / No conforme mirando la bolsa), asi que el rango que se le muestra es la
// forma practica del criterio, no una comparacion que haga el programa.
function toleranciaMedida(valor, codigoUnidad) {
  const tope = TOPE_TOLERANCIA_MEDIDA_POR_UNIDAD[codigoUnidad];
  if (tope == null) return null;
  return Math.min(valor * PORCENTAJE_TOLERANCIA_MEDIDA / 100, tope);
}

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

// Preguntas de medida que aplican a UNA orden, ya redactadas ("¿El ancho de la bolsa esta entre
// 9,75 y 10,25 pulgadas?"). `orden` es una fila que traiga las columnas de COLUMNAS_MEDIDAS_BOLSA.
//
// Se pregunta por un RANGO y no por el valor exacto (15/09/2026): ver toleranciaMedida(), que
// desde el 21/09/2026 la calcula por medida (10%, con tope de 1 pulgada) en vez de sacarla de una
// tabla por unidad. Se devuelve tambien valorEsperado ("10 pulgadas (9–11)")
// aparte del titulo, porque es lo que se guarda en la base junto con la respuesta: dentro de un mes
// la referencia puede haber cambiado de medida y el registro tiene que seguir diciendo contra que
// se comparo ese dia y con que holgura.
function calcularMedidasBolsa(orden) {
  const codigoUnidad = String(orden.MedidaUnidad || '').toUpperCase();
  const formasUnidad = UNIDADES_MEDIDA_BOLSA[codigoUnidad] || [codigoUnidad, codigoUnidad];
  return MEDIDAS_BOLSA.map(m => {
    const n = Number(orden[m.campo]);
    // Sin valor, no numerico o en cero: la bolsa no lleva esa medida -- no se pregunta por ella.
    if (!isFinite(n) || n === 0) return null;
    const valor = n.toLocaleString('es-CO', { maximumFractionDigits: 2 });
    const unidad = formasUnidad[n === 1 ? 0 : 1];
    // Depende de CADA medida desde el 21/09/2026 (10% con tope de 1 pulgada), ya no de una tabla
    // por unidad: por eso se calcula aqui dentro, con n, y no una vez para toda la bolsa.
    const tolerancia = toleranciaMedida(n, codigoUnidad);

    // Sin tolerancia conocida para esa unidad (ej. KG): se pregunta por el valor exacto, como
    // antes. Es preferible a inventar un rango en una unidad que no es de longitud.
    if (tolerancia == null) {
      const valorEsperado = unidad ? `${valor} ${unidad}` : valor;
      return {
        clave: m.clave,
        titulo: `¿${m.articulo} ${m.etiqueta} de la bolsa es de ${valorEsperado}?`,
        valorEsperado
      };
    }

    const formato = (x) => x.toLocaleString('es-CO', { maximumFractionDigits: 3 });
    const minimo = formato(n - tolerancia);
    const maximo = formato(n + tolerancia);
    // ValorEsperado guarda el nominal Y el rango: dentro de unos meses, "10 pulgadas (9,75–10,25)"
    // dice contra que se comparo y con que holgura, que es lo que hace auditable el registro.
    const valorEsperado = `${valor} ${unidad} (${minimo}–${maximo})`;
    return {
      clave: m.clave,
      titulo: `¿${m.articulo} ${m.etiqueta} de la bolsa está entre ${minimo} y ${maximo} ${unidad}?`,
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
    // ¿Hay una ventana NUESTRA, de las que no se pueden perder, ocupando la pantalla?
    //
    // SweetAlert2 es un modal UNICO: cualquier Swal.fire() cierra el que este abierto. El aviso de
    // "Comando enviado" no es importante -- es una confirmacion de cortesia -- pero cerraba de un
    // plumazo el asistente de Calidad y la ventana de verificacion de bascula. Y en el caso de
    // Calidad era peor que perder la pantalla: al cerrarse asi, el asistente lo leia como
    // "cancelado", descartaba lo ya respondido y no volvia a preguntar hasta 5 minutos despues.
    //
    // Reportado por el usuario (16/09/2026): "cuando imprime el primer paquete la pestaña de
    // calidad se cierra al salir la ventana emergente de comando enviado". Pasa justo ahi porque el
    // chequeo de Calidad sale precisamente con el PRIMER paquete del bulto, que es el mismo momento
    // en que el operario esta imprimiendo.
    //
    // typeof: estas banderas viven en scriptComandos, y este ayudante lo usan tambien scripts que
    // pueden cargarse en paginas donde aquel no esta.
    function hayVentanaQueNoSePuedePerder() {
      return (typeof calidadEnPantalla !== 'undefined' && calidadEnPantalla)
          || (typeof pesoPatronEnPantalla !== 'undefined' && pesoPatronEnPantalla);
    }

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
            // El comando salio igual; lo unico que se omite es el aviso, para no cerrar una
            // ventana que si importa (ver hayVentanaQueNoSePuedePerder).
            if (!hayVentanaQueNoSePuedePerder()) {
              Swal.fire({ icon: 'success', title: 'Comando enviado', timer: 1500, showConfirmButton: false });
            }
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

    // QUITADO 24/09/2026: aca vivia abrirVerificacion(), el marcador de posicion de la isla
    // "Verificacion" (18/09/2026, sin funcionalidad). El usuario aclaro que ese boton era el mismo
    // de Autorizacion, asi que la isla la ocupa ahora → abrirAutorizacion (ver scriptAutorizacion
    // y renderOrdenDetalle) y el marcador se elimino.

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
    // orden). Cada pregunta se contesta Si/No via checkbox (los dos checkboxes de una misma
    // pregunta son mutuamente excluyentes -- marcar uno desmarca el otro). No deja confirmar si
    // falta alguna respuesta. Publica comando 'calidad' con TODAS las respuestas (de todos los
    // apartados) en 'datos', mismo mecanismo que los demas botones.
    var APARTADOS_CALIDAD = ${JSON.stringify(apartadosCalidad)};

function abrirCalidad() {
      calidadEnPantalla = true;
      // Las respuestas se van juntando aca a medida que se recorren los apartados, para que volver
      // atras no borre lo ya contestado.
      mostrarApartadoCalidad(0, {});
    }

    // Un APARTADO POR PANTALLA (15/09/2026, a pedido del usuario): Medidas, luego Pelicula, etc.
    // Antes salian todos juntos en una sola ventana con scroll, y en la tableta eso obligaba a
    // checkbox y texto diminutos. Con uno a la vez sobra sitio y se puede agrandar todo (ver
    // .calidad-paso en estilosBase).
    //
    // Avanza SOLO al terminar de contestar el apartado -- no hay boton de "siguiente". El operario
    // marca la ultima pregunta y la pantalla pasa a la siguiente por su cuenta, con un respiro de
    // 350 ms para que alcance a ver lo que marco antes de que cambie.
    function mostrarApartadoCalidad(indice, respuestas) {
      var ap = APARTADOS_CALIDAD[indice];
      var esUltimo = indice === APARTADOS_CALIDAD.length - 1;
      var avanzando = false;   // distingue "se completo y cerre yo la ventana" de "el operario cancelo"

      // OJO (24/09/2026, a pedido del usuario): lo que cambio es SOLO la etiqueta que lee el
      // operario -- antes "Conforme / No conforme", ahora "Si / No". Los value= siguen siendo
      // 'conforme'/'no_conforme' porque son los que el servidor traduce a 'Conforme'/'NoConforme'
      // (ver el POST de calidad), y esos dos son los unicos que acepta
      // CK_SEL_ChequeoCalidadDetalle_Respuesta. Cambiarlos aca rompe el guardado.
      var preguntasHtml = ap.preguntas.map(function(p) {
        var marcada = respuestas[p.clave];
        return '<div class="calidad-pregunta">' +
          '<div class="calidad-titulo">' + p.titulo + '</div>' +
          '<div class="calidad-opciones">' +
            '<label class="calidad-opcion"><input type="checkbox" name="' + p.clave + '" value="conforme"' +
              (marcada === 'conforme' ? ' checked' : '') + '> Sí</label>' +
            '<label class="calidad-opcion no-conforme"><input type="checkbox" name="' + p.clave + '" value="no_conforme"' +
              (marcada === 'no_conforme' ? ' checked' : '') + '> No</label>' +
          '</div>' +
        '</div>';
      }).join('');

      var pct = Math.round(indice / APARTADOS_CALIDAD.length * 100);
      var html =
        '<div class="calidad-progreso">Apartado ' + (indice + 1) + ' de ' + APARTADOS_CALIDAD.length +
          '<div class="calidad-progreso-barra"><div class="calidad-progreso-relleno" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<div class="calidad-paso">' + preguntasHtml + '</div>';

      Swal.fire({
        title: 'Calidad · ' + ap.titulo,
        html: html,
        width: 560,
        // Sin boton de confirmar: el apartado avanza solo. Los otros dos son "‹ Atras" (desde el
        // segundo en adelante) y "Cancelar", que pospone el chequeo 5 minutos.
        showConfirmButton: false,
        showDenyButton: indice > 0,
        denyButtonText: '‹ Atrás',
        denyButtonColor: '#64748b',
        showCancelButton: true,
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#c0392b',
        allowOutsideClick: false,
        didOpen: function() {
          var contenedor = Swal.getHtmlContainer();

          function completo() {
            return ap.preguntas.every(function(p) {
              return contenedor.querySelector('input[name="' + p.clave + '"]:checked');
            });
          }

          ap.preguntas.forEach(function(p) {
            var checks = contenedor.querySelectorAll('input[name="' + p.clave + '"]');
            checks.forEach(function(actual) {
              actual.addEventListener('change', function() {
                // Los dos checkbox de una misma pregunta son excluyentes: marcar uno desmarca el otro.
                if (actual.checked) {
                  checks.forEach(function(otro) { if (otro !== actual) otro.checked = false; });
                }
                if (!completo() || avanzando) return;
                avanzando = true;
                ap.preguntas.forEach(function(preg) {
                  var marcado = contenedor.querySelector('input[name="' + preg.clave + '"]:checked');
                  respuestas[preg.clave] = marcado.value;
                });
                setTimeout(function() { Swal.close(); }, 350);
              });
            });
          });
        }
      }).then(function(resultado) {
        if (avanzando) {
          if (!esUltimo) { mostrarApartadoCalidad(indice + 1, respuestas); return; }
          guardarCalidad(respuestas);
          return;
        }
        if (resultado.isDenied) { mostrarApartadoCalidad(indice - 1, respuestas); return; }
        // Se cancelo -- se reintenta pronto (5 min) en vez de desaparecer: el chequeo debe
        // insistir, no perderse porque se cancelo una vez (a pedido del usuario, 03/09/2026).
        // Lo ya contestado se descarta: un chequeo a medias no es un chequeo.
        calidadReintentarDesde = Date.now() + 5 * 60 * 1000;
        calidadEnPantalla = false;
      });
    }

    function guardarCalidad(respuestas) {
      // Historial de notificaciones (18/09/2026): se anota el RESULTADO, que es lo que despues se
      // quiere volver a mirar. La ventana del chequeo es bloqueante, no se puede perder de vista;
      // lo que se pierde es en que quedo, sobre todo si salio algo no conforme.
      if (typeof registrarNotificacion === 'function') {
        var noConformes = Object.keys(respuestas).filter(function(k) {
          return respuestas[k] === 'no_conforme';
        }).length;
        registrarNotificacion(
          noConformes > 0 ? 'calidad_alerta' : 'calidad',
          noConformes > 0
            ? 'Chequeo de calidad con ' + noConformes + ' no conforme(s)'
            : 'Chequeo de calidad conforme',
          window.idBultoActivo ? 'Bulto ' + window.idBultoActivo : '');
      }
      // calidadEnPantalla se libera cuando el POST termina, no cuando se cierra la ventana: si se
      // liberara antes, el sondeo de 5s podria alcanzar al guardado a medio camino (el servidor
      // todavia no ha escrito el chequeo, /calidad-pendiente sigue diciendo que si) y volveria a
      // abrir el mismo chequeo encima.
      enviarComando('calidad', null, respuestas)
        .then(function(data) {
          // Si no se pudo guardar (Node-RED caido, red intermitente) el chequeo sigue pendiente --
          // se reintenta en 5 minutos, no cada 5 segundos.
          if (!data || !data.ok) calidadReintentarDesde = Date.now() + 5 * 60 * 1000;
        })
        .finally(function() { calidadEnPantalla = false; });
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

    // Verificacion periodica de la bascula (14/09/2026). Mismo molde que el sondeo de Calidad de
    // aca abajo: lo decide el servidor, no un setTimeout del navegador, asi que recargar la pagina
    // o cambiar de pestana no reinicia la cuenta ni la duplica. Y tampoco se encima a otra ventana
    // bloqueante: si hay una abierta se salta ese sondeo y reintenta al siguiente.
    //
    // Reusa verificarBascula() de scriptProtocoloArranque, que es la misma ventana del paso 6 del
    // protocolo -- por eso esto solo corre en las paginas que cargan ese script. Si no estuviera
    // (una pagina que no lo incluya), el sondeo se queda quieto en vez de reventar.
    var PESO_PATRON_SONDEO_MS = 60000;
    var pesoPatronEnPantalla = false;

    function vigilarPesoPatron() {
      revisarPesoPatron();
      setInterval(revisarPesoPatron, PESO_PATRON_SONDEO_MS);
    }

    function revisarPesoPatron() {
      if (pesoPatronEnPantalla || typeof verificarBascula !== 'function') return;
      fetch('/selladora/' + ${jsString(maquinaCodigo)} + '/peso-patron-pendiente')
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(datos) {
          if (!datos || !datos.ok || !datos.pendiente) return;
          if (pesoPatronEnPantalla || Swal.isVisible()) return;
          pesoPatronEnPantalla = true;
          verificarBascula(${JSON.stringify(idOrden)}, {
            paso: 'peso_patron_periodico',
            alTerminar: function() { pesoPatronEnPantalla = false; }
          });
        })
        .catch(function() { /* red intermitente -- se reintenta en el proximo sondeo */ });
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
    ${calidadHabilitada && VERIFICACION_BASCULA_ACTIVA ? `vigilarPesoPatron();` : ''}
  `;
}

// El boton suelto "Alternar aquí" (scriptAlternarReferencia/confirmarAlternarReferencia) se quito
// el 10/09/2026 a pedido del usuario: ya no hace falta un boton propio para cambiar de referencia,
// porque "Imprimir etiqueta" y "Cierre bulto" de una referencia que no esta recibiendo paquetes
// alternan solos antes de mandar el comando (ver accionReferencia en scriptAccionesReferencia).
// El endpoint POST /alternar-referencia sigue siendo el mismo y lo llama esa funcion.

// Script compartido por renderPage y renderOrdenDetalle -- confirmacion antes de Finalizar, y
// (31/08/2026) antes de Tomar control de una ejecucion PendienteOperador.
// Ajuste de la cantidad realmente consumida de un rollo (18/09/2026, ver
// AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md). Dos ventanas: la lista de rollos de la orden y el
// teclado para digitar C. Se usa igual desde la pagina de una referencia suelta y desde la de un
// grupo -- el endpoint resuelve solo el ancla bajo la que vive la materia prima.
// Observaciones libres del operario (22/09/2026). Se inyecta en las SEIS paginas con encabezado,
// porque la mitad de su trabajo (interceptar "Cerrar sesion") tiene que pasar en todas -- no solo
// donde esta el boton. Ver SEL_ObservacionOperario y los endpoints /observacion y /mi-orden-activa.
// Autorizacion de un pedido por un lider (22/09/2026). Se inyecta en las mismas paginas que
// scriptObservaciones() porque sus dos consumidores viven en sitios distintos: el boton y el
// Finalizar estan en la pagina del pedido, pero el bloqueo de "Cerrar sesion" tiene que existir en
// todas. Ver SEL_AutorizacionPedido y los endpoints /autorizacion.
//
// OJO: lo de aca es para EXPLICAR, no para proteger. El bloqueo de verdad esta en el servidor
// (POST /finalizar y GET /logout); esta pantalla solo evita que el operario llegue hasta alla para
// recibir un error.
function scriptAutorizacion() {
  return `
    function estadoAutorizacion(idOrden) {
      return fetch('/api/selladora/orden/' + idOrden + '/autorizacion')
        .then(function(r) { return r.json(); });
    }

    // Ventana de firma: usuario + clave de un lider. Resuelve true si quedo firmado.
    function pedirFirmaAutorizacion(idOrden, datos) {
      var cargos = (datos.cargosPermitidos || []).join(', ');
      return Swal.fire({
        title: '🔑 Autorización de la OT',
        html: '<div style="text-align:left;font-size:14px;">' +
                '<div style="background:#fff4e5;border-left:5px solid #f39c12;padding:10px 12px;border-radius:8px;margin-bottom:14px;">' +
                  'Orden de Trabajo <b>' + datos.ot + '</b> (pedido ' + datos.pedido + '). Esta firma se pide ' +
                  '<b>una sola vez por OT</b> y es la que permite finalizar y cerrar sesión.' +
                '</div>' +
                '<label style="display:block;font-weight:600;margin-bottom:4px;">Usuario</label>' +
                '<input id="aut-usuario" class="swal2-input" style="margin:0 0 10px;width:100%;" ' +
                  'autocapitalize="characters" autocomplete="off" spellcheck="false">' +
                '<label style="display:block;font-weight:600;margin-bottom:4px;">Contraseña</label>' +
                '<input id="aut-clave" type="password" class="swal2-input" style="margin:0;width:100%;" autocomplete="off">' +
                '<div style="font-size:12px;color:#64748b;margin-top:10px;">Solo pueden autorizar: ' + cargos + '.</div>' +
              '</div>',
        width: 480,
        showCancelButton: true,
        confirmButtonText: 'Autorizar',
        confirmButtonColor: '#71bf44',
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#c0392b',
        allowOutsideClick: false,
        didOpen: function() {
          var u = document.getElementById('aut-usuario');
          if (u) u.focus();
        },
        preConfirm: function() {
          var codigo = (document.getElementById('aut-usuario').value || '').trim();
          var clave = document.getElementById('aut-clave').value || '';
          if (!codigo || !clave) { Swal.showValidationMessage('Escriba usuario y contraseña.'); return false; }
          Swal.showLoading();
          return fetch('/api/selladora/orden/' + idOrden + '/autorizacion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo: codigo, password: clave })
          })
            .then(function(r) { return r.json(); })
            .then(function(resp) {
              // El error del servidor se muestra DENTRO de la ventana, sin cerrarla: asi el lider
              // corrige la clave sin tener que volver a abrir todo el flujo.
              if (!resp.ok) { Swal.showValidationMessage(resp.error || 'No se pudo autorizar.'); return false; }
              return resp;
            })
            .catch(function() { Swal.showValidationMessage('Error de conexión.'); return false; });
        }
      }).then(function(r) {
        if (!r.isConfirmed || !r.value) return false;
        return Swal.fire({
          icon: 'success', title: 'OT autorizada',
          html: 'Firmó <b>' + r.value.firma.nombre + '</b><br>' +
                '<span style="font-size:13px;color:#64748b;">' + (r.value.firma.cargo || '') + '</span>',
          timer: 2200, showConfirmButton: false
        }).then(function() { return true; });
      });
    }

    // Puerta unica: devuelve una promesa que resuelve true SOLO si la OT actual quedo autorizada.
    // La usan el Finalizar y el cierre de sesion. Sin OT todavia (25/09/2026) no se exige firma.
    function exigirAutorizacion(idOrden) {
      return estadoAutorizacion(idOrden).then(function(datos) {
        if (!datos.ok) {
          return Swal.fire({ icon: 'error', title: 'No se pudo comprobar', text: datos.error, confirmButtonColor: '#71bf44' })
            .then(function() { return false; });
        }
        if (datos.sinOT || datos.autorizado) return true;
        return pedirFirmaAutorizacion(idOrden, datos);
      }).catch(function() {
        return Swal.fire({ icon: 'error', title: 'Error de conexión', text: 'No se pudo comprobar la autorización.', confirmButtonColor: '#71bf44' })
          .then(function() { return false; });
      });
    }

    // El boton de la pantalla. Se puede usar en cualquier momento, antes de finalizar o de salir.
    function abrirAutorizacion(idOrden) {
      estadoAutorizacion(idOrden).then(function(datos) {
        if (!datos.ok) {
          Swal.fire({ icon: 'error', title: 'No se pudo comprobar', text: datos.error, confirmButtonColor: '#71bf44' });
          return;
        }
        if (datos.sinOT) {
          Swal.fire({
            icon: 'info', title: 'Todavía no hay Orden de Trabajo',
            text: 'La OT nace con el primer bulto. Hasta entonces no hay nada que autorizar.',
            confirmButtonColor: '#71bf44'
          });
          return;
        }
        if (!datos.autorizado) { pedirFirmaAutorizacion(idOrden, datos); return; }
        // Ya firmado: se muestra quien y cuando, y se deja volver a firmar (la tabla guarda la
        // historia, no sobreescribe) por si hubo que revisar la OT otra vez.
        var f = datos.firma;
        var cuando = f.fecha ? new Date(f.fecha).toLocaleString() : '—';
        Swal.fire({
          icon: 'success',
          title: 'OT ya autorizada',
          html: '<div style="text-align:left;font-size:14px;">' +
                  '<div>Orden de Trabajo <b>' + datos.ot + '</b></div>' +
                  '<div style="font-size:13px;color:#64748b;">Pedido ' + datos.pedido + '</div>' +
                  '<div style="margin-top:8px;">Firmó <b>' + (f.nombre || f.usuario) + '</b></div>' +
                  '<div style="font-size:13px;color:#64748b;">' + (f.cargo || '') + '</div>' +
                  '<div style="font-size:13px;color:#64748b;margin-top:6px;">' + cuando + '</div>' +
                '</div>',
          showCancelButton: true,
          confirmButtonText: 'Cerrar', confirmButtonColor: '#71bf44',
          cancelButtonText: 'Volver a autorizar', cancelButtonColor: '#0078d7'
        }).then(function(r) {
          if (r.dismiss === Swal.DismissReason.cancel) pedirFirmaAutorizacion(idOrden, datos);
        });
      });
    }
  `;
}

function scriptObservaciones() {
  return `
    // Ventana de escritura. Devuelve una promesa que resuelve en true si se guardo, false si el
    // operario salio sin escribir. 'opciones' permite reusarla para las dos puertas de entrada:
    //   - titulo/texto  : cambian segun quien la abre.
    //   - origen        : 'Manual' (boton) o 'CierreSesion' (al salir).
    //   - botonOmitir   : etiqueta del boton de "no escribir" -- null para no mostrarlo.
    function ventanaObservacion(idOrden, opciones) {
      var o = opciones || {};
      return Swal.fire({
        title: o.titulo || 'Observación',
        html: o.texto ? '<div style="font-size:14px;color:#57606a;margin-bottom:10px;">' + o.texto + '</div>' : '',
        input: 'textarea',
        inputPlaceholder: 'Escriba lo que observó (máquina, material, calidad, lo que sea)…',
        inputAttributes: { maxlength: 500, 'aria-label': 'Observación' },
        showCancelButton: true,
        showDenyButton: !!o.botonOmitir,
        confirmButtonText: o.botonGuardar || 'Guardar',
        confirmButtonColor: '#71bf44',
        denyButtonText: o.botonOmitir || '',
        denyButtonColor: '#8b949e',
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#c0392b',
        allowOutsideClick: false,
        // Sin esto una observacion vacia se guardaria como fila en blanco, que es peor que no
        // tener fila: aparece en el reporte y no dice nada.
        preConfirm: function(valor) {
          var t = (valor || '').trim();
          if (!t) { Swal.showValidationMessage('Escriba la observación o use el otro botón.'); return false; }
          return t;
        }
      }).then(function(r) {
        if (r.isDenied) return false;   // "salir sin escribir"
        if (!r.isConfirmed) return null; // cancelar: se queda donde estaba
        return fetch('/api/selladora/orden/' + idOrden + '/observacion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ observacion: r.value, origen: o.origen || 'Manual' })
        })
          .then(function(resp) { return resp.json(); })
          .then(function(datos) {
            if (!datos.ok) {
              return Swal.fire({ icon: 'error', title: 'No se pudo guardar', text: datos.error, confirmButtonColor: '#71bf44' })
                .then(function() { return null; });
            }
            return true;
          })
          .catch(function() {
            return Swal.fire({ icon: 'error', title: 'Error de conexión', text: 'No se pudo guardar la observación.', confirmButtonColor: '#71bf44' })
              .then(function() { return null; });
          });
      });
    }

    // Puerta 1: el boton de la pantalla de la orden.
    function abrirObservacion(idOrden) {
      ventanaObservacion(idOrden, { titulo: '📝 Registrar observación', origen: 'Manual' })
        .then(function(guardo) {
          if (guardo === true) {
            Swal.fire({ icon: 'success', title: 'Observación registrada', timer: 1600, showConfirmButton: false });
          }
        });
    }

    // Puerta 2: "Cerrar sesion". Si el operario tiene una orden Activa a su nombre se le pregunta
    // antes de salir; si no, la salida es la de siempre y no se nota ningun cambio.
    //
    // REGLA: esto NUNCA puede dejar a nadie encerrado en la tableta. Cualquier fallo (endpoint
    // caido, Swal sin cargar, red) termina en location.href = '/logout', igual que el enlace crudo.
    function engancharSalidaConObservacion() {
      var enlaces = document.querySelectorAll('a.salir');
      if (!enlaces.length) return;
      enlaces.forEach(function(enlace) {
        enlace.addEventListener('click', function(evento) {
          if (typeof Swal === 'undefined') return; // sin Swal: que el enlace funcione como siempre
          evento.preventDefault();
          var salir = function() { location.href = '/logout'; };
          fetch('/api/mi-orden-activa')
            .then(function(r) { return r.json(); })
            .then(function(datos) {
              if (!datos.ok || !datos.orden) return salir();
              // Primero la FIRMA (22/09/2026): sin ella el servidor no deja cerrar sesion con un
              // pedido activo, asi que preguntar por la observacion antes seria hacerle escribir al
              // operario algo que despues no lo va a dejar salir igual. Si no se firma, se queda.
              exigirAutorizacion(datos.orden.idOrden).then(function(autorizado) {
                if (!autorizado) return;
                preguntarObservacionYSalir(datos.orden, salir);
              });
            })
            .catch(salir);
        });
      });
    }

    // La observacion de salida, ya con el pedido autorizado. Separada para que el encadenado de
    // arriba se lea de corrido: firma -> observacion -> salir.
    function preguntarObservacionYSalir(orden, salir) {
      ventanaObservacion(orden.idOrden, {
        titulo: '¿Alguna observación antes de salir?',
        texto: 'Va a cerrar sesión con el pedido <b>' + orden.pedido + '</b> activo en ' +
               orden.maquina + '. Si pasó algo en el turno, déjelo escrito aquí.',
        origen: 'CierreSesion',
        botonGuardar: 'Registrar y salir',
        botonOmitir: 'Salir sin observación'
      }).then(function(resultado) {
        // true  -> se guardo, sale. false -> eligio no escribir, sale.
        // null  -> cancelo o fallo el guardado: se queda, que es lo que pidio.
        if (resultado === true || resultado === false) salir();
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', engancharSalidaConObservacion);
    } else {
      engancharSalidaConObservacion();
    }
  `;
}

function scriptAjusteConsumo() {
  return `
    function kg(n) { return (Number(n) || 0).toFixed(2); }

    function abrirAjusteConsumo(idOrden) {
      Swal.fire({ title: 'Cargando rollos...', didOpen: function() { Swal.showLoading(); }, allowOutsideClick: false });
      fetch('/api/selladora/orden/' + idOrden + '/rollos-consumo')
        .then(function(r) { return r.json(); })
        .then(function(datos) {
          if (!datos.ok) {
            Swal.fire({ icon: 'error', title: 'No se puede ajustar', text: datos.error, confirmButtonColor: '#71bf44' });
            return;
          }
          if (!datos.rollos.length) {
            Swal.fire({ icon: 'info', title: 'Sin rollos', text: 'Esta orden no tiene materia prima registrada.', confirmButtonColor: '#71bf44' });
            return;
          }
          listaAjusteConsumo(idOrden, datos);
        })
        .catch(function() {
          Swal.fire({ icon: 'error', title: 'Error de conexión', text: 'No se pudo consultar los rollos de esta orden.', confirmButtonColor: '#71bf44' });
        });
    }

    // La lista muestra, por rollo, lo que se escaneo (R) y lo que hay registrado ahora (C). Mientras
    // nadie ajuste nada los dos valores son iguales -- se muestran igual para que se vea de una que
    // R es el techo y que un rollo ya ajustado no vuelve a partir de cero.
    function listaAjusteConsumo(idOrden, datos) {
      var filas = datos.rollos.map(function(ro, i) {
        var ajustado = ro.ajustes > 0;
        return '<button type="button" class="swal-rollo-item" onclick="pedirConsumoRollo(' + idOrden + ', ' + i + ')">' +
                 '<div class="swal-rollo-serial">' + ro.serial + '</div>' +
                 '<div class="swal-rollo-meta">' + ro.referencia + (ro.lote !== '—' ? ' · Lote ' + ro.lote : '') +
                   (ajustado ? ' · <b>ya ajustado</b>' : '') + '</div>' +
                 '<div class="swal-rollo-kg">' + kg(ro.cantidadActual) + ' Kg' +
                   (ajustado ? ' <span class="swal-rollo-orig">de ' + kg(ro.cantidadOriginal) + '</span>' : '') +
                 '</div>' +
               '</button>';
      }).join('');

      window.__ajusteConsumo = datos;

      Swal.fire({
        title: 'Ajustar consumo de rollo',
        html: '<div style="text-align:left;">' +
                '<div class="swal-ajuste-resumen">' +
                  '<div><span>Consumo registrado</span><b>' + kg(datos.totalActual) + ' Kg</b></div>' +
                  '<div><span>Salida real producida</span><b>' + kg(datos.salidaReal) + ' Kg</b></div>' +
                  '<div><span>Máximo devolvible</span><b>' + kg(datos.margenDevolucion) + ' Kg</b></div>' +
                '</div>' +
                '<div class="swal-ajuste-ayuda">Elija el rollo que no se consumió completo. La salida real ya producida ' +
                  'es el piso: el consumo total siempre tiene que quedar por encima, porque siempre hay merma.</div>' +
                filas +
              '</div>',
        width: 520,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'Cerrar',
        cancelButtonColor: '#6b7280'
      });
    }

    function pedirConsumoRollo(idOrden, indice) {
      var datos = window.__ajusteConsumo;
      var ro = datos.rollos[indice];

      // Piso de ESTE rollo: lo que la salida real exige menos lo que aportan los demas rollos. Es la
      // misma cuenta que revalida el servidor adentro de la transaccion; aca solo sirve para que el
      // operario vea el rango antes de digitar y no se lleve un error despues de confirmar.
      var otros = 0;
      datos.rollos.forEach(function(r, i) { if (i !== indice) otros += Number(r.cantidadActual) || 0; });
      var minimo = Math.max(0, datos.salidaReal - otros);

      Swal.fire({
        title: 'Consumo real del rollo',
        html: '<div style="text-align:left;">' +
                '<div class="swal-rollo-serial" style="margin-bottom:10px;">' + ro.serial + '</div>' +
                '<div class="swal-ajuste-resumen">' +
                  '<div><span>Se escaneó</span><b>' + kg(ro.cantidadOriginal) + ' Kg</b></div>' +
                  '<div><span>Registrado ahora</span><b>' + kg(ro.cantidadActual) + ' Kg</b></div>' +
                '</div>' +
                '<label class="swal-ajuste-label">¿Cuántos Kg se consumieron de verdad?</label>' +
                '<input id="ajuste-consumo-kg" type="number" inputmode="decimal" step="0.01" ' +
                  'min="0" max="' + ro.cantidadOriginal + '" value="' + kg(ro.cantidadActual) + '" class="swal2-input" ' +
                  'style="margin:0;width:100%;font-size:22px;text-align:center;">' +
                '<div class="swal-ajuste-ayuda">Permitido: más de ' + kg(minimo) + ' Kg y hasta ' + kg(ro.cantidadOriginal) + ' Kg.</div>' +
                '<label class="swal-ajuste-label">Motivo (opcional)</label>' +
                '<input id="ajuste-consumo-motivo" type="text" maxlength="255" class="swal2-input" style="margin:0;width:100%;">' +
              '</div>',
        width: 520,
        showCancelButton: true,
        confirmButtonText: 'Confirmar ajuste',
        confirmButtonColor: '#71bf44',
        cancelButtonText: 'Cancelar',
        cancelButtonColor: '#6b7280',
        focusConfirm: false,
        preConfirm: function() {
          var contenedor = Swal.getHtmlContainer();
          var valor = Number(contenedor.querySelector('#ajuste-consumo-kg').value);
          var motivo = contenedor.querySelector('#ajuste-consumo-motivo').value;
          if (!isFinite(valor) || valor <= 0) { Swal.showValidationMessage('Digite los Kg consumidos.'); return false; }
          if (valor > Number(ro.cantidadOriginal) + 0.0001) {
            Swal.showValidationMessage('No puede superar los ' + kg(ro.cantidadOriginal) + ' Kg que se escanearon.');
            return false;
          }
          if (valor <= minimo + 0.0001) {
            Swal.showValidationMessage('Tiene que ser más de ' + kg(minimo) + ' Kg: siempre hay merma.');
            return false;
          }
          return { cantidad: valor, motivo: motivo };
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        confirmarAjusteConsumo(idOrden, ro.serial, resultado.value.cantidad, resultado.value.motivo);
      });
    }

    function confirmarAjusteConsumo(idOrden, serial, cantidad, motivo) {
      Swal.fire({ title: 'Aplicando ajuste...', didOpen: function() { Swal.showLoading(); }, allowOutsideClick: false });
      fetch('/api/selladora/orden/' + idOrden + '/rollo/ajustar-consumo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial: serial, cantidad: cantidad, motivo: motivo })
      })
        .then(function(r) { return r.json(); })
        .then(function(datos) {
          if (!datos.ok) {
            Swal.fire({ icon: 'error', title: 'No se pudo ajustar', text: datos.error, confirmButtonColor: '#71bf44', width: 520 });
            return;
          }
          var devuelto = Number(datos.devuelto) || 0;
          var lineaInventario = devuelto > 0
            ? '<div><span>Devuelto al inventario</span><b>' + kg(devuelto) + ' Kg</b></div>'
            : (devuelto < 0 ? '<div><span>Descontado del inventario</span><b>' + kg(-devuelto) + ' Kg</b></div>' : '');
          Swal.fire({
            icon: 'success',
            title: 'Consumo ajustado',
            html: '<div style="text-align:left;"><div class="swal-ajuste-resumen">' +
                    '<div><span>Consumo del rollo</span><b>' + kg(datos.cantidadAnterior) + ' → ' + kg(datos.cantidadNueva) + ' Kg</b></div>' +
                    lineaInventario +
                    '<div><span>Consumo total de la orden</span><b>' + kg(datos.consumoTotal) + ' Kg</b></div>' +
                    '<div><span>Merma resultante</span><b>' + kg(datos.mermaEstimada) + ' Kg</b></div>' +
                  '</div>' +
                  (datos.controlActualizado ? '' :
                    '<div class="swal-ajuste-ayuda" style="color:#b46200;"><b>Ojo:</b> la materia prima y el inventario ' +
                    'quedaron corregidos, pero este proceso no tiene control de material (PRDExtrusionControl), así que ' +
                    'la merma del escritorio no se va a recalcular sola. Avise al digitador.</div>') +
                  '</div>',
            width: 520,
            confirmButtonText: 'Entendido',
            confirmButtonColor: '#71bf44'
          }).then(function() { location.reload(); });
        })
        .catch(function() {
          Swal.fire({ icon: 'error', title: 'Error de conexión', text: 'No se pudo aplicar el ajuste.', confirmButtonColor: '#71bf44' });
        });
    }
  `;
}

function scriptConfirmarFinalizar() {
  return `
    function confirmarFinalizar(evento, formulario) {
      evento.preventDefault();

      // Sin la firma del lider no tiene sentido ni preguntar (22/09/2026): el POST lo rechazaria el
      // servidor. Se pide primero y solo si queda firmada se sigue con la confirmacion de siempre.
      //
      // El IdOrden sale del ACTION del formulario y no de una variable del servidor: esta funcion
      // se genera una sola vez por pagina (scriptConfirmarFinalizar() no recibe parametros) pero la
      // cola de la maquina pinta un formulario de Finalizar por cada orden. Cerrar sobre un id fijo
      // firmaria siempre el mismo pedido sin importar en cual se apreto.
      // Se parte la ruta en vez de usar una expresion regular: dentro de un template literal cada
      // backslash hay que escribirlo doble, y el que se escribe de menos no da error -- se pierde
      // en silencio y deja un regex que parece correcto pero no captura nada. Partir por barras no
      // tiene esa trampa (y este comentario, por lo mismo, no lleva ni un backslash).
      var partes = String(formulario.action || '').split('/');
      var iOrden = partes.indexOf('orden');
      var idOrdenFin = (iOrden >= 0 && partes[iOrden + 1]) ? Number(partes[iOrden + 1]) : 0;
      if (!idOrdenFin) {
        // Sin id no se puede comprobar nada aqui; se deja seguir y que decida el servidor, que
        // tiene su propia guardia. Nunca se traga el Finalizar en silencio.
        confirmarFinalizarPaso2(formulario);
        return false;
      }

      if (typeof exigirAutorizacion !== 'function') {
        // Pagina sin el script de autorizacion cargado: igual que arriba, decide el servidor.
        confirmarFinalizarPaso2(formulario);
        return false;
      }

      exigirAutorizacion(idOrdenFin).then(function(autorizado) {
        if (!autorizado) return;
        confirmarFinalizarPaso2(formulario);
      });
      return false;
    }

    function confirmarFinalizarPaso2(formulario) {
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
    //   alAnadir(idOrden)  : lo mismo pero para el "+ Rollo" (esNuevoRollo = true), en vez de
    //       recargar la pagina. Lo usa el protocolo de relevo (18/09/2026), donde pitar otro rollo
    //       es un paso a mitad del protocolo y recargar perderia el hilo.
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
            if (ganchos && ganchos.alAnadir) { ganchos.alAnadir(idOrden); return; }
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
//   6) Verificacion de la bascula contra el elemento patron (15/09/2026).
//   7) Al terminarlo se pide el amperaje del ferroniquel -- hasta el 15/09/2026 este paso pedia el
//      % de la perilla de temperatura; ver agregar_amperaje_ferroniquel.sql para el porque del
//      cambio y de la tabla nueva.
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
    // esRelevo = true cuando el protocolo NO lo dispara el boton "Iniciar" sino la retoma/reanuda
    // de una ejecucion que ya venia corriendo (18/09/2026, a pedido del usuario: "cuando se retoma
    // un pedido por otro operario nuevamente inicia el protocolo de arranque"). Es el MISMO
    // protocolo -- los mismos pasos, la misma tabla, los mismos cronometros -- con una sola
    // diferencia: el paso del rollo no obliga a pitar uno nuevo, porque la maquina ya tiene uno
    // montado (ver pasoRolloRelevo). Por eso el relevo se cuenta en 4 pasos y no en 5: el chequeo
    // 4.1/4.2 del rollo solo aparece si de verdad se monta otro.
    function comenzarProtocoloArranque(idOrden, esRelevo) {
      Swal.fire({
        icon: 'info',
        title: esRelevo ? 'Protocolo de arranque (relevo)' : 'Protocolo de arranque',
        html: '<div style="text-align:left;font-size:15px;line-height:1.7;">' +
                (esRelevo
                  ? '<b>1.</b> Limpieza y desinfección<br>' +
                    '<b>2.</b> Chequeo de peligro químico<br>' +
                    '<b>3.</b> Rollo montado (solo se pita otro si hace falta)<br>' +
                    '<b>4.</b> Alistamiento, verificación de la báscula y amperaje del ferroníquel'
                  : '<b>1.</b> Limpieza y desinfección<br>' +
                    '<b>2.</b> Chequeo de peligro químico<br>' +
                    '<b>3.</b> Escaneo del rollo<br>' +
                    '<b>4.</b> Chequeo del rollo y de peligro físico<br>' +
                    '<b>5.</b> Alistamiento, verificación de la báscula y amperaje del ferroníquel') +
              '</div>' +
              (esRelevo
                ? '<div style="text-align:left;font-size:13px;color:#64748b;margin-top:12px;">' +
                    'Acaba de recibir esta máquina, así que el protocolo se corre completo con su usuario. ' +
                    'El rollo solo se vuelve a pitar si hay que cambiarlo.' +
                  '</div>'
                : '') +
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
              }).then(function() { cronometroLimpieza(idOrden, datos.horaInicio, esRelevo); });
            });
          });
      });
    }

    function cronometroLimpieza(idOrden, horaInicio, esRelevo) {
      cronometroProtocolo(idOrden, {
        titulo: '🧼 Limpieza y desinfección',
        subtitulo: esRelevo ? 'Relevo de operario · paso 1 de 4' : 'Protocolo de arranque · paso 1 de 5',
        horaInicio: horaInicio,
        textoBoton: '■ Terminar limpieza y desinfección',
        alTerminar: function() { preguntarPeligroQuimico(idOrden, esRelevo); }
      });
    }

    // ---------------- Paso 2: peligro quimico ----------------
    function preguntarPeligroQuimico(idOrden, esRelevo) {
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
              if (r2.isConfirmed) preguntarPeligroQuimico(idOrden, esRelevo);
            });
          });
          return;
        }
        if (resultado.dismiss === Swal.DismissReason.cancel) {
          guardarPasoProtocolo(idOrden, { paso: 'peligro_quimico', respuesta: 'No' }, function() {
            // En el relevo el paso 3 no es el escaneo sino la confirmacion del rollo ya montado.
            if (esRelevo) pasoRolloRelevo(idOrden);
            else pasoEscanearRolloProtocolo(idOrden);
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

    // ---------------- Paso 3 del relevo: el rollo que ya esta montado ----------------
    // Diferencia con el paso 3 del arranque (18/09/2026, decision del usuario): aca la ejecucion YA
    // esta corriendo y la maquina ya tiene un rollo puesto, asi que pitar uno nuevo NO es
    // obligatorio -- se muestra cual esta montado y el operario que recibe la maquina decide si
    // sigue con ese o lo cambia. Si lo cambia entra por el mismo "+ Rollo" de siempre
    // (esNuevoRollo = true, con su chequeo 4.1/4.2) y no por el camino de Iniciar: la ejecucion ya
    // arranco, no se puede volver a arrancar.
    function pasoRolloRelevo(idOrden) {
      fetch('/api/selladora/orden/' + idOrden + '/rollo/actual')
        .then(function(r) { return r.json(); })
        .then(function(datos) { ventanaRolloRelevo(idOrden, (datos && datos.ok) ? datos.rollo : null); })
        .catch(function() { ventanaRolloRelevo(idOrden, null); });
    }

    function ventanaRolloRelevo(idOrden, rollo) {
      // Sin rastro del rollo montado (base sin SEL_RolloEjecucion, o una orden que arranco antes de
      // que esa tabla existiera) no se puede dar por bueno a ciegas: se pide pitarlo, que es el
      // camino seguro y ademas deja el rastro que le faltaba a esta ejecucion.
      if (!rollo || !rollo.serial) {
        Swal.fire({
          icon: 'warning', title: 'Pite el rollo montado',
          text: 'No se pudo determinar qué rollo está montado en la máquina. Escanéelo para continuar.',
          confirmButtonText: '📷 Escanear rollo', confirmButtonColor: '#71bf44',
          allowOutsideClick: false, allowEscapeKey: false
        }).then(function() { escanearRolloRelevo(idOrden); });
        return;
      }
      Swal.fire({
        title: 'Rollo montado',
        html: '<div style="text-align:left;">' +
                filaRollo('Serial', rollo.serial) +
                filaRollo('Peso (Kg)', rollo.cantidad != null ? rollo.cantidad : '—') +
                filaRollo('Lote', rollo.lote || '—') +
                filaRollo('Referencia', rollo.referencia || '—') +
                filaRollo('Montado', rollo.hora || '—') +
              '</div>' +
              '<div style="text-align:left;font-size:13px;color:#64748b;margin-top:10px;">' +
                'Verifique que este es el rollo que está en la máquina. Si hubo que cambiarlo, pite el nuevo.' +
              '</div>',
        showDenyButton: true,
        confirmButtonText: '✔ Sigo con este rollo', confirmButtonColor: '#71bf44',
        denyButtonText: '📷 Pitar otro rollo', denyButtonColor: '#b46200',
        allowOutsideClick: false, allowEscapeKey: false
      }).then(function(resultado) {
        if (resultado.isConfirmed) {
          // Queda el rastro de QUE rollo recibio este operario -- es lo unico que el relevo agrega
          // a la trazabilidad cuando no se cambia el rollo: no se vuelve a descontar inventario ni
          // se duplica la fila de materia prima, porque el rollo es el mismo que ya estaba.
          guardarPasoProtocolo(idOrden, { paso: 'rollo_mismo', respuesta: 'Si', serial: rollo.serial }, function() {
            pasoAlistamientoProtocolo(idOrden, true);
          });
          return;
        }
        if (resultado.isDenied) escanearRolloRelevo(idOrden);
      });
    }

    function escanearRolloRelevo(idOrden) {
      abrirEscaneoRollo(idOrden, true, {
        antesDeConfirmar: preguntarEstadoRolloNuevo,
        alAnadir: function() { pasoAlistamientoProtocolo(idOrden, true); }
      });
    }

    // ---------------- Paso 5: alistamiento ----------------
    function pasoAlistamientoProtocolo(idOrden, esRelevo) {
      protocoloIntentar(
        function() { return protocoloPost('/api/selladora/orden/' + idOrden + '/pausar', { tipo: 'alistamiento', subtipo: 'arranque' }); },
        function(datos) {
          guardarPasoProtocolo(idOrden, { paso: 'alistamiento', respuesta: 'Iniciada' }, function() {
            Swal.fire({
              icon: 'success', title: 'Alistamiento iniciado',
              text: 'Quedó registrado como actividad. El tiempo ya está corriendo.',
              timer: 2200, showConfirmButton: false
            }).then(function() { cronometroAlistamiento(idOrden, datos.horaInicio, esRelevo); });
          });
        });
    }

    function cronometroAlistamiento(idOrden, horaInicio, esRelevo) {
      cronometroProtocolo(idOrden, {
        titulo: '⚙️ Alistamiento',
        subtitulo: esRelevo ? 'Relevo de operario · paso 4 de 4' : 'Protocolo de arranque · paso 5 de 5',
        horaInicio: horaInicio,
        textoBoton: '■ Terminar alistamiento',
        // CAMBIO 14/09/2026: entre el alistamiento y la temperatura se intercalo la verificacion
        // de la bascula. La temperatura sigue siendo el ultimo paso porque es la que redirige a
        // producir.
        alTerminar: function() {
          ${VERIFICACION_BASCULA_ACTIVA
            ? `verificarBascula(idOrden, { paso: 'peso_patron', alTerminar: function() { pasoAmperajeProtocolo(idOrden); } });`
            : `pasoAmperajeProtocolo(idOrden);`}
        }
      });
    }

    // ---------------- Paso 6: verificacion de la bascula ----------------
    // A pedido del usuario (14/09/2026). Al terminar el alistamiento, ANTES de la temperatura, se
    // verifica que la bascula este midiendo bien: el operario pone el elemento patron, dice cuanto
    // deberia pesar, y la tableta CAPTURA el peso que la bascula esta reportando en ese instante
    // (window.ultimoPesoBascula, lo mantiene scriptPesoEnVivo desde el WebSocket /ws/peso).
    //
    // Decisiones del usuario, para que no se cambien sin querer:
    //   - El elemento patron es FIJO: 1 kg para toda la planta (PESO_PATRON_KG en el servidor). El
    //     operario no lo digita -- solo pone la pesa y captura.
    //   - Tolerancia por PORCENTAJE (TOLERANCIA_PESO_PATRON_PCT, +-1%), que llega desde el servidor.
    //   - Si NO concuerda, BLOQUEA: no se puede seguir hasta que de dentro de tolerancia. Por eso
    //     la ventana no tiene boton de cancelar.
    //   - Del peso capturado NO queda rastro: "se guarda temporal". En SEL_ProtocoloArranque solo
    //     queda el veredicto (Conforme / NoConforme), como en los demas pasos.
    // Cada INTENTO fallido se registra como NoConforme antes de dejar reintentar: saber cuantas
    // veces hubo que tarar antes de que cuadrara es justo lo que hace util esta verificacion.
    //
    // La misma ventana la usa la revision periodica de cada 30-40 min (ver vigilarPesoPatron en
    // scriptComandos); lo unico que cambia es el paso con que se guarda y a donde se vuelve.
    var TOLERANCIA_PESO_PATRON_PCT = ${TOLERANCIA_PESO_PATRON_PCT};
    var PESO_PATRON_KG = ${PESO_PATRON_KG};
    // Una lectura de mas de 15s es de una bascula que ya no esta reportando: no sirve para verificar.
    var PESO_BASCULA_VENCE_MS = 15000;

    function pesoBasculaActual() {
      if (typeof window.ultimoPesoBascula !== 'number') return null;
      if (!window.ultimoPesoBasculaEn || (Date.now() - window.ultimoPesoBasculaEn) > PESO_BASCULA_VENCE_MS) return null;
      return window.ultimoPesoBascula;
    }

    // opciones: { paso, alTerminar } -- paso es 'peso_patron' (arranque) o
    // 'peso_patron_periodico' (la revision de cada 30-40 min).
    function verificarBascula(idOrden, opciones) {
      var paso = opciones.paso;
      var alTerminar = opciones.alTerminar || function() {};

      // Rango aceptado, calculado aca mismo para que el operario lo tenga a la vista y sepa contra
      // que se le esta comparando en vez de recibir un "no concuerda" a secas.
      var margen = PESO_PATRON_KG * TOLERANCIA_PESO_PATRON_PCT / 100;
      var html =
        '<div style="text-align:left;font-size:14px;">' +
          '<div style="background:#fff4e5;border-left:5px solid #f39c12;padding:10px 12px;border-radius:8px;margin-bottom:14px;">' +
            '<b>Antes de pesar:</b> oprima <b>TARA</b> en el transmisor de peso y espere a que marque cero. ' +
            'Luego coloque el elemento patrón sobre la báscula.' +
          '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
            '<div style="flex:1 1 160px;">' +
              '<div class="label">Elemento patrón</div>' +
              '<div style="font-size:24px;font-weight:800;">' + PESO_PATRON_KG.toFixed(3) + '<span style="font-size:15px;font-weight:600;"> kg</span></div>' +
              '<div style="font-size:12px;color:#64748b;">Se acepta entre ' + (PESO_PATRON_KG - margen).toFixed(3) +
                ' y ' + (PESO_PATRON_KG + margen).toFixed(3) + ' kg (±' + TOLERANCIA_PESO_PATRON_PCT + ' %)</div>' +
            '</div>' +
            '<div style="flex:1 1 160px;">' +
              '<div class="label">Leyendo la báscula</div>' +
              '<div style="font-size:30px;font-weight:800;" id="peso-patron-leido">—<span style="font-size:16px;font-weight:600;"> kg</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // FIX 17/09/2026 (a pedido del usuario -- pruebas desde PC sin bascula fisica conectada,
        // pesoBasculaActual() siempre da null ahi): enlaces casi ocultos para forzar el registro sin
        // depender de una lectura real. A proposito discretos (gris, chico) -- es un atajo de
        // prueba, no un boton mas del flujo normal.
        '<div style="text-align:center;margin-top:14px;">' +
          '<a href="#" id="debug-forzar-conforme" style="font-size:10px;color:#cbd5e1;text-decoration:underline;margin-right:14px;">forzar Conforme (sin báscula)</a>' +
          '<a href="#" id="debug-forzar-noconforme" style="font-size:10px;color:#cbd5e1;text-decoration:underline;">forzar NoConforme (sin báscula)</a>' +
        '</div>';

      function forzarSinBascula(esConforme) {
        Swal.close();
        guardarPasoProtocolo(idOrden, { paso: paso, respuesta: esConforme ? 'Conforme' : 'NoConforme' }, function() {
          if (esConforme) {
            Swal.fire({ icon: 'warning', title: 'Forzado sin báscula', text: 'Se guardó Conforme sin leer una báscula real (atajo de prueba).', timer: 2400, showConfirmButton: false }).then(alTerminar);
            return;
          }
          Swal.fire({
            icon: 'error', title: 'Forzado NoConforme (sin báscula)',
            html: 'Se guardó NoConforme como atajo de prueba.<br><br>Oprima <b>TARA</b> en el transmisor de peso, verifique el elemento patrón y vuelva a capturar.',
            confirmButtonText: 'Volver a capturar', confirmButtonColor: '#c0392b',
            allowOutsideClick: false, allowEscapeKey: false
          }).then(function() { verificarBascula(idOrden, opciones); });
        });
      }

      Swal.fire({
        icon: 'info',
        title: 'Verificación de báscula',
        html: html,
        width: 520,
        confirmButtonText: '⚖️ Capturar peso',
        confirmButtonColor: '#0078d7',
        showCancelButton: false, showCloseButton: false,
        allowOutsideClick: false, allowEscapeKey: false,
        didOpen: function() {
          // El peso de la ventana se refresca solo mientras esta abierta, para que el operario vea
          // cuando la bascula se estabiliza antes de capturar.
          var elLeido = document.getElementById('peso-patron-leido');
          var tick = setInterval(function() {
            if (!document.getElementById('peso-patron-leido')) { clearInterval(tick); return; }
            var p = pesoBasculaActual();
            elLeido.innerHTML = (p == null ? '—' : p.toFixed(3)) + '<span style="font-size:16px;font-weight:600;"> kg</span>';
          }, 400);
          var elForzarSi = document.getElementById('debug-forzar-conforme');
          var elForzarNo = document.getElementById('debug-forzar-noconforme');
          if (elForzarSi) elForzarSi.onclick = function(e) { e.preventDefault(); forzarSinBascula(true); };
          if (elForzarNo) elForzarNo.onclick = function(e) { e.preventDefault(); forzarSinBascula(false); };
        },
        preConfirm: function() {
          var esperado = PESO_PATRON_KG;
          var leido = pesoBasculaActual();
          if (leido == null) {
            Swal.showValidationMessage('La báscula no está reportando peso. Revise la conexión e intente de nuevo.');
            return false;
          }
          var diferenciaPct = Math.abs(leido - esperado) / esperado * 100;
          return { esperado: esperado, leido: leido, diferenciaPct: diferenciaPct,
                   conforme: diferenciaPct <= TOLERANCIA_PESO_PATRON_PCT };
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed || !resultado.value) return;
        var v = resultado.value;
        var respuesta = v.conforme ? 'Conforme' : 'NoConforme';

        // El veredicto se guarda SIEMPRE, tambien cuando no concuerda: el rastro de los intentos
        // fallidos es lo que despues permite ver que esa bascula venia dando problemas.
        guardarPasoProtocolo(idOrden, { paso: paso, respuesta: respuesta }, function() {
          if (v.conforme) {
            Swal.fire({
              icon: 'success', title: 'Báscula verificada',
              html: 'Leído <b>' + v.leido.toFixed(3) + ' kg</b> contra <b>' + v.esperado.toFixed(3) + ' kg</b>.<br>' +
                    'Diferencia ' + v.diferenciaPct.toFixed(2) + ' %, dentro del ±' + TOLERANCIA_PESO_PATRON_PCT + ' % permitido.',
              timer: 2400, showConfirmButton: false
            }).then(alTerminar);
            return;
          }
          // No concuerda -> se bloquea. La unica salida es tarar y volver a capturar.
          Swal.fire({
            icon: 'error', title: 'El peso NO concuerda',
            html: 'Leído <b>' + v.leido.toFixed(3) + ' kg</b> contra <b>' + v.esperado.toFixed(3) + ' kg</b>.<br>' +
                  'Diferencia <b>' + v.diferenciaPct.toFixed(2) + ' %</b>, por encima del ±' + TOLERANCIA_PESO_PATRON_PCT + ' % permitido.<br><br>' +
                  'Oprima <b>TARA</b> en el transmisor de peso, verifique el elemento patrón y vuelva a capturar.',
            confirmButtonText: 'Volver a capturar', confirmButtonColor: '#c0392b',
            allowOutsideClick: false, allowEscapeKey: false
          }).then(function() { verificarBascula(idOrden, opciones); });
        });
      });
    }

    // ---------------- Paso 7: amperaje del ferroniquel ----------------
    // CAMBIO 15/09/2026 (a pedido del usuario): este paso pedia el "% de la perilla de temperatura"
    // y ahora pide el AMPERAJE que consume el ferroniquel. Es otra magnitud, no un cambio de
    // nombre: por eso va a su propia tabla (SEL_AmperajeFerroniquel) y no a la de temperatura, que
    // se queda con su historico intacto. Ver agregar_amperaje_ferroniquel.sql.
    //
    // Sigue siendo el ULTIMO paso del protocolo y el que redirige a producir.
    function pasoAmperajeProtocolo(idOrden) {
      Swal.fire({
        icon: 'question',
        title: 'Amperaje del ferroníquel',
        input: 'number',
        inputLabel: '¿Cuántos amperios está consumiendo el ferroníquel?',
        inputAttributes: { min: '0', max: '999', step: '0.01', inputmode: 'decimal' },
        confirmButtonText: 'Guardar y empezar a producir', confirmButtonColor: '#71bf44',
        showCancelButton: false, showCloseButton: false,
        allowOutsideClick: false, allowEscapeKey: false,
        inputValidator: function(valor) {
          if (valor === '' || valor === null) return 'Escriba el amperaje.';
          var n = Number(valor);
          // Rango holgado a proposito -- ver la NOTA SOBRE EL RANGO en
          // agregar_amperaje_ferroniquel.sql. Este paso es obligatorio para arrancar: un rango
          // apretado dejaria la maquina parada por no poder registrar un valor legitimo.
          if (!isFinite(n) || n <= 0 || n > 999) return 'Debe ser un número de amperios mayor que 0.';
          return null;
        }
      }).then(function(resultado) {
        if (!resultado.isConfirmed) return;
        var valor = Number(resultado.value);
        // A proposito NO se guarda desde un preConfirm: esta ventana no tiene boton de cancelar (el
        // amperaje es obligatorio para arrancar), y con preConfirm un error que se repita -- por
        // ejemplo que falte ejecutar agregar_amperaje_ferroniquel.sql en esta base -- dejaria al
        // operario encerrado en una ventana que no se puede cerrar. Con protocoloIntentar el error
        // sale con "Reintentar" y con "Salir"; si sale, el paso queda pendiente y se vuelve a pedir
        // al entrar de nuevo a la orden (la maquina ya esta produciendo, no hay nada trancado).
        protocoloIntentar(
          function() { return protocoloPost('/api/selladora/orden/' + idOrden + '/amperaje', { amperaje: valor }); },
          function(datosTemp) {
            guardarPasoProtocolo(idOrden, { paso: 'amperaje', respuesta: String(valor) }, function() {
              Swal.fire({
                icon: 'success', title: 'Protocolo de arranque completo',
                text: 'Amperaje registrado: ' + valor + ' A. Ya puede producir.',
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
      // relevo = este protocolo lo disparo una retoma/reanuda de la ejecucion, no el boton Iniciar
      // (lo decide el servidor, ver protocoloPendienteDeRelevo). Cambia dos cosas: el paso del
      // rollo no obliga a pitar uno nuevo, y los cronometros se rotulan "paso N de 4".
      var relevo = !!pendiente.relevo;
      // 'inicio' solo existe en el relevo: la ronda esta marcada en la base pero todavia no
      // arranco ni la limpieza. Se entra derecho por la ventana de presentacion del protocolo --
      // esa ya explica sola lo que va a pasar y trae su propio Cancelar, asi que no hace falta el
      // aviso previo de mas abajo.
      if (pendiente.paso === 'inicio') { comenzarProtocoloArranque(idOrden, relevo); return; }
      if (pendiente.paso === 'limpieza') { cronometroLimpieza(idOrden, pendiente.horaInicio, relevo); return; }
      if (pendiente.paso === 'alistamiento') { cronometroAlistamiento(idOrden, pendiente.horaInicio, relevo); return; }
      // 'alistamiento_inicio' tambien es del relevo: el rollo ya quedo resuelto pero el cronometro
      // del alistamiento nunca alcanzo a abrirse (la tableta se apago entre los dos pasos).
      if (pendiente.paso === 'alistamiento_inicio') { pasoAlistamientoProtocolo(idOrden, relevo); return; }
      if (pendiente.paso === 'peso_patron') {
        verificarBascula(idOrden, { paso: 'peso_patron', alTerminar: function() { pasoAmperajeProtocolo(idOrden); } });
        return;
      }
      if (pendiente.paso === 'amperaje') { pasoAmperajeProtocolo(idOrden); return; }

      var textos = {
        peligro_quimico: 'Falta responder el chequeo de peligro químico para poder seguir.',
        rollo: relevo
          ? 'Falta confirmar el rollo que está montado para poder seguir.'
          : 'Falta escanear el rollo y responder su chequeo para poder seguir.',
        peso_patron: 'Falta verificar la báscula contra el elemento patrón para poder seguir.'
      };
      var continuar = function() {
        if (pendiente.paso === 'peligro_quimico') preguntarPeligroQuimico(idOrden, relevo);
        else if (relevo) pasoRolloRelevo(idOrden);
        else pasoEscanearRolloProtocolo(idOrden);
      };
      if (pedido) { continuar(); return; }
      // Historial de notificaciones (18/09/2026). Con clave porque este aviso vuelve a salir en
      // CADA carga de pagina mientras el protocolo siga a medias: sin ella, el panel se llenaria
      // del mismo renglon cada vez que el operario cambia de pantalla.
      if (typeof registrarNotificacion === 'function') {
        registrarNotificacion('protocolo',
          relevo ? 'Protocolo de relevo sin terminar' : 'Protocolo de arranque sin terminar',
          textos[pendiente.paso] || '', 'protocolo:' + idOrden + ':' + pendiente.paso);
      }
      Swal.fire({
        icon: 'info',
        title: relevo ? 'Protocolo de relevo sin terminar' : 'Protocolo de arranque sin terminar',
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
        ${bloqueUsuarioHeader(usuario)}
      </div>
    </div>
  </header>
  <main>
    ${BITACORA_VISIBLE ? `<div class="islas-fila">
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Bitácora de turno</div>
          <div class="isla-detalle">Bultos, rollos y unidades del turno en curso</div>
        </div>
        <a class="btn-accion btn-isla btn-info" href="/selladora/${maquinaCodigo}/bitacora">📋 Bitácora</a>
      </div>
    </div>` : ''}
    <div class="barra">
      <span class="actualizado" id="cola-actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
    </div>
    <div id="cola-ordenes">${renderColaOrdenes(colaOrdenes || [], maquinaCodigo, miOperario)}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptNotificaciones(maquinaCodigo)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <!-- scriptPesoEnVivo va ANTES del protocolo y aunque esta pantalla no muestre el peso: el paso de
       verificacion de bascula (verificarBascula) lee window.ultimoPesoBascula, que lo mantiene este
       script desde el WebSocket /ws/peso. El protocolo de arranque corre aqui, en la cola, asi que
       sin esto la ventana de la bascula no recibe ninguna lectura (16/09/2026). -->
  <script>${scriptPesoEnVivo()}</script>
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
  <script>${scriptNotificaciones(null)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
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

function renderOrdenDetalle(orden, totalBultos, historial, usuario, maquinaCodigo, pausaActiva, avance, calidadHabilitada, grupoSellado, protocoloPendiente, esAdmin, ordenProduccion) {
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
        <div class="hist-rollo">
          <div class="hist-rollo-datos">
            <div class="hist-rollo-serial">${h.Serial ?? '—'}</div>
            <div class="hist-rollo-meta">${h.Referencia ?? '—'}${h.Lote ? ' · Lote ' + h.Lote : ''}</div>
          </div>
          <div class="hist-rollo-kg">${h.Cantidad != null ? Number(h.Cantidad).toFixed(2) : '—'}<small>Kg consumidos</small></div>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  // Ajuste del consumo real del rollo (18/09/2026, ver AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md):
  // solo en PendienteValidacion. Antes (Activa) la maquina sigue gastando rollo, asi que todavia no
  // se sabe cuanto se consumio; despues (Finalizada) el digitador ya cerro el proceso y calculo la
  // merma con estos mismos kilos -- corregirlos ahi descuadraria una merma ya cerrada, igual que
  // pasa con "Volver a pesar" y con la correccion de bolsas.
  // Observacion libre del operario (22/09/2026). Sin condicion de estado a proposito: lo que el
  // operario vio no depende de si la orden esta corriendo o ya se finalizo, y anotar nunca cambia
  // nada -- solo agrega una fila a SEL_ObservacionOperario. La OTRA puerta de entrada es la
  // pregunta al cerrar sesion, que vive en scriptObservaciones() y sale en todas las paginas.
  const botonObservacion = `<button type="button" class="btn-accion btn-isla btn-info"
         onclick="abrirObservacion(${orden.IdOrden})">📝 Observación</button>`;

  // Autorizacion del pedido (22/09/2026). Se puede firmar en cualquier momento; es obligatoria
  // antes de Finalizar y antes de cerrar sesion con el pedido activo. El boton no cambia de
  // aspecto segun este firmado o no: el estado se consulta al abrirlo, porque esta pagina se
  // pinta una vez y la firma puede llegar desde otra tableta mientras esta abierta.
  // CAMBIO 24/09/2026 (a pedido del usuario): este boton se paso a la fila de
  // "Produccion / Residuos", ocupando la isla donde estaba "Verificar" -- ese boton era un
  // marcador de posicion sin funcionalidad y lo que iba a hacer es justo esto, asi que se quito.
  // Sin btn-isla (ancho fijo de 140px, para las islas de texto+boton): aca vive dentro de
  // .orden-acciones, igual que Finalizar/Pausa.
  const botonAutorizacion = `<button type="button" class="btn-accion btn-info"
         onclick="abrirAutorizacion(${orden.IdOrden})">🔑 Autorización</button>`;

  const botonAjusteConsumo = orden.Estado === 'PendienteValidacion'
    ? `<button type="button" class="btn-accion btn-isla btn-info" style="margin-bottom:10px;"
         onclick="abrirAjusteConsumo(${orden.IdOrden})">⚖ Ajustar consumo de rollo</button>`
    : '';

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
          ${ordenProduccion ? `<div class="header-ot">${ordenProduccion}</div>` : ''}
          <h1>Pedido ${orden.NumeroPedido || '—'} ${badgeEstadoOrden(orden.Estado)}</h1>
          <div class="sub">${orden.Elemento}</div>
          <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${orden.MaquinaNombre}</a>
          ${/* Acceso directo al Simulador de PLC desde esta misma pantalla (13/09/2026). Nacio
               marcado como TEMPORAL "hasta terminar de probar"; el 15/09/2026 el usuario pidio
               esconder el apartado, asi que ahora depende de SIMULADOR_PLC_VISIBLE igual que el
               de la pantalla de Selladoras. */ ''}
          ${esAdmin && SIMULADOR_PLC_VISIBLE ? `<a class="volver" href="/admin/simulador-plc?maquina=${maquinaCodigo}">🧪 Simulador de PLC</a>` : ''}
        </div>
        ${avanceCard}
        ${bloqueUsuarioHeader(usuario)}
      </div>
    </div>
  </header>
  <main>
    ${/* La fila ya no cuelga de `acciones`: la isla de Autorizacion va aca (24/09/2026) y la firma
          se puede pedir en cualquier estado, tambien con la orden ya finalizada o en validacion,
          que es cuando `acciones` viene vacio. Produccion y Residuos si siguen apareciendo solo
          cuando hay algo que mostrar. */ ''}
    <div class="islas-fila islas-fila-ajustada">
      ${acciones ? `<div class="isla">
        <div class="label">Producción</div>
        <div class="orden-acciones">${acciones}</div>
      </div>` : ''}
      ${botonesResiduosHTML ? `<div class="isla">
        <div class="label">Residuos</div>
        <div class="orden-acciones">${botonesResiduosHTML}</div>
      </div>` : ''}
      <div class="isla">
        <div class="label">Autorización de la OT</div>
        <div class="isla-detalle">Necesaria para finalizar y para cerrar sesión</div>
        <div class="orden-acciones">${botonAutorizacion}</div>
      </div>
    </div>
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
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Observaciones</div>
          <div class="isla-detalle">Deje por escrito lo que vio en el turno</div>
        </div>
        ${botonObservacion}
      </div>
    </div>
    <h2 style="font-size:15px;margin:0 0 10px;">Especificaciones</h2>
    <div class="ejecucion-box"><div class="ejecucion-grid">${especificaciones}</div></div>
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial rollo</h2>
    ${botonAjusteConsumo}
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptNotificaciones(maquinaCodigo)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptEscanearRollo(maquinaCodigo)}</script>
  <script>${scriptProtocoloArranque(maquinaCodigo)}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptAjusteConsumo()}</script>
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
              onclick="abrirAccionesPaquete(this, ${JSON.stringify(pe.id_paquete)}, ${JSON.stringify(b.id)}, ${JSON.stringify(pe.ConsecutivoPaquete)}, ${JSON.stringify(Number(pe.PesoPaqueGr))}, ${jsString(b.serialPadre).replace(/"/g, '&quot;')}, ${jsString(b.estado).replace(/"/g, '&quot;')}, ${JSON.stringify(idOrdenTarjetas)}, ${JSON.stringify(Number(pe.UnidadesPaquete))})">📦 Paquete ${pe.ConsecutivoPaquete}</a>
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
    // FIX 13/09/2026 (a pedido del usuario -- "Modificar cantidad de paquetes"): SweetAlert2 solo
    // trae 3 botones nativos (confirm/deny/cancel), y ya estaban los 3 ocupados (Reimprimir/Volver
    // a pesar/Cancelar) -- para el 4to se pasa a botones HTML propios dentro del modal en vez de
    // pelear con los roles nativos. Mismo look (apilados, ancho completo, un color por acción).
    function abrirAccionesPaquete(enlace, idPaquete, idBulto, consecutivoPaquete, pesoGr, serialBulto, estadoBulto, idOrdenBulto, unidadesPaquete) {
      var estiloBoton = 'display:block;width:100%;padding:13px;margin:0 0 10px;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;';
      Swal.fire({
        title: 'Paquete ' + consecutivoPaquete,
        html:
          '<div style="font-size:14px;color:#64748b;margin-bottom:16px;">Peso registrado: <b>' + pesoGr + ' kg</b>' +
            ' — Bolsas: <b>' + unidadesPaquete + '</b></div>' +
          '<button type="button" id="btn-pq-reimprimir" style="' + estiloBoton + 'background:#71bf44;">🖨️ Reimprimir etiqueta</button>' +
          '<button type="button" id="btn-pq-repesar" style="' + estiloBoton + 'background:#006984;">⚖️ Volver a pesar</button>' +
          '<button type="button" id="btn-pq-modcant" style="' + estiloBoton + 'background:#b46200;">🔢 Modificar cantidad de bolsas</button>' +
          '<button type="button" id="btn-pq-cancelar" style="' + estiloBoton + 'margin-bottom:0;background:#c0392b;">Cancelar</button>',
        showConfirmButton: false, showCancelButton: false, showDenyButton: false,
        didOpen: function() {
          document.getElementById('btn-pq-reimprimir').onclick = function() {
            Swal.close();
            reimprimirPaquete(enlace, idBulto, consecutivoPaquete, pesoGr, serialBulto, idOrdenBulto);
          };
          document.getElementById('btn-pq-repesar').onclick = function() {
            Swal.close();
            volverAPesarPaquete(enlace, idPaquete, idBulto, consecutivoPaquete, pesoGr, serialBulto, estadoBulto, idOrdenBulto);
          };
          document.getElementById('btn-pq-modcant').onclick = function() {
            Swal.close();
            modificarCantidadPaquete(enlace, idPaquete, consecutivoPaquete, unidadesPaquete, estadoBulto, idOrdenBulto);
          };
          document.getElementById('btn-pq-cancelar').onclick = function() { Swal.close(); };
        }
      });
    }

    // Ventana simple (sin báscula, es un número que el operario digita) para corregir cuántas
    // unidades representa ESTE paquete puntual -- caso real: un paquete con menos de 100 bolsas
    // (un resto/ajuste). Guarda en SEL_PesajeElemento.UnidadesPaquete; el servidor recalcula
    // PRDProduccion.Unidades del bulto si ya estaba Cerrado (mismo criterio que "Volver a pesar"
    // con el peso -- ver /api/selladora/paquete/modificar-cantidad).
    function modificarCantidadPaquete(enlace, idPaquete, consecutivoPaquete, unidadesActual, estadoBulto, idOrdenBulto) {
      var avisoCerrado = (estadoBulto === 'Cerrado')
        ? '<div style="text-align:left;font-size:12px;color:#b46200;background:#fff7ed;border-radius:8px;padding:8px 10px;margin-top:12px;">' +
          '⚠️ Este bulto ya está cerrado. Se corrigen las bolsas de este paquete y el total de ' +
          'unidades del bulto, pero <b>el saldo de inventario no se toca</b>.</div>'
        : '';
      Swal.fire({
        title: 'Cantidad de bolsas -- paquete ' + consecutivoPaquete,
        html: '<div style="font-size:13px;color:#64748b;margin-bottom:10px;">Bolsas registradas hoy: <b>' + unidadesActual + '</b>. Por defecto cada paquete trae 100 bolsas -- solo cambie esto si este paquete puntual trae menos (o más).</div>' + avisoCerrado,
        input: 'number',
        inputValue: unidadesActual,
        inputAttributes: { min: 0, step: 1 },
        showCancelButton: true,
        confirmButtonText: '🔢 Guardar cantidad', confirmButtonColor: '#b46200',
        cancelButtonText: 'Cancelar', cancelButtonColor: '#c0392b',
        preConfirm: function(valor) {
          var unidades = parseInt(valor, 10);
          if (isNaN(unidades) || unidades < 0) { Swal.showValidationMessage('Ingrese una cantidad válida.'); return false; }
          return fetch('/api/selladora/paquete/modificar-cantidad', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idPaquete: idPaquete, unidades: unidades })
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
        Swal.fire({ icon: 'success', title: 'Cantidad de bolsas actualizada', confirmButtonColor: '#71bf44', timer: 1400, showConfirmButton: false })
          .then(function() { location.reload(); });
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
        ${bloqueUsuarioHeader(usuario)}
      </div>
    </div>
  </header>
  <main>
    <div id="contenedor-bultos">${renderTarjetasBultos(bultos, pesajesPorBulto, residuosPorBulto)}</div>
    ${renderSeccionTraslado(bultos, pesajesPorBulto)}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptNotificaciones(maquinaCodigo)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
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

  // Sin la firma del lider no se cierra sesion con un pedido activo (22/09/2026). Igual que en
  // Finalizar, el bloqueo tiene que estar aqui y no solo en el modal: /logout es un enlace, y
  // escribirlo en la barra de direcciones saltaria cualquier guardia que viviera en la pantalla.
  //
  // NUNCA deja a nadie encerrado por un fallo tecnico: si la consulta revienta (base caida, script
  // SQL sin correr) se deja salir, que es como se comportaba antes de que esto existiera. Lo que
  // se bloquea es la salida SIN firma, no la salida cuando no se pudo comprobar.
  if (usuario && usuario.codigoOperarioPRD) {
    try {
      const p = await getPool();
      const dtActiva = await p.request().input('operario', usuario.codigoOperarioPRD).query(`
        SELECT TOP 1 ord.IdOrden, ord.NumeroPedido, ord.Maquina
        FROM SEL_EjecucionOrden eje
        INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = eje.IdOrden
        WHERE eje.Operario = @operario AND eje.Estado = 'Activa'
        ORDER BY eje.IdEjecucion DESC
      `);
      if (dtActiva.recordset.length > 0) {
        const activa = dtActiva.recordset[0];
        // Desde el 25/09/2026 la firma es de la OT actual; si la orden aun no tiene OT (limpieza,
        // alistamiento) no hay nada que firmar y se deja salir.
        const ot = await otActualDeOrden(p, activa.IdOrden);
        const firma = ot ? await obtenerAutorizacionOT(p, ot) : true;
        if (!firma) {
          const maquinaCodigo = await obtenerCodigoMaquinaDeOrden(p, activa.IdOrden).catch(() => null);
          return res.status(403).send(renderErrorSimple(
            `No puede cerrar sesión: la Orden de Trabajo ${ot} (pedido ${activa.NumeroPedido}) sigue activa y todavía no tiene la ` +
            `autorización de un líder. Pídala con el botón "Autorización" de la pantalla del pedido. ` +
            `Pueden autorizarla: ` + CARGOS_AUTORIZAN_PEDIDO.map(c => c.nombre).join(', ') + '.',
            maquinaCodigo ? `/selladora/${maquinaCodigo}` : '/'
          ));
        }
      }
    } catch (err) {
      console.error('No se pudo comprobar la autorización antes de cerrar sesión:', err.message);
    }
  }

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
  // FIX 13/09/2026 (bug real, mismo patrón ya corregido en frmLiberacionProduccion.vb para pedido
  // 11243 -- REVIERTE el criterio del 08/09/2026: "la llave real del grupo es ord.Elemento, no
  // ord.Linea"): esa razón resultó ser la misma causa raíz del bug -- dos LÍNEAS DISTINTAS del
  // mismo pedido pueden vender la misma referencia sin ser la misma agrupación física, y con
  // Elemento como llave esas dos líneas se confundían entre sí. Ahora la llave es ord.Linea; con
  // el grupo identificado por Línea, reasignar la referencia de una línea agrupada YA NO la deja
  // huérfana (el grupo sigue apuntando a la misma línea, sin importar qué producto tenga asignado
  // ahora).
  const colaResult = await p.request().input('codigo', codigo).query(`
    SELECT ord.IdOrden, ord.Estado, ISNULL(ord.NumeroPedido,'') AS NumeroPedido, ie.Referencia AS Elemento,
           ej.Estado AS EstadoEjecucion, ej.Operario AS OperarioEjecucionCodigo, op.Nombre AS OperarioEjecucionNombre,
           ej.HoraFinReal,
           -- Orden de Trabajo (PRDProduccion.OrdenProduccion, redefinicion 15/09/2026): se resuelve
           -- por el primer bulto de esta ejecucion, igual patron que el endpoint de pausar. Null
           -- mientras la orden sigue 'Pendiente' (todavia no se ha dado Iniciar y no existe OT).
           (SELECT TOP 1 pp.OrdenProduccion FROM SEL_Bultos b
            INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
            WHERE b.id_ejecucion = ej.IdEjecucion AND pp.OrdenProduccion IS NOT NULL) AS OrdenProduccion,
           (SELECT TOP 1 g.IdGrupo FROM PRDGrupoEtapasCompartidasLineas gl
            INNER JOIN PRDGrupoEtapasCompartidas g ON g.IdGrupo = gl.IdGrupo AND g.CategoriaMaquina = 'SELLADORA'
            -- FIX 09/09/2026 (bug real: Pedido 11085 se coló en el grupo del Pedido 11408 porque
            -- ambos usan el mismo Elemento de salida en fechas distintas) -- Línea por sí sola
            -- TAMPOCO alcanza: dos pedidos DISTINTOS pueden compartir el mismo número de línea, así
            -- que se sigue exigiendo también el MISMO pedido (g.Numero es el Numero del pedido para
            -- el que se armó ese grupo, ver crear_grupoetapascompartidas.sql). NULL = NULL nunca es
            -- verdadero en SQL, así que una orden sin ord.Linea guardada (creada antes de este
            -- cambio) simplemente no matchea nada -- no hace falta filtro aparte.
            WHERE gl.Linea = ord.Linea AND g.Numero = ord.NumeroPedido) AS IdGrupoSellado
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

// ============================================================================================
// SIMULADOR DE PLC (13/09/2026, a pedido del usuario -- "no tengo el PLC, necesito botones que
// hagan lo mismo para poder probar"). Restringido a administrador (requireAdmin), igual que
// tablet-fija. Hace A MANO exactamente lo que en producción dispara la máquina/Node-RED sola:
//   - "Simular paquete pesado": lo que hace Node-RED cada vez que la báscula pesa un paquete --
//     INSERT en SEL_PesajeElemento sobre el bulto Activo/Temporal más reciente de la máquina
//     (mismo criterio que el script SQL que ya venía probando el usuario a mano).
//   - "Simular cierre de bulto": lo que hace trg_SEL_Bultos_CierreBulto al cerrar un bulto --
//     UPDATE SEL_Bultos SET estado='Cerrado' (el trigger real se encarga de generar la entrada de
//     inventario, PRDProduccion, etc. -- este botón solo dispara ESE UPDATE, no lo duplica).
// NO reemplaza nada de producción -- es una herramienta de prueba que evita tener que correr SQL a
// mano cada vez, para cuando no hay PLC conectado.
// ============================================================================================

function renderSimuladorPLC(usuario, maquinas, maquinaSel, error, mensaje) {
  const opciones = maquinas.map(m =>
    `<option value="${m.Codigo}" ${String(maquinaSel) === String(m.Codigo) ? 'selected' : ''}>${m.Nombre}</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Simulador de PLC — Admin</title>
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
      <h1>🧪 Simulador de PLC</h1>
      <div class="sub">Solo para pruebas sin PLC conectado -- hace a mano lo que la máquina dispara sola.</div>
    </div>
  </header>
  <main>
    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">Máquina</div>
      <form id="form-maquina">
        <select name="maquina" id="maquina" required>
          <option value="">-- Selecciona --</option>
          ${opciones}
        </select>
      </form>
    </div>

    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">1) Simular paquete pesado</div>
      <p style="margin:0 0 14px;color:var(--texto-suave);">Agrega un paquete al bulto Activo/Temporal más reciente de la máquina elegida -- mismo efecto que un pesaje real de báscula.</p>
      <form method="post" action="/admin/simulador-plc/paquete" onsubmit="return copiarMaquina(this)">
        <input type="hidden" name="maquina" value="">
        <label for="peso">Peso (Kg)</label>
        <input type="number" step="0.001" min="0" name="peso" id="peso" value="18" required>
        <label for="potencia" style="margin-top:10px;">Potencia</label>
        <input type="number" step="0.001" name="potencia" id="potencia" value="10">
        <label for="temperatura" style="margin-top:10px;">Temperatura</label>
        <input type="number" step="0.001" name="temperatura" id="temperatura" value="10">
        <label for="golpes" style="margin-top:10px;">Golpes (vacío = NULL)</label>
        <input type="number" step="1" min="0" name="golpes" id="golpes">
        <button type="submit" style="margin-top:14px;">Simular paquete pesado</button>
      </form>
    </div>

    <div class="ejecucion-box">
      <div class="label" style="margin-bottom:6px;">2) Simular cierre de bulto</div>
      <p style="margin:0 0 14px;color:var(--texto-suave);">Cierra el bulto Activo/Temporal más reciente de la máquina elegida (Golpes/Potencia = promedio de sus paquetes) -- dispara el mismo trigger que un cierre real.</p>
      <form method="post" action="/admin/simulador-plc/cerrar-bulto" onsubmit="return copiarMaquina(this)">
        <input type="hidden" name="maquina" value="">
        <button type="submit" style="background:#c0392b;">Simular cierre de bulto</button>
      </form>
    </div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>
    // El selector de máquina es UNA sola vez arriba -- cada form copia su valor a su propio campo
    // oculto justo antes de enviarse, para no repetir el <select> tres veces en la página.
    function copiarMaquina(form) {
      var maquina = document.getElementById('maquina').value;
      if (!maquina) { alert('Selecciona una máquina primero.'); return false; }
      form.querySelector('input[name="maquina"]').value = maquina;
      return true;
    }
  </script>
  ${mensaje ? `<script>Swal.fire({ icon: 'success', title: 'Listo', text: ${jsString(mensaje)}, confirmButtonColor: '#71bf44' });</script>` : ''}
  ${error ? `<script>Swal.fire({ icon: 'error', title: 'Error', text: ${jsString(error)}, confirmButtonColor: '#71bf44' });</script>` : ''}
</body>
</html>`;
}

async function cargarMaquinasSimulador() {
  const p = await getPool();
  const maquinas = await p.request().query(
    `SELECT Codigo, Nombre FROM PRDMaquinas WHERE Tipo = 'SELLADORA' ORDER BY Nombre`
  );
  return maquinas.recordset;
}

app.get('/admin/simulador-plc', requireLogin, requireAdmin, async (req, res) => {
  try {
    const maquinas = await cargarMaquinasSimulador();
    res.send(renderSimuladorPLC(req.session.usuario.nombre, maquinas, req.query.maquina || '', req.query.error || null, req.query.ok || null));
  } catch (err) {
    res.send(renderSimuladorPLC(req.session.usuario.nombre, [], '', err.message, null));
  }
});

// Mismo criterio que el script SQL que ya venía probando el usuario a mano: toma el bulto
// Activo/Temporal MÁS RECIENTE (MAX id) de la máquina, le sube number_paqu en 1, e inserta el
// paquete. Se hace con UPDLOCK/ROWLOCK + en una transacción para no pisarse con un pesaje real
// del PLC si llegara a estar corriendo al mismo tiempo.
app.post('/admin/simulador-plc/paquete', requireLogin, requireAdmin, async (req, res) => {
  const maquina = Number(req.body.maquina);
  const peso = Number(req.body.peso);
  const potencia = req.body.potencia !== '' ? Number(req.body.potencia) : null;
  const temperatura = req.body.temperatura !== '' ? Number(req.body.temperatura) : null;
  const golpes = req.body.golpes !== '' ? Number(req.body.golpes) : null;

  if (!maquina) return res.redirect('/admin/simulador-plc?error=' + encodeURIComponent('Falta la máquina.'));
  if (!peso || peso <= 0) return res.redirect('/admin/simulador-plc?maquina=' + maquina + '&error=' + encodeURIComponent('Ingrese un peso válido.'));

  try {
    const p = await getPool();
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      const dtBulto = await tx.request().input('maquina', maquina).query(`
        SELECT TOP 1 b.id, b.number_paqu
        FROM SEL_Bultos b WITH (UPDLOCK, ROWLOCK)
        WHERE b.id_maquina = @maquina AND b.estado IN ('Activo', 'Temporal')
        ORDER BY b.id DESC
      `);
      if (dtBulto.recordset.length === 0) {
        await tx.rollback();
        return res.redirect('/admin/simulador-plc?maquina=' + maquina + '&error=' + encodeURIComponent('No hay bulto Activo/Temporal para esta máquina.'));
      }
      const idBulto = dtBulto.recordset[0].id;
      const nuevoConsecutivo = dtBulto.recordset[0].number_paqu + 1;

      await tx.request().input('idBulto', idBulto).input('consec', nuevoConsecutivo).query(
        `UPDATE SEL_Bultos SET number_paqu = @consec WHERE id = @idBulto`
      );
      await tx.request()
        .input('peso', peso).input('idBulto', idBulto).input('consec', nuevoConsecutivo)
        .input('potencia', potencia).input('temperatura', temperatura).input('golpes', golpes)
        .query(`
          INSERT INTO SEL_PesajeElemento (PesoPaqueGr, id_bulto, ConsecutivoPaquete, FechaHora, Potencia, Temperatura, Golpes)
          VALUES (@peso, @idBulto, @consec, GETDATE(), @potencia, @temperatura, @golpes)
        `);
      await tx.commit();
      res.redirect('/admin/simulador-plc?maquina=' + maquina + '&ok=' + encodeURIComponent('Paquete #' + nuevoConsecutivo + ' agregado al bulto ' + idBulto + '.'));
    } catch (errTx) {
      await tx.rollback();
      throw errTx;
    }
  } catch (err) {
    res.redirect('/admin/simulador-plc?maquina=' + maquina + '&error=' + encodeURIComponent(err.message));
  }
});

// Mismo criterio que el segundo script SQL del usuario: cierra el bulto Activo/Temporal más
// reciente de la máquina, con Golpes/Potencia = promedio de sus propios paquetes. El resto
// (INVExistencias, PRDProduccion, apertura del siguiente Temporal) lo hace SOLO
// trg_SEL_Bultos_GenerarEntradaInventario/trg_SEL_Bultos_CierreBulto al reaccionar a este UPDATE --
// este endpoint no los duplica.
app.post('/admin/simulador-plc/cerrar-bulto', requireLogin, requireAdmin, async (req, res) => {
  const maquina = Number(req.body.maquina);
  if (!maquina) return res.redirect('/admin/simulador-plc?error=' + encodeURIComponent('Falta la máquina.'));

  try {
    const p = await getPool();
    const dtBulto = await p.request().input('maquina', maquina).query(`
      SELECT TOP 1 id FROM SEL_Bultos WHERE id_maquina = @maquina AND estado IN ('Activo', 'Temporal') ORDER BY id DESC
    `);
    if (dtBulto.recordset.length === 0) {
      return res.redirect('/admin/simulador-plc?maquina=' + maquina + '&error=' + encodeURIComponent('No hay bulto Activo/Temporal para esta máquina.'));
    }
    const idBulto = dtBulto.recordset[0].id;

    await p.request().input('idBulto', idBulto).query(`
      UPDATE b
      SET b.estado = 'Cerrado', b.HoraFin = GETDATE(), b.Golpes = agg.GolpesProm, b.Potencia = agg.PotenciaProm
      FROM SEL_Bultos b
      CROSS APPLY (
        SELECT ISNULL(AVG(pe.Golpes), 0) AS GolpesProm, CAST(AVG(pe.Potencia) AS DECIMAL(10,3)) AS PotenciaProm
        FROM SEL_PesajeElemento pe WHERE pe.id_bulto = b.id
      ) agg
      WHERE b.id = @idBulto
    `);
    res.redirect('/admin/simulador-plc?maquina=' + maquina + '&ok=' + encodeURIComponent('Bulto ' + idBulto + ' cerrado.'));
  } catch (err) {
    res.redirect('/admin/simulador-plc?maquina=' + maquina + '&error=' + encodeURIComponent(err.message));
  }
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
// FIX 09/09/2026 (bug real, Pedido 11085 colado en el grupo del Pedido 11408): Línea por sí sola
// TAMPOCO es llave suficiente para expandir un grupo -- dos pedidos DISTINTOS pueden compartir el
// mismo número de línea, y sin exigir también el mismo Numero de pedido (g.Numero, el pedido para
// el que se armó ESE grupo puntual), la expansión "todos los miembros de este IdGrupo" termina
// trayendo órdenes de OTRO pedido que nunca tuvo nada que ver -- eso bloqueaba Finalizar (contaba
// un bulto Activo ajeno) y corrompía la página de grupo/alternar. Todas las consultas de aquí para
// abajo que expanden un IdGrupo a sus miembros reales exigen `ord.NumeroPedido = g.Numero`.
// FIX 13/09/2026 (bug real, mismo patrón ya corregido en frmLiberacionProduccion.vb para pedido
// 11243 -- REVIERTE el criterio del 08/09/2026: la llave real es ord.Elemento): esa razón resultó
// ser la misma causa raíz del bug -- dos LÍNEAS DISTINTAS del mismo pedido pueden vender la misma
// referencia sin ser la misma agrupación física, y con Elemento como llave esas dos líneas se
// confundían entre sí. Ahora la llave es ord.Linea.
async function obtenerIdGrupoSelladoDeOrden(p, idOrden) {
  const dtGrupo = await p.request().input('idOrden', idOrden).query(`
    SELECT TOP 1 g.IdGrupo
    FROM SEL_OrdenProduccion ord
    INNER JOIN PRDGrupoEtapasCompartidasLineas gl ON gl.Linea = ord.Linea
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
    -- FIX 13/09/2026 (mismo patrón que obtenerIdGrupoSelladoDeOrden -- ver comentario arriba):
    -- Línea, no Elemento, para no confundir dos líneas distintas del mismo pedido que vendan la
    -- misma referencia.
    INNER JOIN SEL_OrdenProduccion ord ON ord.Linea = gl.Linea AND ord.NumeroPedido = g.Numero
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
    // FIX 23/09/2026: la MP se guarda bajo el Lote del ANCLA (primer bulto, por id), no del ultimo
    // -- antes daba igual porque toda la orden compartia fecha, pero ahora cada bulto nuevo toma la
    // fecha real del dia (trg_SEL_Bultos_CierreBulto) y el Lote del ultimo puede ser otro dia.
    const ultimoBulto = await p.request().input('idOrden', m.IdOrden).query(`
      SELECT TOP 1 b.refsalida, b.mes, b.dia FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY b.id ASC
    `);
    if (ultimoBulto.recordset.length === 0) continue;
    const { refsalida: nElemento, mes, dia } = ultimoBulto.recordset[0];
    const tLote = String(mes).padStart(2, '0') + String(dia).padStart(2, '0');
    const nLineaOriginal = await obtenerLineaOriginalControlSellado(p, m.IdOrden, 0);
    const historialResult = await p.request()
      .input('elemento', nElemento).input('lote', tLote).input('lineaOriginal', nLineaOriginal)
      .query(`
        SELECT mp.Detalle AS Serial, e.Nombre AS Referencia, mp.LoteMP AS Lote, mp.Cantidad
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
function renderGrupoSelladoDetalle(idGrupo, numeroPedido, maquinaNombre, maquinaCodigo, miembros, usuario, historial, totalBultos, pausaActiva, calidadHabilitada, protocoloPendiente, ordenProduccion) {
  // "Activo ahora" es el que esta recibiendo paquetes en este momento (su bulto esta Activo o
  // Temporal). Si ninguno lo esta (grupo recien creado, nadie ha dado Iniciar) no se ofrece
  // "+ Rollo": el rollo se registra siempre contra la referencia activa.
  const miembroActivoAhora = miembros.find(m => m.EstadoBultoActual === 'Activo' || m.EstadoBultoActual === 'Temporal');
  // Ancla para las acciones que son del PEDIDO y no de una referencia puntual (Finalizar y Pausa,
  // que escriben contra SEL_EjecucionOrden): la que este recibiendo paquetes, o la primera Activa.
  const miembroAncla = miembroActivoAhora || miembros.find(m => m.Estado === 'Activa') || null;

  const filasHistorial = (historial || []).length
    ? historial.map(h => `
        <div class="hist-rollo">
          <div class="hist-rollo-datos">
            <div class="hist-rollo-serial">${h.Serial ?? '—'}</div>
            <div class="hist-rollo-meta">${h.Referencia ?? '—'}${h.Lote ? ' · Lote ' + h.Lote : ''} · sale como ${h.ReferenciaSalida ?? '—'}</div>
          </div>
          <div class="hist-rollo-kg">${h.Cantidad != null ? Number(h.Cantidad).toFixed(2) : '—'}<small>Kg consumidos</small></div>
        </div>`).join('')
    : `<div class="pesaje-vacio">Sin materia prima registrada todavía.</div>`;

  // Ajuste del consumo real -- ver la nota en renderOrdenDetalle. En un grupo la materia prima vive
  // toda bajo la ancla (los hermanos se crearon con sinMateriaPrima=true), asi que da igual desde
  // que miembro se pida: resolverAnclaMateriaPrima lo redirige solo. Se usa el primer miembro en
  // PendienteValidacion porque el Finalizar pasa a las 3 referencias juntas.
  const miembroParaAjuste = (miembros || []).find(m => m.Estado === 'PendienteValidacion') || null;
  // Observacion libre del operario (22/09/2026). Sin condicion de estado a proposito: lo que el
  // operario vio no depende de si la orden esta corriendo o ya se finalizo, y anotar nunca cambia
  // nada -- solo agrega una fila a SEL_ObservacionOperario. La OTRA puerta de entrada es la
  // pregunta al cerrar sesion, que vive en scriptObservaciones() y sale en todas las paginas.
  const miembroParaObservacion = miembroAncla || (miembros || [])[0] || null;
  const botonObservacion = miembroParaObservacion
    ? `<button type="button" class="btn-accion btn-isla btn-info"
         onclick="abrirObservacion(${miembroParaObservacion.IdOrden})">📝 Observación</button>`
    : '';

  // Autorizacion del pedido (22/09/2026). Se puede firmar en cualquier momento; es obligatoria
  // antes de Finalizar y antes de cerrar sesion con el pedido activo. El boton no cambia de
  // aspecto segun este firmado o no: el estado se consulta al abrirlo, porque esta pagina se
  // pinta una vez y la firma puede llegar desde otra tableta mientras esta abierta.
  const botonAutorizacion = miembroParaObservacion
    ? `<button type="button" class="btn-accion btn-isla btn-info"
         onclick="abrirAutorizacion(${miembroParaObservacion.IdOrden})">🔑 Autorización</button>`
    : '';
  const botonAjusteConsumo = miembroParaAjuste
    ? `<button type="button" class="btn-accion btn-isla btn-info" style="margin-bottom:10px;"
         onclick="abrirAjusteConsumo(${miembroParaAjuste.IdOrden})">⚖ Ajustar consumo de rollo</button>`
    : '';

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
          ${ordenProduccion ? `<div class="header-ot">${ordenProduccion}</div>` : ''}
          <h1>🔗 Pedido ${numeroPedido || '—'}</h1>
          <div class="sub">Sellado en paralelo -- un solo proceso, ${miembros.length} referencias de salida</div>
          <a class="volver" href="/selladora/${maquinaCodigo}">‹ ${maquinaNombre}</a>
        </div>
        ${avanceCard}
        ${bloqueUsuarioHeader(usuario)}
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
      ${botonObservacion ? `<div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Observaciones</div>
          <div class="isla-detalle">Deje por escrito lo que vio en el turno</div>
        </div>
        ${botonObservacion}
      </div>
      <div class="isla isla-con-boton">
        <div class="isla-texto">
          <div class="label">Autorización de la OT</div>
          <div class="isla-detalle">Necesaria para finalizar y para cerrar sesión</div>
        </div>
        ${botonAutorizacion}
      </div>` : ''}
    </div>
    <h2 style="font-size:15px;margin:0 0 10px;">Referencias de salida</h2>
    ${tarjetasReferencia}
    <h2 style="font-size:15px;margin:22px 0 10px;">Historial rollo (todo el grupo)</h2>
    ${botonAjusteConsumo}
    <div class="ejecucion-box">${filasHistorial}</div>
  </main>
  <script src="/sweetalert2.min.js"></script>
  <!-- Los tres avisos automaticos que antes solo estaban en la pagina de una referencia suelta se
       agregaron aca el 10/09/2026, junto con quitar el boton "Más información" de cada tarjeta (a
       pedido del usuario): este apartado tiene que bastarse solo, y sin ellos el operario que se
       quedara aca no se enteraba de un pedido nuevo, de una suspension pedida por Programación ni
       de un protocolo de arranque a medias. -->
  <script>${scriptNotificaciones(maquinaCodigo)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
  <script>${scriptAvisoPedidoNuevo(maquinaCodigo)}</script>
  <script>${scriptPreguntaActividadInicial()}</script>
  <script>${scriptConfirmarFinalizar()}</script>
  <script>${scriptAjusteConsumo()}</script>
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
        ${bloqueUsuarioHeader(usuario)}
      </div>
    </div>
  </header>
  <main>
    <div class="filtro-refs">${filtro}</div>
    <div id="contenedor-bultos">${renderTarjetasBultosGrupo(datosPorReferencia)}</div>
    ${traslados}
  </main>
  <script src="/sweetalert2.min.js"></script>
  <script>${scriptNotificaciones(maquinaCodigo)}</script>
  <script>${scriptAutorizacion()}</script>
  <script>${scriptObservaciones()}</script>
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
    // Orden de Trabajo (redefinicion 15/09/2026): las 3 referencias del grupo comparten la MISMA OT
    // (obtenerAnclaGrupoSellado en el Node de scan-rollo.js la ancla por la referencia ancla del
    // grupo) -- se resuelve una sola vez contra la ejecucion de la orden ancla.
    let ordenProduccion = null;
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

        const dtOP = await p.request().input('idEjecucion', idEjecucion).query(`
          SELECT TOP 1 pp.OrdenProduccion FROM SEL_Bultos b
          INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
          WHERE b.id_ejecucion = @idEjecucion AND pp.OrdenProduccion IS NOT NULL
        `);
        if (dtOP.recordset.length > 0) ordenProduccion = dtOP.recordset[0].OrdenProduccion;
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

    res.send(renderGrupoSelladoDetalle(idGrupo, miembros[0].NumeroPedido, maquinaNombre, codigo, miembros, req.session.usuario.nombre, historial, totalBultos, pausaActiva, calidadHabilitada, protocoloPendiente, ordenProduccion));
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

    // Orden de Trabajo (PRDProduccion.OrdenProduccion, redefinicion 15/09/2026, a pedido del
    // usuario -- "apenas se cree en la tarjeta se coloca la orden de trabajo y adentro de la
    // pantalla también"): mismo patron que obtenerColaOrdenes/el endpoint de pausar. Null mientras
    // la orden sigue 'Pendiente' (no hay ejecucion ni bulto todavia).
    let ordenProduccion = null;
    if (idEjecucion) {
      const dtOP = await p.request().input('idEjecucion', idEjecucion).query(`
        SELECT TOP 1 pp.OrdenProduccion FROM SEL_Bultos b
        INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
        WHERE b.id_ejecucion = @idEjecucion AND pp.OrdenProduccion IS NOT NULL
      `);
      if (dtOP.recordset.length > 0) ordenProduccion = dtOP.recordset[0].OrdenProduccion;
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
    // FIX 23/09/2026: Lote del ANCLA (primer bulto, por id), no del ultimo -- ver el mismo fix en
    // obtenerHistorialMPGrupo.
    let historial = [];
    const ultimoBulto = await p.request().input('idOrden', idOrden).query(`
      SELECT TOP 1 b.refsalida, b.mes, b.dia FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY b.id ASC
    `);
    if (ultimoBulto.recordset.length > 0) {
      const { refsalida: nElemento, mes, dia } = ultimoBulto.recordset[0];
      const tLote = String(mes).padStart(2, '0') + String(dia).padStart(2, '0');
      const nLineaOriginal = await obtenerLineaOriginalControlSellado(p, idOrden, 0);
      const historialResult = await p.request()
        .input('elemento', nElemento).input('lote', tLote).input('lineaOriginal', nLineaOriginal)
        .query(`
          SELECT mp.Detalle AS Serial, e.Nombre AS Referencia, mp.LoteMP AS Lote, mp.Cantidad
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

    const esAdmin = req.session.usuario.codigo === ADMIN_CODIGO;
    res.send(renderOrdenDetalle(orden, totalBultos, historial, req.session.usuario.nombre, codigo, pausaActiva, avance, calidadHabilitada, grupoSellado, protocoloPendiente, esAdmin, ordenProduccion));
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
    ORDER BY b.id ASC -- FIX 23/09/2026: num_bulto se reinicia por dia, el orden real es por id
  `);
  const bultos = bultosResult.recordset.map((b, idx) => ({ ...b, numRelativo: idx + 1 }));

  let pesajesPorBulto = new Map();
  let residuosPorBulto = new Map();
  if (bultos.length > 0) {
    // id_paquete (PK real de SEL_PesajeElemento) se necesita para identificar sin ambigüedad UN
    // paquete puntual al trasladarlo (ver /api/selladora/paquete/trasladar) -- ConsecutivoPaquete
    // solo es único DENTRO de un bulto, no en toda la orden.
    const pesajesResult = await p.request().input('idOrden', idOrden).query(`
      SELECT pe.id_paquete, pe.id_bulto, pe.ConsecutivoPaquete, FORMAT(pe.FechaHora,'dd/MM/yyyy HH:mm:ss') AS Hora, pe.PesoPaqueGr,
             ISNULL(pe.UnidadesPaquete, 100) AS UnidadesPaquete
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

// Cada paquete producido cuenta 100 unidades POR DEFECTO cuando la orden se mide en unidades
// (regla de negocio dada por el usuario, 02/09/2026). Se mantiene como constante de RESPALDO --
// FIX 13/09/2026 (a pedido del usuario -- "Modificar cantidad de paquetes"): ya no se multiplica
// a ciegas por esta constante, se suma el UnidadesPaquete real de cada paquete
// (SEL_PesajeElemento.UnidadesPaquete, ver agregar_unidadespaquete_pesajeelemento.sql) -- que por
// default SIGUE siendo 100 (el PLC no cambia), pero el operario puede corregirlo paquete por
// paquete desde Bultos. Este valor solo queda de referencia si algún día hace falta un fallback.
const UNIDADES_POR_PAQUETE = 100;

// Avance de produccion de una orden: lo producido contra lo pedido (tarjeta del encabezado de
// Informacion, ver renderOrdenDetalle). Reglas acordadas con el usuario (02/09/2026):
//  - La meta sale de SEL_OrdenProduccion: KilosSolicitados manda si tiene valor (> 0) y el avance
//    se mide en kg; si no, UnidadesSolicitadas y se mide en unidades. Si ninguna tiene valor no hay
//    meta configurada (tipo null) y la tarjeta no se muestra.
//  - Lo producido es el acumulado de TODOS los bultos Activo + Cerrado de la orden (no solo el
//    bulto activo, a diferencia de /resumen-bulto-activo): en kg, la suma de PesoPaqueGr, que pese
//    a llamarse "Gr" guarda KILOGRAMOS (ver FIX 02/09/2026 en scriptResumenBultoActivo); en
//    unidades, la SUMA de UnidadesPaquete de cada paquete (FIX 13/09/2026 -- antes era paquetes x
//    UNIDADES_POR_PAQUETE fijo, ver comentario de esa constante).
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
    SELECT ISNULL(SUM(pe.PesoPaqueGr), 0) AS PesoTotalKg, COUNT(*) AS Paquetes,
           ISNULL(SUM(ISNULL(pe.UnidadesPaquete, 100)), 0) AS UnidadesTotal
    FROM SEL_PesajeElemento pe
    INNER JOIN SEL_Bultos b ON b.id = pe.id_bulto
    INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
    WHERE ej.IdOrden = @idOrden AND b.estado IN ('Activo', 'Cerrado', 'EnEspera', 'Temporal')
  `);
  const paquetes = Number(dtProducido.recordset[0].Paquetes);
  const producido = tipo === 'kg'
    ? Number(dtProducido.recordset[0].PesoTotalKg)
    : Number(dtProducido.recordset[0].UnidadesTotal);
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

// "Modificar cantidad de paquetes" (13/09/2026, a pedido del usuario) -- por defecto CADA paquete
// pesado representa 100 unidades (SEL_PesajeElemento.UnidadesPaquete, DEFAULT 100 -- ver
// agregar_unidadespaquete_pesajeelemento.sql), pero hay paquetes puntuales que traen menos (un
// resto/ajuste) y el operario necesita corregirlo desde la tableta, sin que el PLC sepa nada de
// esto. Mismo criterio que "Volver a pesar" (mismo endpoint hermano, arriba): si el bulto ya
// estaba Cerrado, recalcula PRDProduccion.Unidades sumando TODOS los paquetes del bulto con su
// UnidadesPaquete real -- si sigue abierto, no hay nada que rehacer (trg_SEL_Bultos_CierreBulto lo
// calculará bien al cerrar, una vez esa trigger también sume UnidadesPaquete en vez de multiplicar
// por 100 -- ver la nota PENDIENTE en agregar_unidadespaquete_pesajeelemento.sql).
app.post('/api/selladora/paquete/modificar-cantidad', requireLogin, async (req, res) => {
  const idPaquete = Number(req.body && req.body.idPaquete);
  const unidades = Number(req.body && req.body.unidades);
  if (!Number.isFinite(idPaquete) || idPaquete <= 0) {
    return res.json({ ok: false, error: 'Falta idPaquete.' });
  }
  if (!Number.isInteger(unidades) || unidades < 0) {
    return res.json({ ok: false, error: 'La cantidad de bolsas debe ser un número entero mayor o igual a cero.' });
  }
  try {
    const p = await getPool();
    const dtPaquete = await p.request().input('idPaquete', idPaquete).query(`
      SELECT TOP 1 pe.id_paquete, pe.id_bulto, pe.ConsecutivoPaquete, ISNULL(pe.UnidadesPaquete, 100) AS UnidadesPaquete,
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
    const unidadesAnterior = Number(paq.UnidadesPaquete);

    // Mismo tope que "Volver a pesar" -- ver esa nota arriba (merma ya calculada por el digitador).
    if (paq.EstadoOrden === 'Finalizada') {
      return res.json({
        ok: false,
        error: 'Esta orden ya fue cerrada definitivamente por el digitador y su merma ya está calculada. La cantidad de bolsas de este paquete solo se puede corregir desde el escritorio.'
      });
    }

    let unidadesTotalBulto = null;
    const tx = new sql.Transaction(p);
    await tx.begin();
    try {
      await tx.request().input('idPaquete', idPaquete).input('unidades', unidades)
        .query(`UPDATE SEL_PesajeElemento SET UnidadesPaquete = @unidades WHERE id_paquete = @idPaquete`);

      // Igual que "Volver a pesar": solo hay algo que rehacer si el bulto YA estaba Cerrado
      // (CantidadTotal ya calculado por trg_SEL_Bultos_CierreBulto). En un bulto abierto no se
      // toca PRDProduccion todavía -- se escribe recién al cerrar.
      if (paq.id_bulto != null && paq.CantidadTotal != null) {
        const dtTotal = await tx.request().input('idBulto', paq.id_bulto).query(
          `SELECT ISNULL(SUM(ISNULL(UnidadesPaquete, 100)), 0) AS Total FROM SEL_PesajeElemento WHERE id_bulto = @idBulto`
        );
        unidadesTotalBulto = Number(dtTotal.recordset[0].Total);

        await tx.request().input('serialPadre', paq.serialPadre).input('total', unidadesTotalBulto).query(`
          UPDATE PRDProduccion SET Unidades = @total, FechaModificado = GETDATE()
          WHERE Detalle = @serialPadre
        `);
        // INVExistencias no guarda unidades por separado (solo Cantidad en kg) -- nada más que tocar.
      }
      await tx.commit();
    } catch (errTx) {
      await tx.rollback();
      throw errTx;
    }

    res.json({
      ok: true,
      unidadesAnterior,
      unidadesNuevo: unidades,
      idBulto: paq.id_bulto,
      consecutivoPaquete: paq.ConsecutivoPaquete,
      bultoCerrado: paq.CantidadTotal != null,
      unidadesTotalBulto
    });
  } catch (err) {
    const falta = /Invalid column name 'UnidadesPaquete'/i.test(err.message);
    res.json({ ok: false, error: falta ? 'Falta la columna SEL_PesajeElemento.UnidadesPaquete (ejecute agregar_unidadespaquete_pesajeelemento.sql).' : err.message });
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

// ¿Toca ya la verificacion periodica de la bascula? (a pedido del usuario, 14/09/2026: "esta
// actividad tambien debe salir aleatoriamente cada 30-40 minutos"). Lo sondea la tableta, ver
// vigilarPesoPatron() en scriptComandos.
//
// La verificacion es de la BASCULA, o sea de la MAQUINA: se mira la ultima hecha en esa maquina
// sin importar por que orden paso el operario. Vale tanto la del arranque como una periodica
// anterior (Paso LIKE 'peso_patron%'), porque las dos comprueban lo mismo -- no tiene sentido
// pedirla a los 5 minutos de haberla hecho en el protocolo.
//
// El intervalo lo calcula proximaVerificacionBascula(), que es aleatorio pero DETERMINISTA para
// una misma ultima verificacion: si se sorteara en cada sondeo, la ventana saldria antes o despues
// segun el azar de cada consulta.
app.get('/selladora/:codigo/peso-patron-pendiente', requireLogin, async (req, res) => {
  const { codigo } = req.params;
  try {
    const p = await getPool();
    const dtUltima = await p.request().input('maquina', codigo).query(`
      SELECT TOP 1 pa.Id, pa.FechaHora
      FROM SEL_ProtocoloArranque pa
      INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = pa.IdOrden
      WHERE ord.Maquina = @maquina AND pa.Paso LIKE 'peso_patron%'
      ORDER BY pa.Id DESC
    `);
    // Nunca se ha verificado en esta maquina. NO se pide de inmediato (FIX 16/09/2026, mismo
    // reporte que el de obtenerProtocoloPendiente): eso solo pasa con ordenes que arrancaron antes
    // de que el paso existiera, y abrirles la ventana apenas entran es exactamente la molestia que
    // se quiere evitar. Se corrige solo: la proxima orden que pase por el protocolo deja su
    // verificacion de arranque, y a partir de ahi el conteo de 30-40 min arranca normal.
    if (dtUltima.recordset.length === 0) return res.json({ ok: true, pendiente: false, ultima: null });

    const { Id, FechaHora } = dtUltima.recordset[0];
    const proxima = proximaVerificacionBascula(Id, FechaHora);
    res.json({ ok: true, pendiente: Date.now() >= proxima.getTime(), ultima: FechaHora, proxima });
  } catch (err) {
    // Mismo blindaje que el resto: sin SEL_ProtocoloArranque no hay forma de saber cuando fue la
    // ultima, y pedir la verificacion en cada sondeo seria peor que no pedirla.
    console.error('No se pudo revisar la verificacion de bascula (¿falta ejecutar agregar_protocolo_arranque.sql?):', err.message);
    res.json({ ok: true, pendiente: false, ultima: null });
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
    // Relevo de operario (18/09/2026, a pedido del usuario): quien recibe la maquina vuelve a
    // correr el protocolo de arranque completo, con la particularidad de que el rollo solo se pita
    // si hace falta -- la maquina ya tiene uno montado (ver protocoloPendienteDeRelevo y
    // pasoRolloRelevo). Aca solo se deja la marca en la base; la ventana la abre la tableta al
    // cargar la pagina, igual que un protocolo a medias. Asi el relevo sobrevive a que la tableta
    // se recargue, se apague o cambie de pantalla, que es el mismo criterio de todo el protocolo.
    //
    // Si la ejecucion vuelve 'En pausa' la marca queda igual, pero el protocolo espera: no puede
    // arrancar su limpieza sobre una ejecucion ya pausada (ver protocoloPendienteDeRelevo), y sale
    // solo cuando el operario reanude.
    const relevoMarcado = await marcarRelevoProtocolo(p, {
      idOrden, operario: miOperario, esOtroOperario: Operario !== miOperario
    });
    // Con el relevo marcado NO se pregunta ademas por la actividad inicial: el protocolo ya trae
    // sus dos actividades cronometradas (limpieza y alistamiento) una detras de otra, y preguntar
    // por una pausa suelta antes de empezar era pedir lo mismo dos veces. Si no se pudo marcar
    // (falta la tabla, o hay un protocolo a medias que sale solo), se comporta como antes.
    const destino = (relevoMarcado || Estado === 'En pausa')
      ? `/selladora/${Maquina}`
      : `/selladora/${Maquina}?preguntarActividad=${idOrden}`;
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

// El rollo que esta montado ahora mismo, para el paso 3 del protocolo de relevo (pasoRolloRelevo):
// el operario que acaba de recibir la maquina lo confirma en vez de tener que pitarlo otra vez.
// SEL_RolloEjecucion es la unica tabla con serial + hora del montaje (PRDProduccionMateriaPrima
// guarda el serial sin hora), y de ahi sale tambien la referencia de la materia prima, por serial.
//
// En sellado paralelo el rollo vive en la ejecucion del ANCLA -- es un solo rollo fisico para las
// 3 referencias -- asi que se pregunta por la orden ancla, no por la que tenia el boton a mano.
//
// Nunca responde error: si no se puede saber que rollo esta montado devuelve rollo = null, y la
// tableta ya sabe que hacer con eso (pedir que lo piten, que es el camino seguro).
app.get('/api/selladora/orden/:idOrden/rollo/actual', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  try {
    const p = await getPool();
    const ancla = await obtenerAnclaGrupoSellado(p, idOrden);
    const dt = await p.request().input('idOrden', ancla ? ancla.IdOrden : idOrden).query(`
      SELECT TOP 1 re.Serial, re.Cantidad, re.LoteMP, re.FechaHora,
             (SELECT TOP 1 e.Nombre FROM PRDProduccionMateriaPrima mp
                INNER JOIN INVElementos e ON e.Codigo = mp.MateriaPrima
                WHERE mp.Detalle = re.Serial ORDER BY mp.Linea DESC) AS Referencia
      FROM SEL_RolloEjecucion re
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = re.id_ejecucion
      WHERE ej.IdOrden = @idOrden
      ORDER BY re.Id DESC
    `);
    if (dt.recordset.length === 0) return res.json({ ok: true, rollo: null });
    const r = dt.recordset[0];
    res.json({
      ok: true,
      rollo: {
        serial: r.Serial,
        cantidad: r.Cantidad != null ? Number(r.Cantidad) : null,
        lote: r.LoteMP,
        referencia: r.Referencia,
        hora: fechaHoraLocalBD(r.FechaHora)
      }
    });
  } catch (err) {
    console.error('No se pudo leer el rollo montado (¿falta ejecutar 07_crear_sel_rolloejecucion.sql?):', err.message);
    res.json({ ok: true, rollo: null });
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

// MOVIDO a sel-inventario-mp.js el 13/09/2026 (TURNOS_BASE_SELLADORA, minutosDelDia,
// fechaISOLocal, resolverTurnoMaquina, cerrarBitacora, abrirOReanudarBitacora): scan-rollo.js
// (el flujo de "Iniciar") tambien necesita abrir la bitacora, no solo tomar-control-ejecucion
// aca abajo -- y scan-rollo.js no puede requerir este archivo (server.js YA lo requiere a el,
// séria circular). Quedan importadas desde el require de sel-inventario-mp.js, arriba del todo.

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
               COUNT(*) AS Paquetes, SUM(pe.PesoPaqueGr) AS PesoPaquetes,
               SUM(ISNULL(pe.UnidadesPaquete, 100)) AS UnidadesPaquetes
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

  // FIX 13/09/2026: ya no es number_paqu x 100 fijo -- suma el UnidadesPaquete real de cada
  // paquete del bulto (ver agregar_unidadespaquete_pesajeelemento.sql / "Modificar cantidad de
  // paquetes"), que sigue siendo 100 por defecto salvo que el operario lo haya corregido.
  const unidadesDe = (r) => Number(r.UnidadesPaquetes || 0);
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
// Rango con el que se valida el amperaje del ferroniquel. Holgado A PROPOSITO: el paso es
// obligatorio para empezar a producir, asi que un rango apretado deja la maquina parada porque el
// operario no puede registrar un valor legitimo, mientras que uno holgado solo deja pasar un error
// de digitacion. Cuando se sepa el rango real del equipo, se ajusta aca y en el inputValidator de
// pasoAmperajeProtocolo. Ver la NOTA SOBRE EL RANGO en agregar_amperaje_ferroniquel.sql.
const AMPERAJE_MIN = 0;
const AMPERAJE_MAX = 999;

// Amperaje del ferroniquel que digita el operario (ver agregar_amperaje_ferroniquel.sql). Se
// guarda con la hora, para saber que consumo habia en cada momento de la orden.
//
// CAMBIO 15/09/2026: este endpoint pedia el % de la perilla de temperatura y escribia en
// SEL_TemperaturaPerilla. Ahora recibe amperios y escribe en SEL_AmperajeFerroniquel. La tabla
// vieja NO se toca: un porcentaje y una corriente no son la misma magnitud, no hay nada que
// convertir, y su unica fila historica sigue significando lo que significaba.
app.post('/api/selladora/orden/:idOrden/amperaje', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const amperaje = Number(req.body && req.body.amperaje);
  if (!Number.isFinite(amperaje) || amperaje <= AMPERAJE_MIN || amperaje > AMPERAJE_MAX) {
    return res.json({ ok: false, error: `El amperaje debe ser un número mayor que ${AMPERAJE_MIN} y hasta ${AMPERAJE_MAX} A.` });
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
      .input('amperaje', amperaje)
      .query(`INSERT INTO SEL_AmperajeFerroniquel (id_ejecucion, Operario, Amperaje) VALUES (@idEjecucion, @operario, @amperaje)`);

    // A donde mandar al operario cuando este es el ULTIMO paso del protocolo de arranque (ver
    // pasoAmperajeProtocolo). Se resuelve aca y no en la tableta porque solo el servidor sabe si
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
    res.json({ ok: false, error: falta ? 'Falta crear la tabla SEL_AmperajeFerroniquel (ejecute agregar_amperaje_ferroniquel.sql).' : err.message });
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

    // FIX 15/09/2026 (a pedido del usuario -- "todo debe quedar asociado a la orden de trabajo"):
    // si la OT ya existe para esta ejecución (pausa durante producción activa, no el alistamiento
    // previo al arranque), se resuelve y se escribe de una vez -- no hay que esperar al backfill
    // de obtenerOCrearOrdenProduccion, que solo corre una vez, al crear la OT. Si todavía no existe
    // (pausa pre-arranque), queda NULL aquí y se backfillea cuando nazca la OT.
    const dtOP = await p.request().input('idEjecucion', IdEjecucion).query(`
      SELECT TOP 1 pp.OrdenProduccion
      FROM SEL_Bultos b
      INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
      WHERE b.id_ejecucion = @idEjecucion AND pp.OrdenProduccion IS NOT NULL
    `);
    const tOrdenProduccionTM = dtOP.recordset.length > 0 ? dtOP.recordset[0].OrdenProduccion : null;

    // 24/09/2026 (a pedido del usuario): bitacora del tiempo muerto = la de la maquina para el TURNO y
    // la FECHA DE TURNO en que empieza (la que abre el operario al tomar control) -- misma regla que
    // trg_SEL_Bultos_CierreBulto para los bultos, con el mismo resolverTurnoMaquina con el que Node abre
    // la bitacora. Si todavia no hay bitacora de ese turno, queda NULL. Nunca bloquea la pausa.
    let nIdBitacoraTM = null;
    try {
      const dtMaq = await p.request().input('idOrden', idOrden)
        .query(`SELECT Maquina FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
      const nMaquinaTM = dtMaq.recordset.length > 0 ? dtMaq.recordset[0].Maquina : null;
      if (nMaquinaTM != null) {
        const turnoTM = await resolverTurnoMaquina(p, nMaquinaTM, horaInicio);
        if (turnoTM.turno != null) {
          const dtBit = await p.request()
            .input('maquina', nMaquinaTM).input('turno', turnoTM.turno).input('fechaTurno', turnoTM.fechaTurno)
            .query(`
              SELECT TOP 1 IdBitacora FROM SEL_BitacoraTurno
              WHERE Maquina = @maquina AND Turno = @turno AND FechaTurno = @fechaTurno
              ORDER BY IdBitacora DESC
            `);
          if (dtBit.recordset.length > 0) nIdBitacoraTM = dtBit.recordset[0].IdBitacora;
        }
      }
    } catch (errBit) {
      console.error('No se pudo resolver la bitacora del tiempo muerto:', errBit.message);
    }

    await p.request()
      .input('idEjecucion', IdEjecucion).input('operario', operario).input('tipo', tipo)
      .input('subtipo', tipo === 'alistamiento' ? subtipo : null)
      .input('horaInicio', horaInicio).input('observaciones', observaciones ? observaciones.trim() : null)
      .input('ordenProduccion', tOrdenProduccionTM).input('idBitacora', nIdBitacoraTM)
      .query(`
        INSERT INTO SEL_TiempoMuerto (id_ejecucion, Operario, Tipo, Subtipo, HoraInicio, Observaciones, OrdenProduccion, IdBitacora)
        VALUES (@idEjecucion, @operario, @tipo, @subtipo, @horaInicio, @observaciones, @ordenProduccion, @idBitacora)
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

    // FIX 16/09/2026 (rediseno del Iniciar, a pedido del usuario): hay que saber QUE actividad se
    // esta cerrando ANTES de cerrarla -- si es el Alistamiento del protocolo de arranque
    // (Tipo='alistamiento', Subtipo='arranque'), es la señal de que hay que materializar el
    // bulto/PRDProduccion que quedo pendiente desde que se escaneo el rollo (ver
    // SEL_RolloPendienteInicio / materializarInicioOrden en scan-rollo.js).
    const dtAbierta = await p.request().input('idEjecucion', IdEjecucion).query(`
      SELECT TOP 1 Tipo, Subtipo FROM SEL_TiempoMuerto
      WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC
    `);
    const esFinDeAlistamientoArranque = dtAbierta.recordset.length > 0
      && String(dtAbierta.recordset[0].Tipo || '').toLowerCase() === 'alistamiento'
      && String(dtAbierta.recordset[0].Subtipo || '').toLowerCase() === 'arranque';

    // FIX 16/09/2026: al terminar el Alistamiento se crea el bulto/OT/PRDProduccion -- antes esto
    // pasaba al confirmar el escaneo del rollo, mucho antes de que el Alistamiento siquiera
    // arrancara. Si por lo que sea ya se habia materializado (no deberia pasar -- /reanudar exige
    // Estado='En pausa', que ya cambia en cuanto esto corre una vez -- pero por las dudas) o no hay
    // ninguna fila pendiente, no hace nada.
    // FIX 25/09/2026: y solo con la orden todavia Pendiente -- el alistamiento de un RELEVO tambien
    // es 'alistamiento'/'arranque' pero corre con la orden ya Activa, y ahi una fila huerfana con
    // Procesado = 0 (pedido 11227) crearia un segundo bulto de arranque. Mismo criterio que la
    // autocuracion de obtenerProtocoloPendiente.
    // FIX 25/09/2026 (pedido 11227): esto va ANTES de cerrar el tiempo muerto, no despues. Antes, si
    // la creacion del bulto fallaba, el alistamiento ya habia quedado cerrado: el "Reintentar" de la
    // tableta ya no lo encontraba abierto, respondia ok sin crear nada y el protocolo seguia (peso
    // patron, amperaje) con la orden Pendiente y sin bulto -- y el operario volvia a darle Iniciar.
    // Ahora un fallo deja el cronometro abierto y la ejecucion En pausa; el reintento vuelve a
    // intentar crear el bulto. Crear la OT con el alistamiento todavia abierto no cambia nada: solo
    // lee MIN(HoraInicio) de los tiempos muertos (ver obtenerOCrearOrdenProduccion).
    let seMaterializo = false;
    if (esFinDeAlistamientoArranque && EstadoOrden === 'Pendiente') {
      // El escaneo mas reciente es el rollo que de verdad quedo montado (confirmarRollo ya no deja
      // dos filas pendientes, pero una base con duplicados viejos si puede tenerlas).
      const dtPendiente = await p.request().input('idEjecucion', IdEjecucion).query(`
        SELECT TOP 1 Id, IdOrden, CodOperario, Serial, Cantidad, Lote, BolsasXGolpe, GeneradoPor
        FROM SEL_RolloPendienteInicio WHERE IdEjecucion = @idEjecucion AND Procesado = 0
        ORDER BY Id DESC
      `);
      if (dtPendiente.recordset.length > 0) {
        const pend = dtPendiente.recordset[0];
        await materializarInicioOrden(p, {
          idOrden: pend.IdOrden, idEjecucion: IdEjecucion, codOperario: pend.CodOperario,
          serial: pend.Serial, cantidad: pend.Cantidad, lote: pend.Lote,
          bolsasXGolpe: pend.BolsasXGolpe, generadoPor: pend.GeneradoPor
        });
        // Se marcan TODAS las pendientes de la ejecucion, no solo la usada: cualquier otra es un
        // escaneo anterior que este reemplazo, y dejarla con Procesado = 0 es lo que dejo huerfana
        // la del pedido 11227.
        await p.request().input('idEjecucion', IdEjecucion).query(
          `UPDATE SEL_RolloPendienteInicio SET Procesado = 1, FechaHoraProcesado = GETDATE() WHERE IdEjecucion = @idEjecucion AND Procesado = 0`
        );
        seMaterializo = true;
      }
    }

    // DuracionMinutos es una columna CALCULADA (AS DATEDIFF(MINUTE, HoraInicio, HoraFin) PERSISTED)
    // -- SQL Server la resuelve sola en cuanto se guarda HoraFin, no se puede asignar a mano
    // (por eso el error "cannot be modified because it is either a computed column...").
    // OJO (15/09/2026): eso era cierto SOLO en carlixplastPrueba. En carlixplast era una columna INT
    // normal y, como aca se dejo de escribirla, quedo en NULL en las 77 filas que habia -- una
    // columna trampa para cualquier Excel/Power BI que hiciera SUM(DuracionMinutos). Lo iguala
    // corregir_duracionminutos_tiempomuerto.sql; mientras una base no lo tenga ejecutado, la
    // duracion de un tiempo muerto hay que derivarla con DATEDIFF(MINUTE, HoraInicio, HoraFin).
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
    // FIX 16/09/2026: EstadoOrden se leyo ANTES de materializar -- si justo se materializo en este
    // mismo llamado, la orden ya quedo 'Activa' (lo hace materializarInicioOrden), asi que se fuerza
    // 'Activa' acá también en vez de usar el valor viejo capturado arriba.
    await p.request().input('idEjecucion', IdEjecucion)
      .input('estado', (seMaterializo || EstadoOrden === 'Activa') ? 'Activa' : 'Pendiente')
      .query(`UPDATE SEL_EjecucionOrden SET Estado = @estado WHERE IdEjecucion = @idEjecucion`);

    res.json({ ok: true });
  } catch (err) {
    // Queda en la consola (25/09/2026): el fallo de la creacion del bulto del pedido 11227 no dejo
    // rastro y no hubo forma de saber despues por que fallo.
    console.error(`No se pudo reanudar la orden ${idOrden}:`, err.message);
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
  'limpieza', 'peligro_quimico', 'rollo_estado', 'peligro_fisico', 'alistamiento',
  // 'temperatura' es el nombre VIEJO del ultimo paso (el % de la perilla). Se deja en la lista a
  // proposito aunque la tableta ya no lo mande: si no, un protocolo que quedo a medias antes del
  // 15/09/2026 no podria ni terminar de guardar sus pasos. Lo nuevo es 'amperaje'.
  'temperatura', 'amperaje',
  // Verificacion de la bascula contra el elemento patron (14/09/2026). Son DOS pasos y no uno
  // porque se disparan distinto y hay que poder distinguirlos:
  //   peso_patron            -> el del protocolo de arranque. obtenerProtocoloPendiente lo busca
  //                             para saber si el arranque quedo a medias.
  //   peso_patron_periodico  -> el que sale solo cada 30-40 min mientras se produce. Si usara la
  //                             misma clave, una verificacion periodica haria creer al retome que
  //                             el paso del arranque ya se hizo.
  // Para un reporte que las quiera juntas: Paso LIKE 'peso_patron%'.
  'peso_patron', 'peso_patron_periodico',
  // Relevo de operario (18/09/2026): 'relevo' es la MARCA que abre una ronda nueva del protocolo
  // cuando alguien retoma una ejecucion en curso -- obtenerProtocoloPendiente la usa como linea
  // divisoria y solo evalua los pasos posteriores. 'rollo_mismo' es la respuesta propia de esa
  // ronda: el operario confirmo que sigue con el rollo que ya estaba montado, sin pitar otro.
  'relevo', 'rollo_mismo'
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
    const { IdEjecucion } = dtEj.recordset[0];
    let EstadoOrden = dtEj.recordset[0].EstadoOrden;
    if (EstadoOrden !== 'Pendiente' && EstadoOrden !== 'Activa') return null;

    // FIX 16/09/2026 (rediseno del Iniciar -- autocuracion): si el Alistamiento del protocolo de
    // arranque YA se cerro (HoraFin puesto, ver POST /reanudar) pero la materializacion del bulto
    // nunca corrio (ventana muy angosta pero posible: el servidor se cae justo entre cerrar el
    // tiempo muerto y crear el bulto), NO hay que volver a pedir escanear el rollo -- ya esta
    // guardado en SEL_RolloPendienteInicio. Se materializa aca mismo antes de seguir evaluando.
    //
    // FIX 25/09/2026 (bug real, pedido 11227: el relevo de operario no abria el protocolo): SOLO con
    // la orden todavia Pendiente. Una orden Activa ya se materializo, y una fila con Procesado = 0
    // que haya quedado huerfana (en el 11227, un segundo escaneo del rollo del 18/09) hacia que esto
    // intentara crear el bulto OTRA VEZ en cada consulta; eso reventaba, el catch de abajo devolvia
    // null y el protocolo -- el de relevo incluido -- nunca salia.
    const dtPendienteAutocura = EstadoOrden !== 'Pendiente' ? { recordset: [] } : await p.request().input('idEjecucion', IdEjecucion).query(`
      SELECT TOP 1 Id, IdOrden, CodOperario, Serial, Cantidad, Lote, BolsasXGolpe, GeneradoPor
      FROM SEL_RolloPendienteInicio WHERE IdEjecucion = @idEjecucion AND Procesado = 0
      ORDER BY Id DESC
    `);
    if (dtPendienteAutocura.recordset.length > 0) {
      const dtAlistamientoCerrado = await p.request().input('idEjecucion', IdEjecucion).query(`
        SELECT TOP 1 1 AS X FROM SEL_TiempoMuerto
        WHERE id_ejecucion = @idEjecucion AND Tipo = 'alistamiento' AND Subtipo = 'arranque' AND HoraFin IS NOT NULL
      `);
      if (dtAlistamientoCerrado.recordset.length > 0) {
        const pend = dtPendienteAutocura.recordset[0];
        await materializarInicioOrden(p, {
          idOrden: pend.IdOrden, idEjecucion: IdEjecucion, codOperario: pend.CodOperario,
          serial: pend.Serial, cantidad: pend.Cantidad, lote: pend.Lote,
          bolsasXGolpe: pend.BolsasXGolpe, generadoPor: pend.GeneradoPor
        });
        // Todas las pendientes, igual que en /reanudar: las demas son escaneos anteriores reemplazados.
        await p.request().input('idEjecucion', IdEjecucion).query(
          `UPDATE SEL_RolloPendienteInicio SET Procesado = 1, FechaHoraProcesado = GETDATE() WHERE IdEjecucion = @idEjecucion AND Procesado = 0`
        );
        await p.request().input('idEjecucion', IdEjecucion).query(
          `UPDATE SEL_EjecucionOrden SET Estado = 'Activa' WHERE IdEjecucion = @idEjecucion`
        );
        // La orden ya quedo 'Activa' (lo hace materializarInicioOrden) -- el resto de esta funcion
        // usa EstadoOrden para decidir la rama Pendiente/Activa, asi que se refleja aca tambien.
        EstadoOrden = 'Activa';
      }
    }

    const dtAbierta = await p.request().input('idEjecucion', IdEjecucion).query(`
      SELECT TOP 1 Tipo, Subtipo, HoraInicio FROM SEL_TiempoMuerto
      WHERE id_ejecucion = @idEjecucion AND HoraFin IS NULL ORDER BY id DESC
    `);
    const abierta = dtAbierta.recordset[0];
    const tipoAbierto = abierta ? String(abierta.Tipo || '').toLowerCase() : '';
    const subtipoAbierto = abierta ? String(abierta.Subtipo || '').toLowerCase() : '';

    // Los pasos ya guardados se leen ANTES de mirar los cronometros abiertos (18/09/2026): son los
    // que dicen si lo que esta corriendo pertenece al arranque original o a una ronda de RELEVO
    // (ver marcarRelevoProtocolo), y de eso dependen el rotulo del cronometro y lo que sigue.
    const dtPasos = await p.request().input('idEjecucion', IdEjecucion).query(
      `SELECT Paso, Respuesta, FechaHora FROM SEL_ProtocoloArranque WHERE id_ejecucion = @idEjecucion ORDER BY Id ASC`
    );
    const pasos = dtPasos.recordset;
    const idxRelevo = pasos.map(x => x.Paso).lastIndexOf('relevo');
    const enRelevo = idxRelevo >= 0;

    // La limpieza del relevo corre con la orden ya Activa -- por eso el Estado 'Pendiente' dejo de
    // ser condicion suficiente para reconocer el cronometro del paso 1.
    if (tipoAbierto === 'limpieza' && (EstadoOrden === 'Pendiente' || enRelevo)) {
      return { idOrden: Number(idOrden), paso: 'limpieza', horaInicio: abierta.HoraInicio, relevo: enRelevo };
    }
    if (tipoAbierto === 'alistamiento' && subtipoAbierto === 'arranque') {
      return { idOrden: Number(idOrden), paso: 'alistamiento', horaInicio: abierta.HoraInicio, relevo: enRelevo };
    }

    if (enRelevo) {
      return await protocoloPendienteDeRelevo(p, {
        idOrden, idEjecucion: IdEjecucion, marca: pasos[idxRelevo], pasos: pasos.slice(idxRelevo + 1), abierta
      });
    }

    if (pasos.length === 0) return null; // este protocolo nunca arranco -- boton Iniciar normal

    if (EstadoOrden === 'Pendiente') {
      const quimico = [...pasos].reverse().find(x => x.Paso === 'peligro_quimico');
      if (!quimico || quimico.Respuesta !== 'No') return { idOrden: Number(idOrden), paso: 'peligro_quimico' };
      return { idOrden: Number(idOrden), paso: 'rollo' };
    }

    // PROTOCOLO YA TERMINADO -> no hay nada pendiente. El ultimo paso es 'amperaje' desde el
    // 15/09/2026 y era 'temperatura' antes; cualquiera de los dos significa que la secuencia llego
    // hasta el final.
    //
    // FIX 16/09/2026 (bug real, reportado por el usuario: "¿por que me sale verificacion de
    // bascula si no hay una ejecucion activa?"). Esta salida temprana TIENE que ir antes de
    // preguntar por peso_patron. Sin ella, toda orden que arranco ANTES de que existiera ese paso
    // -- o sea, con alistamiento y temperatura guardados pero sin peso_patron -- cumplia la
    // condicion de "falta la verificacion" y la tableta le abria la ventana al entrar, aunque su
    // protocolo hubiera terminado semanas atras. En produccion eran 4 ordenes, 2 de ellas Activas.
    // Un paso nuevo no puede volver retroactivamente incompleto un protocolo que ya cerro.
    if (pasos.some(x => x.Paso === 'amperaje' || x.Paso === 'temperatura')) return null;

    // Verificacion de bascula del ARRANQUE: va antes del ultimo paso, y por eso se pregunta antes.
    // Se mira solo 'peso_patron' y NO 'peso_patron_periodico' a proposito -- si se miraran las dos,
    // una verificacion periodica de otra orden haria creer que el paso del arranque ya se hizo.
    // Solo cuenta como hecha si quedo CONFORME: una que fallo deja el arranque a medias, que es
    // justo lo que el usuario pidio al elegir que bloquee.
    if (VERIFICACION_BASCULA_ACTIVA
        && pasos.some(x => x.Paso === 'alistamiento')
        && !pasos.some(x => x.Paso === 'peso_patron' && x.Respuesta === 'Conforme')) {
      return { idOrden: Number(idOrden), paso: 'peso_patron' };
    }

    if (pasos.some(x => x.Paso === 'alistamiento')) {
      return { idOrden: Number(idOrden), paso: 'amperaje' };
    }
    return null;
  } catch (err) {
    console.error('No se pudo leer el protocolo de arranque (¿falta ejecutar agregar_protocolo_arranque.sql?):', err.message);
    return null;
  }
}

// ¿En que paso va una ronda de RELEVO del protocolo (18/09/2026)? -- la que se marca cuando otro
// operario (o el mismo, tras cerrar sesion) retoma una ejecucion que ya venia corriendo, ver
// marcarRelevoProtocolo. Se evalua SOLO con los pasos guardados DESPUES de la marca 'relevo': los
// del arranque original estan todos completos, y mirandolos juntos la ronda nueva se daria por
// terminada apenas empieza.
//
// El orden es el mismo del arranque, con dos diferencias:
//   - el rollo no obliga a pitar uno nuevo (ver pasoRolloRelevo en la tableta): el paso se da por
//     resuelto confirmando el que ya estaba montado o montando otro;
//   - la orden ya esta Activa, o sea que su Estado no sirve para deducir nada -- todo sale de los
//     pasos guardados y del tiempo muerto abierto.
async function protocoloPendienteDeRelevo(p, { idOrden, idEjecucion, marca, pasos, abierta }) {
  const base = { idOrden: Number(idOrden), relevo: true };
  const hay = (paso) => pasos.some(x => x.Paso === paso);

  // Cualquier OTRA actividad abierta (un descanso, un mantenimiento) deja el relevo en espera: el
  // paso 1 arranca con POST /pausar, que rechaza una ejecucion que ya esta en pausa -- abrir la
  // ventana aca dejaria al operario dandole a "Reintentar" contra un error que no puede resolver.
  // Al cerrar esa actividad, la siguiente carga de la pagina retoma el relevo donde iba. Los
  // cronometros del propio protocolo (limpieza y alistamiento/arranque) no llegan hasta aca: los
  // atrapa obtenerProtocoloPendiente antes de llamar a esta funcion.
  if (abierta) return null;

  if (!hay('limpieza')) return { ...base, paso: 'inicio' };
  const quimico = [...pasos].reverse().find(x => x.Paso === 'peligro_quimico');
  if (!quimico || quimico.Respuesta !== 'No') return { ...base, paso: 'peligro_quimico' };
  if (!(await rolloResueltoEnRelevo(p, idEjecucion, marca, pasos))) return { ...base, paso: 'rollo' };
  if (!hay('alistamiento')) return { ...base, paso: 'alistamiento_inicio' };
  // Mismo criterio que el arranque: solo cuenta una verificacion CONFORME -- una fallida deja el
  // protocolo a medias, que es justo lo que se pidio al elegir que bloquee.
  if (VERIFICACION_BASCULA_ACTIVA
      && !pasos.some(x => x.Paso === 'peso_patron' && x.Respuesta === 'Conforme')) return { ...base, paso: 'peso_patron' };
  if (!hay('amperaje') && !hay('temperatura')) return { ...base, paso: 'amperaje' };
  return null; // ronda de relevo completa
}

// ¿El paso del rollo de esta ronda de relevo ya quedo resuelto? Son dos caminos:
//   - 'rollo_mismo' -> el operario confirmo que sigue con el rollo que ya estaba montado;
//   - un rollo montado DESPUES de la marca -> pito otro (SEL_RolloEjecucion es la unica tabla que
//     guarda serial + hora del montaje).
// A proposito NO basta con que existan las respuestas del chequeo 4.1/4.2 ('rollo_estado'): esas
// se guardan ANTES de confirmar el rollo, asi que una tableta que se apague justo ahi habria
// dejado el chequeo escrito sin rollo montado y el relevo se saltaria el paso. Si esa tabla no
// existe en esta base no hay con que comprobarlo, y solo ahi se cae a 'rollo_estado' como unica
// pista -- mejor eso que pedir el rollo en un bucle del que no se puede salir.
async function rolloResueltoEnRelevo(p, idEjecucion, marca, pasos) {
  if (pasos.some(x => x.Paso === 'rollo_mismo')) return true;
  try {
    const dt = await p.request().input('idEjecucion', idEjecucion).input('desde', marca.FechaHora).query(`
      SELECT TOP 1 1 AS X FROM SEL_RolloEjecucion
      WHERE id_ejecucion = @idEjecucion AND FechaHora >= @desde
    `);
    return dt.recordset.length > 0;
  } catch (err) {
    console.error('Relevo: no se pudo leer SEL_RolloEjecucion (¿falta ejecutar 07_crear_sel_rolloejecucion.sql?):', err.message);
    return pasos.some(x => x.Paso === 'rollo_estado');
  }
}

// Marca el arranque de una ronda de relevo: una fila 'relevo' en SEL_ProtocoloArranque que
// obtenerProtocoloPendiente usa como linea divisoria. La llama tomar-control-ejecucion. Devuelve
// true si quedo marcada -- y entonces la tableta entra al protocolo en vez de a la vieja pregunta
// de la actividad inicial.
//
// NO se marca si esa orden ya tiene un protocolo pendiente: seria el arranque original a medias (o
// una ronda de relevo anterior sin terminar), y marcar otra vez lo mandaria a repetir desde la
// limpieza pasos que ya estaban hechos. Ese protocolo pendiente sale solo al cargar la pagina, que
// es el comportamiento que ya existia.
//
// En sellado paralelo el protocolo corre sobre la ANCLA del grupo, igual que al Iniciar: es un
// solo proceso fisico (una limpieza, un rollo, un alistamiento) para las 3 referencias.
async function marcarRelevoProtocolo(p, { idOrden, operario, esOtroOperario }) {
  try {
    const ancla = await obtenerAnclaGrupoSellado(p, idOrden);
    const idOrdenProtocolo = ancla ? ancla.IdOrden : idOrden;
    if (await obtenerProtocoloPendiente(p, idOrdenProtocolo)) return false;
    const dtEj = await p.request().input('idOrden', idOrdenProtocolo).query(
      `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion ASC`
    );
    if (dtEj.recordset.length === 0) return false;
    await p.request()
      .input('idEjecucion', dtEj.recordset[0].IdEjecucion)
      .input('idOrden', idOrdenProtocolo)
      .input('operario', operario || null)
      .input('respuesta', esOtroOperario ? 'Retoma' : 'Reanuda')
      .query(`
        INSERT INTO SEL_ProtocoloArranque (id_ejecucion, IdOrden, Operario, Paso, Respuesta)
        VALUES (@idEjecucion, @idOrden, @operario, 'relevo', @respuesta)
      `);
    return true;
  } catch (err) {
    // Sin la tabla no hay protocolo posible -- el relevo se comporta como antes del 18/09/2026
    // (pregunta de actividad inicial y a producir). Se degrada, no se rompe.
    console.error('No se pudo marcar el relevo del protocolo de arranque:', err.message);
    return false;
  }
}

// Interruptor de la verificacion de la bascula contra el elemento patron. Estuvo APAGADA del
// 18/09/2026 al 21/09/2026 a pedido del usuario; desde el 21/09/2026 vuelve a estar ENCENDIDA. Se
// deja como constante para poder apagarla y prenderla otra vez sin tocar nada mas.
//
// En false apaga tres cosas, todas desde aca:
//   - obtenerProtocoloPendiente y protocoloPendienteDeRelevo dejan de exigir 'peso_patron', o sea
//     que un protocolo sin esa verificacion cuenta como completo;
//   - el cronometro de alistamiento pasa derecho al amperaje en vez de abrir la ventana (paso 6);
//   - scriptComandos no arranca vigilarPesoPatron(), asi que nadie sondea la revision periodica de
//     cada 30-40 min. El endpoint /peso-patron-pendiente sigue existiendo y respondiendo.
//
// Prenderla NO reabre protocolos que ya cerraron: obtenerProtocoloPendiente sale antes por el paso
// 'amperaje'/'temperatura' (ver el FIX 16/09/2026 ahi mismo). Las ordenes que quedaron con el
// alistamiento hecho pero SIN amperaje durante el apagon si pasan por la verificacion, que es
// justo lo que se quiere. Y la revision periodica sale en la primera ronda de sondeo de cada
// maquina que ya tenga verificaciones guardadas, porque su ultima quedo pasada de los 30-40 min.
const VERIFICACION_BASCULA_ACTIVA = true;

// Tolerancia con la que se acepta que el peso de la bascula "concuerda" con el elemento patron
// (decision del usuario, 14/09/2026: por porcentaje, +-1%). ES EL UNICO SITIO donde vive ese
// numero: la tableta lo recibe de aca, no lo trae escrito.
//
// Ojo con subirlo o bajarlo a la ligera: el usuario decidio que una verificacion fallida BLOQUEA
// hasta que concuerde, asi que una tolerancia muy estrecha deja la maquina parada y una muy
// holgada deja pasar una bascula descalibrada.
const TOLERANCIA_PESO_PATRON_PCT = 1;

// Peso del elemento patron, en kilogramos (dato del usuario, 14/09/2026: "son 5 kg fijos"; CAMBIADO
// a 1 kg el 24/09/2026 a pedido del usuario -- la pesa que quedo en planta es de 1 kg). Es la
// misma pesa para toda la planta, por eso es una constante y no una tabla.
//
// CAMBIO respecto al diseno inicial: primero se decidio que el operario digitara cuanto pesaba la
// pesa, y eso tenia un hueco -- quien ponia la referencia era la misma persona a la que se estaba
// auditando. Con el valor fijo ese hueco desaparece: el operario solo pone la pesa en la bascula y
// captura; no puede escribir el numero que haga cuadrar la lectura.
//
// Si algun dia cada maquina usa una pesa distinta, esto es lo que hay que convertir en tabla de
// configuracion (maquina -> peso patron), y de paso la tolerancia de arriba.
const PESO_PATRON_KG = 1;

// Cada cuanto vuelve a salir la verificacion durante la produccion (a pedido del usuario:
// "aleatoriamente cada 30-40 minutos").
const PESO_PATRON_MIN_MS = 30 * 60 * 1000;
const PESO_PATRON_MAX_MS = 40 * 60 * 1000;

// Momento en que toca la proxima verificacion, a partir de la ultima que se hizo en esa MAQUINA.
// El intervalo es aleatorio pero DETERMINISTA: sale del Id de la ultima verificacion, no de
// Math.random(). Si se sorteara en cada sondeo, el "faltan 33 minutos" cambiaria cada 5 segundos y
// la ventana saldria antes o despues segun el azar de cada consulta -- con esto, para una misma
// ultima verificacion la hora siguiente es siempre la misma, la calcule quien la calcule.
function proximaVerificacionBascula(idUltima, fechaUltima) {
  const rango = PESO_PATRON_MAX_MS - PESO_PATRON_MIN_MS;
  // Mezcla barata del Id para que ids consecutivos no den intervalos casi iguales.
  const revuelto = ((Number(idUltima) * 2654435761) >>> 0) % rango;
  return new Date(new Date(fechaUltima).getTime() + PESO_PATRON_MIN_MS + revuelto);
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
    // 24/09/2026: la OT tambien queda Suspendida + pausa + movimiento PAUSA (igual que Produccion.vb).
    // El otro camino (terminar el bulto primero) lo hace trg_SEL_Bultos_SuspenderTemporal en la base.
    await suspenderOTDeOrden(p, {
      idOrden,
      usuario: Number(req.session.usuario && req.session.usuario.codigo) || null,
      motivo: 'Suspendida desde Programación (el operario suspendió sin terminar el bulto)'
    });

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

    // Sin la firma de un lider no se finaliza (22/09/2026). La comprobacion va EN EL SERVIDOR y no
    // solo en el modal: Finalizar es un form POST normal, asi que un navegador que no corra el
    // script -- o alguien que mande el POST a mano -- se saltaria un bloqueo que viviera solo en
    // la pantalla. El de la tableta existe igual, pero para explicar, no para proteger.
    // Desde el 25/09/2026 la firma es de la OT actual; sin OT (nunca saco un bulto) no se exige.
    const otParaFirma = await otActualDeOrden(p, idOrden);
    if (otParaFirma) {
      const firma = await obtenerAutorizacionOT(p, otParaFirma);
      if (!firma) {
        throw new Error(
          `La Orden de Trabajo ${otParaFirma} no tiene la autorización de un líder, así que no se puede finalizar. ` +
          `Pídala con el botón "Autorización" de esta pantalla. Pueden autorizarla: ` +
          CARGOS_AUTORIZAN_PEDIDO.map(c => c.nombre).join(', ') + '.'
        );
      }
    }

    // OperarioFinal (distinto del que inicio) -- mismo bloqueo que EjecucionSelladora.vb si el
    // usuario logueado no tiene SISUsuarios.CodigoOperarioPRD configurado.
    await finalizarOrden(p, idOrden, usuario.generadoPor, usuario.codigoOperarioPRD);
    res.redirect(`/selladora/${maquinaCodigo}`);
  } catch (err) {
    res.status(400).send(renderErrorSimple(err.message, maquinaCodigo ? `/selladora/${maquinaCodigo}` : '/'));
  }
});

// ---------------- Ajuste de la cantidad realmente consumida de un rollo ----------------
// Ver AJUSTE_CANTIDAD_CONSUMIDA_ROLLO_18092026.md y sel-inventario-mp.js (ajustarConsumoRollo).
//
// Permiso: requireLogin a secas, igual que las otras correcciones de la tableta ("Volver a pesar",
// corregir bolsas) -- decision del usuario, 18/09/2026 (pregunta abierta 5 del documento). Hoy
// requireAdmin solo tapa herramientas de administracion (tablet fija, simulador de PLC), no
// acciones de produccion.

// Los rollos de la orden con su cantidad original y la registrada hoy, mas la salida real ya
// producida (el piso que el consumo total no puede cruzar). Solo lectura: pinta la ventana.
app.get('/api/selladora/orden/:idOrden/rollos-consumo', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  try {
    const p = await getPool();
    const estado = await obtenerEstadoAjusteConsumo(p, idOrden);
    if (estado.estado !== 'PendienteValidacion') {
      return res.json({
        ok: false,
        error: estado.estado === 'Activa'
          ? 'Esta orden todavía está activa: la máquina sigue consumiendo rollo, así que aún no se sabe cuánto se gastó. Finalícela primero.'
          : 'El consumo solo se puede ajustar mientras la orden está pendiente de validación. Esta ya fue cerrada por el digitador -- el ajuste tiene que hacerse desde el escritorio.'
      });
    }
    res.json({ ok: true, ...estado });
  } catch (err) {
    // Si todavia no se corrio 20260918_agregar_ajuste_consumo_rollo.sql, el fallo es por
    // SEL_AjusteConsumoRollo / SEL_RolloEjecucion.CantidadOriginal -- se dice cual es el script en
    // vez de soltar el error crudo de SQL Server en la cara del operario.
    const falta = /SEL_AjusteConsumoRollo|CantidadOriginal/i.test(err.message || '');
    res.json({
      ok: false,
      error: falta
        ? 'Falta correr el script sql/aplicados/20260918_agregar_ajuste_consumo_rollo.sql contra esta base antes de poder ajustar el consumo.'
        : err.message
    });
  }
});

// Aplica el ajuste. Toda la logica (validaciones, transaccion y los 8 puntos que hay que dejar
// consistentes) vive en sel-inventario-mp.js -- aca solo se traduce el error a JSON.
app.post('/api/selladora/orden/:idOrden/rollo/ajustar-consumo', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const usuario = req.session.usuario;
  try {
    const p = await getPool();
    const resultado = await ajustarConsumoRollo(p, {
      idOrden,
      serial: req.body.serial,
      cantidadNueva: req.body.cantidad,
      motivo: req.body.motivo,
      generadoPor: usuario.generadoPor,
      usuario: usuario.nombre
    });
    res.json(resultado);
  } catch (err) {
    const falta = /SEL_AjusteConsumoRollo|CantidadOriginal/i.test(err.message || '');
    res.json({
      ok: false,
      error: falta
        ? 'Falta correr el script sql/aplicados/20260918_agregar_ajuste_consumo_rollo.sql contra esta base antes de poder ajustar el consumo.'
        : err.message
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Observaciones libres del operario (22/09/2026). Tabla SEL_ObservacionOperario -- ver
// sql/pendientes/20260922_agregar_observaciones_operario.sql para por que es tabla propia y no una
// columna del chequeo de calidad.
//
// Dos puertas de entrada, las dos decididas por el usuario:
//   1. El boton "Observacion" de la pantalla de la orden -- Origen 'Manual'.
//   2. La pregunta al cerrar sesion, cuando el operario tiene una orden Activa a su nombre --
//      Origen 'CierreSesion'. Ver /api/mi-orden-activa y el script scriptObservaciones().
//
// Permiso: requireLogin a secas, igual que el ajuste de consumo y las demas correcciones de la
// tableta. El que escribe es el operario, no un supervisor.

// Guarda una observacion contra una orden. Todo lo que la acompana (ejecucion, maquina, ancla,
// bitacora) se deduce ACA y no se recibe del navegador: la tableta solo manda el texto.
app.post('/api/selladora/orden/:idOrden/observacion', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  const texto = String(req.body.observacion || '').trim();
  if (!texto) return res.json({ ok: false, error: 'La observación está vacía.' });
  // 'CierreSesion' solo lo puede poner el flujo de salida; cualquier otra cosa entra como Manual.
  const origen = req.body.origen === 'CierreSesion' ? 'CierreSesion' : 'Manual';

  try {
    const p = await getPool();
    const dtOrden = await p.request().input('idOrden', idOrden)
      .query(`SELECT Maquina FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
    if (dtOrden.recordset.length === 0) return res.json({ ok: false, error: 'Orden no encontrada.' });
    const maquina = dtOrden.recordset[0].Maquina;

    // Las tres son opcionales: si alguna falla, la observacion se guarda igual. Perder el texto que
    // el operario acaba de escribir porque su maquina no tiene bitacora abierta seria absurdo.
    let idEjecucion = null, idOrdenAncla = null, idBitacora = null;
    try {
      const dtEj = await p.request().input('idOrden', idOrden).query(
        `SELECT TOP 1 IdEjecucion FROM SEL_EjecucionOrden WHERE IdOrden = @idOrden ORDER BY IdEjecucion ASC`
      );
      if (dtEj.recordset.length > 0) idEjecucion = dtEj.recordset[0].IdEjecucion;
    } catch (e) { /* sin ejecucion todavia: la orden puede estar Pendiente */ }
    try {
      const ancla = await obtenerAnclaGrupoSellado(p, idOrden);
      if (ancla) idOrdenAncla = ancla.IdOrden;
    } catch (e) { /* orden suelta, sin grupo de sellado */ }
    try {
      const dtBi = await p.request().input('maquina', maquina).query(
        `SELECT TOP 1 IdBitacora FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL`
      );
      if (dtBi.recordset.length > 0) idBitacora = dtBi.recordset[0].IdBitacora;
    } catch (e) { /* maquina sin bitacora abierta -- ver la nota del script SQL */ }

    await p.request()
      .input('idOrden', idOrden)
      .input('idOrdenAncla', idOrdenAncla)
      .input('idEjecucion', idEjecucion)
      .input('operario', req.session.usuario.codigoOperarioPRD || null)
      .input('maquina', maquina)
      .input('idBitacora', idBitacora)
      .input('observacion', texto.slice(0, 500))
      .input('origen', origen)
      .query(`
        INSERT INTO SEL_ObservacionOperario
          (IdOrden, IdOrdenAncla, id_ejecucion, Operario, Maquina, IdBitacora, Observacion, Origen)
        VALUES
          (@idOrden, @idOrdenAncla, @idEjecucion, @operario, @maquina, @idBitacora, @observacion, @origen)
      `);
    res.json({ ok: true });
  } catch (err) {
    // Mismo criterio que /protocolo/respuesta y /ajustar-consumo: si falta correr el script, se
    // dice cual en vez de soltar el "Invalid object name" crudo en la cara del operario.
    const falta = /Invalid object name|SEL_ObservacionOperario/i.test(err.message || '');
    res.json({
      ok: false,
      error: falta
        ? 'Falta correr el script sql/pendientes/20260922_agregar_observaciones_operario.sql contra esta base.'
        : err.message
    });
  }
});

// La orden Activa a nombre de este operario, o null. La usa el "Cerrar sesión" para saber si vale
// la pena preguntar por una observacion antes de salir.
//
// El criterio es EL MISMO que el UPDATE de /logout (Operario = yo AND Estado = 'Activa'): si ese
// UPDATE va a marcar una ejecucion como PendienteOperador, es exactamente esa la orden por la que
// hay que preguntar. Si los dos criterios se separan, la pregunta sale sobre una orden y el logout
// suelta otra.
app.get('/api/mi-orden-activa', requireLogin, async (req, res) => {
  const operario = req.session.usuario.codigoOperarioPRD;
  if (!operario) return res.json({ ok: true, orden: null });
  try {
    const p = await getPool();
    const dt = await p.request().input('operario', operario).query(`
      SELECT TOP 1 eje.IdOrden, ord.NumeroPedido, ord.Maquina, maq.Nombre AS MaquinaNombre
      FROM SEL_EjecucionOrden eje
      INNER JOIN SEL_OrdenProduccion ord ON ord.IdOrden = eje.IdOrden
      LEFT JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      WHERE eje.Operario = @operario AND eje.Estado = 'Activa'
      ORDER BY eje.IdEjecucion DESC
    `);
    if (dt.recordset.length === 0) return res.json({ ok: true, orden: null });
    const o = dt.recordset[0];
    res.json({
      ok: true,
      orden: {
        idOrden: o.IdOrden,
        pedido: o.NumeroPedido,
        maquina: (o.MaquinaNombre || '').trim() || ('Máquina ' + o.Maquina)
      }
    });
  } catch (err) {
    // Nunca traba la salida: ante cualquier error se responde "no hay orden" y el logout sigue
    // derecho, que es como se comportaba antes de que existiera la pregunta.
    console.error('No se pudo consultar la orden activa del operario:', err.message);
    res.json({ ok: true, orden: null });
  }
});

// ---------------------------------------------------------------------------------------------
// Autorizacion de un pedido por un lider (22/09/2026). Tabla SEL_AutorizacionPedido -- ver
// sql/pendientes/20260922_agregar_autorizacion_pedido.sql.
//
// Regla, tal como la definio el usuario: el operario trabaja normal y SIN login. La firma se puede
// dar en cualquier momento con el boton de la pantalla del pedido, pero sin ella no se puede
//   - FINALIZAR la orden, ni
//   - CERRAR SESION con un pedido activo.
// CAMBIO 25/09/2026 (a pedido del usuario -- "esa autorizacion debe quedar por orden de trabajo"):
// el alcance ya NO es el pedido sino la OT (PRDOrdenesProduccion.OrdenProduccion). Reglas:
//   - Se exige la firma de la OT ACTUAL de la orden (la del bulto mas reciente). Si la orden se
//     retomo otro dia y nacio una OT nueva, la firma de la OT vieja no sirve para la nueva, y la
//     OT vieja sin firma tampoco bloquea.
//   - Mientras la OT no existe (Pendiente, limpieza, alistamiento: nace con el primer bulto) NO se
//     exige firma -- no hay OT que respaldar.
//   - En sellado paralelo las 3 referencias comparten la MISMA OT, asi que una firma sigue
//     cubriendo el grupo entero, igual que antes con el pedido.
// Ver sql/pendientes/20260925_autorizacion_por_ot.sql (columna OrdenProduccion + backfill).

// El NumeroPedido de una orden. Se usa en todas las comprobaciones de abajo.
async function numeroPedidoDeOrden(p, idOrden) {
  const dt = await p.request().input('idOrden', idOrden)
    .query(`SELECT NumeroPedido, Maquina FROM SEL_OrdenProduccion WHERE IdOrden = @idOrden`);
  return dt.recordset.length ? dt.recordset[0] : null;
}

// La OT actual de una orden = la del bulto mas reciente (mismo criterio que SQL_OT_DE_ORDEN de
// sel-inventario-mp.js, que es el que usa suspender/reanudar), o null si todavia no hay OT.
// Una referencia de un grupo paralelo que aun no tiene bultos propios toma la OT de la ancla del
// grupo: es la misma OT que va a recibir en cuanto saque su primer bulto.
async function otActualDeOrden(p, idOrden) {
  const buscar = async (id) => {
    const dt = await p.request().input('idOrden', id).query(`
      SELECT TOP 1 pp.OrdenProduccion
      FROM SEL_Bultos b
      INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b.id_ejecucion
      INNER JOIN PRDProduccion pp ON pp.Detalle = b.serialPadre
      WHERE ej.IdOrden = @idOrden AND pp.OrdenProduccion IS NOT NULL
      ORDER BY b.id DESC
    `);
    return dt.recordset.length ? dt.recordset[0].OrdenProduccion : null;
  };
  const propia = await buscar(idOrden);
  if (propia) return propia;
  const ancla = await obtenerAnclaGrupoSellado(p, idOrden);
  if (ancla && ancla.IdOrden !== idOrden) return buscar(ancla.IdOrden);
  return null;
}

// La firma mas reciente de una OT, o null. Si falta correr el script SQL REVIENTA con un mensaje
// claro en vez de devolver null: un null aca se leeria como "sin firma" y bloquearia Finalizar sin
// explicar por que. El /logout atrapa el error y deja salir (nunca encierra a nadie).
async function obtenerAutorizacionOT(p, ordenProduccion) {
  try {
    const dt = await p.request().input('ot', ordenProduccion).query(`
      SELECT TOP 1 UsuarioAutoriza, NombreAutoriza, CargoAutoriza, FechaHora
      FROM SEL_AutorizacionPedido WHERE OrdenProduccion = @ot ORDER BY FechaHora DESC, Id DESC
    `);
    return dt.recordset.length ? dt.recordset[0] : null;
  } catch (err) {
    console.error('No se pudo leer SEL_AutorizacionPedido:', err.message);
    throw new Error('No se pudo comprobar la autorización de la OT. Falta correr ' +
      'sql/pendientes/20260925_autorizacion_por_ot.sql contra esta base (' + err.message + ').');
  }
}

// Registra la firma. Todo lo que la acompana se deduce aca; la tableta solo manda usuario y clave.
async function guardarAutorizacionPedido(p, { numeroPedido, ordenProduccion, idOrden, maquina, usuarioAutoriza, operarioEnTurno }) {
  let idBitacora = null;
  try {
    const dtBi = await p.request().input('maquina', maquina).query(
      `SELECT TOP 1 IdBitacora FROM SEL_BitacoraTurno WHERE Maquina = @maquina AND HoraCierre IS NULL`
    );
    if (dtBi.recordset.length > 0) idBitacora = dtBi.recordset[0].IdBitacora;
  } catch (e) { /* maquina sin bitacora abierta: la firma vale igual */ }

  await p.request()
    .input('pedido', numeroPedido)
    .input('ot', ordenProduccion)
    .input('idOrden', idOrden)
    .input('maquina', maquina)
    .input('idBitacora', idBitacora)
    .input('usuario', usuarioAutoriza.codigo)
    .input('nombre', (usuarioAutoriza.nombre || '').slice(0, 60))
    .input('idCargo', usuarioAutoriza.idCargo)
    .input('cargo', (usuarioAutoriza.cargo || usuarioAutoriza.cargoAutorizado || '').slice(0, 100))
    .input('operario', operarioEnTurno || null)
    .query(`
      INSERT INTO SEL_AutorizacionPedido
        (NumeroPedido, OrdenProduccion, IdOrden, Maquina, IdBitacora, UsuarioAutoriza, NombreAutoriza,
         IdCargoAutoriza, CargoAutoriza, OperarioEnTurno)
      VALUES
        (@pedido, @ot, @idOrden, @maquina, @idBitacora, @usuario, @nombre, @idCargo, @cargo, @operario)
    `);
}

// Estado de la firma de la OT actual de una orden: si ya esta y quien la dio. sinOT = la orden
// todavia no tiene OT, asi que no hay nada que firmar ni nada que bloquear.
app.get('/api/selladora/orden/:idOrden/autorizacion', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  try {
    const p = await getPool();
    const orden = await numeroPedidoDeOrden(p, idOrden);
    if (!orden) return res.json({ ok: false, error: 'Orden no encontrada.' });
    const ot = await otActualDeOrden(p, idOrden);
    const firma = ot ? await obtenerAutorizacionOT(p, ot) : null;
    res.json({
      ok: true,
      pedido: orden.NumeroPedido,
      ot,
      sinOT: !ot,
      autorizado: !!firma,
      firma: firma ? {
        usuario: firma.UsuarioAutoriza,
        nombre: firma.NombreAutoriza,
        cargo: firma.CargoAutoriza,
        fecha: firma.FechaHora
      } : null,
      // La tableta pinta con esto la lista de quien puede firmar, sin una segunda copia que se
      // pueda desincronizar de auth.js.
      cargosPermitidos: CARGOS_AUTORIZAN_PEDIDO.map(c => c.nombre)
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// La firma en si: valida usuario+clave+cargo y la guarda.
app.post('/api/selladora/orden/:idOrden/autorizacion', requireLogin, async (req, res) => {
  const idOrden = Number(req.params.idOrden);
  try {
    const p = await getPool();
    const orden = await numeroPedidoDeOrden(p, idOrden);
    if (!orden) return res.json({ ok: false, error: 'Orden no encontrada.' });
    const ot = await otActualDeOrden(p, idOrden);
    if (!ot) {
      return res.json({
        ok: false,
        error: 'Esta orden todavía no tiene Orden de Trabajo (nace con el primer bulto), así que aún no hay nada que autorizar.'
      });
    }

    const intento = await validarAutorizadorPedido(p, req.body.codigo, req.body.password);
    if (!intento.ok) return res.json({ ok: false, error: intento.error });

    await guardarAutorizacionPedido(p, {
      numeroPedido: orden.NumeroPedido,
      ordenProduccion: ot,
      idOrden,
      maquina: orden.Maquina,
      usuarioAutoriza: intento.usuario,
      operarioEnTurno: req.session.usuario.codigoOperarioPRD || null
    });

    res.json({
      ok: true,
      pedido: orden.NumeroPedido,
      ot,
      firma: { nombre: intento.usuario.nombre, cargo: intento.usuario.cargo }
    });
  } catch (err) {
    const falta = /Invalid object name|Invalid column name|SEL_AutorizacionPedido/i.test(err.message || '');
    res.json({
      ok: false,
      error: falta
        ? 'Falta correr los scripts sql/pendientes/20260922_agregar_autorizacion_pedido.sql y ' +
          '20260925_autorizacion_por_ot.sql contra esta base.'
        : err.message
    });
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

  // FIX 24/09/2026: cierre de bitacoras al terminar su turno (ver cerrarBitacorasPorFinTurno en
  // sel-inventario-mp.js). Una vez al arrancar (cierra las que quedaron vencidas mientras el
  // servidor estaba apagado) y luego cada 5 minutos.
  const revisarFinTurno = async () => {
    try { await cerrarBitacorasPorFinTurno(await getPool()); } catch (err) { /* ya se registro adentro */ }
  };
  revisarFinTurno();
  setInterval(revisarFinTurno, 5 * 60 * 1000);
});
