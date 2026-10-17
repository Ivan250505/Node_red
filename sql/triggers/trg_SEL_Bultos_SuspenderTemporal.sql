-- VERSION CANONICA -- verificada con SELECT OBJECT_DEFINITION contra produccion (carlixplast) el
-- 21/09/2026 (pegada completa por el usuario, tras un primer envio cortado a la mitad).
-- CONVENCION: este archivo SIEMPRE debe reflejar el ultimo estado realmente desplegado del
-- trigger. Cada cambio futuro se aplica editando ESTE archivo -- el historial de git hace de
-- versionamiento. Antes de escribir un cambio nuevo sobre este trigger, correr de nuevo:
--   SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.trg_SEL_Bultos_SuspenderTemporal'));
-- y confirmar que coincide.
--
-- QUE HACE: cuando trg_SEL_Bultos_CierreBulto inserta el siguiente bulto 'Temporal' (al cerrar el
-- anterior), este trigger (AFTER INSERT, dispara anidado sobre ese mismo INSERT) revisa si la
-- SEL_EjecucionOrden de ese bulto quedo marcada 'PendienteSuspension'/'SuspensionEnCurso' -- si es
-- asi, el bulto nuevo nace directo en 'Suspendido' (no 'Temporal'/'Activo') y propaga el estado
-- 'Suspendida' a SEL_EjecucionOrden y SEL_OrdenProduccion.
--
-- ACTUALIZADO 24/09/2026 (a pedido del usuario) -- PENDIENTE de aplicar: la suspension tambien
-- suspende la ORDEN DE TRABAJO, igual que Produccion.vb y que Node en "suspender ya":
-- PRDOrdenesProduccion 'Activa' -> 'Suspendida', sus controles EnProceso -> 'Suspendida', una fila en
-- PRDOrdenesProduccionPausas y (si ya existe la tabla) un movimiento PAUSA en SISMovimientos. La OT es
-- la del bulto mas reciente de la orden que ya tiene PRDProduccion. Va en TRY/CATCH con XACT_ABORT OFF:
-- un fallo aca NUNCA puede tumbar el cierre del bulto que dispara este trigger.
--
-- TARJETA #11 (08/10/2026, rev Iván): grupo SELLADORA completo. Si la ejecución pertenece a un
-- grupo (misma máquina, mismo pedido, líneas + pedidos extra), se suspende TODO el grupo --
-- INCLUIDA la orden que pidió la suspensión (el filtro anterior la dejaba fuera: solo
-- suspendía a los hermanos). Sin grupo, mismo comportamiento de antes (solo la orden).
-- No se agrega 'Suspendida' al filtro de captura: al reanudar, la ejecución vuelve a 'Activa'
-- ANTES de crear el Temporal siguiente (reanudarOTDeOrden), así no se re-suspende al instante.
--
-- FIX 08/10/2026 (rev Iván): sin filtro SubEmpresa/Tipo/Fecha en PRDGrupoEtapasPedidosExtra --
-- Fecha es la del pedido EXTRA, no la del grupo; basta IdGrupo.

