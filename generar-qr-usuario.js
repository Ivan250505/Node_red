// Genera (o regenera) el CodigoQR de un operario en SISUsuarios y guarda el PNG
// del QR para imprimirlo. Uso:
//   node generar-qr-usuario.js <CodigoUsuario>
//
// El token es aleatorio y no tiene relacion con la contrasena de login (Clave) --
// es solo un identificador para el flujo de marcacion en /marcar.

require('dotenv').config();
const crypto = require('crypto');
const sql = require('mssql');
const QRCode = require('qrcode');
const { desencriptar } = require('./crypto-mirane');

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

async function main() {
  const codigoUsuario = process.argv[2];
  if (!codigoUsuario) {
    console.error('Uso: node generar-qr-usuario.js <CodigoUsuario>');
    process.exit(1);
  }

  const token = crypto.randomBytes(16).toString('hex'); // 32 caracteres, cabe en varchar(50)

  const pool = await sql.connect(dbConfig);
  const result = await pool.request()
    .input('codigo', codigoUsuario)
    .input('token', token)
    .query(`
      UPDATE SISUsuarios SET CodigoQR = @token WHERE Codigo = @codigo;
      SELECT Nombre FROM SISUsuarios WHERE Codigo = @codigo;
    `);

  if (result.recordset.length === 0) {
    console.error(`No existe ningun usuario con Codigo = ${codigoUsuario}`);
    await pool.close();
    process.exit(1);
  }

  const nombre = result.recordset[0].Nombre || codigoUsuario;
  const archivoPng = `qr-${codigoUsuario}.png`;
  await QRCode.toFile(archivoPng, token, { width: 400 });

  console.log(`Listo: ${nombre} (Codigo ${codigoUsuario})`);
  console.log(`QR guardado en ${archivoPng}`);

  await pool.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
