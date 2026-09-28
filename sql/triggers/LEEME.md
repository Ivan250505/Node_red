# Triggers de la Selladora + SQL de Node-RED (COPIA de lectura)

> **Copia** de `Source/Produccion/nueva produccion/triggers/` del repo de **Mirane** (actualizada el 28/09/2026).
> Allá se editan; esta carpeta se vuelve a copiar cuando cambian. Si hay diferencia, manda Mirane.

Aquí vive **todo el SQL que corre solo** cuando la Selladora trabaja:
- Los **triggers** de la base (`SEL_Bultos`, `SEL_PesajeElemento`).
- En `node_red/`, el **SQL que ejecuta Node-RED** con las señales del PLC: pesaje, cierre de bulto y residuos.

**La carpeta canónica es la de Mirane.** Los cambios se hacen aquí y después:
1. Los triggers se corren en la base (Prueba y Producción).
2. El SQL de `node_red/` se pega en los nodos de Node-RED.
3. La carpeta completa se copia al repo de Node, en `sql/triggers/` (copia de lectura para quien trabaje allá).

Por encima de este repo manda lo que devuelve la base:

```sql
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_CierreBulto'));
```

## Triggers

| Archivo | Tabla | Qué hace | Estado |
|---|---|---|---|
| `00_requisito_agregar_idbitacora_sel_bultos_prdproduccion.sql` | — | Crea `SEL_Bultos.IdBitacora` y `PRDProduccion.IdBitacora` (idempotente). | Confirmar en cada base |
| `trg_SEL_Bultos_CierreBulto.sql` | `SEL_Bultos` | Al cerrar un bulto: corrige la hora final si viene mala, pasa cantidad/unidades/hora final/duración a `PRDProduccion`, asigna bitácora por turno y abre el bulto siguiente `Temporal` con fecha real. | **28/09: hora final protegida** + 24/09 (bitácora por turno), **pendientes de aplicar** |
| `trg_SEL_Bultos_GenerarEntradaInventario.sql` | `SEL_Bultos` | Existencias del bulto y entrada a inventario (Tipo 35 por OT). | 23/09 (movimientos por OT) |
| `trg_SEL_Bultos_SuspenderTemporal.sql` | `SEL_Bultos` | Si la ejecución está en suspensión, el bulto nuevo nace `Suspendido` y suspende la OT. | 24/09, **pendiente de aplicar** |
| `trg_SEL_PesajeElemento_ActualizarBulto.sql` | `SEL_PesajeElemento` | Con cada paquete, pasa el bulto de `Temporal` a `Activo` (no suma `number_paqu`, eso lo hace el SQL del pesaje). | Copiado de la base real (28/09) |

### Cambio del 28/09/2026: hora final del bulto

Había bultos con **hora final = hora inicio (Duración 0)** o **sin hora final**. Venía de dos lados:
1. Node-RED cerraba con `@HoraPLC`, que a veces llegaba con la hora del cierre anterior. Se corrige en `node_red/02_cierre_bulto.sql` (`GETDATE()`).
2. El Node, al **Finalizar** la orden, cerraba los bultos `EnEspera` sin hora final. Se corrige en `ejecucion-selladora.js` (repo de Node): hora del último paquete.

Además, `trg_SEL_Bultos_CierreBulto` quedó como red de seguridad: si un bulto se cierra con la hora final vacía o menor o igual a la de inicio, la completa con la hora de su **último paquete pesado** o, si no tiene paquetes, con la hora actual.

## SQL de Node-RED

Ver `node_red/LEEME.md`: qué nodo corre cada archivo, sus parámetros y qué trigger dispara.
