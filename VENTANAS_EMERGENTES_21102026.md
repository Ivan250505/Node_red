# Ventanas emergentes de la tableta

21/10/2026. Listado de las ventanas emergentes (SweetAlert, `Swal.fire`) de la aplicación y de la
condición que hace que salga cada una. Todo sale de `server.js` (155 llamadas a `Swal.fire`). Los
números de línea son los del 21/10/2026 y se corren con cada cambio.

Aquí van las ventanas que preguntan algo o bloquean. Las de "Cargando…", "✓ hecho", "Error" y
"Sin conexión" salen siempre como respuesta a una acción y se agrupan en la sección 7.

**Regla general:** SweetAlert solo muestra una ventana a la vez, así que cada `Swal.fire` cierra la
que esté abierta. Por eso los avisos automáticos esperan a que la pantalla esté libre
(`Swal.isVisible()`) y "Comando enviado" no sale mientras Calidad o la báscula están abiertas
(`hayVentanaQueNoSePuedePerder`).

**Banderas que cambian lo que sale (al 21/10/2026):**

| Bandera | Archivo | Valor | Efecto |
|---|---|---|---|
| `AUTORIZACION_LIDER_ACTIVA` | auth.js | `true` | Salen las ventanas de firma del turno |
| `AUTORIZACION_LIDER_OBLIGATORIA` | auth.js | `false` | La firma del turno es solo un recordatorio, no bloquea |
| `VERIFICACION_BASCULA_ACTIVA` | server.js | `false` | La verificación de báscula está apagada, en el protocolo y en la revisión periódica |
| `CALIDAD_INTERVALO_MIN` | server.js | `30` | Minutos entre chequeos de Calidad de un mismo bulto |
| `MINUTOS_AVISO_FIRMA_TURNO` | server.js | `30` | Minutos antes del fin del turno en que se pide la firma |

---

## 1. Avisos automáticos (salen solos, sin tocar nada)

