# Finalizar bloqueado (pedido 11731) y protocolo de arranque cruzado (pedido 11940)

Diagnóstico del 26/09/2026, máquina 7 (Selladora), base de producción `carlixplast`.
**Los dos problemas quedaron resueltos en la base y en el código**, pero el código **todavía no está
desplegado en el servidor de producción** (`192.168.150.107`). Ver «Lo que falta» al final.

Commits: `3a69bba`, `29a6071` y `116b77d`.

---

## 1. «String or binary data would be truncated» al finalizar el pedido 11731

### El síntoma

En la tableta, al pulsar **■ Finalizar** en el pedido 11731 (orden 24) salía la ventana de
**🔑 Autorización**. El líder firmaba y justo después aparecía:

```
String or binary data would be truncated
```

La orden seguía `Activa`. Parecía un fallo de la firma, pero **no lo era**.

### Lo que se descartó

- **La firma sí se guardaba.** `SEL_AutorizacionPedido` tenía las firmas de C.JESID, la última del
  26/09 a las 11:17, con la bitácora del turno.
- **Ningún dato de la firma es demasiado largo.** Los códigos de los 9 usuarios autorizadores
  tienen 7 a 10 caracteres (la columna admite 20), los nombres 16 como máximo (admite 60) y la OT
  `OT-20260925S005M01` tiene 18 (admite 20). Se reprodujo el INSERT de la firma en producción con
  los 9 autorizadores, dentro de una transacción revertida, y ninguno falló.
- **No hay triggers** en `SEL_AutorizacionPedido`.

El error venía del paso siguiente: el Finalizar en sí (`finalizarOrden` → `finalizarControlParcialSellado`).

### La causa

Desde el commit `d2fd35d` (24/09/2026), el Finalizar deja la OT en `'PendienteValidacion'`
(`sel-inventario-mp.js`, `finalizarControlParcialSellado`):

```sql
UPDATE PRDOrdenesProduccion
SET HoraFinReal = GETDATE(),
    Estado = CASE WHEN Estado = 'Activa' THEN 'PendienteValidacion' ELSE Estado END
WHERE OrdenProduccion = @op
```

Pero la columna nunca se preparó para ese valor, **ni en producción ni en pruebas**:

| | Antes | `'PendienteValidacion'` necesita |
|---|---|---|
| `PRDOrdenesProduccion.Estado` | `VARCHAR(15)` | 19 caracteres |
| `CK_PRDOrdenesProduccion_Estado` | `Activa`, `Suspendida`, `Finalizada` | que el valor esté en la lista |

Por eso **todo** Finalizar de la tableta fallaba desde el 24/09, no solo el del 11731. De las 349 OT
de producción, ninguna había llegado nunca a `PendienteValidacion`. La transacción se revertía entera,
así que no quedaron datos a medias.

### El arreglo

Script `sql/pendientes/20260926_estado_pendientevalidacion_ot.sql` (commit `3a69bba`):

- amplía `Estado` a `VARCHAR(20)`, el mismo largo que `SEL_OrdenProduccion.Estado` y
  `PRDExtrusionControl.Estado`;
- rehace el CHECK con `Activa`, `Suspendida`, `PendienteValidacion` y `Finalizada`;
- no toca el DEFAULT (`'Activa'`) ni la nulabilidad.

**Ya se corrió en `carlixplast` y `carlixplastPrueba`.** Después de correrlo, el Finalizar del 11731
funcionó: la orden 24 quedó en `PendienteValidacion`.

No hizo falta tocar código: el Finalizar ya estaba bien, lo que estaba mal era la tabla.

---

## 2. «Protocolo de arranque sin terminar» en el pedido 11940

### El síntoma

Justo después de finalizar el 11731, en la pantalla de la máquina 7 apareció:

```
Protocolo de arranque sin terminar
Falta escanear el rollo y responder su chequeo para poder seguir.
[Continuar protocolo]  [Ahora no]
```

No era del 11731. Era del **pedido 11940 (orden 25)**, el siguiente en la cola.

### Qué pasó

| Hora | Operario | Qué hizo |
|---|---|---|
| 25/09, 19:16 | 182 – Jesús Orejarena | Retomó el 11731 (relevo). Quedó `Activa` en la máquina 7 |
| 25/09, 22:19 | 182 – Jesús Orejarena | **Dio ▶ Iniciar en el 11940** con el 11731 todavía activo. Arrancó la limpieza (paso 1) |
| 25/09 → 26/09 | — | La limpieza del 11940 quedó corriendo toda la noche (**casi 13 horas** en `SEL_TiempoMuerto`) |
| 26/09, 11:05 | 180 – Andrés Abaunza | Cerró esa limpieza y respondió el peligro químico. No escaneó el rollo |
| 26/09, 11:10 | 180 – Andrés Abaunza | Se pasó al 11731 para terminarlo |

