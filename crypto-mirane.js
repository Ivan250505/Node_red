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

// Para descifrar el Clave de SISUsuarios. Recibe el valor ya como Buffer (ver FIX 05/09/2026
// mas abajo) o, por compatibilidad, como el string "crudo" que entregaba el driver para una
// columna VARCHAR.
// FIX 31/08/2026: iconv-lite ('win1252') en vez de Buffer.from(..., 'latin1') en los dos
// extremos -- evita corromper bytes 0x80-0x9F del cifrado (entrada) o de la contraseña
// reconstruida (salida), que es lo que hace Encoding.Default (CP1252) en .NET.
// FIX 05/09/2026 (bug real -- "bad decrypt" con J.GAMBOAF/J.MANTILLAD/A.ROJASR, aunque el
// Clave guardado en la BD es correcto): windows-1252 tiene 5 bytes SIN DEFINIR (0x81, 0x8D,
// 0x8F, 0x90, 0x9D). El estandar WHATWG que implementa iconv-lite (y que tedious usa para
// decodificar columnas VARCHAR) mapea los 5 a U+FFFD (caracter de reemplazo) -- una vez ahi,
// el byte original se PIERDE, y volver a codificar a 'win1252' no lo puede recuperar (los 5
// dan 0x9D de vuelta, sin importar cual era el original). Esto rompe justo esos ~2% de claves
// cuyo cifrado (bytes practicamente aleatorios) contiene alguno de esos 5 bytes -- confirmado
// con los 3 usuarios de arriba, cada uno con un byte distinto de esos 5 en su Clave.
// .NET/Windows en cambio SI puede leer esos 5 bytes sin perdida (CP1252 real de Windows los
// trata como pass-through), por eso desde el escritorio de Mirane siempre funcionaron.
// Solucion real: no pasar el cifrado por NINGUN decode de texto -- pedirlo como VARBINARY en
// el SELECT (ver auth.js) para que tedious lo entregue como Buffer crudo, sin perdida posible.
// Se deja el iconv-lite como fallback SOLO por si algun llamador viejo todavia pasa un string.
function desencriptarDesdeBD(claveCruda) {
  if (!claveCruda || (typeof claveCruda === 'string' && claveCruda.length === 0)) return '';
  const datos = Buffer.isBuffer(claveCruda) ? claveCruda : iconv.encode(claveCruda, 'win1252');
  const decipher = crypto.createDecipheriv('des-ede-cbc', KEY, IV);
  const claro = Buffer.concat([decipher.update(datos), decipher.final()]);
  return iconv.decode(claro, 'win1252');
}

module.exports = { encriptar, desencriptar, desencriptarDesdeBD };