| Ventana | Cuándo sale | Función / línea |
|---|---|---|
| **Programación pidió suspender esta orden** (pita y vibra) | Cada 5 s se revisa si Programación marcó la orden para suspender. Sale una sola vez por orden. Si hay otra ventana abierta, espera 5 s. | `scriptAvisoSuspension`, ~2069 |
| **Límite de paquetes del bulto** / **Aviso del pesaje** | Cada 5 s. Node-RED avisó que un paquete no se pudo registrar (hoy solo `LIMITE_PAQUETES`, cuando el bulto llega al paquete #99). Al darle "Entendido" se borra el aviso en todas las tabletas de la máquina. | `scriptAvisoPesaje`, ~2122 |
| **Calidad · (apartado)** (asistente de varias pantallas) | Cada 5 s. El bulto Activo ya tiene al menos un paquete y (a) todavía no tiene chequeo, o (b) pasaron 30 min desde su último chequeo. Si el operario cancela, vuelve a salir a los 5 min. | `revisarCalidadDelBulto` / `mostrarApartadoCalidad`, ~3086; servidor ~10288 |
| **🔑 Autorización del turno** (versión con aviso de fin de turno) | Cada 60 s. La bitácora del turno no tiene firma y faltan ≤ 30 min para el fin del turno (o ya se cerró). Con "Más tarde" se vuelve a preguntar a los 5 min. | `revisarFirmaDeTurno`, ~3445 |
| **Verificación de báscula** (la revisión periódica) | Cada 60 s, si el servidor dice que ya pasaron 30–40 min desde la última. **Hoy está apagada.** | `revisarPesoPatron`, ~3199 |
| **⏸ En pausa** (cronómetro, solo se cierra con "Reanudar") | Al cargar la página, si la ejecución está en pausa. | `abrirModalPausaActiva`, ~2985 |
| **Protocolo de arranque / relevo sin terminar** | Al cargar la página, si la orden tiene un protocolo a medias en un paso sin cronómetro. Si el paso es limpieza o alistamiento, se abre directamente su cronómetro. Ofrece Continuar, Ahora no y Cancelar arranque (este último no en el relevo). | `reanudarProtocoloArranque`, ~5577 |
| **Retomar / Reanudar ejecución** | Al cargar la página de la orden o del grupo, si hay que tomar la orden. Le sale a quien no es el dueño, o al mismo operario si cerró sesión con la orden en curso. Ofrece "Solo mirar". | `bloqueRetomar`, ~10433 |
| **¿Va a realizar alguna actividad antes de producir?** | Al cargar la cola después de un Retomar (por el camino viejo, sin protocolo). Si dice Sí, sale **Motivo de la actividad**. | `preguntarActividadInicial`, ~4542 |

"Nuevo pedido en la cola" y "Pizarra" **no** son ventanas emergentes. El primero es una tarjeta que
se va sola a los 7 s y el segundo solo va al panel de notificaciones.

---

## 2. Protocolo de arranque (botón ▶ Iniciar, o Retomar con relevo)

Las ventanas salen en este orden, y cada paso solo aparece si el anterior se completó.

1. **Hay un arranque sin terminar**: otra orden de la máquina tiene su protocolo a medias. Ofrece
   seguir con esa o cancelar su arranque. Si la máquina ya tiene otra orden activa, sale
   **No se puede iniciar**.
2. **Reanudar pedido suspendido**: la orden fue suspendida y Programación la reanudó. Se retoma
   sobre lo ya producido, sin protocolo.
3. **Protocolo de arranque** (o **Protocolo de arranque (relevo)**) → **Limpieza y desinfección
   iniciada** → cronómetro de limpieza. Solo en el arranque normal (no en el relevo) el cronómetro
   trae **¿Cancelar el arranque?** → **Arranque cancelado**.
4. **¿Detecta algún peligro químico?**: si contesta Sí, sale **Comuníquese con el jefe de planta**,
   que se repite hasta que contesta "Ya se resolvió".
5. Solo en el arranque normal: **¿Con cuántas pistas va a trabajar?**
6. Escaneo del rollo (pistola o teclado):
   - Si el rollo es de otro pedido o de otro cliente, sale **El rollo es de otro pedido** / **El
     rollo es de otro cliente**. Es solo un aviso; Cancelar vuelve a pedir el serial.
   - Luego **Chequeo del rollo** (buen estado / peligro físico). Si el rollo está mal o hay
     peligro, sale **Escanee otro rollo**.
7. Con más de una pista: **¿Se monta otro rollo?**, que repite el paso 6 por cada rollo adicional
   (**Otro rollo**). Al final, **Iniciar ejecución** con el resumen de lo montado.
8. En el relevo, en lugar de los pasos 5–7: **Rollo montado** ("Sigo con este rollo" o cambiarlo).
   Si no hay registro del rollo montado, sale **Pite el rollo montado**.
9. **Alistamiento iniciado** → cronómetro del alistamiento.
10. **Verificación de báscula** (**Báscula verificada** / **El peso NO concuerda**). **Hoy está
    apagada**, así que este paso se salta.
11. **Amperaje del ferroníquel** → **Protocolo de arranque completo**.

Si falla la escritura de cualquier paso, sale **No se pudo continuar**, con Reintentar o Salir
(`protocoloIntentar`).

---

## 3. Durante la producción (botones de la página de la orden)

| Ventana | Botón y condición |
|---|---|
| **¿Está seguro de imprimir la etiqueta?** | Imprimir etiqueta. |
| **¿Está seguro de cerrar el bulto?** | Cierre bulto. Si se confirma, también reimprime la etiqueta del último paquete, siempre que el bulto tenga paquetes. |
| **¿Está seguro de marcar este bulto con Retal / Troquelado / Refilado?** / **¿…salida no conforme?** | Botones de residuo. Piden el peso en kg (mayor que 0). |
| **Motivo de la pausa** | Botón Pausa. Alistamiento abre sus submotivos y Otro pide una descripción. Al confirmar se recarga la página y sale **⏸ En pausa**. |
| **Observación** → **Observación registrada** | Botón Observaciones. |
| **🔑 Autorización del turno** / **Turno ya autorizado** / **Todavía no hay bitácora de turno** | Botón Autorización. Cuál sale depende del estado de la bitácora: sin firma, ya firmada o todavía sin bitácora. |
| **Corregir turno** (o **Sin turnos**) | Botón Turno. **Sin turnos** sale si la máquina no tiene turnos configurados para esa hora. |
| **¿Qué turno va a trabajar?** / **Confirme el turno** | Antes de Iniciar o Retomar, solo si un turno está empezando (de 30 min antes a 90 min después de su hora) y todavía no se escogió. |
| **+ Rollo** | Hace el mismo escaneo y chequeo del paso 6 del protocolo y luego abre el cronómetro de alistamiento de materiales. Si no se puede abrir, sale **No se pudo iniciar el alistamiento**. |
| **Cambiando a esta referencia…** | Solo en sellado en paralelo: Imprimir o Cierre sobre una referencia que no es la que está recibiendo paquetes en ese momento. |
| **Comando enviado** | Después de cualquier comando que salió bien. **No sale** si Calidad o la báscula están abiertas, para no cerrarlas. |

---

## 4. Finalizar y cerrar sesión

En **Finalizar**, las ventanas salen en este orden y cada una solo si aplica:

1. **La salida supera la materia prima escaneada**: la salida (bultos más residuos) es mayor que la
   materia prima escaneada. Es solo un aviso: "Finalizar de todas formas" o "Volver a escanear
   rollo".
2. **¿Va a ajustar algún rollo consumido?**: la orden tiene rollos, la salida no supera la materia
   prima y todavía queda margen para devolver. Lleva a **Ajustar consumo de rollo** → **Consumo real
   del rollo** → **Consumo ajustado**.
3. **⚠ Avance incompleto**: alguna referencia lleva menos del 95% y todavía no hay firma. Pide la
   firma del Líder de Sellado o del Jefe de Planta.
4. **Recordatorio: firma del turno**: la bitácora no tiene firma. Hoy no bloquea
   (`AUTORIZACION_LIDER_OBLIGATORIA = false`): Pedir firma, Continuar sin firma o Volver.
5. **¿Finalizar este proceso?**

En **Cerrar sesión**: si el operario tiene una orden Activa, sale el mismo **Recordatorio de firma**
y después la **Observación** de salida (con opción de no escribir). Sin orden activa, sale directo.

---

## 5. Suspender, reanudar y retomar

| Ventana | Condición |
|---|---|
| **Suspender pedido** | Botón Suspender. Motivo y firma (Líder o Jefe de Planta) en la misma ventana; se elige terminar el bulto en curso o suspender ya. Después sale **Suspensión en curso** si hay que esperar a que se cierre el bulto, o **Pedido suspendido** si no. |
| **Reanudar pedido suspendido** / **Reanudar pedido finalizado** | Botón Reanudar en la cola para una orden Suspendida o finalizada por accidente. Pide la firma del Líder o del Jefe de Planta → **Pedido reanudado**. |
| **¿Retomar esta ejecución?** / **¿Reanudar esta ejecución?** | Botón de la cola. Dice "Reanudar" si es el mismo operario. |

---

## 6. Página de bultos

| Ventana | Condición para que aparezca el botón |
|---|---|
| **¿Eliminar el bulto N?** | El bulto está Cerrado, no tiene paquetes, su cantidad es 0, no está validado y no es el primero de la orden. |
| **¿Corregir el conteo del bulto?** | El bulto está abierto (Temporal, Activo o EnEspera) y el conteo de paquetes no coincide con el último paquete. |
| **¿Reabrir el bulto N?** | Solo supervisor. Es el último bulto cerrado de una ejecución Activa y el bulto abierto que le sigue no tiene paquetes. |
| **Paquete N** (menú) → **Cantidad de bolsas** / **Volver a pesar el paquete** / **¿Reimprimir la etiqueta del paquete?** | Se toca cualquier paquete. Si el bulto está Cerrado, se agrega un aviso de que el inventario no se toca. |
| **¿Trasladar el paquete…?** / **¿Trasladar TODO el bulto a…?** | Sección de traslado. Si no se eligió origen o destino, sale **Seleccione el paquete y el bulto destino** / **Seleccione primero un paquete del bulto a mover**. Si el traslado es a otra referencia, la pregunta avisa que cambia el producto. |
| **Corregir turno de la OT** | Solo supervisor, con la OT Activa. **Sin otros turnos** si no hay a cuál pasarla. |

---

## 7. Respuestas y errores (salen siempre como resultado)

- **Errores**: "Error", "No se pudo…", "Sin conexión" y "Error de conexión". Están en casi todos
  los flujos.
- **Confirmaciones de que algo terminó bien**: "Rollo añadido", "Ejecución iniciada", "Bulto
  eliminado", "Bulto reabierto", "Conteo corregido", "Turno corregido", "Paquete trasladado",
  "Peso corregido", etc.
- **Ventanas de carga**: "Suspendiendo…", "Reanudando…", "Trasladando…", "Aplicando ajuste…",
  "Registrando el rollo…", etc.
- **Error al cargar una página**: en el login ("No se pudo ingresar"), el Dashboard, la cola o la
  tableta fija, sale una ventana "Error" si el servidor devolvió un error.
- **Simulador PLC** (solo con base de pruebas): sale "Listo" o "Error" según lo que traiga la URL
  al volver.
- **Pizarra**: "Error" si no se pudo guardar o borrar una nota.
