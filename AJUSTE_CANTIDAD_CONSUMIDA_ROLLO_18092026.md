# Ajuste de la cantidad realmente consumida de un rollo (Selladora)

Fecha: 18/09/2026 · Estado: **implementado en Node el 18/09/2026.**
Para: el programador que haga el cambio (el diseño de abajo se conserva tal cual se escribió).

## 0. Estado de la implementación (18/09/2026)

Implementado **solo del lado Node** (este repo no tiene el código VB de Mirane). Qué quedó dónde:

| Pieza | Dónde |
|---|---|
| Lógica del ajuste (transacción, validaciones, los 8 puntos de §5) | `sel-inventario-mp.js` → `ajustarConsumoRollo` |
| Estado para la pantalla (rollos + R/C + S + topes) | `sel-inventario-mp.js` → `obtenerEstadoAjusteConsumo` |
| Entrada de D al inventario | `sel-inventario-mp.js` → `entradaExistenciaPorDetalle` |
| `UPDATE` de la línea Tipo 24 | `sel-inventario-mp.js` → `ajustarLineaSalidaTipo24` |
| Recálculo del control | `sel-inventario-mp.js` → `recalcularControlSellado` |
| Endpoints `GET /rollos-consumo` y `POST /rollo/ajustar-consumo` | `server.js` |
| Ventanas de la tableta | `server.js` → `scriptAjusteConsumo` |
| Tabla `SEL_AjusteConsumoRollo` + `SEL_RolloEjecucion.CantidadOriginal` | `sql/pendientes/20260918_agregar_ajuste_consumo_rollo.sql` |

**Falta correr el script SQL en producción.** Ya está aplicado y probado en `carlixplastPrueba`.

### Preguntas abiertas, resueltas

- **#2 (dónde va el botón)** → solo Node, en el apartado *Historial rollo* de la página de una
  referencia y de la de un grupo. El código VB no vive en este repo.
- **#4 (`MaterialConsumidoKg`)** → decisión del usuario: `MaterialTotalKg` y `MaterialConsumidoKg`
  se recalculan **los dos** como `SUM(PRDProduccionMateriaPrima.Cantidad)` del ancla. Mantiene la
  invariante que Node ya tenía (`MaterialDisponibleKg`, que es columna **calculada**, queda en 0) y
  de paso corrige el caso de varios rollos.
- **#5 (quién puede ajustar)** → decisión del usuario: cualquier usuario logueado, igual que
  "Volver a pesar" y la corrección de bolsas.
- **#1 (merma mínima)** → se dejó la regla estricta `C > S` de §4, sin margen adicional.
- **#6 (órdenes `Finalizada`)** → no se permite, como anticipaba el documento.
- **#3 (`INVMovimientosLotes`)** → sigue sin resolver. Se volvió a buscar y no hay escrituras a esa
  tabla en el flujo Tipo 24 de Node: solo `INVMovimientos`, `INVMovimientosElementos`,
  `INVExistencias` y `AUD_INVExi_Borradas`.

### Dos cosas que el diseño no anticipaba y aparecieron al implementar

1. **El `UPDATE` de la línea Tipo 24 (§5 punto 3) se apoya en un supuesto que este mismo ajuste
   rompe.** Ubicar la línea por `Tipo + Detalle + Elemento` funciona hoy porque un rollo se consume
   entero y su fila de existencias se borra, así que no se puede volver a pitar. Al devolver kilos,
   el serial vuelve a existir y puede montarse en otra orden, generando una segunda línea con el
   mismo `Detalle`. `ajustarLineaSalidaTipo24` desempata por la línea cuya cantidad coincide con la
   que se está corrigiendo, y si ni así puede decidir corta con un error en vez de pisar la
   equivocada.
