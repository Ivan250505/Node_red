# Cambio en Node-RED: hora final del cierre de bulto

**Fecha:** 28/09/2026
**Nodos a modificar:** los **dos** que cierran el bulto:
1. El cierre **automático** (al completar los paquetes).
2. El del botón **"📦 Cierre bulto"** de la tableta.

---

## Problema

Al cerrar el bulto, la hora final (`HoraFin`) se llena con `@HoraPLC`:

```sql
b.HoraFin = @HoraPLC,
```

En algunos cierres llega un `@HoraPLC` **viejo**: la misma hora del cierre del bulto anterior, idéntica al milisegundo. Como cada bulto nuevo arranca con la hora final del anterior, el bulto queda con:

- **Hora final = hora inicio**
- **Duración = 0 minutos**, aunque tenga kilos reales.
- El bulto siguiente también arranca con esa hora vieja.

Casos reales:

| Bulto | Fecha | Máquina | Síntoma |
|---|---|---|---|
| 35967 Línea 6 | 25/09 | 7 | Duración 0 |
| 36788 Línea 6 | 26/09 | 7 | Duración 0 |
| 22421 Línea 2 | 27/09 | 7 | 03:29 → 03:29, 18.20 kg, Duración 0 |

## Solución

Usar la hora del **servidor de base de datos** (`GETDATE()`) en vez de `@HoraPLC`. Es el mismo reloj que ya usan el pesaje de paquetes y la tableta, así todo queda con la misma hora.

**Solo cambia una línea.** Los golpes y la potencia se siguen calculando igual que hoy (promedio de los paquetes). **No se declara ninguna variable**; se usan las que ya declara Node-RED (`@MiMaquina`).

### SQL para pegar (en los dos nodos)

```sql
UPDATE b
      SET b.estado   = 'Cerrado',
          b.HoraFin  = GETDATE(),
          b.Golpes   = agg.GolpesTotal,
          b.Potencia = agg.PotenciaPromedio
      FROM carlixplast.dbo.SEL_Bultos b
      CROSS APPLY (
          SELECT
              ISNULL(AVG(pe.Golpes), 0)               AS GolpesTotal,
              CAST(AVG(pe.Potencia) AS DECIMAL(10,3))  AS PotenciaPromedio
          FROM carlixplast.dbo.SEL_PesajeElemento pe
          WHERE pe.id_bulto = b.id
      ) agg
      WHERE b.id_maquina = @MiMaquina
        AND b.estado IN ('Activo', 'Temporal');
```

**Cambio respecto a lo que hay hoy:**

```diff
-          b.HoraFin  = @HoraPLC,
+          b.HoraFin  = GETDATE(),
```

### Alternativa (si se quiere seguir usando la hora del PLC)

Usa `@HoraPLC`, pero si viene vacía o no es posterior a la hora de inicio del bulto, toma la del servidor:

```sql
          b.HoraFin  = CASE WHEN @HoraPLC IS NULL OR @HoraPLC <= b.HoraInicio
                            THEN GETDATE() ELSE @HoraPLC END,
```

**Se recomienda la primera opción (`GETDATE()`)**: es más simple y no depende de que el PLC mande bien la hora.

---

## Qué NO cambia

- La condición del `WHERE` (máquina y estado `Activo`/`Temporal`).
- El cálculo de golpes y potencia.
- Todo lo demás lo sigue haciendo la base de datos, igual que hoy (trigger de cierre): pasar la cantidad, las unidades y la duración a Producción, abrir el bulto siguiente y la entrada a inventario.

## Cómo verificar después de pegarlo

Cerrar un par de bultos y revisar que la hora final sea la real y la duración mayor a 0:

```sql
SELECT TOP 10 b.id, b.serialPadre, b.HoraInicio, b.HoraFin,
       DATEDIFF(MINUTE, b.HoraInicio, b.HoraFin) AS Minutos, b.CantidadTotal
FROM carlixplast.dbo.SEL_Bultos b
WHERE b.id_maquina = 7 AND b.estado = 'Cerrado'
ORDER BY b.id DESC;
```

(Cambiar `7` por la máquina donde se probó.)
