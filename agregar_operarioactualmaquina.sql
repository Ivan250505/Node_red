-- Tabla que registra que Operario (PRDOperarios.Codigo) esta operando actualmente cada maquina
-- (PRDMaquinas.Codigo) -- usada por el aviso de relevo en la pagina de Informacion (si el usuario
-- que la mira ahora no es el operario actual, se le ofrece "Tomar control" en vez de asumir el
-- relevo solo por entrar a mirar) y por trg_SEL_Bultos_CierreBulto para saber a que operario
-- atribuir cada bulto que la maquina cierra sola, sin que nadie toque esta pagina.
-- Ejecutar una sola vez contra la base de Mirane.

CREATE TABLE SEL_OperarioActualMaquina (
  Maquina VARCHAR(20) NOT NULL PRIMARY KEY,
  Operario INT NOT NULL,
  FechaHora DATETIME NOT NULL DEFAULT GETDATE()
);
