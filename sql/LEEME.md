# Scripts de base de datos

Todos los `.sql` del proyecto viven acá. Antes estaban sueltos en la raíz, 32 archivos sin orden
ni fecha, y no había forma de saber cuál se había corrido ni dónde (reorganizado el 15/09/2026).

## Las tres carpetas

| Carpeta | Qué contiene |
|---|---|
| `aplicados/` | Migraciones **ya ejecutadas en producción**. Son el histórico: describen cómo llegó la base a donde está, y son lo que se correría en orden para levantar una base desde cero. |
| `pendientes/` | Migraciones escritas pero **todavía no ejecutadas**. Hoy está vacía. Cuando una se aplique en todas las bases, se mueve a `aplicados/`. |
| `herramientas/` | Cosas que **no son migraciones**: diagnósticos de solo lectura y scripts de reversión. No se corren como parte de ningún despliegue. |

El prefijo de fecha (`AAAAMMDD_`) es la fecha en que el archivo entró al repositorio, sacada de
git. Sirve para dos cosas: que el orden alfabético sea el orden cronológico de ejecución, y que se
vea de un golpe qué tan viejo es cada uno.

## Estado por base (comprobado contra la base el 15/09/2026)

| Script | Producción | Prueba |
|---|:--:|:--:|
| `20260824_agregar_codigooperarioprd_sisusuarios.sql` | ✅ | ✅ |
| `20260824_agregar_operarioactualmaquina.sql` | ✅ | ✅ |
| `20260824_agregar_qr_accesos.sql` | ✅ | ✅ |
| `20260831_agregar_tipos_tiempomuerto.sql` | ✅ | ✅ |
| `20260901_agregar_orden_aseo_tiempomuerto.sql` | ✅ | ✅ |
| `20260904_agregar_proximacalidad_ejecucionorden.sql` | ✅ | ✅ |
| `20260909_agregar_protocolo_arranque.sql` | ✅ | ✅ |
| `20260909_agregar_repesaje_paquete.sql` | ✅ | ✅ |
| `20260909_agregar_rollo_ejecucion.sql` | ✅ | ✅ |
| `20260909_agregar_temperatura_perilla.sql` | ✅ | ✅ |
| `20260910_arreglar_traslado_bulto_vacio.sql` | ✅ | ✅ |
| `20260911_subir_a_produccion_sellado_paralelo.sql` | ✅ | ✅ |
| `20260913_agregar_bitacora_turno.sql` | ✅ | ✅ |
| `20260913_agregar_calidad_por_bulto_y_medidas.sql` | ✅ | ✅ |
| `20260913_agregar_unidadespaquete_pesajeelemento.sql` | ✅ | ✅ |
| `20260913_sellado_paralelo_pasos/` (13 pasos) | ✅ | ✅ |
| `20260915_agregar_amperaje_ferroniquel.sql` | ✅ | ✅ |
| `20260915_corregir_duracionminutos_tiempomuerto.sql` | ✅ | ✅ |
| `20260916_igualar_prueba_con_produccion.sql` | — *(solo Prueba)* | ✅ |
| `pendientes/20260918_agregar_ajuste_consumo_rollo.sql` | ⏳ **falta** | ✅ |

**Falta correr `20260918_agregar_ajuste_consumo_rollo.sql` en producción** (18/09/2026). Ya está
aplicado y probado de punta a punta en `carlixplastPrueba`. Sin él, el botón "Ajustar consumo de
rollo" de la tableta avisa que falta el script y no deja hacer nada -- el resto de la aplicación
sigue funcionando igual. Es aditivo (una columna nullable en `SEL_RolloEjecucion` y la tabla nueva
`SEL_AjusteConsumoRollo`) y se puede re-ejecutar sin daño.

Sigue pendiente también `20260916_renombrar_tipoproceso_sellado_a_selladora.sql`: comprobado el
18/09/2026 contra Prueba, conviven 38 controles con `TipoProceso = 'Sellado'` y 5 con `'SELLADORA'`.
Mientras no se corra, el VB de Mirane (que filtra por `'Sellado'`) no encuentra los controles que
crea Node y `RecalcularMermaSellado` sale en silencio sin calcular la merma.

El 16/09/2026 se igualó `CarlixplastPrueba` con producción y se
comprobó columna por columna que no queda ninguna diferencia en las tablas `SEL_`: mismos tipos,
mismos anchos, misma nulabilidad y las mismas tres restricciones `CHECK`.

Ojo al comprobarlo de nuevo: `OBJECT_NAME()` resuelve en la base **actual**, no en la que se
consulta, así que comparar restricciones entre bases con nombres a tres partes da resultados
falsos. Hay que consultar cada base con su propio `USE`, o unir `sys.check_constraints` con
`sys.tables` dentro de cada una.

## Dos cosas que hay que saber antes de usar esto

### 1. Hay definiciones duplicadas

El mismo objeto está definido en varios archivos. No son versiones distintas: son copias derivadas
del mismo original (la de `20260913_sellado_paralelo_pasos/07` lo dice en su encabezado, *"Origen:
subir_a_produccion_sellado_paralelo.sql, Paso 2"*). Aun así, si mañana hay que recrear una de esas
tablas, no hay nada que indique cuál es la buena:

| Objeto | Definido en |
|---|---|
| `SEL_RolloEjecucion` | `20260909_agregar_rollo_ejecucion.sql`, `20260911_subir_a_produccion...`, `20260913_sellado_paralelo_pasos/07` |
| `UnidadesPaquete` | `20260913_agregar_unidadespaquete...`, `20260913_sellado_paralelo_pasos/12` y `/13` |
| `PRDGrupoEtapasCompartidas` | `20260911_subir_a_produccion...`, `20260913_sellado_paralelo_pasos/03` a `/06` |
| `sp_SEL_AnularBultoVacio` | `20260910_arreglar_traslado_bulto_vacio.sql`, `20260911_subir_a_produccion...`, `20260913_sellado_paralelo_pasos/10` y `/11` |

Mientras eso siga así, `aplicados/` **no se puede correr de punta a punta** sobre una base vacía sin
revisar antes qué se pisa con qué.

### 2. La carpeta `20260913_sellado_paralelo_pasos/` se llamaba "pendientes"

Era `pendientes_bd_sellado_paralelo/` y su `00_LEEME.txt` dice que junta "TODO lo que quedó
pendiente de correr". Ya no queda nada pendiente ahí: se comprobó objeto por objeto y todo existe
en las dos bases. Se renombró para que el nombre deje de mentir, pero **ese `00_LEEME.txt` sigue
hablando en futuro** y conviene leerlo con eso en mente. Sus archivos van sin `GO` a propósito, uno
por lote, para poder correrlos de a uno en DBeaver.

## Lo que falta para que esto se sostenga solo

Nada de esto se actualiza por su cuenta: la tabla de arriba la mantiene quien corra un script. El
arreglo de verdad es una tabla `SEL_Migraciones` en la base donde cada script deje su nombre y la
fecha al ejecutarse — así la base misma dice qué se le aplicó y se acaba el "¿esto ya se corrió?".
Mientras tanto, **quien ejecute algo tiene que venir a marcarlo acá**.