2. **El `Valor` de `INVExistencias`.** `descontarExistenciaPorDetalle` nunca lo toca (así viene
   portado de Mirane), pero la fila borrada sí se llevó su valorización. La entrada la reconstruye a
   prorrata desde el snapshot de `AUD_INVExi_Borradas`, y la rama de "subir C" descuenta valor en
   proporción — si no, un ciclo bajar-subir dejaba kilos sin costo dentro del inventario.

### Qué se probó

Contra `carlixplastPrueba`, orden 67 (66 Kg consumidos, 5 Kg de salida real): rechazo por `C > R`,
rechazo por `C ≤ S`, rechazo por serial ajeno, ajuste 66→50, segundo ajuste 50→40 (devuelve 10 más,
no 26 — no se encadena), y corrección al alza 40→45 (vuelve a descontar 5). En todos los casos se
conserva la identidad `MP + existencias = R`, el `Valor` queda proporcional, y el movimiento Tipo 24
se actualiza sin gastar consecutivo. Los datos de prueba se restauraron al estado original.

## 1. Qué se necesita (en una frase)

Hoy el sistema asume que **todo el rollo montado se consumió**. Si el operario solo gastó una parte,
tiene que poder **corregir la cantidad consumida** mientras la orden sigue *pendiente de validación*,
y el sistema debe **devolver la diferencia al inventario** y dejar consistentes todos los registros
que dependen de esa cantidad (movimiento Tipo 24, historial de MP, control del proceso, cálculo de merma).

## 2. Cómo funciona hoy en Mirane (`Produccion.vb`, escritorio)

El historial de materia prima (`dtgMateriaPrima`) ya permite digitar la cantidad. Al **Guardar**:

| Paso | Dónde | Qué hace |
|---|---|---|
| Tope al digitar | `dtgMateriaPrima_CellEndEdit` (~7687) | La `Cantidad` no puede superar `INVExistencias.Cantidad` de esa etiqueta (`ValidarYObtenerCantidadDesdeExistencias`, ~7238). Si la supera, la ajusta al disponible. |
| Reescribe el historial | `btnGuardar_Click` (~3384-3392, ~3762) | `DELETE` de `PRDProduccionMateriaPrima` del proceso y luego `registrarMateriaPrima` (~486) inserta de nuevo con la cantidad digitada. |
| Ajusta el Tipo 24 | `GenerarSalidaMateriaPrima` (~8175) | Busca el movimiento por `Observaciones = "Salida Materia Prima - {lote} - {elemento} - {linea}"`. **Revierte** cada línea existente con `EntradaInventario` (devuelve el stock al mismo `Detalle`), borra las líneas de `INVMovimientosElementos` y las **vuelve a insertar con la cantidad nueva**, descontando con `SalidaInventario`. Al final borra filas de `INVExistencias` con `Cantidad=0 AND Unidades=0` (con snapshot previo en `AUD_INVExi_Borradas`). |
| Control del proceso | `ActualizarMaterialConsumido` (~9442) y `MaterialTotalKg` (~10216) | `MaterialConsumidoKg` suma el peso bruto de cada etiqueta; `MaterialTotalKg` se recalcula como `SUM(PRDProduccionMateriaPrima.Cantidad)` (`CalcularMaterialTotal`). |
| Modo etiquetas parciales | `dtgMateriaPrima_CellBeginEdit` (~8049) | Las filas ya guardadas **no** son editables; solo se agregan filas nuevas (`RegistrarNuevasMPEnHistorial`, ~8324, solo INSERT). |

Resultado: en el escritorio, lo que se digita es lo que se descuenta, y al re-guardar los movimientos se rehacen solos.

## 3. Cómo funciona hoy en Node (Selladora)

Archivos: `scan-rollo.js` y `sel-inventario-mp.js`.

