/* ============================================================
   GENERADOR DE PÁGINAS SEO ESTÁTICAS DEL RANKING
   ------------------------------------------------------------
   Crea, a partir de los datos de Supabase (solo lectura, clave
   pública), páginas HTML "de piedra" que Google puede leer sin
   ejecutar JavaScript:
     - Un HUB con las últimas carreras.
     - Una página por carrera con su clasificación completa.
     - Un sitemap.xml.
   Se sirven bajo ranking.mfppcycling.com (subdominio → Netlify).
   NO toca el widget interactivo. Si la lectura falla, se omite
   sin romper el build.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';
const BASE = 'https://ranking.mfppcycling.com';        // subdominio SEO
const WEB = 'https://mfppcycling.com';                 // web principal (entrenador)
const LOGO = 'https://mfppcycling.com/wp-content/uploads/2023/05/Recurso-3.png';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function slug(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function fmtFecha(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}
function anyoDe(iso) { const m = String(iso || '').match(/^(\d{4})/); return m ? m[1] : ''; }

// Plantilla común: cabecera, estilos mínimos y pie. `head` añade meta/JSON-LD.
function pagina({ titulo, head, cuerpo }) {
  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `<title>${esc(titulo)}</title>\n` + head +
    '<style>' +
    ':root{--p:#0e7490;--a:#0891b2;--t:#1f2937;--s:#6b7280;--b:#e5e7eb;--f:#f8fafc}' +
    '*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--t);line-height:1.5;background:#fff}' +
    '.wrap{max-width:900px;margin:0 auto;padding:20px 16px 48px}' +
    'a{color:var(--p)}h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.15rem;margin:1.4em 0 .4em}' +
    '.marca{color:var(--p);font-weight:800;letter-spacing:.04em;text-decoration:none}' +
    '.mig{font-size:.85rem;color:var(--s);margin:0 0 12px}.mig a{text-decoration:none}' +
    '.meta{color:var(--s);font-size:.92rem;margin:.2em 0 1em}' +
    'table{width:100%;border-collapse:collapse;font-size:.93rem;margin:.5em 0}' +
    'th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--s);border-bottom:2px solid var(--b);padding:8px 6px}' +
    'td{padding:8px 6px;border-bottom:1px solid var(--b)}.c{text-align:center}.podio{background:#ecfdf5}.pts{font-weight:700;color:var(--a)}' +
    '.cta{margin:24px 0;padding:16px;background:var(--f);border:1px solid var(--b);border-radius:12px}' +
    '.btn{display:inline-block;margin-top:8px;background:var(--p);color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px}' +
    '.lista{list-style:none;padding:0}.lista li{padding:10px 0;border-bottom:1px solid var(--b)}.lista .f{color:var(--s);font-size:.85rem}' +
    'footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--b);color:var(--s);font-size:.85rem}' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    `<p class="mig"><a class="marca" href="${WEB}">MFPP CYCLING</a> · <a href="${BASE}/ranking/resultados/">Ranking y resultados</a></p>\n` +
    cuerpo +
    '<div class="cta"><b>¿Quieres mejorar tu rendimiento y escalar en el ranking?</b><br>' +
    'Entrenamiento personalizado de ciclismo por potencia para cadetes, juveniles y amateurs. ' +
    `<br><a class="btn" href="${WEB}">Descubre el método MFPP →</a></div>\n` +
    `<footer>Ranking de rendimiento del ciclismo base · MFPP Cycling · Datos actualizados cada semana. ` +
    `<a href="${WEB}/ranking/">Ver el ranking interactivo →</a></footer>\n` +
    '</div>\n</body>\n</html>\n';
}

async function leerCarreras() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const url = SUPABASE_URL + '/rest/v1/races?select=id,name,date,notes,' +
      'race_results(pos,bib,name,team,cat,time,gap_seconds)&race_type=eq.clasificacion&order=date.desc';
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

function paginaCarrera(r, extra, ruta) {
  const url = BASE + '/ranking/resultados/' + ruta;
  const localidad = extra.localidad || '';
  const anyo = anyoDe(r.date);
  const resultados = (r.race_results || [])
    .filter(x => Number.isFinite(parseInt(x.pos, 10)) && parseInt(x.pos, 10) > 0)
    .sort((a, b) => parseInt(a.pos, 10) - parseInt(b.pos, 10));
  const hayTiempo = resultados.some(x => x.time);
  const filas = resultados.map(x => {
    const pos = parseInt(x.pos, 10);
    return `<tr class="${pos <= 3 ? 'podio' : ''}">` +
      `<td class="c">${pos}</td>` +
      (x.bib != null && x.bib !== '' ? `<td class="c">${esc(x.bib)}</td>` : '<td class="c"></td>') +
      `<td>${esc(x.name)}</td><td>${esc(x.team)}</td><td class="c">${esc(x.cat)}</td>` +
      (hayTiempo ? `<td class="c">${esc(x.time || '')}</td>` : '') +
      '</tr>';
  }).join('\n');
  const titulo = `Resultados ${r.name} ${anyo} · Clasificación | MFPP Cycling`;
  const desc = `Clasificación completa de ${r.name}${localidad ? ' (' + localidad + ')' : ''}` +
    ` del ${fmtFecha(r.date)}. Resultados y podio del ciclismo base. MFPP Cycling.`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'SportsEvent',
    name: r.name, startDate: String(r.date || '').slice(0, 10), sport: 'Cycling',
    eventStatus: 'https://schema.org/EventScheduled', url: url,
    organizer: { '@type': 'Organization', name: 'MFPP Cycling', url: WEB }
  };
  if (localidad) jsonld.location = { '@type': 'Place', name: localidad };
  const head =
    `<meta name="description" content="${esc(desc)}">\n` +
    '<meta name="robots" content="index, follow">\n' +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="article">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const cuerpo =
    `<h1>${esc(r.name)}</h1>\n` +
    `<p class="meta">📅 ${esc(fmtFecha(r.date))}${localidad ? ' · 📍 ' + esc(localidad) : ''} · Ciclismo base</p>\n` +
    `<p><a href="${WEB}/ranking/?carrera=${encodeURIComponent(r.id)}">▶ Abrir esta clasificación en el ranking interactivo</a> ` +
    '(mapa, perfil, fichas de corredores…).</p>\n' +
    '<h2>Clasificación</h2>\n<table><thead><tr><th class="c">Pos.</th><th class="c">Dorsal</th>' +
    '<th>Corredor</th><th>Equipo</th><th class="c">Cat.</th>' + (hayTiempo ? '<th class="c">Tiempo</th>' : '') +
    `</tr></thead>\n<tbody>\n${filas || '<tr><td colspan="6">Sin datos.</td></tr>'}\n</tbody></table>\n`;
  return pagina({ titulo, head, cuerpo });
}

function paginaHub(items) {
  const url = BASE + '/ranking/resultados/';
  const titulo = 'Ranking y Resultados de Ciclismo Base 2026 · Cadetes y Juveniles | MFPP Cycling';
  const desc = 'Resultados y clasificaciones del ciclismo base de la Comunidad Valenciana: ' +
    'cadetes, juveniles y sub-23. Podios, tiempos y ranking de rendimiento. Actualizado cada semana.';
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: titulo, url: url, inLanguage: 'es',
    publisher: { '@type': 'SportsOrganization', name: 'MFPP Cycling', url: WEB, logo: LOGO }
  };
  const head =
    `<meta name="description" content="${esc(desc)}">\n` +
    '<meta name="robots" content="index, follow">\n' +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const lista = items.map(it =>
    `<li><a href="${esc(it.ruta)}">${esc(it.nombre)}</a>` +
    `<div class="f">${esc(fmtFecha(it.fecha))}${it.localidad ? ' · ' + esc(it.localidad) : ''}` +
    `${it.podio ? ' · 🥇 ' + esc(it.podio) : ''}</div></li>`
  ).join('\n');
  const cuerpo =
    '<h1>Ranking y resultados de ciclismo base</h1>\n' +
    '<p class="meta">Cadetes, juveniles y sub-23 · Comunidad Valenciana · Temporada 2026</p>\n' +
    '<p>Aquí encontrarás las <b>clasificaciones y podios</b> de las pruebas del ciclismo base, ' +
    'con el ranking de rendimiento que elabora MFPP Cycling. ' +
    `Para filtros, fichas de corredores, mapas y perfiles, entra en el <a href="${WEB}/ranking/">ranking interactivo</a>.</p>\n` +
    '<h2>Últimas carreras</h2>\n<ul class="lista">\n' + lista + '\n</ul>\n';
  return pagina({ titulo, head, cuerpo });
}

async function generarSEO(distDir) {
  const carreras = (await leerCarreras()).filter(r => (r.race_results || []).length);
  const outDir = path.join(distDir, 'ranking', 'resultados');
  fs.mkdirSync(outDir, { recursive: true });
  const urls = [{ loc: BASE + '/ranking/resultados/', lastmod: null }];
  const items = [];
  for (const r of carreras) {
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    const ruta = slug(r.name) + '-' + String(r.id).slice(0, 6) + '.html';
    fs.writeFileSync(path.join(outDir, ruta), paginaCarrera(r, extra, ruta), 'utf8');
    const ganador = (r.race_results || []).find(x => parseInt(x.pos, 10) === 1);
    items.push({
      ruta, nombre: r.name, fecha: r.date, localidad: extra.localidad || '',
      podio: ganador ? ganador.name : ''
    });
    urls.push({ loc: BASE + '/ranking/resultados/' + ruta, lastmod: String(r.date || '').slice(0, 10) });
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), paginaHub(items), 'utf8');
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n'.replace('sitemap.org', 'sitemaps.org') +
    urls.map(u => '<url><loc>' + esc(u.loc) + '</loc>' +
      (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') + '</url>').join('\n') +
    '\n</urlset>\n';
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemap, 'utf8');
  return carreras.length;
}

module.exports = { generarSEO };
