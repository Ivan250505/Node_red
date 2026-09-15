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
| `accesos.js` | Bitácora de entrada/salida: registra el evento en `SISAccesos` al iniciar y cerrar sesión. |
| `agregar_qr_accesos.sql` | Script SQL: crea la tabla `SISAccesos` (y agrega `SISUsuarios.CodigoQR`, hoy sin uso). Ejecutar una sola vez. |
| `.env` | Configuración real (servidor de BD, puerto web, secreto de sesión). **No se sube a git.** |
| `.env.example` | Plantilla de `.env` sin datos sensibles. |
| `GIT.md` | Guía de Git: clonar, pull, commit, push, conflictos. |
| `public/` | Archivos estáticos servidos tal cual (logo, librería `sweetalert2.min.js`). |
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

## 9. Bitácora de entrada/salida (`SISAccesos`)

El único inicio de sesión es `/login` con usuario y contraseña de Mirane (`SISUsuarios`). Al entrar
se registra un evento `Entrada` en `SISAccesos` con `Origen = 'Manual'`; al presionar "Cerrar sesión"
(`/logout`) se registra `Salida`. Cualquier ruta protegida sin sesión redirige a `/login`.

> **Login por QR (eliminado el 04/09/2026).** Hasta esa fecha existía `/marcar`, una segunda puerta
> de entrada donde el operario escaneaba con la cámara un QR impreso (`SISUsuarios.CodigoQR`) en vez
> de escribir su contraseña. Se quitó a pedido del usuario junto con el resto de usos de la cámara,
> y con ella `renderMarcar()`, `POST /marcar/registrar`, `buscarUsuarioPorQR()` y el script
> `generar-qr-usuario.js`. La columna `SISUsuarios.CodigoQR` sigue en la base (ya no se lee) y
> `agregar_qr_accesos.sql` se conserva porque es el script que también creó `SISAccesos`.

### 9.1 Notas

- `SISAccesos` queda como bitácora independiente de la sesión: aunque la cookie dure 8h y se cierre sola, el par Entrada/Salida real solo se registra cuando de verdad se usa `/login` o "Cerrar sesión".
- `/logout` hace algo más que cerrar la sesión: si el operario tenía una ejecución `Activa` a su nombre, la deja en `PendienteOperador` para que otro pueda retomarla (ver `server.js`).

## 10. Protocolo de arranque de una orden (09/09/2026)

Al pulsar **"▶ Iniciar"** una orden ya no se abre directo el escaneo del rollo: la tableta guía una
secuencia fija de pasos que no se pueden saltar ni reordenar.

| Paso | Qué pasa | Dónde queda registrado |
|---|---|---|
| 1 | Limpieza y desinfección: se avisa y arranca el cronómetro | `SEL_TiempoMuerto` (`Tipo='limpieza'`), igual que el botón de Pausa |
| 2 | Al terminarla: *¿Detecta algún peligro químico (aceites y lubricantes)?* — si **Sí**, sale el aviso de comunicarse con el jefe de planta y no se puede seguir | `SEL_ProtocoloArranque` (`Paso='peligro_quimico'`) |
| 3 | Se abre el escaneo del rollo de siempre | igual que antes (`scan-rollo.js`) |
| 4 | Con el rollo consultado y **antes** de confirmarlo: *¿El rollo está en buen estado?* y *¿Identifica algún peligro físico?* — si el rollo está mal o hay peligro, se pide escanear otro | `SEL_ProtocoloArranque` (`rollo_estado` / `peligro_fisico`, con el serial) |
| 5 | Confirmado el rollo arranca la ejecución y empieza el cronómetro del alistamiento | `SEL_TiempoMuerto` (`Tipo='alistamiento'`, `Subtipo='arranque'`) |
| 6 | Al terminar el alistamiento se pide la temperatura de trabajo de la perilla | `SEL_TemperaturaPerilla` + `SEL_ProtocoloArranque` |

Notas:

- **El botón "🌡️ Temperatura perilla" de la página de Información se eliminó**: la temperatura se
  pide una sola vez, en el paso 6. Si se necesita volver a registrarla cuando el operario mueve la
  perilla a mitad de la orden, hay que reponer ese botón.
