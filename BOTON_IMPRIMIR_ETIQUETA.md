# El botón "Imprimir etiqueta" — todo lo que está ligado a él

Recorrido completo del botón 🖨️ **Imprimir etiqueta** de la tableta: dónde está pintado, qué pasa
al tocarlo, qué sale hacia Node-RED y qué **no** hace.

Referencias de línea tomadas del commit `2703e67`. Si el archivo se mueve, lo estable son los
nombres de función.

## 1. En una frase

El botón manda el comando `imprimir_etiqueta` a Node-RED (vía `POST /api/comando` de este mismo
servidor) para que imprima la etiqueta del paquete **que la báscula está pesando en ese momento**.
Este servidor **no escribe nada en la base de datos** por este botón: es fire-and-forget hacia
Node-RED, y toda la lógica de pesaje/numeración/impresión vive del otro lado.

## 2. Dónde vive el botón

Hay **dos** botones distintos, con el mismo texto y el mismo comando, pero con funciones de click
diferentes:

| Pantalla | Ruta | HTML del botón | Función que llama |
|---|---|---|---|
| Información de una orden suelta | `GET /selladora/:codigo/orden/:idOrden` ([server.js:6419](server.js#L6419)) | [server.js:4263](server.js#L4263), dentro de `imprimirYAccionesBox` en `renderOrdenDetalle` | `confirmarYEnviar(...)` |
| Tarjeta de cada referencia (sellado en paralelo) | `GET /selladora/:codigo/grupo/:idGrupo` ([server.js:6302](server.js#L6302)) | [server.js:6002](server.js#L6002), dentro de `bloqueOperar` | `accionReferencia(...)` |

En las dos pantallas va en la misma fila que 📦 **Cierre bulto**, en dos columnas
(`.imprimir-acciones-grid`, [server.js:770](server.js#L770)); en pantalla angosta la fila pasa a una
sola columna ([server.js:908](server.js#L908)). El estilo propio del botón es `.btn-imprimir`
([server.js:773](server.js#L773)): azul `#0078d7`, `min-height: 110px` y ancho completo — es de
toque grande a propósito, se usa con las manos ocupadas en la máquina.

## 3. La cadena completa

```
[🖨️ Imprimir etiqueta]  (tableta)
        |
        v
confirmarYEnviar()            <- orden suelta: una confirmación "¿Está seguro...?"
  o accionReferencia()        <- grupo: misma confirmación + alternarSilencioso() si hace falta
        |
        v
enviarComando('imprimir_etiqueta', boton, null, idOrdenDestino)
        |  fetch POST /api/comando   {comando, idOrden, maquinaCodigo, datos:null}
        v
app.post('/api/comando')      <- requireLogin + whitelist COMANDOS_VALIDOS
        |
        v
enviarComandoANodeRed()       <- POST {NODERED_HTTP_URL}/api/comando, timeout 4s
        |
        v
Node-RED  ->  PLC / impresora   (fuera de este repo)
```

## 4. Pieza por pieza

| Pieza | Dónde | Qué hace |
|---|---|---|
| Markup del botón | [server.js:4263](server.js#L4263) y [server.js:6002](server.js#L6002) | Solo se pinta con la orden **Activa** (ver §6). |
| `confirmarYEnviar` | [server.js:2309](server.js#L2309) (`scriptComandos`) | Swal "¿Está seguro de imprimir la etiqueta?" con Sí/Cancelar. Al confirmar llama a `enviarComando`. |
| `accionReferencia` | [server.js:5821](server.js#L5821) (`scriptAccionesReferencia`) | La misma confirmación, y si esa referencia no es la que recibe paquetes, alterna primero (ver §7). |
| `alternarSilencioso` | [server.js:5776](server.js#L5776) | `POST /api/selladora/orden/:idOrden/alternar-referencia`. Si falla, el comando **no** se manda. |
| `enviarComando` | [server.js:2277](server.js#L2277) | Deshabilita el botón, hace el `fetch`, muestra "Comando enviado"/error y devuelve la promesa. |
| `hayVentanaQueNoSePuedePerder` | [server.js:2272](server.js#L2272) | Si Calidad o la verificación de báscula están en pantalla, se **omite** el aviso de "Comando enviado" (ver §8). |
| `POST /api/comando` | [server.js:8417](server.js#L8417) | `requireLogin`, valida contra `COMANDOS_VALIDOS` y reenvía. Agrega el usuario de la sesión. |
| `COMANDOS_VALIDOS` | [server.js:7778](server.js#L7778) | `imprimir_etiqueta`, `reimprimir_etiqueta`, `cierre_bulto`, `retal`, `troquelado`, `refilado`, `calidad`, `no_conforme`. |
| `enviarComandoANodeRed` | [server.js:167](server.js#L167) | `POST` a `NODERED_HTTP_URL/api/comando` con `AbortController` de 4 s. |
| `NODERED_HTTP_URL` | [server.js:142](server.js#L142) | Del `.env`; por defecto `http://localhost:1880`. |
| Estilos | [server.js:770-775](server.js#L770-L775), [server.js:862](server.js#L862), [server.js:908](server.js#L908) | Rejilla de dos columnas, botón azul alto, y una sola columna en pantalla angosta. |

## 5. Qué se manda exactamente

**Navegador → este servidor** (`POST /api/comando`):

```json
{ "comando": "imprimir_etiqueta", "idOrden": 1234, "maquinaCodigo": "SE05", "datos": null }
```

`idOrden` y `maquinaCodigo` se cierran sobre el scope de `scriptComandos` (valores fijos de esa
página). En la pantalla de grupo, `accionReferencia` pasa `idOrdenDestino` para que el comando vaya
contra **esa** referencia y no contra la que quedó fija en el closure.

**Este servidor → Node-RED** (mismo path, `POST /api/comando`):

```json
{ "comando": "imprimir_etiqueta", "idOrden": 1234, "maquinaCodigo": "SE05",
  "usuario": "<req.session.usuario.codigo>", "datos": null }
```

El único campo que agrega el servidor es `usuario`. `datos` va en `null`: **Node-RED resuelve solo**
qué paquete imprimir (el que la báscula está pesando). Ese es justo el contraste con
`reimprimir_etiqueta`, que sí lleva `datos` describiendo un paquete ya pesado.

## 6. Cuándo se ve el botón

Solo con la ejecución **Activa** (`orden.Estado === 'Activa'`):

- `imprimirYAccionesBox` en `renderOrdenDetalle` queda en `''` si no está Activa.
- En la tarjeta de una referencia, si no está Activa sale en su lugar el texto
  *"Esta referencia no está activa (Estado) — no se puede imprimir ni cerrar bultos."*
  ([server.js:6009](server.js#L6009)).

Tiene sentido: báscula e impresora actúan sobre el bulto que se está armando en ese momento. El
script que define `confirmarYEnviar` (`scriptComandos`) también se inyecta **solo** con la orden
Activa ([server.js:4375](server.js#L4375)).

## 7. Lo que pasa alrededor del click

- **Alternar referencia (solo pantalla de grupo, 10/09/2026).** Si el operario toca el botón en una
  referencia que no está recibiendo paquetes, el botón **no se bloquea**: se alterna solo, con una
  sola confirmación, y después se manda el comando — así le llega a Node-RED con la máquina ya en la
  referencia correcta. `window.refActivaAhora` se actualiza para no alternar de gratis si se toca
  dos veces la misma tarjeta. Si hubo que alternar, la página se recarga 1,6 s después.
- **La tarjeta se cierra sola (11/09/2026).** Si el comando sale bien, `cerrarTarjetaReferencia()`
  cierra el `<details>` de esa referencia; si falló, se deja abierta. Cierre bulto **no** cierra la
  tarjeta: después del cierre se sigue operando la misma referencia con el bulto nuevo.
- **El botón se deshabilita** mientras el `fetch` está en vuelo y se vuelve a habilitar en el
  `finally`.
- **No toca `window.idBultoActivo`.** Ese dato (lo mantiene `scriptResumenBultoActivo` cada 4 s,
  [server.js:1268](server.js#L1268)) lo usan Cierre bulto y los residuos, no Imprimir etiqueta.

## 8. Qué puede tapar el botón

No hay ninguna validación que bloquee la impresión, pero sí ventanas modales que ocupan la pantalla
y hay que resolver antes de llegar al botón:

| Ventana | Cómo se sale |
|---|---|
| Pausa activa (`abrirModalPausaActiva`, [server.js:2510](server.js#L2510)) | Solo con "▶ Reanudar": `allowOutsideClick:false`, `allowEscapeKey:false`, sin cancelar. |
| Chequeo de Calidad | Respondiendo el formulario, o Cancelar (vuelve a salir a los 5 min). |
| Verificación de báscula con peso patrón | Completando la verificación. |
| Protocolo de arranque a medias | Se retoma al abrir la página; trae "Cancelar". |

Ojo con el caso reportado el 16/09/2026: el chequeo de Calidad sale con el **primer paquete** del
bulto, que es el mismo momento en que el operario está imprimiendo. Por eso el aviso de "Comando
enviado" se omite si Calidad está en pantalla — SweetAlert2 es un modal único y ese aviso de
cortesía cerraba el asistente, que lo leía como "cancelado" y descartaba lo ya respondido.

## 9. Errores y el timeout

El flujo de Node-RED que recibe esto **no tiene nodo `http response`** (comprobado: la conexión
queda abierta sin devolver nada). Por eso:

- `enviarComandoANodeRed` aborta a los **4 s** y trata el `AbortError` como **entregado**.
- Solo un error de conexión real (Node-RED caído) sube como fallo y el botón muestra
  "Error / No se pudo enviar el comando".
- O sea: **"Comando enviado" quiere decir "salió de aquí"**, no "la etiqueta se imprimió". Si la
  etiqueta no sale y el botón no se quejó, el problema está del lado de Node-RED, del PLC o de la
  impresora — no en esta app.

## 10. `imprimir_etiqueta` vs. sus parientes

| Comando | Quién lo manda | `datos` | Para qué |
|---|---|---|---|
| `imprimir_etiqueta` | Este botón | `null` | El paquete que la báscula está pesando ahora. Node-RED lo resuelve solo. |
| `reimprimir_etiqueta` | Página de Bultos (`reimprimirPaquete`), "Volver a pesar", traslado de paquetes, y el cierre de bulto | `{idBulto, consecutivoPaquete, pesoGr, serialBulto}` | Un paquete **ya pesado**, no necesariamente el activo. |
| `cierre_bulto` | El botón de al lado | `null`, y encadena un `reimprimir_etiqueta` | Cierra el bulto y reimprime la etiqueta del último paquete, si el cierre salió bien y el bulto tenía paquetes (`confirmarCerrarBultoYReimprimir`, [server.js:2334](server.js#L2334)). |
| `retal` / `troquelado` / `refilado` / `no_conforme` | Isla "Residuos" | `{peso, idBulto}` | El peso lo digita el operario antes de enviar. |

## 11. Lo que NO está en este repo

Todo lo que pasa **después** del `POST` a Node-RED:

- qué hace el flujo de Node-RED con `imprimir_etiqueta`, cómo sabe qué paquete es y qué le manda a
  la impresora;
- el formato de la etiqueta;
- las escrituras en BD que se derivan del pesaje (`SEL_PesajeElemento`, `SEL_Bultos`,
  `PRDProduccion`), que desde el 26/08/2026 son de Node-RED y de los triggers, no de esta app.

`NODE-RED.md` de este repo **no** documenta ese flujo: trata de una migración hipotética de esta app
a Node-RED, que es otro tema.

## 12. Si hay que tocarlo

- **Cambiar texto, color o tamaño:** `.btn-imprimir` ([server.js:773](server.js#L773)) y los dos
  markups ([server.js:4263](server.js#L4263), [server.js:6002](server.js#L6002)) — son dos, es fácil
  cambiar uno y olvidar el otro.
- **Cambiar la pregunta de confirmación:** en la orden suelta el texto va en el markup, como primer
  argumento de `confirmarYEnviar`; en la pantalla de grupo está escrito dentro de
  `accionReferencia`.
- **Mandar datos extra a Node-RED:** tercer argumento de `enviarComando` (`datos`), que el endpoint
  reenvía tal cual. No hace falta tocar el servidor salvo que el comando sea nuevo.
- **Comando nuevo:** agregarlo a `COMANDOS_VALIDOS` ([server.js:7778](server.js#L7778)) o el
  endpoint responde 400 "Comando inválido".
- **Apuntar a otro Node-RED:** `NODERED_HTTP_URL` en el `.env` (requiere reiniciar Node).
- **Bloquear la impresión bajo alguna condición:** hoy no hay ninguna. El sitio natural es
  `enviarComando`, o el propio endpoint si tiene que ser una regla del servidor.