- `consultarSerial` (scan-rollo.js:37) lee `INVExistencias.Cantidad` y devuelve **esa cantidad completa** como la del rollo. No hay campo para corregirla.
- `confirmarRollo` (scan-rollo.js:311):
  - **Iniciar**: solo deja el rollo en `SEL_RolloPendienteInicio`; la escritura real ocurre en `materializarInicioOrden` → `crearBultoInicial` (scan-rollo.js:106).
  - **Añadir Rollo**: escribe directo con `registrarMateriaPrimaRollo` + `generarSalidaRollo`.
- En ambos casos se usa la cantidad completa en:
  1. `registrarMateriaPrimaRollo` (sel-inventario-mp.js:101) → `INSERT PRDProduccionMateriaPrima` (ancla = `LineaOriginal`, no el `num_bulto` del rollo).
  2. `generarSalidaRollo` (sel-inventario-mp.js:160) → movimiento **Tipo 24** con `Observaciones = "Salida Materia Prima Selladora - {lote} - {elementoProducto} - {linea}"`, línea en `INVMovimientosElementos` (`Detalle` = serial del rollo) y `descontarExistenciaPorDetalle` (sel-inventario-mp.js:125), que deja la fila en 0 y luego se borra con `DELETE FROM INVExistencias WHERE Cantidad = 0 AND Unidades = 0`.
  3. `registrarControlParcialSellado` (sel-inventario-mp.js:271) → `PRDExtrusionControl.MaterialConsumidoKg += cantidad` y `PRDExtrusionRollos`.
  4. `SEL_RolloEjecucion` (línea de tiempo del rollo, `Cantidad`) y, solo en el primer rollo, `SEL_EjecucionOrden.PesoRolloBruto/PesoRolloNeto`.
- El historial de MP que muestra Node (`server.js` ~4797 y ~5689) es solo lectura y ni siquiera muestra cantidad.

Diferencia clave: **Mirane permite editar la cantidad y rehace los movimientos; Node no tiene edición alguna.**

## 4. Regla de negocio

Sea, para una orden de Selladora:

- **R** = cantidad original del rollo (la que hoy está en `PRDProduccionMateriaPrima.Cantidad`).
- **S** = salida real acumulada de la orden = `Σ [(Cantidad − PesoCono) + Torta + NuevoRetal + ResiduoTroquelado + ResiduoRefilado + ResiduoNoConforme]` de sus bultos (es exactamente la fórmula de `ObtenerDatosMermaOrden` en `SEL_InventarioMP.vb`).
- **C** = nueva cantidad consumida que digita el usuario.
- **D = R − C** = lo que se devuelve al inventario.

Reglas:

1. `C ≤ R` (no se puede consumir más de lo que entró).
2. `C > S` **estricto**: lo que entra nunca puede ser igual a lo que sale; siempre hay merma (retal, no conforme, etc.). Por eso la devolución máxima es **R − S**, y en la práctica un poco menos.
   - Ejemplo: rollo de 50 kg, salida de 30 kg → como máximo se devuelven 20 kg (C mínimo > 30).
   - Ejemplo: rollo de 60 kg, el operario dice que consumió 50, salida 45 → válido (50 > 45), se devuelven 10 kg.
3. Con **varios rollos** en la misma orden (Añadir Rollo) la validación es sobre el total: `Σ C_i > S`.
4. En **Sellado en paralelo** (grupo de referencias) la MP vive solo bajo la ancla y la salida se compara contra **todo el grupo** (misma lógica combinada de `RecalcularMermaSellado`).

## 5. Qué hay que actualizar cuando se corrige C

Todo en **una sola transacción**. La llave del rollo es su `Detalle` (serial de la etiqueta, 19+ dígitos; los últimos 5 son el elemento).

