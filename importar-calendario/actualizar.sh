#!/usr/bin/env bash
# Actualiza el calendario federativo de la web en UN paso:
#   1) raspa las 17 federaciones  2) sube a Supabase (con backup y diff)
# Uso:  bash importar-calendario/actualizar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="/Users/manuelfrancisperezperez/Desktop/Redes Sociales/.env"
export NODE_PATH="$(pwd)/node_modules"

echo "▶ 1/2 · Leyendo las 17 federaciones (tarda ~2-3 min)…"
node importar-calendario/scrape.js > importar-calendario/salida.json

# Extrae SOLO la clave de Supabase del .env (sin cargar el resto del fichero)
export SUPABASE_SERVICE_KEY="$(grep -E '^SUPABASE_SERVICE_KEY=' "$ENV" | head -1 | cut -d= -f2-)"
if [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "❌ Falta SUPABASE_SERVICE_KEY en $ENV"; exit 1
fi

echo "▶ 2/2 · Subiendo a Supabase…"
node importar-calendario/upload.js --apply
echo "✔ Listo. La web reflejará el calendario en el próximo acceso."
