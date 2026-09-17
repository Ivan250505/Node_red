# «Transaction has been aborted» al dar Finalizar

Diagnóstico del 16/09/2026. **El error sigue vivo**: lo de abajo explica la causa y deja el
procedimiento que se usó para desatascar una orden puntual, pero no arregla el problema de fondo.

---

## 1. El síntoma

Al pulsar **■ Finalizar** en la tableta, la pantalla muestra:

```
Transaction has been aborted.
```

Ese mensaje **no es la causa**. Es el tercero de una cadena, y los dos anteriores quedan sepultados.

## 2. El error real

Está dentro de `finalizarControlParcialSellado()` (`sel-inventario-mp.js`), en la consulta que crea
la Orden de Trabajo:

```
Conversion failed when converting date and/or time from character string.

INSERT INTO PRDOrdenesProduccion
  (OrdenProduccion, Lote, Destino, Consecutivo, Fecha, Elemento, LineaAncla,
   TipoProceso, GeneradoPor, FechaCreacion, Estado, HoraInicioReal)
VALUES
  (@op, @lote, @destino, @consecutivo, @fecha, @elemento, @lineaAncla,
   'SELLADORA', @generadoPor, GETDATE(), 'Activa', ISNULL(@horaInicioReal, GETDATE()))
```

Alguno de los parámetros con forma de fecha llega como texto que SQL Server no sabe convertir.
**Todavía no está identificado cuál** — ver «Lo que falta» al final.

Es código reciente: las columnas `Estado`, `HoraInicioReal` y el `TipoProceso = 'SELLADORA'` entraron
con los cambios de Orden de Trabajo del 15 y 16/09/2026.

## 3. Por qué el mensaje engaña

Tres eslabones, cada uno tapando al anterior:

| # | Qué pasa | Mensaje |
|---|---|---|
| 1 | Falla el `INSERT` de la OT | `Conversion failed when converting date and/or time…` ← **la causa** |
| 2 | `mssql` libera la conexión de la transacción. La siguiente consulta no la encuentra | `Transaction has not begun. Call begin() first.` |
| 3 | El `catch` llama a `tx.rollback()`, que no puede revertir una transacción ya muerta | `Transaction has been aborted.` ← **lo que se ve** |

El tercer eslabón es un defecto del manejo de errores, en `ejecucion-selladora.js`:

```js
} catch (err) {
    await tx.rollback();   // si ESTO lanza, su error reemplaza a err
    throw err;
}
```

Como el `rollback()` no está protegido, su excepción sustituye a la original y se pierde el
diagnóstico. **Arreglo recomendado, independiente de la causa raíz:**

```js
} catch (err) {
    try { await tx.rollback(); } catch (errRollback) {
      console.error('Rollback fallido tras el error real:', errRollback.message);
    }
    throw err;   // ahora sí llega la causa
}
```

## 4. Lo que se descartó

Para que nadie repita el camino:

- **Las 7 sentencias de `finalizarOrden()` funcionan.** Se ejecutaron una a una contra la base
  dentro de una transacción revertida: las siete pasan, y `@@TRANCOUNT` sigue en 1 después de cada
  una. El problema es posterior.
- **No hay ningún trigger culpable.** `SEL_Bultos` no tiene trigger de `DELETE`, y ninguno de sus
  tres triggers contiene `ROLLBACK`.
- **No es `@horaInicioReal` en `null` sin tipo.** Era la hipótesis más razonable —`mssql` infiere
  `NVarChar` para un `null` sin tipo declarado— pero se probaron las tres formas
  (`null` sin tipo, `sql.DateTime` con `null`, y una fecha real) y **las tres funcionan**.
- **No hay dos copias de `mssql`.** Se comprobó que `require('mssql')` devuelve la misma instancia
  desde los dos módulos.

## 5. Cómo se encontró (técnica reutilizable)

El error real no aparece por ningún lado hasta que se instrumenta el objeto de transacción. Envolver
`tx.request()` para registrar cada consulta y su resultado deja el fallo a la vista:

```js
const requestOriginal = tx.request.bind(tx);
tx.request = function () {
  const req = requestOriginal();
  const queryOriginal = req.query.bind(req);
  req.query = async function (texto) {
    try   { const r = await queryOriginal(texto); console.log('OK   ', texto.slice(0, 60)); return r; }
    catch (e) { console.log('FALLA', texto.slice(0, 60), '->', e.message); throw e; }
  };
  return req;
};
```