| # | Tabla / dato | Cambio |
|---|---|---|
| 1 | `PRDProduccionMateriaPrima` | `Cantidad = C` en la fila con ese `Detalle` (Fecha/Lote/Elemento del ancla, `Linea = LineaOriginal`). |
| 2 | `INVExistencias` | **Sumar D** de vuelta al mismo `Bodega` / `Elemento` (= últimos 5 dígitos) / `Detalle` / `Serie` (lote MP). La fila probablemente ya fue **borrada** (quedó en 0), así que hay que **recrearla** con `Linea = MAX(Linea)+1` (ver `EntradaInventario`, `INVModulo.vb:2686`). Dejar rastro en `AUD_INVExi_Borradas` (nuevo `Origen`). Es una **entrada por la diferencia**, no revertir todo y volver a descontar. |
| 3 | `INVMovimientosElementos` **Tipo 24** | `UPDATE Cantidad = C` en la línea con ese `Detalle` (no borrar/recrear: evita gastar consecutivos). Ubicarla por `Tipo=24 + Detalle + Elemento`, **no** por `Observaciones` (Node usa el prefijo `"Salida Materia Prima Selladora - "`, Mirane `"Salida Materia Prima - "`) ni por `Fecha` exacta (en Añadir Rollo Node pasa `fHoy` con hora; en el primer rollo, la fecha sin hora). Actualizar también `FechaModificado` del encabezado `INVMovimientos`. |
| 4 | `PRDExtrusionControl` | `MaterialTotalKg = SUM(PRDProduccionMateriaPrima.Cantidad)` recalculado (igual que hace Mirane en ~10216). `MaterialConsumidoKg`: ver pregunta abierta #4. Actualizar `FechaUltimaModificacion` y `UsuarioUltimaModificacion`. |
| 5 | `SEL_RolloEjecucion` (la "ejecución de rollos") | `Cantidad = C` en la fila con `id_ejecucion` + `Serial`. **Recomendado**: agregar columna `CantidadOriginal` para no perder lo que se escaneó. |
| 6 | `SEL_EjecucionOrden` | **No se toca por defecto.** Guarda un único valor por ejecución (`SerialRolloEntrada`, `PesoRolloBruto`, `PesoRolloNeto`), que no representa el total de rollos ni tiene sentido como dato de consumo. Solo si aplica: si el usuario ajusta justamente el rollo que figura en `SerialRolloEntrada`, se puede actualizar `PesoRolloBruto/Neto = C` para que no contradiga lo demás; en cualquier otro caso se deja igual. |
| 7 | `SEL_RolloPendienteInicio` | Solo si `Procesado = 0` (Iniciar aún sin materializar): actualizar `Cantidad`. En ese caso todavía no hay MP, movimiento ni inventario tocados. |
| 8 | Merma | No se escribe a mano: `RecalcularMermaSellado` lee `SUM(PRDProduccionMateriaPrima.Cantidad)`. Hay que **volver a calcularla después del ajuste** y el ajuste debe hacerse **antes** de que la orden se cierre (`IntentarCerrarOrdenSiCompleta` / "Cerrar Definitivo"), o forzar el recálculo. |
| 9 | Auditoría | Registrar quién, cuándo, serial, R, C, D y motivo. Recomendado: tabla nueva (p. ej. `SEL_AjusteConsumoRollo`). El SQL de creación se entrega como script para que lo corra el usuario. |

## 6. Validaciones

- La orden debe estar en `PendienteValidacion` (no `Activa`, no `Finalizada`).
- El serial debe pertenecer a la MP de esa orden/grupo (existir en `PRDProduccionMateriaPrima` del ancla).
- `C ≤ R` y `Σ C_i > S` (ver sección 4). Mostrar al usuario el mínimo y máximo permitidos.
- La bodega del rollo debe seguir teniendo `Detalle` habilitado (misma guardia AR de `generarSalidaRollo`); si no, no se puede recrear la fila de existencias.
- Ajustes repetidos: calcular siempre contra `CantidadOriginal`, no encadenar ajuste sobre ajuste.
- Bloquear si `S` cambió mientras el usuario tenía la pantalla abierta (revalidar dentro de la transacción).

## 7. Flujo propuesto

