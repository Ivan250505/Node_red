# Migrar/integrar esto con Node-RED — qué habría que cambiar

Este documento parte de la app actual (Express, ver `DOCUMENTACION.md`) y detalla qué cambiaría si en vez de correr `node server.js` se quisiera montar lo mismo (o integrarlo) dentro de Node-RED. **No es un simple "instalar y listo": es repartir la lógica de `server.js`/`auth.js`/`crypto-mirane.js` en flujos**, porque Node-RED no trae sesiones de login ni el cifrado TripleDES que usa Mirane de forma nativa.

## Resumen de lo que cambia por archivo

| Archivo actual | Qué pasa con él en Node-RED |
|---|---|
| `server.js` | Se reparte en varios flujos: nodos `http in` / `http response` reemplazan cada `app.get`/`app.post`, y `function` nodes arman el mismo HTML que ya generan `renderLogin`, `renderDashboard`, `renderPage`. |
| `auth.js` | La consulta a `SISUsuarios` pasa a un nodo de SQL Server; la comparación de usuario/estado/contraseña pasa a un `function` node. |
| `crypto-mirane.js` | No hay nodo comunitario para TripleDES con clave `MERLIN`/IV `LINMER` — se pega el mismo código dentro de un `function` node (o se referencia como módulo externo, ver punto 4). |
| `encriptar-password.js` | No depende de Express, **no cambia**: se sigue usando desde consola tal cual para generar la contraseña cifrada. |
| `.env` | Node-RED no carga `.env` solo. Las variables se mueven a `settings.js` (con `dotenv` ahí) o a un nodo de configuración/credenciales del flujo. |
| `public/logo-carlixplast.png` | Se sirve con la opción `httpStatic` de `settings.js` en vez de `express.static('public')`. |

## Puntos concretos a resolver

### 1. Conexión a SQL Server
Instalar un nodo de SQL Server para Node-RED, por ejemplo:

```powershell
npm install node-red-contrib-mssql-plus
```

y configurar ahí lo mismo que hoy está en `dbConfig` de `server.js` (`server`, `port`, `database`, `user`, `password`, `encrypt: false`, `trustServerCertificate: true`).

### 2. Sesión de login
Express trae `express-session` incorporado; Node-RED no. Opciones:
- Instalar un nodo/middleware de sesión para Node-RED (ej. `node-red-contrib-express-session` o similar), o
- Manejarlo a mano: al hacer login, generar un token, guardarlo en el **context store** (`flow`/`global` context) junto con el usuario y un timestamp de expiración (8h, igual que hoy), mandarlo como cookie en la respuesta, y en cada request leer la cookie y validar contra ese context store. Esto es más trabajo que hoy, donde `express-session` ya lo resuelve solo.

### 3. HTML del dashboard
El diseño actual (tarjetas, badges, CSS embebido) está armado con template strings en `server.js`. Dos caminos:
- **Mantenerlo igual**: copiar esas mismas funciones (`estilosBase`, `renderDashboard`, `renderPage`, `renderLogin`) dentro de `function` nodes que arman el string y lo devuelven con `http response`. Es lo más directo y no obliga a rediseñar nada.
- **Pasarlo a `node-red-dashboard`** (`ui_template`/`ui_group`): da un panel de administración prearmado, pero implica rehacer el diseño actual (tarjetas, colores, badges) con los componentes propios del dashboard — cambio grande, solo tiene sentido si de verdad se quiere ese estilo de panel en vez del actual.

Recomendado: la primera opción, para no perder el diseño ya hecho.

### 4. El cifrado TripleDES de `crypto-mirane.js`
Usa el módulo nativo `crypto` de Node, así que funciona igual dentro de un `function` node. Solo hay que habilitar que los function nodes puedan hacer `require` de módulos, en `settings.js`:

```js
functionExternalModules: true
```

y dentro del `function` node:

```js
const crypto = global.get('crypto') || require('crypto');
```

o directamente pegar las funciones `encriptar`/`desencriptar`/`desencriptarDesdeBD` completas dentro del `function` node (más simple, sin depender de configuración extra).

### 5. Variables de entorno
En vez de que `dotenv` las cargue automáticamente al arrancar `server.js`, hay que:
- Cargarlas en `settings.js` (que sí corre con Node) con `require('dotenv').config()`, y
- Exponerlas a los flujos vía `functionGlobalContext` en ese mismo `settings.js`, para poder leerlas desde los `function` nodes con `global.get(...)`.

### 6. Cómo se inicia y cómo se accede desde el celular
Ya no se ejecuta `node server.js`; se inicia Node-RED (`node-red`, o como servicio/PM2 si se quiere que arranque solo). El acceso desde el celular/tablet en red local **funciona igual que hoy**: mismo procedimiento de `ipconfig` para sacar la IP del PC (ver `DOCUMENTACION.md`), pero apuntando al puerto de Node-RED en vez de 3000 — por defecto `1880`, o el que se configure en `settings.js` (`uiPort`).

### 7. Seguridad del editor de Node-RED
Importante y fácil de pasar por alto: si Node-RED queda expuesto en la red local, **por defecto el editor de flujos (`/`) no pide login** — cualquiera en la misma WiFi podría entrar y modificar los flujos, no solo ver el dashboard. Hay que configurar `adminAuth` en `settings.js` para poner usuario/contraseña al editor, separado del login de la app (`SISUsuarios`) que ven los operarios.

## Esquema sugerido de flujos

```
[http in: GET /login]  -> [function: renderLogin]              -> [http response]
[http in: POST /login] -> [mssql: SELECT SISUsuarios]
                        -> [function: desencriptar + comparar]  -> [function: crear sesión + cookie] -> [http response: redirect]
[http in: GET /]       -> [function: validar cookie]  -> [mssql: query máquinas]  -> [function: renderDashboard] -> [http response]
[http in: GET /selladora/:codigo] -> [function: validar cookie] -> [mssql: query ejecución + bultos] -> [function: renderPage] -> [http response]
[http in: GET /logout] -> [function: borrar sesión] -> [http response: redirect]
```

## ¿Vale la pena migrar?

Para esta app puntual (un solo propósito: ver bultos en un celular), la versión actual en Express es más simple de mantener: todo el flujo de login/consulta/render está en 3 archivos claros y no depende de reconstruir sesiones ni cifrado a mano dentro de nodos. Pasarlo a Node-RED tiene sentido sobre todo si ya se usa Node-RED para otras integraciones en planta y se quiere que esto viva ahí junto con lo demás — no porque Node-RED sea necesariamente más simple para este caso.
