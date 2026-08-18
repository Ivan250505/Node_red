// Uso: node encriptar-password.js "elPasswordReal"
// Imprime el valor cifrado para pegar en .env como DB_PASSWORD_ENC -- así el .env nunca
// tiene la contraseña en texto plano, igual que Mirane no la guarda en texto plano en su .ini.
const { encriptar } = require('./crypto-mirane');

const password = process.argv[2];
if (!password) {
  console.error('Uso: node encriptar-password.js "elPasswordReal"');
  process.exit(1);
}
console.log(encriptar(password));
