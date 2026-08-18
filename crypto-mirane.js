// Replica exacta de Encriptar/Desencriptar en Source/Librerias/General.vb (usada por
// BaseDatos.vb para el Password del .ini de Mirane) -- TripleDES, clave "MERLIN" y
// IV "LINMER" fijos (rellenados con espacios a 16/8 bytes), CBC + PKCS7 (default de
// TripleDESCryptoServiceProvider). El texto plano usa Encoding.Default (ANSI) en .NET,
// que para contraseñas ASCII normales equivale a latin1 -- si la contraseña real tiene
// tildes/ñ u otro caracter fuera de ASCII, verificar contra el .ini real antes de confiar.

const crypto = require('crypto');

const KEY = Buffer.from('MERLIN'.padEnd(16, ' '), 'latin1');
const IV = Buffer.from('LINMER'.padEnd(8, ' '), 'latin1');

// El cifrado son bytes binarios -- para guardarlo/copiarlo como texto (en .env, en la
// consola) se representa en Base64, no como el string "crudo" que produce .NET
// internamente (ese se corrompe al pasar por consola/portapapeles/archivos en UTF-8).
function encriptar(texto) {
  if (!texto) return '';
  const cipher = crypto.createCipheriv('des-ede-cbc', KEY, IV);
  const datos = Buffer.from(texto, 'latin1');
  const cifrado = Buffer.concat([cipher.update(datos), cipher.final()]);
  return cifrado.toString('base64');
}

function desencriptar(base64Cifrado) {
  if (!base64Cifrado) return '';
  const decipher = crypto.createDecipheriv('des-ede-cbc', KEY, IV);
  const datos = Buffer.from(base64Cifrado, 'base64');
  const claro = Buffer.concat([decipher.update(datos), decipher.final()]);
  return claro.toString('latin1');
}

// Para descifrar un valor leido directo de una columna de SQL Server (ej. SISUsuarios.Clave)
// -- ahi el driver ya entrega el string "crudo" (mismo formato que produce .NET internamente,
// Encoding.Default.GetString), no Base64. No usar desencriptar() con estos valores.
function desencriptarDesdeBD(textoCrudo) {
  if (!textoCrudo) return '';
  const decipher = crypto.createDecipheriv('des-ede-cbc', KEY, IV);
  const datos = Buffer.from(textoCrudo, 'latin1');
  const claro = Buffer.concat([decipher.update(datos), decipher.final()]);
  return claro.toString('latin1');
}

module.exports = { encriptar, desencriptar, desencriptarDesdeBD };