1. Orden en `PendienteValidacion` → botón **"Ajustar consumo de rollo"**.
2. Lista los rollos montados en la orden (serial, referencia, cantidad original R, cantidad actual).
3. El usuario elige uno y digita C; la pantalla muestra `S`, el mínimo (> S) y el máximo (R).
4. Al confirmar: transacción con los puntos 1-5 y 7 de la sección 5 (el 6, `SEL_EjecucionOrden`, solo si aplica), y luego recálculo de merma (punto 8).
5. Mensaje con lo devuelto al inventario (D) y la merma resultante.

La lógica debería vivir en **un solo lugar** que reutilicen ambas pantallas (Mirane `frmValidacionSelladora.vb` y Node), para no repetir el problema de tener dos versiones que se desalinean. Ver pregunta abierta #2.

## 8. Casos borde

- **Rollo ya consumido por completo y fila borrada**: hay que recrear la fila de `INVExistencias` (punto 2). Si el rollo ya fue **remisionado o movido** después, la devolución sigue siendo una entrada válida, pero revisar que el `Detalle` no haya quedado duplicado.
- **Añadir Rollo en día distinto al Iniciar**: la MP queda bajo la Fecha/Lote del ancla, el movimiento Tipo 24 bajo la fecha del día del escaneo. Por eso no buscar por Fecha exacta.
- **Orden de un grupo paralelo**: los hermanos se crean con `sinMateriaPrima=true`; toda la MP está bajo la ancla.
- **Etiqueta única**: el mismo flujo aplica (R = C original, S = peso de una sola etiqueta).

## 9. Preguntas abiertas (para confirmar con el usuario)

1. ¿Cuánta merma mínima exigir? Hoy la regla es solo `C > S`; puede requerir un margen mínimo (kg o %).
2. ¿Dónde va el botón? Opciones: pantalla de validación de Mirane (`frmValidacionSelladora.vb`), página Node de la orden, o ambas con la lógica compartida.
3. En el dictado se mencionó "se insertan las licencias / lo que garantiza": **no encontré escrituras a `INVMovimientosLotes` en el flujo de Tipo 24** (ni en Mirane ni en Node; solo lecturas). Confirmar a qué registro se refería (¿lotes, líneas del movimiento?).
4. `MaterialConsumidoKg` significa cosas distintas: en Mirane suma el peso bruto de **cada etiqueta**; en Node suma el **peso del rollo** solo en Iniciar (y `Añadir Rollo` ni llama a `registrarControlParcialSellado`, así que ni `MaterialTotalKg` ni `MaterialConsumidoKg` se actualizan con rollos adicionales). Definir qué debe representar antes de ajustarlo.
5. ¿Solo el rol de digitador/supervisor puede ajustar, o también el operario?
6. ¿Se permite ajustar una orden ya `Finalizada`? (Hoy no: cambiaría una merma ya cerrada.)

## 10. Hallazgo aparte (relacionado con la merma que no se calculó)

Node escribe y busca `PRDExtrusionControl.TipoProceso = 'SELLADORA'` desde el 16/09/2026
(`sel-inventario-mp.js` líneas 276, 289 y 689; commit `d88853b`; script pendiente
`Node/sql/pendientes/20260916_renombrar_tipoproceso_sellado_a_selladora.sql`).
El código VB de Mirane sigue filtrando `TipoProceso = 'Sellado'` (`ObtenerDatosMermaOrden`,
`CerrarProcesoSellado`, `RegistrarControlParcialSellado`, `ConsControlPesajes.vb` ~110 y ~287).
Con un control creado por Node, `RecalcularMermaSellado` no encuentra el control y sale **en silencio sin
calcular la merma**. Esto explicaría el caso reportado independientemente de que la orden tuviera una sola
etiqueta. Está pendiente de confirmar con el log de debug (`DEBUG_MERMA_SELLADORA.txt`).