CREATE OR ALTER TRIGGER trg_SEL_Bultos_SuspenderTemporal
ON SEL_Bultos
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;

    -- Bultos recién reservados (siempre entran como 'Temporal', eso lo sigue haciendo
    -- trg_SEL_Bultos_CierreBulto sin cambios) cuya ejecución fue marcada para suspender -- se
    -- captura primero en una tabla aparte para no depender del orden de los UPDATE de abajo.
    DECLARE @ASuspender TABLE (IdBulto INT, IdEjecucion INT, IdOrden INT);
    INSERT INTO @ASuspender (IdBulto, IdEjecucion, IdOrden)
    SELECT i.id, eo.IdEjecucion, eo.IdOrden
    FROM inserted i
    INNER JOIN SEL_EjecucionOrden eo ON eo.IdEjecucion = i.id_ejecucion
    WHERE i.estado = 'Temporal'
      AND eo.Estado IN ('PendienteSuspension', 'SuspensionEnCurso');

    IF EXISTS (SELECT 1 FROM @ASuspender)
    BEGIN
        -- TARJETA #11: grupo SELLADORA completo (misma máquina, mismo pedido, líneas +
        -- pedidos extra), INCLUIDA la solicitante. Sin grupo, solo ella (igual que antes).
        DECLARE @GrupoIds TABLE (IdOrden INT NOT NULL, IdEjecucion INT NOT NULL, PRIMARY KEY (IdOrden, IdEjecucion));
        INSERT INTO @GrupoIds (IdOrden, IdEjecucion)
        SELECT IdOrden, IdEjecucion FROM @ASuspender;
        INSERT INTO @GrupoIds (IdOrden, IdEjecucion)
        SELECT DISTINCT ord2.IdOrden, ej2.IdEjecucion
        FROM @ASuspender s
        INNER JOIN SEL_OrdenProduccion ord1 ON ord1.IdOrden = s.IdOrden
        INNER JOIN PRDGrupoEtapasCompartidas g ON g.CategoriaMaquina = 'SELLADORA'
          -- FIX 08/10/2026 (rev Iván): sin filtro SubEmpresa/Tipo/Fecha en PedidosExtra --
          -- Fecha es la del pedido EXTRA (fFechaB de Liberación), no la del grupo.
          AND (EXISTS (SELECT 1 FROM PRDGrupoEtapasCompartidasLineas gl
                      WHERE gl.IdGrupo = g.IdGrupo AND gl.Linea = ord1.Linea AND g.Numero = ord1.NumeroPedido)
            OR EXISTS (SELECT 1 FROM PRDGrupoEtapasPedidosExtra pe
                      WHERE pe.IdGrupo = g.IdGrupo
                        AND pe.Numero = ord1.NumeroPedido AND pe.Linea = ord1.Linea))
        INNER JOIN (
          SELECT gl2.Linea AS Linea, g2.Numero AS Numero, gl2.IdGrupo AS IdGrupo
          FROM PRDGrupoEtapasCompartidasLineas gl2
          INNER JOIN PRDGrupoEtapasCompartidas g2 ON g2.IdGrupo = gl2.IdGrupo
          UNION
          SELECT pe2.Linea AS Linea, pe2.Numero AS Numero, pe2.IdGrupo AS IdGrupo
          FROM PRDGrupoEtapasPedidosExtra pe2
          INNER JOIN PRDGrupoEtapasCompartidas g3 ON g3.IdGrupo = pe2.IdGrupo
        ) gm ON gm.IdGrupo = g.IdGrupo
        INNER JOIN SEL_OrdenProduccion ord2 ON ord2.Linea = gm.Linea AND ord2.NumeroPedido = gm.Numero
          AND ord2.Maquina = ord1.Maquina
        INNER JOIN SEL_EjecucionOrden ej2 ON ej2.IdOrden = ord2.IdOrden
        WHERE NOT EXISTS (SELECT 1 FROM @GrupoIds x WHERE x.IdOrden = ord2.IdOrden AND x.IdEjecucion = ej2.IdEjecucion)
          AND ord2.Estado IN ('Pendiente', 'Activa', 'PendienteSuspension', 'SuspensionEnCurso')
          AND ej2.Estado IN ('Pendiente', 'Activa', 'PendienteSuspension', 'SuspensionEnCurso');

        UPDATE b SET b.estado = 'Suspendido'
        FROM SEL_Bultos b
        INNER JOIN @GrupoIds g ON g.IdEjecucion = b.id_ejecucion
        WHERE b.estado IN ('Activo', 'Temporal');

        UPDATE eo SET eo.Estado = 'Suspendida'
        FROM SEL_EjecucionOrden eo
        INNER JOIN @GrupoIds g ON g.IdEjecucion = eo.IdEjecucion
        WHERE eo.Estado <> 'Suspendida';

        UPDATE op SET op.Estado = 'Suspendida'
        FROM SEL_OrdenProduccion op
        INNER JOIN @GrupoIds g ON g.IdOrden = op.IdOrden
        WHERE op.Estado <> 'Suspendida';

        -- 24/09/2026: Orden de Trabajo suspendida + pausa + movimiento (ver encabezado).
        -- Tarjeta #11: se resuelve para TODAS las órdenes del grupo (comparten la misma OT).
        SET XACT_ABORT OFF;
        BEGIN TRY
            DECLARE @OTs TABLE (OT VARCHAR(20), IdOT INT);
            INSERT INTO @OTs (OT, IdOT)
            SELECT DISTINCT x.OT, o.IdOrdenProduccion
            FROM @GrupoIds g
            CROSS APPLY (
                SELECT TOP 1 p.OrdenProduccion AS OT
                FROM PRDProduccion p
                INNER JOIN SEL_Bultos b2 ON b2.serialPadre = p.Detalle
                INNER JOIN SEL_EjecucionOrden ej ON ej.IdEjecucion = b2.id_ejecucion
                WHERE ej.IdOrden = g.IdOrden AND p.OrdenProduccion IS NOT NULL
                ORDER BY b2.id DESC
            ) x
            INNER JOIN PRDOrdenesProduccion o ON o.OrdenProduccion = x.OT AND o.Estado = 'Activa';

            IF EXISTS (SELECT 1 FROM @OTs)
            BEGIN
                UPDATE o SET o.Estado = 'Suspendida'
                FROM PRDOrdenesProduccion o INNER JOIN @OTs t ON t.OT = o.OrdenProduccion;

                UPDATE ec SET ec.Estado = 'Suspendida', ec.FechaUltimaModificacion = GETDATE()
                FROM PRDExtrusionControl ec
                INNER JOIN PRDProduccion pa ON pa.Elemento = ec.ElementoOriginal AND pa.Fecha = ec.FechaOriginal
                                           AND pa.Lote = ec.LoteOriginal AND pa.Linea = ec.LineaOriginal
                INNER JOIN @OTs t ON t.OT = pa.OrdenProduccion
                WHERE ec.Estado = 'EnProceso';

                INSERT INTO PRDOrdenesProduccionPausas (OrdenProduccion, HoraInicioPausa, UsuarioPausa, Observaciones)
                SELECT t.OT, GETDATE(), NULL, 'Suspendida desde Programación (al terminar el bulto en curso)'
                FROM @OTs t
                WHERE NOT EXISTS (SELECT 1 FROM PRDOrdenesProduccionPausas pz
                                  WHERE pz.OrdenProduccion = t.OT AND pz.HoraFinPausa IS NULL);

                IF OBJECT_ID('dbo.SISMovimientos') IS NOT NULL
                BEGIN
                    DECLARE @Mov TABLE (Id INT);
                    INSERT INTO SISMovimientos (Tipo, Subtipo, IdReferencia, Referencia, FechaHora, Usuario, Origen, Motivo, Resumen)
                    OUTPUT INSERTED.IdMovimiento INTO @Mov
                    SELECT 'ORDEN_TRABAJO', 'PAUSA', t.IdOT, t.OT, GETDATE(), NULL, 'Tableta',
                           N'Suspendida desde Programación (al terminar el bulto en curso)',
                           N'Orden de trabajo suspendida desde la tableta'
                    FROM @OTs t;
                    INSERT INTO SISMovimientosDetalle (IdMovimiento, Tabla, Campo, ValorAnterior, ValorNuevo)
                    SELECT Id, 'PRDOrdenesProduccion', 'Estado', 'Activa', 'Suspendida' FROM @Mov;
                END
            END
        END TRY
        BEGIN CATCH
            -- no tumbar el cierre del bulto: la OT queda como estaba (revisar a mano si pasa)
        END CATCH
    END
END
