require('dotenv').config();
const express = require('express');
const session = require('express-session');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');
const { validarLogin, requireLogin } = require('./auth');

const dbConfig = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: desencriptar(process.env.DB_PASSWORD_ENC),
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
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
  </style>
</head>
<body>
  <div class="caja">
    <img class="logo-login" src="/logo-carlixplast.png" alt="Carlixplast">
    <div class="sub">Bultos — Selladora · Ingresa con tu usuario de Mirane</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="post" action="/login">
      <label>Usuario</label>
      <input type="text" name="codigo" autocapitalize="none" autocomplete="username" required autofocus>
      <label>Contraseña</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Ingresar</button>
    </form>
  </div>
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
      background: var(--gris-fondo);
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
      display: flex; justify-content: flex-start; align-items: center;
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

function renderDashboard(maquinas, usuario, error) {
  const tarjetas = maquinas.map(m => `
    <a class="maquina-card" href="/selladora/${m.Codigo}">
      <div class="maquina-top">
        <span class="maquina-nombre">🏭 ${m.Nombre}</span>
        <span class="maquina-chevron">›</span>
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
    <div class="usuario-bar">
      <span>👤 ${usuario}</span>
      <a class="salir" href="/logout">Salir</a>
    </div>
    <div class="sub">Máquinas con producción activa en este momento</div>
  </header>
  <main>
    ${error ? `<div class="error">Error: ${error}</div>` : ''}
    ${contenido}
  </main>
</body>
</html>`;
}

function renderPage(rows, error, usuario, maquinaNombre, maquinaCodigo, ejecucion) {
  const tarjetas = rows.map(r => `
    <div class="card">
      <div class="card-top">
        <div>
          <span class="bulto-num">Bulto ${r.num_bulto}</span>
          <div class="rollo-serial">Rollo ${ejecucion ? (ejecucion.SerialRollo ?? '—') : '—'}</div>
        </div>
        ${badgeEstado(r.estado)}
      </div>
      <div class="card-grid">
        <div class="full"><span class="label">Elemento</span><span class="valor">${r.ElementoRef}</span></div>
        <div><span class="label">Cant. Total (KG)</span><span class="valor">${r.CantidadTotal ?? '—'}</span></div>
        <div><span class="label">Golpes por minuto</span><span class="valor">${r.Golpes ?? '—'}</span></div>
        <div><span class="label">Potencia (KW)</span><span class="valor">${r.Potencia ?? '—'}</span></div>
        <div><span class="label">Inicio del bulto</span><span class="valor">${r.HoraInicio ?? '—'}</span></div>
        <div><span class="label">Fin del bulto</span><span class="valor">${r.HoraFin ?? '—'}</span></div>
        <div class="full"><span class="label">Serial</span><span class="valor serial">${r.serialPadre ?? '—'}</span></div>
      </div>
    </div>`).join('');

  const contenido = rows.length
    ? `<div class="grid">${tarjetas}</div>`
    : `<div class="vacio">No hay bultos activos ni temporales en este momento.</div>`;

  const bloqueEjecucion = ejecucion ? `
    <div class="ejecucion-box">
      <h2>🧵 Rollo en curso — Pedido ${ejecucion.NumeroPedido || '—'}</h2>
      <div class="ejecucion-grid">
        <div><span class="label">Elemento</span><span class="valor">${ejecucion.Elemento}</span></div>
        <div><span class="label">Serial rollo</span><span class="valor serial">${ejecucion.SerialRollo ?? '—'}</span></div>
        <div><span class="label">Peso neto</span><span class="valor">${ejecucion.PesoRolloNeto ?? '—'}</span></div>
        <div><span class="label">Inicio del rollo</span><span class="valor">${ejecucion.HoraInicioReal ?? '—'}</span></div>
        <div><span class="label">Fin del rollo</span><span class="valor">${ejecucion.HoraFinReal ?? '—'}</span></div>
      </div>
    </div>` : `<div class="error">Esta selladora no tiene ningún rollo escaneado todavía en su orden activa.</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bultos — ${maquinaNombre}</title>
  <style>${estilosBase()}</style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="logo-wrap"><img class="logo" src="/logo-carlixplast.png" alt="Carlixplast"></div>
    </div>
    <div class="usuario-bar">
      <span>👤 ${usuario}</span>
      <a class="salir" href="/logout">Salir</a>
    </div>
    <a class="volver" href="/">‹ Selladoras</a>
    <h1>🏭 ${maquinaNombre}</h1>
    <div class="sub">Ejecución activa y sus bultos</div>
  </header>
  <main>
    <div class="barra">
      <span class="actualizado">Actualizado: ${new Date().toLocaleTimeString('es-CO')}</span>
      <form method="get" action="/selladora/${maquinaCodigo}"><button type="submit">↻ Actualizar</button></form>
    </div>
    ${error ? `<div class="error">Error: ${error}</div>` : ''}
    ${bloqueEjecucion}
    ${contenido}
  </main>
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
    res.redirect('/');
  } catch (err) {
    res.send(renderLogin('Error al validar: ' + err.message));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Solo selladoras con una orden 'Activa' en este momento (mismo criterio de "en curso"
// que ya usa EjecucionSelladora.vb: como máximo una orden Activa por máquina).
app.get('/', requireLogin, async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(`
      SELECT maq.Codigo, maq.Nombre, ord.NumeroPedido, ie.Referencia AS Elemento,
             (SELECT COUNT(*) FROM SEL_Bultos b
               WHERE b.id_maquina = maq.Codigo AND b.estado IN ('Activo', 'Temporal')) AS BultosActivos
      FROM SEL_OrdenProduccion ord
      INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
      INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
      WHERE ord.Estado = 'Activa' AND maq.Tipo = 'SELLADORA'
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

    // Orden activa de esta máquina + su ejecución (rollo) más reciente -- mismo patrón
    // "latest IdEjecucion por IdOrden" que EjecucionSelladora.vb:CargarGrid.
    const ejec = await p.request()
      .input('codigo', codigo)
      .query(`
        SELECT maq.Nombre AS MaquinaNombre, ord.NumeroPedido, ie.Referencia AS Elemento,
               ej.IdEjecucion,
               ej.SerialRolloEntrada AS SerialRollo, ej.PesoRolloNeto,
               FORMAT(ej.HoraInicioReal, 'dd/MM/yyyy HH:mm') AS HoraInicioReal,
               FORMAT(ej.HoraFinReal, 'dd/MM/yyyy HH:mm') AS HoraFinReal
        FROM SEL_OrdenProduccion ord
        INNER JOIN PRDMaquinas maq ON maq.Codigo = ord.Maquina
        INNER JOIN INVElementos ie ON ie.Codigo = ord.Elemento
        LEFT JOIN (
          SELECT IdOrden, MAX(IdEjecucion) AS MaxId FROM SEL_EjecucionOrden GROUP BY IdOrden
        ) latest ON latest.IdOrden = ord.IdOrden
        LEFT JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = latest.MaxId
        WHERE ord.Maquina = @codigo AND ord.Estado = 'Activa'
      `);

    if (ejec.recordset.length === 0) {
      const maquina = await p.request()
        .input('codigo', codigo)
        .query(`SELECT Nombre FROM PRDMaquinas WHERE Codigo = @codigo`);
      const nombre = maquina.recordset[0] ? maquina.recordset[0].Nombre : 'Selladora';
      return res.send(renderPage([], null, req.session.usuario.nombre, nombre, codigo, null));
    }

    const info = ejec.recordset[0];
    let bultos = [];
    if (info.IdEjecucion) {
      const result = await p.request()
        .input('idEjecucion', info.IdEjecucion)
        .query(`
          SELECT b.id, b.num_bulto, b.estado, b.CantidadTotal, b.Golpes, b.Potencia,
                 FORMAT(b.HoraInicio, 'dd/MM/yyyy HH:mm:ss') AS HoraInicio,
                 FORMAT(b.HoraFin, 'dd/MM/yyyy HH:mm:ss') AS HoraFin,
                 b.serialPadre,
                 ISNULL(ie.Referencia, CAST(b.refsalida AS varchar)) AS ElementoRef
          FROM SEL_Bultos b
          LEFT JOIN INVElementos ie ON ie.Codigo = b.refsalida
          WHERE b.id_ejecucion = @idEjecucion
          ORDER BY b.id DESC
        `);
      bultos = result.recordset;
    }

    res.send(renderPage(bultos, null, req.session.usuario.nombre, info.MaquinaNombre, codigo, info.IdEjecucion ? info : null));
  } catch (err) {
    res.status(500).send(renderPage([], err.message, req.session.usuario.nombre, 'Selladora', codigo, null));
  }
});

const webPort = Number(process.env.WEB_PORT || 3000);
app.listen(webPort, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${webPort} (y en la IP de este PC en la red local)`);
});
