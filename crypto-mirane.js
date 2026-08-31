// Replica exacta de Encriptar/Desencriptar en Source/Librerias/General.vb (usada por
// BaseDatos.vb para el Password del .ini de Mirane) -- TripleDES, clave "MERLIN" y
// IV "LINMER" fijos (rellenados con espacios a 16/8 bytes), CBC + PKCS7 (default de
// TripleDESCryptoServiceProvider). El texto plano usa Encoding.Default (ANSI) en .NET.
//
// FIX 31/08/2026 (bug real encontrado -- "bad decrypt" al hacer login con algunos usuarios,
// ej. P.CESAR, aunque la misma clave SI funcionaba desde el escritorio de Mirane): en Windows
// en español, Encoding.Default de .NET Framework es Windows-1252 (CP1252), NO Latin-1/
// ISO-8859-1 puro -- difieren justo en los bytes 0x80-0x9F (CP1252 los mapea a caracteres
// tipograficos como €/comillas curvas, con puntos Unicode > 0xFF; Latin-1 los deja como
// codigos de control crudos, identicos al byte). SISUsuarios.Clave es texto cifrado (bytes
// practicamente aleatorios) -- con ~65% de probabilidad CUALQUIER contraseña cifrada tiene al
// menos un byte en ese rango. Cuando eso pasa, `Buffer.from(str, 'latin1')` trunca mal ese
// caracter (se queda solo con los 8 bits bajos de un codepoint > 0xFF) y corrompe el bloque
// cifrado -- TripleDES con un bloque corrupto tira exactamente "bad decrypt". Se usa
// iconv-lite (codepage 'win1252') para el round-trip byte-a-byte correcto, tanto al leer el
// cifrado desde la BD como al reconstruir la contraseña en claro.
const crypto = require('crypto');
const iconv = require('iconv-lite');

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
// FIX 31/08/2026: iconv-lite ('win1252') en vez de Buffer.from(..., 'latin1') en los dos
// extremos -- ver nota arriba, evita corromper bytes 0x80-0x9F del cifrado (entrada) o de la
// contraseña reconstruida (salida).
function desencriptarDesdeBD(textoCrudo) {
  if (!textoCrudo) return '';
  const decipher = crypto.createDecipheriv('des-ede-cbc', KEY, IV);
  const datos = iconv.encode(textoCrudo, 'win1252');
  const claro = Buffer.concat([decipher.update(datos), decipher.final()]);
  return iconv.decode(claro, 'win1252');
}

module.exports = { encriptar, desencriptar, desencriptarDesdeBD };
