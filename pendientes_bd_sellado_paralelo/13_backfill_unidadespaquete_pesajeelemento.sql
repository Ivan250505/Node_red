-- Correr DESPUES del archivo 12 (necesita que la columna ya exista, por eso va en archivo
-- aparte). Rellena las filas YA EXISTENTES -- el DEFAULT constraint solo aplica a filas nuevas.

UPDATE SEL_PesajeElemento SET UnidadesPaquete = 100 WHERE UnidadesPaquete IS NULL;
