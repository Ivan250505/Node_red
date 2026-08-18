# Documentación — Bultos Web

App mínima en Node.js/Express para ver el estado de `SEL_Bultos` (bultos activos por selladora) desde una tablet o celular conectado a la misma red local del PC donde corre el servidor. Se conecta directamente a la base de datos de Mirane/Carlixplast (SQL Server).

## 1. Requisitos

- Node.js instalado en el PC que va a hacer de servidor (recomendado v18 o superior).
- Acceso de red desde ese PC hacia el SQL Server de Mirane (`DB_SERVER`/`DB_PORT` del `.env`).
- El PC y el celular/tablet conectados a la **misma red local** (mismo WiFi, no "red de invitados" separada).

## 2. Estructura de archivos

| Archivo | Para qué sirve |
|---|---|
| `server.js` | Servidor Express: rutas, login, consultas SQL y HTML del dashboard/detalle. |
| `auth.js` | Valida el login contra la tabla `SISUsuarios` (código + contraseña). |
| `crypto-mirane.js` | Cifrado/descifrado TripleDES compatible con Mirane (clave `MERLIN`/IV `LINMER`), igual al de `General.vb`. |
| `encriptar-password.js` | Script de consola para generar el valor cifrado que va en `DB_PASSWORD_ENC`. |
| `.env` | Configuración real (servidor de BD, puerto web, secreto de sesión). **No se sube a git.** |
| `.env.example` | Plantilla de `.env` sin datos sensibles. |
| `public/` | Archivos estáticos servidos tal cual (logo). |
| `package.json` | Dependencias y script `start`. |

## 3. Librerías que hay que tener instaladas

Están declaradas en `package.json` → `dependencies`:

- `express` — servidor web / rutas.
- `express-session` — sesión de login (cookie), dura 8 horas.
- `mssql` — driver de conexión a SQL Server.
- `dotenv` — carga las variables del `.env`.

Para instalarlas (o reinstalarlas si se borra `node_modules`):

```powershell
cd "C:\Users\Lenovo\Documents\Trabajo\Node"
npm install
```

## 4. Configuración (`.env`)

Copiar `.env.example` a `.env` (si no existe) y completar:

```
DB_SERVER=<ip o nombre del SQL Server de Mirane>
DB_PORT=<puerto del SQL Server>
DB_DATABASE=<nombre de la base, ej. carlixplastPrueba>
DB_USER=<usuario de SQL>
DB_PASSWORD_ENC=<contraseña cifrada, ver punto 5>
WEB_PORT=3000
SESSION_SECRET=<texto largo y aleatorio, solo para firmar la cookie>
```

`.env` está en `.gitignore`, así que nunca se comparte por git.

## 5. Cómo cifrar la contraseña de la base de datos

La contraseña de SQL **no se guarda en texto plano** en `.env`. Se genera con:

```powershell
node encriptar-password.js "elPasswordReal"
```

Esto imprime un texto en Base64 en la consola. Ese valor se pega tal cual en `DB_PASSWORD_ENC` dentro del `.env`.

## 6. Cómo iniciar el servidor

Desde la carpeta del proyecto:

```powershell
npm start
```

(equivalente a `node server.js`). En consola debería aparecer:

```
Servidor corriendo en http://localhost:3000 (y en la IP de este PC en la red local)
```

El servidor escucha en `0.0.0.0`, es decir en todas las interfaces de red del PC, no solo en `localhost` — por eso es alcanzable desde otros equipos de la red.

## 7. Cómo acceder desde otro celular/tablet (red local)

**Paso 1 — Averiguar la IP del PC servidor.** En ese PC, abrir `cmd` o PowerShell y ejecutar:

```powershell
ipconfig
```

Buscar el adaptador que está usando esa red (normalmente **"Adaptador de LAN inalámbrica Wi-Fi"** o **"Ethernet"**) y anotar el valor de **"Dirección IPv4"**, por ejemplo `192.168.1.50`.

**Paso 2 — Entrar desde el celular/tablet.** Con el dispositivo conectado a la **misma red WiFi**, abrir el navegador e ir a:

```
http://192.168.1.50:3000
```

(cambiando `192.168.1.50` por la IP real que dio `ipconfig`, y `3000` por el `WEB_PORT` configurado en `.env`).

### Si no conecta: Firewall de Windows

Windows puede estar bloqueando el puerto para conexiones entrantes de la red. Para abrirlo (PowerShell **como administrador**, solo hace falta una vez):

```powershell
New-NetFirewallRule -DisplayName "Bultos Web" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

(ajustar `3000` si se cambió `WEB_PORT`).

## 8. Problemas comunes

- **No abre desde el celular pero sí desde el PC (`localhost`)**: casi siempre es el Firewall (ver arriba) o que el celular está en otra red (ej. datos móviles en vez de WiFi, o WiFi de invitados aislado).
- **La IP cambia cada vez que se reinicia el router/PC**: normal si el router no asigna IP fija (DHCP). Repetir el `ipconfig` cuando deje de funcionar la URL guardada.
- **Error al validar login / error de conexión a la base**: revisar `DB_SERVER`, `DB_PORT`, `DB_USER` y que `DB_PASSWORD_ENC` se haya generado bien con `encriptar-password.js`. El error concreto se muestra en la pantalla de login.
- **La sesión se cierra sola**: la cookie dura 8 horas (`maxAge` en `server.js`), pensado para un turno de trabajo.
