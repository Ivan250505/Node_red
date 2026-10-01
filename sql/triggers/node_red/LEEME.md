# SQL de los nodos de Node-RED (Selladora)

Node-RED solo recibe las señales del PLC y de la báscula (peso, golpes, potencia, botones). El SQL
que ejecuta contra la base **lo escribimos nosotros** y vive acá. Esta carpeta es la **versión
canónica**: cualquier cambio se hace en estos archivos y después se pega en el nodo de Node-RED.
Desde el 28/09/2026 vive dentro de `triggers/`, junto a los triggers que dispara, y se copia al repo
de Node en `sql/triggers/node_red/`.

**Al pegar en Node-RED:** Node-RED ya declara sus parámetros (`@MiMaquina`, `@maquina`, `@peso`...).
Si el archivo trae un `DECLARE` de un parámetro, se quita al pegarlo. Pedido de Carlos, 28/09.

| Archivo | Nodo de Node-RED | Cuándo corre | Parámetros | Versión |
|---|---|---|---|---|
| `01_pesaje_paquete.sql` | Pesaje de paquete | Cada paquete que pesa la báscula | `@maquina`, `@peso`, `@golpes`, `@potencia` | 21/09/2026 (unidades por paquete de la referencia, Cat. 18) |
| `02_cierre_bulto.sql` | Cierre de bulto (**dos nodos**: automático y botón "📦 Cierre bulto") | Al completar los paquetes del bulto y con el botón de la tableta (`/api/comando` → `cierre_bulto`) | `@MiMaquina` | **28/09/2026: `HoraFin = GETDATE()`** (antes `@HoraPLC`); Golpes/Potencia = promedio de paquetes. **30/09: sin `carlixplast.dbo.`** — corre contra la BD de la conexión. **Antes de pegarlo en producción, confirmar con Carlos que esa conexión apunta a `carlixplast`**: con otra BD por defecto cerraría bultos ajenos (revisión Iván 01/10/2026) |
| `03_residuo_insertar.sql` | Insertar residuo | Retal / Troquelado / No conforme **con cantidad** | `@IdBulto`, `@TipoResiduo`, `@Cantidad` | 30/09/2026 (GeneradoPor y operario desde el operario activo de la máquina; antes 0) |
| `04_residuo_marcar_pendiente.sql` | Marcar residuo pendiente | Retal / Troquelado / No conforme **sin cantidad** (la confirma el digitador) | `@maquina`, `@tipoResiduo` | 01/09/2026 |
| `CAMBIO_CIERRE_BULTO_HORAFIN_28092026.md` | — | Instrucciones para Carlos del cambio del 28/09 en el cierre | — | 28/09/2026 |

## ¿Y "abrir bulto"?

El PLC **no abre bultos** y no tiene SQL para eso:
- El **primer** bulto de una orden lo crea el **Node** al iniciar la orden (`crearBultoInicial`, `server.js`).
- Los **siguientes** los crea `trg_SEL_Bultos_CierreBulto` al cerrar el anterior: nacen `Temporal`, con `HoraInicio` = hora final del que se cerró.
- El primer pesaje los pasa a `Activo` (`trg_SEL_PesajeElemento_ActualizarBulto`).

## Qué dispara cada uno en la base

- **Pesaje**: `UPDATE SEL_Bultos.number_paqu` (el conteo lo hace este SQL) + `INSERT SEL_PesajeElemento` → `trg_SEL_PesajeElemento_ActualizarBulto` (solo pasa el bulto de `Temporal` a `Activo`). No cierra ni crea bultos.
- **Cierre**: `UPDATE SEL_Bultos SET estado = 'Cerrado'` → `trg_SEL_Bultos_CierreBulto` (corrige una hora final mala; PRDProduccion: cantidad, unidades, `HoraFinal`, `Duracion`; abre el bulto siguiente con `HoraInicio` = este `HoraFin`) → `trg_SEL_Bultos_SuspenderTemporal` y `trg_SEL_Bultos_GenerarEntradaInventario` (existencias y Tipo 35).
- **Residuos**: crean el hijo (Linea padre + 1000/3000/4000) con su entrada a inventario.

## Pendientes (28/09/2026)

- [ ] `02_cierre_bulto.sql`: pegar en Node-RED el cambio de `HoraFin`, en el nodo automático **y** en el del botón.
- [ ] `03_residuo_insertar.sql`: confirmar que ya se pegó la versión del 23/09. Antes fallaba con "No se pudo determinar la bodega para el residuo".
- [ ] `01_pesaje_paquete.sql`: confirmar que el nodo tiene la versión del 21/09, con `UnidadesPaquete`.

Los archivos originales siguen en `../../` (`agregar_unidadespaquete_referencia_pesaje_21092026.sql`,
`insertar_residuo_hijo_nodered.sql`, `marcar_residuo_hijo_pendiente_nodered.sql`) como historial;
de aquí en adelante se edita **solo** esta carpeta.
