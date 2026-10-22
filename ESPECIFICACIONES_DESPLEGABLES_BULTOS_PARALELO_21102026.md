# Especificaciones visuales — desplegables de "Ver bultos" (sellado en paralelo)

21/10/2026. Estado actual de los dos desplegables de la página de bultos de un pedido con varias
referencias de salida (`/selladora/:maquina/grupo/:idGrupo/bultos`): el **filtro por referencia** y
los de **Trasladar paquete entre bultos**. Todo sale de `server.js`.

---

## 1. Filtro por referencia

- HTML: `renderBultosGrupo` (server.js, ~línea 8968).
- Estilos: `.filtro-refs*` en `estilosBase` (server.js, ~líneas 993-1008).
- Comportamiento: `scriptFiltroReferencias` (server.js, ~línea 8580).

### Contenedor `.filtro-refs`

Franja blanca encima de las tarjetas de bultos.

| Propiedad | Valor |
|---|---|
| Fondo | blanco |
| Esquinas | 14px |
| Relleno | 12px arriba/abajo, 14px a los lados |
| Sombra | `0 1px 4px rgba(0,0,0,0.08)` |
| Separación inferior | 14px |
| Distribución | una fila (flex), centrada en vertical, 12px entre elementos, pasa a otra línea si no cabe |

### Elementos, de izquierda a derecha

| Elemento | Especificación |
|---|---|
| Punto `.filtro-refs-punto` | círculo de 14×14px. Color de la referencia elegida; con "Todas", gris `#64748b` |
| Etiqueta "REFERENCIA" (`label.label`) | 11px, MAYÚSCULAS, peso 600, espaciado de letras 0.03em, gris `#64748b`, sin margen |
| Desplegable `.filtro-refs-select` | ver la tabla siguiente |
| Conteo `.filtro-refs-conteo` | "N bulto(s)": 13px, peso 600, gris `#64748b`. Cambia con la referencia elegida |

### Desplegable `.filtro-refs-select`

| Propiedad | Valor |
|---|---|
| Ancho | ocupa el espacio libre (`flex: 1 1 260px`) |
| Letra | 15px, **peso 600**, color `#1c2733` |
| Relleno | 10px arriba/abajo, 12px a los lados |
| Borde | **2px** del color de la referencia elegida; con "Todas", gris `#cfd4da` |
| Esquinas | 10px |
| Fondo | blanco |
| Cursor | pointer |

**Opciones:**

- `Todas las referencias` (sin color)
- `REFERENCIA · Nombre`, una por cada referencia, con su color en `data-color` y su número de bultos en `data-conteo`

Al cambiar la selección se esconden las tarjetas de bulto y las secciones de traslado de las
demás referencias (clase `.oculto` sobre todo lo que tenga `data-ref`), y el punto y el borde
toman el color de la referencia elegida.

### Colores de las referencias

`COLORES_REFERENCIA_GRUPO` (server.js, ~línea 5859), por orden. Son los mismos de las tarjetas de
la página del pedido y de las de bultos.

| # | Color | Hex |
|---|---|---|
| 1 | Azul petróleo | `#006984` |
| 2 | Naranja | `#b46200` |
| 3 | Morado | `#8e44ad` |
| 4 | Verde | `#0b8457` |
| 5 | Rojo | `#c0392b` |

Si hay más de 5 referencias, los colores se repiten.

---

## 2. Trasladar paquete entre bultos

- HTML: `renderSeccionTraslado` (server.js, ~líneas 6526-6580).
- Estilos: `.seccion-traslado` / `.traslado-campo` (server.js, ~líneas 744-755).

### Recuadro

- Es una tarjeta desplegable `<details class="card seccion-traslado">`, con 16px de separación arriba.
  Hay una por referencia.
- Sale **cerrada**. Título: `▸ 🔀 Trasladar paquete entre bultos — REFERENCIA`; la flecha cambia a `▾`
  al abrirla. Con la tarjeta abierta, el título queda a 12px del primer campo.
- Debajo del título: una línea de 4px de alto del color de la referencia (bordes redondeados) y el
  nombre de la referencia (12px, peso 600, gris `#64748b`).

### Desplegables

No tienen estilo propio: usan el estilo general de `select` de `estilosBase`
(server.js, ~líneas 640-643).

| Propiedad | Valor |
|---|---|
| Ancho | 100% del recuadro |
| Letra | 16px, **peso normal**, color `#1c2733` |
| Relleno | 12px arriba/abajo, 14px a los lados |
| Borde | **1px** gris `#d0d7de`, fijo (no toma el color de la referencia) |
| Esquinas | 10px |
| Fondo | blanco |

### Etiquetas de los campos

Estilo general de `label`: 13px, peso 600, color `#1c2733`, 6px de separación con el desplegable.
No van en mayúsculas.

### Campos, en orden

12px de separación entre uno y otro, 16px después del último.

1. **¿A dónde va el paquete?**: dos opciones de radio, "Misma referencia" y "Otra referencia",
   en letra de 15px y con 18px entre ellas. Si una está deshabilitada, debajo sale el motivo en
   12px gris `#64748b`.
2. **Referencia destino** (`.sel-ref-destino`): solo aparece con "Otra referencia". Empieza en
   "Seleccione…", salvo que haya una sola referencia posible, que sale ya elegida.
   Opciones: `REFERENCIA · Nombre`.
3. **Paquete a mover** (`.sel-paquete-origen`): empieza en "Seleccione…".
4. **Bulto destino** (`.sel-bulto-destino`): sale **deshabilitado** con el texto "Primero escoja el
   paquete…" hasta que se escoge el paquete.
5. Botones morados `#8e44ad` (`.btn-accion.btn-traslado`): "🔀 Trasladar" y
   "📦 Trasladar bulto completo" (este con 8px de separación arriba).

---

## 3. Diferencias entre los dos

| | Filtro por referencia | Traslado |
|---|---|---|
| Letra | 15px, **peso 600** | 16px, peso normal |
| Relleno | 10px × 12px | 12px × 14px |
| Borde | **2px del color de la referencia** | 1px gris `#d0d7de` fijo |
| Etiqueta | "REFERENCIA": 11px, mayúsculas, gris, al lado del desplegable | "Paquete a mover": 13px, oscura, encima |
| Ancho | comparte la fila con el punto y el conteo | todo el ancho de la tarjeta |
| Esquinas y fondo | 10px, blanco | 10px, blanco |

## Tokens de color usados

| Token | Valor | Uso |
|---|---|---|
| `--texto` | `#1c2733` | texto de los desplegables y de las etiquetas del traslado |
| `--texto-suave` | `#64748b` | etiqueta "REFERENCIA", conteo, punto sin referencia, avisos |
| `--color-ref` | color de la referencia | punto y borde del filtro, línea del traslado |
| — | `#cfd4da` | borde del filtro con "Todas las referencias" |
| — | `#d0d7de` | borde de los desplegables del traslado |