Con eso salieron las 20 consultas de `finalizarControlParcialSellado()` en orden, y la 19 marcada
como la primera que falla.

---

## 6. Finalización forzada de la orden 63

Mientras el bug siga, **ninguna orden se puede finalizar desde la tableta**. La orden 63 se desatascó
a mano el 16/09/2026.

### Qué se hizo

Se aplicaron las **mismas 7 sentencias** que ejecuta `finalizarOrden()`, extraídas del propio
`ejecucion-selladora.js` (no reescritas), dentro de una transacción, y se confirmó. Se **saltó**
`finalizarControlParcialSellado()`, que es el paso roto.

| | |
|---|---|
| Base | `CarlixplastPrueba` **únicamente** |
| Orden | 63 — pedido 11085, `BARBLSTA15L22.5C1.8L1 MARROQUINERIAS MANTRA`, SELLADORA 05 |
| Antes | orden `Activa`, ejecución `Activa`, sin hora de fin |
| Después | orden `PendienteValidacion`, ejecución `PendienteValidacion`, fin `16/09/2026 16:24`, operario final 187 |
| Bultos | los **2 cerrados quedaron intactos**; se eliminó 1 vacío (igual que el finalizar normal) |

Se eligió la orden 63 porque era la única `Activa` del pedido y no tenía ningún bulto en proceso —
la misma condición que exige el finalizar normal para no perder los golpes y la potencia del PLC.

### Qué NO se hizo, y por qué importa

Al saltarse `finalizarControlParcialSellado()`:

- **No se creó la Orden de Trabajo** de esos bultos.
- **No se refrescaron los `PRDProduccion`** con cantidad, unidades, cliente y destino.

Desde la tableta la orden se ve finalizada; desde el escritorio le falta ese respaldo. **En una base
de pruebas es asumible. Esto no sirve como procedimiento para planta.**

### Cómo revertirlo

```sql
USE CarlixplastPrueba;

UPDATE SEL_OrdenProduccion SET Estado = 'Activa' WHERE IdOrden = 63;

UPDATE SEL_EjecucionOrden
   SET Estado = 'Activa', HoraFinReal = NULL, OperarioFinal = NULL
 WHERE IdOrden = 63;
```

El bulto vacío que se eliminó **no se recupera**, pero no contenía ningún paquete: la máquina abre
otro en cuanto se vuelve a producir.

### Si hay que repetirlo en otra orden

Requisitos antes de tocar nada: que la orden esté `Activa` y que **no tenga ningún bulto en estado
`Activo`**. Si lo tiene, hay que esperar a que la máquina lo cierre sola — forzarlo pierde para
siempre los golpes y la potencia que registra el PLC.

```sql
-- Comprobación previa
SELECT ord.Estado,
       (SELECT COUNT(*) FROM SEL_Bultos b
         WHERE b.id_ejecucion = ej.IdEjecucion AND b.estado = 'Activo') AS BultosEnProceso
FROM SEL_OrdenProduccion ord
INNER JOIN SEL_EjecucionOrden ej ON ej.IdOrden = ord.IdOrden
WHERE ord.IdOrden = <idOrden>;
```

El script usado está en el directorio temporal de la sesión, no en el repositorio: extrae las
sentencias de `ejecucion-selladora.js` en tiempo de ejecución, para no acabar con una copia que se
desincronice del original.

---

## 7. Lo que falta

1. **Identificar el parámetro** que rompe el `INSERT`. Pista útil: `@fecha` sí funciona en la
   consulta anterior (`SELECT … WHERE Fecha = @fecha`, que pasa sin problema), así que el sospechoso
   está entre los demás o en la interacción con las columnas nuevas.
2. **Proteger el `rollback()`** del `catch` (sección 3) para que el error real llegue a la pantalla
   la próxima vez. Esto conviene hacerlo aunque la causa raíz se arregle antes.
3. **Revisar `Produccion.vb`** en el escritorio: el mismo cambio de OT se portó allí el 15/09/2026 y
   podría arrastrar el mismo defecto.
