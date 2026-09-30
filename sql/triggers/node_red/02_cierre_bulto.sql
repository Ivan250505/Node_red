-- ===== NODO NODE-RED: CIERRE DE BULTO (automático al completar paquetes y botón "Cierre bulto") =====
-- Canónico 28/09/2026: el SQL que tenía el nodo en Node-RED el 28/09 (Golpes/Potencia = PROMEDIO de
-- los paquetes, ya no @C0/@Potencia del PLC como en la versión de agosto), con el único cambio de
-- HoraFin. Va igual en los DOS nodos: el cierre automático y el del botón "📦 Cierre bulto".
-- Sin DECLARE: Node-RED ya declara @MiMaquina (pedido de Carlos, 28/09).
--
-- FIX 27-28/09/2026 (bug real: 35967 L6 del 25/09, 36788 L6 del 26/09, 22421 L2 del 27/09): HoraFin
-- se llenaba con @HoraPLC, y en algunos cierres Node-RED mandó un valor VIEJO (la hora del cierre del
-- bulto anterior, idéntica al milisegundo) -- el bulto quedó con HoraFin = HoraInicio, Duracion = 0, y
-- el bulto siguiente arrancó desde esa hora vieja. Ahora HoraFin es el reloj de la BASE (GETDATE()),
-- mismo criterio que ya usan Node (pausas, bultos) y el pesaje (SEL_PesajeElemento.FechaHora).
-- Red de seguridad: trg_SEL_Bultos_CierreBulto (28/09) corrige igual una HoraFin NULL o <= HoraInicio.
--
-- Este UPDATE es lo ÚNICO que dispara trg_SEL_Bultos_CierreBulto (cierra el bulto, pasa cantidad/
-- unidades/HoraFinal/Duracion a PRDProduccion y abre el siguiente 'Temporal' con HoraInicio = este
-- HoraFin), y en cascada trg_SEL_Bultos_SuspenderTemporal y trg_SEL_Bultos_GenerarEntradaInventario.
-- Instrucciones para quien lo pega: CAMBIO_CIERRE_BULTO_HORAFIN_28092026.md (misma carpeta).

-- FIX 30/09/2026 (tarjeta #3, punto 1): sin calificador de base (antes carlixplast.dbo):
-- el SQL corre en la base a la que este conectado Node-RED. Calificado solo servia en
-- produccion y en pruebas cerraba bultos de la base equivocada. Al pegar en Node-RED sigue
-- igual (ahi la base es la de produccion).

UPDATE b
      SET b.estado   = 'Cerrado',
          b.HoraFin  = GETDATE(),          -- antes: @HoraPLC
          b.Golpes   = agg.GolpesTotal,
          b.Potencia = agg.PotenciaPromedio
      FROM SEL_Bultos b
      CROSS APPLY (
          SELECT
              ISNULL(AVG(pe.Golpes), 0)               AS GolpesTotal,
              CAST(AVG(pe.Potencia) AS DECIMAL(10,3))  AS PotenciaPromedio
          FROM SEL_PesajeElemento pe
          WHERE pe.id_bulto = b.id
      ) agg
      WHERE b.id_maquina = @MiMaquina
        AND b.estado IN ('Activo', 'Temporal');

-- Alternativa si se quiere seguir usando la hora del PLC, pero sin aceptar una hora vieja:
--   b.HoraFin = CASE WHEN @HoraPLC IS NULL OR @HoraPLC <= b.HoraInicio THEN GETDATE() ELSE @HoraPLC END,