- **Nada del protocolo vive en el navegador.** Cada paso queda en la base apenas se responde, así que
  si la tableta se recarga, se apaga o se bloquea a mitad, al volver a entrar se retoma en el mismo
  paso y el cronómetro sigue con la hora real (ver `obtenerProtocoloPendiente` en `server.js`).
- **Con sellado en paralelo (pedidos agrupados):** el protocolo corre UNA sola vez sobre la orden
  ancla del grupo, porque es un solo proceso físico — una limpieza, un chequeo de peligro químico, un
  rollo, un alistamiento y una temperatura para las 3 referencias. El "▶ Iniciar" de la tarjeta
  fusionada del grupo entra por el mismo protocolo, y al terminar el paso 6 la tableta cae en la
  página del grupo (`/selladora/:codigo/grupo/:idGrupo`), no en la de una referencia suelta — si no,
  no habría por dónde alternar. El destino lo decide el servidor en `POST .../temperatura`, que es el
  único que sabe si la orden está agrupada.
- El protocolo completo aplica **solo a Iniciar**. De "+ Rollo" (añadir un rollo a una orden ya en
  curso) sí se pide el chequeo del paso 4 — *¿está en buen estado?* y *¿algún peligro físico?*, sin
  la numeración 4.1/4.2 — antes de confirmar el rollo (a pedido del usuario, 09/09/2026): un rollo
  que entra a mitad de la orden se revisa igual que el primero. Los otros pasos no se repiten.
- Los dos cronómetros usan los mismos `POST /pausar` y `POST /reanudar` del botón de Pausa, para que
  queden en `SEL_TiempoMuerto` como cualquier otra actividad.
- Requiere ejecutar **`agregar_protocolo_arranque.sql`** una sola vez contra la base: crea
  `SEL_ProtocoloArranque` y agrega `'ARRANQUE'` a `CK_SEL_TiempoMuerto_Subtipo`. El paso 6 además
  necesita `agregar_temperatura_perilla.sql`.
- El reporte de producción trae un bloque nuevo, **"Protocolo de arranque"**, con las respuestas tal
  como las dio el operario. Las dos actividades cronometradas no se repiten ahí: ya salen en la
  bitácora y en "Paradas del turno".

## 11. Volver a pesar un paquete (09/09/2026)

En la página de **Bultos**, tocar un paquete ya no reimprime de una: sale un menú con dos opciones.

- **🖨️ Reimprimir etiqueta** — lo de siempre.
- **⚖️ Volver a pesar** — abre una ventana con el peso **en vivo de la báscula** (el mismo `/ws/peso`
  de la página de Información). El operario vuelve a poner el paquete, pulsa "Guardar este peso" y
  la etiqueta se reimprime sola con el peso corregido. No se puede guardar sin una lectura real de
  la báscula: no hay campo para escribirlo a mano.

Qué toca al guardar (`POST /api/selladora/paquete/repesar`, todo en una transacción):

| Tabla | Qué pasa |
|---|---|
| `SEL_PesajeElemento.PesoPaqueGr` | queda el peso corregido |
| `SEL_Bultos.CantidadTotal` | se recalcula (`SUM` de sus paquetes) |
| `PRDProduccion.Cantidad` | se pone en ese total nuevo |
| `PRDExtrusionRollos.PesoBrutoKg` | se pone en ese total nuevo |
| `SEL_RepesajePaquete` | rastro: qué paquete, cuándo, de cuánto a cuánto, quién y en qué estado estaba el bulto |
| `INVExistencias` / movimiento Tipo 35 | **no se tocan** (ver abajo) |

Las tres columnas de producción se corrigen con la **misma fórmula que ya usaba el sistema**:
`trg_SEL_Bultos_CierreBulto` (al cerrar el bulto) y `finalizarControlParcialSellado` (al dar
Finalizar) sacan las dos de `SEL_Bultos.CantidadTotal`. `Unidades`, `Duracion` y `HoraFinal` no se
tocan: repesar no cambia ni el número de paquetes ni las horas.

