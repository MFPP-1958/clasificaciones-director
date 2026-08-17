# Importador del calendario federativo

Actualiza la tabla Supabase `pruebas_federativas`, que es la que **lee el
calendario de la web** (`mfppcycling.com/calendario`). La web solo lee; este
importador es quien mete los datos.

## Actualizar el calendario (lo normal)

```bash
bash importar-calendario/actualizar.sh
```

Hace las dos cosas: raspa las 17 federaciones y sube el resultado a Supabase.
Antes de escribir hace **copia de seguridad** en `backups/`. Al terminar, la web
muestra el calendario nuevo en el siguiente acceso (si no lo ves, recarga con
Ctrl+F5 / Cmd+Shift+R).

## Solo mirar qué cambiaría, sin tocar nada

```bash
NODE_PATH=$(pwd)/node_modules node importar-calendario/scrape.js > importar-calendario/salida.json
NODE_PATH=$(pwd)/node_modules node importar-calendario/upload.js --diff
```

## Piezas

- **`scrape.js`** — lee las 16 federaciones "smartweb" + Cataluña (web aparte).
  Solo pruebas de **hoy en adelante**. Escribe `salida.json`.
- **`upload.js`** — `--diff` (solo lee y compara) / `--apply` (backup → borra las
  futuras → inserta las nuevas; las **pasadas no se tocan**). Necesita la clave
  `SUPABASE_SERVICE_KEY` (está en `Redes Sociales/.env`, fuera del repo).
- **`actualizar.sh`** — ejecuta las dos en un paso.

## Notas técnicas

- Las webs federativas redirigen a una página de *Error* a los pocos segundos
  (anti-scrape). Se esquiva bloqueando `**/show_error_frontend/**`.
- La fecha exacta sale de un timestamp oculto en la celda FECHA (smartweb) o del
  formato DD/MM/YYYY (Cataluña).
- La tabla tiene clave única (federación, prueba, fecha); `upload.js` deduplica
  antes de insertar.
- `estado` puede ser `activa` / `aplazada` / `anulada`; la web las muestra y
  filtra ("incidencias").
