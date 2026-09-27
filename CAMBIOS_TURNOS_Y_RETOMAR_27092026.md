# Cambios 27/09/2026 — turnos activos y Retomar/Finalizar

Dos errores reales vistos en la **máquina 7 (SELLADORA 05)** la mañana del 27/09/2026. Los dos venían
de los cambios del 26/09 (commits `843cbb9`, `f267c8a` y `077cc04`).

---

## 1. Turnos activos: quedaban horas sin ningún turno

### Qué pasó
Estaban activos Mañana, Tarde y Noche. A las 06:00 el operario escogió **Pleno Día** y quedaron activos
**Pleno Día + Noche**:

| Turno | Horario | Quedó |
|---|---|---|
| Mañana | 06:00–14:00 | apagado |
| Tarde | 14:00–22:00 | apagado |
| Noche | 22:00–06:00 | **activo** |
| Pleno Noche | 18:00–05:45 | apagado |
| Pleno Día | 06:00–17:55 | activo |

Resultado: **de 17:55 a 22:00 no hay ningún turno activo**. En ese rato `trg_SEL_Bultos_CierreBulto` no
encuentra turno y **no inserta el bulto en `PRDProduccion`**; la bitácora tampoco resuelve turno.

### Por qué
`planTurnosActivos` (versión del 26/09) solo apagaba los turnos que **se cruzan** con el escogido y
encendía los libres que **no chocaran con ningún activo**. Al escoger Pleno Día se apagaron Mañana y
Tarde, pero la Noche no se cruza con Pleno Día y siguió activa; y como la Noche sí se cruza con Pleno
Noche, este no se pudo encender.

### Qué cambió (`sel-inventario-mp.js`)
- **`planTurnosActivos`** ahora arma el **juego completo que cubre el día** a partir del turno escogido,
  sin cruces y prefiriendo los de su misma duración, y **apaga todo lo demás** (se cruce o no):

  | Escoge | Queda activo | Se apaga |
  |---|---|---|
  | Pleno Día | Pleno Día + Pleno Noche | Mañana, Tarde, Noche |
  | Pleno Noche | Pleno Noche + Pleno Día | Mañana, Tarde, Noche |
  | Mañana / Tarde / Noche | Mañana + Tarde + Noche | Pleno Día, Pleno Noche |

  Devuelve también `minutosSinCubrir` (> 0 solo si los **horarios** no alcanzan a cubrir el día).
  La usan la ventana de turno al Iniciar/Retomar (`activarTurnoMaquina`) y el botón 🕘 Turno
  (`corregirTurnoMaquina`).
- **`repararCoberturaTurnos`** (nueva): guardia que corre **cada 5 minutos** junto con el cierre de
  bitácoras (`server.js`, `revisarFinTurno`, antes de `cerrarBitacorasPorFinTurno`). En cada máquina
  vuelve a armar el juego completo a partir del turno que está corriendo **ahora**; ese nunca se cambia.
  Si la hora cae en un hueco, parte del activo que **acaba de terminar** (así un hueco de 5 minutos en
  los datos no voltea una jornada de 12 h a turnos de 8 h). Arregla el estado venga de donde venga
  (Mirane GestionTurnos, un UPDATE a mano, la regla vieja). No toca las máquinas que ya están bien y
  deja en consola lo que repara.

Con esto, al reiniciar Node la máquina 7 pasa sola de Pleno Día + Noche a **Pleno Día + Pleno Noche**.

### Lo que NO arregla
Los huecos de **17:55–18:00** y **05:45–06:00** vienen de los horarios (Pleno Día termina 17:55 y Pleno
Noche 05:45), no de los activos. Se arreglan con `sql/pendientes/20260926_corregir_horas_turnos_12h.sql`.

---

## 2. Retomar (y Finalizar) se perdía sin avisar

### Qué pasó
A las 06:00 Andrés (operario 180) le dio **Retomar ejecución** y escogió Pleno Día. El turno sí se
activó, pero **el Retomar nunca llegó al servidor**:

- la máquina y la ejecución siguieron a nombre del operario de la noche (183);
- no se abrió la bitácora de la mañana;
- no se marcó el protocolo de relevo;
- los bultos siguientes salieron con el `GeneradoPor` del operario de la noche.

Andrés siguió trabajando desde la página de la orden (Node no exige haber retomado).

### Por qué
La cola de la máquina **se redibuja cada 4 segundos** (`scriptActualizarCola` reemplaza el `innerHTML`
de `#cola-ordenes`) y el botón Retomar es un `<form>` dentro de ella. Desde el 26/09,
`confirmarTomarControlEjecucion` llama `formulario.submit()` **después** de la ventana del turno (consulta
+ elección + POST `/turno`). Mientras el operario escogía pasaron más de 4 s, la cola se redibujó y ese
`<form>` ya no estaba en la página: **el navegador descarta en silencio el envío de un formulario que ya
no está en la página**. Finalizar, que también vive en la cola y pasa por dos ventanas (firma del líder
y confirmación), tenía el mismo riesgo.

### Qué cambió (`server.js`)
- **`confirmarTomarControlEjecucion`**: guarda la dirección del formulario apenas se toca el botón y, al
  terminar las ventanas, envía un **formulario nuevo** pegado al `body` con esa dirección.
- **`enviarFormularioNuevo`** (nueva, en `scriptConfirmarFinalizar`): lo mismo para **Finalizar**
  (`confirmarFinalizarPaso2`).
- **`scriptActualizarCola`**: no redibuja la cola mientras haya una ventana abierta (`Swal.isVisible()`).

Con esto, cada Retomar llega a `tomar-control-ejecucion` y deja guardado todo lo que hace esa ruta:
operario de la ejecución, operario actual de la máquina (`SEL_OperarioActualMaquina`, de donde el
trigger saca operario y `GeneradoPor` de los bultos), bitácora del turno y marca de relevo.

---

## Al desplegar

1. Reiniciar Node. En la primera pasada de la guardia se reparan los turnos activos (ver consola:
   `Turnos activos reparados en máquina …`).
2. Correr, si no se ha hecho, `sql/pendientes/20260926_corregir_horas_turnos_12h.sql` (horarios de 12 h).
3. Datos del 26–27/09 en la máquina 7 (scripts en Mirane,
   `Source/Produccion/nueva produccion/orden_trabajo/2_migracion_historicos/`):
   - `corregir_retomar_andres_maquina7_27092026.sql`: bitácora de la mañana del 27/09, operario actual,
     `PRDProduccionOperarios` y `GeneradoPor` desde las 06:00.
   - Bitácora de la noche del 26/09 abierta desde las 22:00 (script entregado en la conversación).

## Pendientes (no incluidos aquí)

- Exigir el Retomar: si el operario logueado no es el dueño de la ejecución, bloquear los botones de la
  orden hasta que retome.
- Abrir sola la bitácora del turno siguiente cuando el cierre automático cierra la anterior y la
  máquina sigue con una orden activa.
- Cierre de bulto en Node-RED: `HoraFin = @HoraPLC` llegó con un valor viejo en 3 bultos (duración 0).
  El SQL corregido (`HoraFin = GETDATE()`) está en Mirane, `nueva produccion/node_red/02_cierre_bulto.sql`,
  pendiente de pegar en Node-RED.
- Escaneo de rollo: aceptar solo existencias con `Cantidad > 0` (hoy toma cualquier renglón, incluso
  negativo, y la orden arranca sin materia prima).