Todo esto aplica **solo si el bulto ya estaba cerrado**. En un bulto todavía abierto no hay nada que
rehacer: `CantidadTotal` y la fila de `PRDProduccion` las llena el trigger al cerrar, y para ese
momento ya suman el valor corregido.

Ojo con los decimales: `SEL_Bultos.CantidadTotal` y `SEL_PesajeElemento.PesoPaqueGr` tienen 3
decimales, pero `PRDProduccion.Cantidad`, `PRDExtrusionRollos.PesoBrutoKg` e `INVExistencias.Cantidad`
tienen 2. Un total de 18.949 se guarda como 18.95 en esas tres — igual que hace el trigger hoy.

### Dónde se corta

- **Inventario no se toca**, por decisión expresa del usuario (09/09/2026). `INVExistencias.Cantidad`
  y la línea del movimiento Tipo 35 las escribe `trg_SEL_Bultos_GenerarEntradaInventario` en el
  momento en que el bulto cierra y nadie más las reescribe, así que tras un repesaje ese saldo queda
  con el peso viejo. La ventana de la tableta se lo avisa al operario, y `SEL_RepesajePaquete` guarda
  el rastro exacto por si después se decide ajustarlo.
- **Orden ya cerrada definitivamente** (`SEL_OrdenProduccion.Estado = 'Finalizada'`, lo que deja
  "Cerrar Definitivo" del escritorio): se bloquea el repesaje. Ahí ya se calculó la Merma a partir de
  estos mismos pesos y esta pantalla no tiene cómo recalcularla — lo ajusta el digitador. Mientras la
  orden está `Activa` o en `PendienteValidacion` sí se puede corregir: Finalizar desde la tableta no
  calcula merma.

Requiere ejecutar **`agregar_repesaje_paquete.sql`** una sola vez contra la base.

## 12. `SEL_TiempoMuerto.DuracionMinutos` (15/09/2026)

Las dos bases tenían definida distinto esta columna, y en producción llevaba desde el 03/09/2026
guardando NULL:

| Base | Cómo estaba | Resultado |
|---|---|---|
| `carlixplastPrueba` | columna **calculada** `AS DATEDIFF(MINUTE, HoraInicio, HoraFin) PERSISTED` | se llenaba sola |
| `carlixplast` | columna `INT` normal, que no escribe nadie | **NULL en las 77 filas** |

El origen: `POST /reanudar` la llenaba a mano, eso reventaba contra `carlixplastPrueba` (*"cannot be
modified because it is either a computed column..."*), se quitó la asignación de `server.js` — y en
producción, donde no era calculada, quedó sin nadie que la llenara.

**No se perdió información:** `HoraInicio` y `HoraFin` están completos, así que la duración siempre
se puede derivar con `DATEDIFF(MINUTE, HoraInicio, HoraFin)`. El problema era otro: una columna que
existe, tiene nombre creíble y devuelve NULL es una trampa para cualquier Excel o Power BI que haga
`SUM(DuracionMinutos)` — lee "cero tiempo muerto", o sea eficiencia perfecta.

Lo corrige **`corregir_duracionminutos_tiempomuerto.sql`**, que deja las dos bases con la columna
calculada. Ejecutar una sola vez contra la base. Es idempotente: si ya es calculada, no hace nada.

Notas:

- La columna **no se asigna nunca desde la aplicación**. Al ser calculada, SQL Server la resuelve
  sola cuando `/reanudar` guarda `HoraFin`. Volver a escribirla a mano reproduce el error de arriba.
- Una columna normal no se puede convertir en calculada en sitio: hay que soltarla y recrearla. Por
  eso el script **aborta** si encuentra valores escritos, en vez de borrarlos. Al correrlo en
  producción no había ninguno, así que el cambio no costó datos.
- Ojo con la unidad: `DATEDIFF(MINUTE, ...)` cuenta cruces de frontera, no duración real — de
  10:00:59 a 10:01:01 da 1 minuto y de 10:00:00 a 10:00:59 da 0 (hoy 9 de las 77 filas dan 0). Sirve
  para paradas de planta; si algún día alimenta un OEE que necesite segundos, hay que soltar y
  recrear la columna otra vez en las dos bases.
