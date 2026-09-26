# Triggers de `SEL_Bultos`

Copia de lectura de los triggers de la base (26/09/2026), para que quien trabaje en Node vea qué hace
la base cuando se cierra un bulto sin tener que abrir el repo de Mirane.

**La versión canónica vive en el repo de Mirane:** `Source/Produccion/nueva produccion/triggers/`. Allá
es donde se editan; esta carpeta se vuelve a copiar cuando cambian. Si hay diferencia, manda Mirane, y
por encima de los dos manda lo que devuelve la base:

```sql
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_CierreBulto'));
```

| Archivo | Qué hace | Estado |
|---|---|---|
| `00_requisito_agregar_idbitacora_sel_bultos_prdproduccion.sql` | Crea `SEL_Bultos.IdBitacora` y `PRDProduccion.IdBitacora` (idempotente). Los usan el trigger de cierre y el botón **Turno** (`corregirTurnoMaquina`). | Confirmar en cada base |
| `trg_SEL_Bultos_CierreBulto.sql` | Al cerrar un bulto: inserta `PRDProduccion` (Turno según `TURHorariosMaquinas.Activo = 1`), asigna `IdBitacora` por Máquina + Turno + FechaTurno, crea el siguiente bulto `Temporal`, promedia Golpes. | Versión del 24/09 (bitácora por turno) **pendiente de aplicar** |
| `trg_SEL_Bultos_GenerarEntradaInventario.sql` | Entrada a inventario del bulto cerrado (movimiento Tipo 35, bodega por línea). | Igual a producción (verificado 17/09) |
| `trg_SEL_Bultos_SuspenderTemporal.sql` | Si la ejecución está en suspensión, el bulto nuevo nace `Suspendido`; versión nueva también suspende la OT. | Versión del 24/09 **pendiente de aplicar** |

Ojo con el turno: el trigger **no calcula el turno por la hora "más corta"**, lee el turno activo de la
máquina. Si en algún momento no hay ningún turno activo que cubra la hora, `@Turno` queda NULL y el
bulto no se inserta en `PRDProduccion` (ver `DIAGNOSTICO_TURNOS.md`, puntos 2 y 3).
