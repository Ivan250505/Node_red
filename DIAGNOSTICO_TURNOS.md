# Diagnóstico: turnos de 8 y 12 horas (M/T/N y D/V)

Fecha: 26/09/2026
Commits revisados: `843cbb9` (Turno activo: escoger antes de Iniciar y de retomar) y `f267c8a` (Corregir turno desde la tableta, botón Turno).

## Contexto

La planta trabaja en turnos de 8 horas (M 06–14, T 14–22, N 22–06) o de 12 horas (D 06–18, V 18–06). El operario escoge cuál va a trabajar al iniciar sesión. Esa elección debe llegar a todas las tablas que guardan turno o bitácora:

- `SEL_BitacoraTurno` (`Turno`, `FechaTurno`, `Serial` con la letra D/V/M/T/N)
- `PRDProduccion.Turno` (bultos, los inserta el trigger `trg_SEL_Bultos_CierreBulto`)
- `PRDOrdenesProduccion` (`Turno`, letra en el código de la OT y consecutivo por Fecha + Máquina + Turno)
- `SEL_TiempoMuerto.IdBitacora`
- `SEL_ObservacionOperario.IdBitacora`
- `SEL_AutorizacionPedido` (firma del líder, aviso 30 minutos antes del fin del turno)

Si cada parte vuelve a calcular el turno a partir de la hora, las tablas terminan en desacuerdo. Antes de estos commits, la regla "gana la franja más corta" hacía que D y V no se eligieran nunca.

## Qué resolvieron los commits

**`843cbb9`:** el turno escogido se guarda marcándolo con `Activo = 1` en `TURHorariosMaquinas` y apagando los que se cruzan con él. Todo lo que ya leía `Activo = 1` pasa a coincidir con la elección. La ventana para escoger sale en Iniciar y en Reanudar/Retomar (que también es el camino de un relevo).

**`f267c8a`:** agrega el botón **🕘 Turno** para corregir una elección equivocada. En una sola transacción corrige el turno activo, la bitácora abierta (o la une a la del turno correcto si ya existe), `PRDProduccion.Turno` e `IdBitacora` de los bultos, y registra el cambio en `SISMovimientos`. La OT no se toca, por decisión explícita.

| Tabla / proceso | Estado |
|---|---|
| Bitácora (`Turno`, `FechaTurno`, serial D/V) | ✅ `resolverTurnoMaquina` solo usa turnos activos. Una jornada D ya no se cierra por error a las 14:00 |
| Bultos (`PRDProduccion.Turno`) | ✅ Coinciden, siempre que no haya dos turnos activos cruzados |
| OT (`PRDOrdenesProduccion`) | ✅ `resolverTurnoPorHora` ya leía `Activo = 1` |
| `SEL_TiempoMuerto.IdBitacora` | ✅ Usa `resolverTurnoMaquina`, ya corregido |
| `SEL_ObservacionOperario.IdBitacora` | ✅ Toma la bitácora abierta |
| Firma del líder y cierre automático | ✅ Se calculan desde `bi.Turno`, que ahora queda bien guardado |

## Hallazgos

### 🔴 1. Iniciar y Retomar se bloquean si falla la consulta del turno (error introducido en `f267c8a`)

`server.js`, al final de `elegirTurnoSiHaceFalta` (alrededor de la línea 3303): el diff reemplazó `.catch(function() { seguir(); });` por `};`. Si la consulta `GET /turno-pendiente` falla (corte de red, o sesión expirada que devuelve la página de login y hace fallar `r.json()`), `seguir()` nunca se ejecuta. **Iniciar y Retomar no hacen nada y no muestran ningún mensaje.**

**Arreglo:** volver a poner `.catch(function() { seguir(); })` después del `})` que cierra el `.then` principal.

### 🔴 2. Horas sin ningún turno activo: los bultos no llegan a `PRDProduccion`

`activarTurnoMaquina` solo apaga los turnos que se cruzan con el elegido. No revisa que las 24 horas queden cubiertas. Ejemplo:

1. Ayer se eligió D, lo que apagó M y T.
2. Hoy a las 06:00 se elige M, lo que apaga D. T sigue apagado.
3. Desde las 14:00, hasta que alguien retome y escoja, **no hay ningún turno activo**.

