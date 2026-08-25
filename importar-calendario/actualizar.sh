#!/usr/bin/env bash
# Actualiza el calendario federativo de la web en UN paso:
#   1) raspa las 17 federaciones  2) sube a Supabase (con backup y diff)
#   3) dispara un build de Netlify → regenera las fichas SEO estáticas del
#      calendario (para que Google vea fechas/estados frescos).
# Uso:  bash importar-calendario/actualizar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="/Users/manuelfrancisperezperez/Desktop/Redes Sociales/.env"
export NODE_PATH="$(pwd)/node_modules"

echo "▶ 1/3 · Leyendo las 17 federaciones (tarda ~2-3 min)…"
node importar-calendario/scrape.js > importar-calendario/salida.json

# Extrae SOLO la clave de Supabase del .env (sin cargar el resto del fichero)
export SUPABASE_SERVICE_KEY="$(grep -E '^SUPABASE_SERVICE_KEY=' "$ENV" | head -1 | cut -d= -f2-)"
if [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "❌ Falta SUPABASE_SERVICE_KEY en $ENV"; exit 1
fi

echo "▶ 2/3 · Subiendo a Supabase…"
node importar-calendario/upload.js --apply

# ── 3) Regenerar las páginas SEO estáticas (build de Netlify) ──
# Las fichas /calendario/prueba/… solo se regeneran en un build. Con el "build
# hook" de Netlify disparamos uno para que reflejen los nuevos datos.
# Crea el hook en Netlify (Site configuration → Build & deploy → Build hooks) y
# pega su URL en el .env como:  NETLIFY_BUILD_HOOK=https://api.netlify.com/build_hooks/xxxx
HOOK="$(grep -E '^NETLIFY_BUILD_HOOK=' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)"
if [ -n "${HOOK:-}" ]; then
  echo "▶ 3/3 · Regenerando fichas SEO (build de Netlify)…"
  if curl -fsS -X POST -d '{}' "$HOOK" >/dev/null; then
    echo "   ✓ Build lanzado. En unos 2-3 min las fichas del calendario estarán al día."
  else
    echo "   ⚠️  No se pudo lanzar el build (revisa NETLIFY_BUILD_HOOK). El calendario interactivo SÍ está al día igualmente."
  fi
else
  echo "▶ 3/3 · (Opcional) SEO: no hay NETLIFY_BUILD_HOOK en el .env → las fichas estáticas se regenerarán en el próximo despliegue."
  echo "   Para automatizarlo: crea un Build hook en Netlify y añádelo al .env como NETLIFY_BUILD_HOOK=…"
fi

echo "✔ Listo. El calendario interactivo se actualiza al instante; las fichas SEO, con el build."