La ventana no había salido antes porque la pantalla de la máquina muestra el protocolo pendiente de
**una sola orden** y le da prioridad a la `Activa` (`obtenerProtocoloPendienteMaquina`). Mientras el
11731 estuvo activo, con su protocolo completo, el 11940 quedaba oculto. Al finalizar el 11731, el
11940 pasó a ser la orden revisada.

### La causa de fondo

El botón **▶ Iniciar** no revisaba si la máquina ya tenía otra orden activa. La regla existía
(`validarPuedeIniciar` en `ejecucion-selladora.js`: *«La máquina ya tiene un proceso activo. Primero
finalice ese proceso»*), pero **solo se aplicaba en el paso del rollo**. La limpieza y el peligro
químico se guardaban sin revisar nada.

Lo más probable es que a Andrés la tableta lo frenara con ese mensaje al llegar al rollo, y por eso
se fue a finalizar el 11731.

### El arreglo

**Datos (producción).** A pedido del usuario se borró el protocolo a medias del 11940: los 2 pasos de
`SEL_ProtocoloArranque` (ids 114 y 116) y la limpieza de `SEL_TiempoMuerto` (id 129). Antes se
comprobó que fueran exactamente esas filas y que la orden no tuviera bultos, rollos ni escaneos
pendientes. La orden 25 queda en `Pendiente`, como si nunca hubiera arrancado.

**Código** (commit `116b77d`). La regla de `validarPuedeIniciar` ahora se aplica desde el primer paso:

- **Tableta:** ▶ Iniciar consulta `GET /api/selladora/orden/:idOrden/puede-iniciar` antes de abrir el
  protocolo. Si la máquina tiene otra orden `Activa`, muestra el aviso y no registra nada.
- **Servidor:** `bloqueoArranquePorOrdenActiva` rechaza `POST /pausar` (donde arranca el cronómetro de
  la limpieza) y `POST /protocolo/respuesta` para órdenes `Pendiente` con otra `Activa` en la máquina.
  Así no se salta ni sin la pantalla ni desde un protocolo que ya iba a medias.
- Las rondas de **relevo** no cambian: corren sobre la orden que ya está `Activa`.

---

## 3. Autorización del líder: ahora por bitácora de turno

Cambio de regla pedido por el usuario el mismo día (commit `29a6071`). La firma pasó de ser **por
pedido** a ser **por bitácora de turno** de la máquina (`SEL_BitacoraTurno`). Hubo un paso intermedio
por OT (`4dfa6e4`) que se descartó.

- Para **finalizar** o **cerrar sesión** con un pedido activo se exige firmada la **bitácora más
  reciente de la máquina**, abierta o ya cerrada. La bitácora se cierra sola a la hora oficial de fin
  del turno (`cerrarBitacorasPorFinTurno`, cada 5 min). Por eso el operario que sale pocos minutos
  después igual necesita la firma de su turno.
- Desde **30 minutos antes** del fin del turno la tableta abre sola la ventana de firma. «Más tarde»
  la vuelve a pedir a los 5 minutos (`vigilarFirmaDeTurno`).
- Una firma cubre todas las órdenes de esa máquina en el turno. El pedido y la OT se siguen guardando
  en cada firma, pero solo como registro.
- Script `sql/pendientes/20260925_autorizacion_por_bitacora.sql`, **ya corrido en las dos bases**.

---

## Lo que falta

1. **Desplegar el código en el servidor de producción** (`192.168.150.107`) y reiniciar Node. Hasta
   entonces allá sigue la versión anterior: la firma no se exige por bitácora y se puede iniciar un
   pedido con otro activo.
2. **Bitácoras viejas sin firma.** En producción hay 4 bitácoras cerradas sin firma, todas de la
   máquina 7 (IdBitacora 1 a 4, del 14 al 23/09), de antes de la regla. No bloquean a nadie; queda a
   criterio si se pide la firma retroactiva. El script de la autorización las lista al final.
3. **Hueco conocido de la firma por turno.** Si un operario se va sin cerrar sesión, su bitácora puede
   quedar sin firma: el siguiente toma control, nace una bitácora nueva y la anterior ya no se exige.
   Se puede cerrar bloqueando la toma de control mientras la bitácora anterior no tenga firma.
   **Sin decidir.**
4. **Finalizar sin probar de punta a punta.** Se confirmó que funciona con el 11731 en producción, pero
   no hay una prueba automática. Si aparece otro error de truncado, revisar primero que los
   `Estado` nuevos quepan en su columna y en su CHECK.
