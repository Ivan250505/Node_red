-- El chequeo aleatorio de Calidad (cada 20-30 min mientras la orden esta Activa) vivia solo en
-- memoria del navegador (un setTimeout) -- se reiniciaba a cero cada vez que se recargaba la
-- pagina o se navegaba a otra pestaña, asi que casi nunca llegaba a completar el conteo. Esta
-- columna guarda CUANDO debe salir el proximo chequeo, server-side, para que sobreviva
-- navegacion/recargas (a pedido del usuario, 03/09/2026).
ALTER TABLE SEL_EjecucionOrden ADD ProximaCalidad DATETIME NULL;