En ese caso el trigger deja `@Turno = NULL` y no inserta el bulto (`IF @Turno IS NOT NULL`, `corregir_trigger_cierrebulto_unidades.sql:194`). El botón Turno tampoco lo recupera, porque solo modifica filas que ya existen en `PRDProduccion`.

**Arreglo propuesto:** al elegir un turno, dejar activos también los que completan el día sin cruzarse (D → V; M → T y N). Como protección adicional, que el trigger use el turno de la bitácora abierta de la máquina cuando no encuentre un turno activo.

### 🔴 3. Huecos de 5 minutos en los horarios de 12 horas

En `TURHorariosMaquinas`, Pleno Día está como 06:00–**17:55** y Pleno Noche como 18:00–**05:45**. En una jornada D o V, los bultos que cierran entre 17:55–18:00 y 05:45–06:00 no tienen turno, y aplica lo mismo del punto 2.

**Arreglo:** corregir los datos a 06:00–18:00 y 18:00–06:00.

### 🟠 4. Columnas que no están en el repositorio

`corregirTurnoMaquina` actualiza `PRDProduccion.IdBitacora` y `SEL_Bultos.IdBitacora`. Ningún script de `sql/` crea esas columnas, y el trigger que está en el repo tampoco las llena. Probablemente la versión del trigger en la base es más nueva que el archivo. Si alguna de las dos columnas no existe en producción, la transacción completa falla y el botón Turno siempre da error.

**Acción:** confirmarlo en la base y dejar el script y el trigger actualizados en `sql/`.

### 🟠 5. Una corrección tardía divide la jornada

La corrección solo modifica la bitácora abierta y ofrece los turnos que cubren la hora actual. Ejemplo: el operario eligió M y a las 15:00 se da cuenta de que era D. La bitácora M ya se cerró sola a las 14:00 y está abierta una T. El botón convierte la T en D, pero la M (06–14) y sus bultos siguen como M. El día queda repartido en dos bitácoras.

**A decidir:** si la corrección debe alcanzar también la bitácora anterior de la misma jornada.

### 🟠 6. La OT queda distinta de sus bultos

Después de corregir, `PRDProduccion.Turno` queda en D, pero `PRDOrdenesProduccion.Turno`, la letra en el código de la OT y el consecutivo siguen en M. Es intencional ("se resuelve aparte"), pero cualquier reporte que cruce la OT con sus bultos por turno va a mostrar diferencias.

### 🟠 7. Una bitácora sin turno no se cierra nunca

Si la máquina tiene horarios pero ninguno activo a esa hora, `resolverTurnoMaquina` devuelve turno NULL. Antes se usaban los turnos base. Esa bitácora queda sin serial y `cerrarBitacorasPorFinTurno` no la cierra, porque exige `Turno IS NOT NULL`. Con el botón Turno ahora se puede arreglar a mano, pero sigue pasando.

### 🟡 8. Las tabletas modifican la configuración que también usa Mirane

`TURHorariosMaquinas.Activo` ahora se cambia desde dos lugares de la tableta. Si algún reporte de Mirane calcula el turno de registros viejos por hora con `Activo = 1`, sus resultados cambiarían cada vez que alguien escoja turno.

**Acción:** confirmarlo con quien mantiene Mirane.

### 🟡 9. La corrección no pide autorización ni motivo

Cualquier usuario con sesión puede cambiar el turno y mover bultos. En `SISMovimientos` el motivo siempre queda con el texto por defecto.

**A decidir:** exigir la firma del líder o al menos pedir el motivo.

### 🟡 10. La sesión dura 8 horas

La cookie de sesión dura 8 horas (`maxAge` en `server.js:66`). En una jornada D o V el operario pierde la sesión a mitad de turno.

**Arreglo:** subir el `maxAge` a unas 12–13 horas.

### ⚪ 11. Menor: el usuario puede quedar NULL en el registro

En la corrección, el usuario se guarda como `Number(req.session.usuario.codigo)`. Si `SISUsuarios.Codigo` tiene letras, queda NULL en `SISMovimientos`.

## Prioridades

1. **Ya:** devolver el `.catch` (punto 1).
2. **Antes de producción:** cubrir las horas sin turno (puntos 2 y 3) y confirmar las columnas `IdBitacora` (punto 4). Son los que pueden hacer perder producción sin que nadie se dé cuenta.
3. **Después:** sesión de 12 horas (punto 10), el alcance y la autorización de la corrección (puntos 5 y 9), y el cruce OT–bultos y Mirane (puntos 6 y 8).
