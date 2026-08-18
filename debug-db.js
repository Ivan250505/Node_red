// Uso: node debug-db.js
// Prueba la conexion a la base de datos por fuera de la app web, en 2 pasos:
//   1) TCP: puede esta PC alcanzar DB_SERVER:DB_PORT (red/firewall)
//   2) SQL: con ese TCP abierto, login+conexion real con mssql (credenciales/datos)
// Sirve para saber en cual de los 2 pasos esta fallando sin tener que loguearse en la web.

require('dotenv').config();
const net = require('net');
const sql = require('mssql');
const { desencriptar } = require('./crypto-mirane');

const server = process.env.DB_SERVER;
const port = Number(process.env.DB_PORT || 1433);
const database = process.env.DB_DATABASE;
const user = process.env.DB_USER;

console.log('--- Config leida del .env ---');
console.log('DB_SERVER  :', JSON.stringify(server));
console.log('DB_PORT    :', port);
console.log('DB_DATABASE:', JSON.stringify(database));
console.log('DB_USER    :', JSON.stringify(user));
console.log('DB_PASSWORD_ENC presente:', !!process.env.DB_PASSWORD_ENC);
console.log('Carpeta actual (cwd)    :', process.cwd());
console.log('');

if (!server) {
  console.error('X DB_SERVER esta vacio/indefinido. Revisa que el .env este en esta misma carpeta (' + process.cwd() + ') y que el proceso se haya reiniciado despues de editarlo.');
  process.exit(1);
}

function testTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, detalle) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, detalle });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'conectado'));
    socket.once('timeout', () => finish(false, `timeout despues de ${timeoutMs}ms`));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(port, host);
  });
}

async function main() {
  console.log(`--- Paso 1: TCP a ${server}:${port} ---`);
  const tcp = await testTcp(server, port, 5000);
  if (!tcp.ok) {
    console.error(`X No se pudo abrir conexion TCP: ${tcp.detalle}`);
    console.error('  Esto es de red, no de la app: firewall, VPN, puerto cerrado en el SQL Server, o esta PC no tiene salida hacia esa IP/puerto.');
    process.exit(1);
  }
  console.log('OK TCP abierto.\n');

  console.log('--- Paso 2: login SQL ---');
  let password;
  try {
    password = desencriptar(process.env.DB_PASSWORD_ENC);
  } catch (err) {
    console.error('X No se pudo desencriptar DB_PASSWORD_ENC:', err.message);
    process.exit(1);
  }

  const dbConfig = {
    server,
    port,
    database,
    user,
    password,
    options: { encrypt: false, trustServerCertificate: true }
  };

  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query('SELECT 1 AS ok');
    console.log('OK Conexion y login SQL correctos. Resultado de prueba:', result.recordset);
    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error('X Fallo el login/conexion SQL:', err.message);
    console.error('  Si el TCP del paso 1 abrio bien, esto es casi siempre: usuario/clave incorrectos, DB_DATABASE mal escrita, o la clave no coincide (revisa que DB_PASSWORD_ENC se haya generado con la clave real actual).');
    process.exit(1);
  }
}

main();
