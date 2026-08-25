// ============================================================================
// SEO ESTÁTICO DEL CALENDARIO FEDERATIVO
// ----------------------------------------------------------------------------
// A partir de la tabla `pruebas_federativas` de Supabase, genera páginas
// ESTÁTICAS e indexables (para Google) bajo dist/calendario/:
//   · Una FICHA por prueba (futuras + recientes) con datos estructurados Event.
//   · Landings editoriales por comunidad y por comunidad+modalidad.
//   · Un HUB del calendario.
//   · Un sitemap (sitemap-calendario.xml) y actualiza robots.txt para incluirlo.
// Se sirven en el subdominio SEO (ranking.mfppcycling.com/calendario/…), igual
// que las páginas del ranking. NO toca el widget interactivo ni el ranking.
// build.js llama a generarCalendarioSEO() en un try/catch (no rompe el deploy).
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';
const BASE = 'https://ranking.mfppcycling.com';   // subdominio SEO (Netlify)
const WEB = 'https://mfppcycling.com';            // web principal (widget)
const CAL = WEB + '/calendario/';                 // calendario interactivo
const LOGO = WEB + '/wp-content/uploads/2024/01/logo.png';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const CATLBL = { escuelas: 'Escuelas', infantil: 'Infantil', cadete: 'Cadete', junior: 'Junior', sub23: 'Sub-23', elite: 'Élite', master: 'Máster' };
// Estado de la prueba → eventStatus de schema.org
const STATUS = { activa: 'https://schema.org/EventScheduled', aplazada: 'https://schema.org/EventPostponed', anulada: 'https://schema.org/EventCancelled' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}
function normDup(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(19|20)\d\d\b/g, ' ').replace(/[^a-z0-9]+/g, '');
}
function fechaISO(iso) { return String(iso || '').slice(0, 10); }
function fmtCorta(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); }
function fmtLarga(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return iso || '';
  const d = new Date(iso + 'T12:00:00');
  const dow = Number.isNaN(d.getTime()) ? '' : DIAS[d.getDay()];
  return `${dow ? dow + ', ' : ''}${parseInt(m[3], 10)} de ${MESES[parseInt(m[2], 10) - 1] || ''} de ${m[1]}`;
}
function anyoDe(iso) { const m = String(iso || '').match(/^(\d{4})/); return m ? m[1] : ''; }
function catsTxt(codes) {
  return String(codes || '').split(',').filter(Boolean).map(c => CATLBL[c] || c).join(', ');
}
function sexoTxt(s) { return s === 'F' ? 'Femenino' : (s === 'MF' ? 'Masculino y femenino' : 'Masculino'); }

// ── Descarga de las pruebas (paginado; Supabase corta a 1000) ──
async function leerPruebas() {
  const campos = 'federacion,prueba,fecha,localidad,provincia,modalidad,categorias,sexo,estado,observaciones,fuente,club,clase,hora,actualizado';
  const out = [];
  for (let off = 0; ; off += 1000) {
    const url = SUPABASE_URL + '/rest/v1/pruebas_federativas?select=' + campos + '&order=fecha.asc&limit=1000&offset=' + off;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } });
    if (!res.ok) throw new Error('Supabase ' + res.status);
    const chunk = await res.json();
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

// ── Deduplicado (mismo criterio que el widget: fecha+nombre normalizado+fed) ──
function dedupe(list) {
  const byKey = {};
  const score = s => (/[áéíóúñ]/i.test(s) ? 2 : 0) + (/[a-z]/.test(s) && /[A-Z]/.test(s) ? 1 : 0);
  list.forEach(r => {
    const k = fechaISO(r.fecha) + '|' + normDup(r.prueba) + '|' + (r.federacion || '');
    const prev = byKey[k];
    if (!prev || score(r.prueba) > score(prev.prueba)) byKey[k] = r;
  });
  return Object.keys(byKey).map(k => byKey[k]);
}

// ── Plantilla común (identidad MFPP) ──
function pagina({ titulo, head, cuerpo }) {
  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `<title>${esc(titulo)}</title>\n` + head +
    '<style>' +
    ':root{--azul:#1E6F9A;--dark:#11334A;--claro:#55A9D8;--am:#F3B11A;--t:#1f2933;--s:#4B5563;--b:#e5e7eb;--f:#f4f8fb}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--t);line-height:1.55;background:#fff;-webkit-text-size-adjust:100%}' +
    '.wrap{max-width:1000px;margin:0 auto;padding:20px 16px 48px}' +
    'a{color:var(--azul);text-decoration:none}a:hover{text-decoration:underline}' +
    '.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--b);padding-bottom:12px;margin-bottom:16px}' +
    '.marca{color:var(--dark);font-weight:800;letter-spacing:.03em;font-size:1.05rem}.marca .sep{color:var(--b);margin:0 8px;font-weight:400}.marca .k{color:var(--azul)}' +
    '.top .go{font-size:.85rem;font-weight:700}' +
    '.mig{font-size:.85rem;color:var(--s);margin:0 0 10px}' +
    'h1{font-size:1.55rem;margin:.1em 0 .1em;line-height:1.25;color:var(--dark)}h2{font-size:1.15rem;margin:1.4em 0 .6em;color:var(--dark)}' +
    '.sub{color:var(--s);font-size:.95rem;margin:.2em 0 1.1em}' +
    '.intro{font-size:.98rem;margin:0 0 1.2em}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;margin:.4em 0 1.2em}' +
    '.chip{font-size:.82rem;font-weight:700;color:var(--t);background:var(--f);border:1px solid var(--b);border-radius:99px;padding:5px 12px}' +
    '.chip.st-aplazada{background:#fef3c7;color:#92400e;border-color:#fde68a}.chip.st-anulada{background:#fee2e2;color:#991b1b;border-color:#fecaca}' +
    '.datos{list-style:none;margin:.4em 0 1.4em;padding:0;border:1px solid var(--b);border-radius:12px;overflow:hidden}' +
    '.datos li{display:flex;gap:12px;padding:10px 14px;border-bottom:1px solid var(--b);font-size:.95rem}.datos li:last-child{border-bottom:0}' +
    '.datos .k{flex:0 0 140px;color:var(--s);font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}' +
    '.datos .v{flex:1;min-width:0}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}' +
    '.card{border:1px solid var(--b);border-radius:14px;padding:14px 16px;background:#fff;transition:box-shadow .15s,border-color .15s}' +
    '.card:hover{border-color:var(--azul);box-shadow:0 4px 16px rgba(30,111,154,.10)}' +
    '.card .f{font-size:.78rem;font-weight:700;color:var(--azul);text-transform:capitalize}' +
    '.card h3{font-size:1.02rem;margin:.15em 0 .2em;line-height:1.3}' +
    '.card .loc{margin:0;font-size:.85rem;color:var(--s)}' +
    '.rnav{display:flex;flex-wrap:wrap;gap:8px;margin:.4em 0 1.4em}' +
    '.rnav a{font-size:.85rem;font-weight:700;color:var(--azul);background:var(--f);border:1px solid var(--b);border-radius:99px;padding:7px 14px}' +
    '.rnav a:hover{border-color:var(--azul);text-decoration:none}' +
    '.cta{margin:26px 0;padding:18px;background:var(--f);border:1px solid var(--b);border-radius:14px}' +
    '.cta b{font-size:1.02rem}.btn{display:inline-block;margin-top:10px;background:var(--azul);color:#fff;font-weight:700;padding:11px 18px;border-radius:10px}.btn:hover{background:var(--dark);text-decoration:none}' +
    '.btn.alt{background:#fff;color:var(--azul);border:1.5px solid var(--azul)}' +
    'footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--b);color:var(--s);font-size:.85rem}' +
    '@media(max-width:600px){.grid{grid-template-columns:1fr}h1{font-size:1.3rem}.datos .k{flex-basis:110px}}' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<div class="top">' +
    `<span class="marca"><a href="${WEB}">MFPP CYCLING</a><span class="sep">·</span><span class="k">Calendario</span></span>` +
    `<a class="go" href="${CAL}">Calendario interactivo →</a>` +
    '</div>\n' +
    cuerpo +
    '<div class="cta"><b>¿Entrenas para competir esta temporada?</b><br>' +
    'Entrenamiento personalizado de ciclismo por potencia para cadetes, juveniles y amateurs, con un método probado. ' +
    `<br><a class="btn" href="${WEB}">Descubre el método MFPP →</a></div>\n` +
    `<footer><a class="marca" href="${WEB}" style="font-size:.9rem">MFPP CYCLING</a> · Calendario de carreras ciclistas de España · ` +
    `<a href="${CAL}">Ver el calendario interactivo</a></footer>\n` +
    '</div>\n</body>\n</html>\n';
}

// ── Ficha de una prueba (Event JSON-LD) ──
function paginaEvento(p, ruta, comuRuta) {
  const url = BASE + ruta;
  const est = (p.estado || 'activa').toLowerCase().trim();
  const cats = catsTxt(p.categorias);
  const lugar = [p.localidad, p.provincia].filter(Boolean).join(', ');
  const titulo = `${p.prueba} · ${fmtCorta(p.fecha)}${p.localidad ? ' · ' + p.localidad : ''} | Calendario ciclista MFPP`;
  const desc = `${p.prueba}: carrera ciclista${p.modalidad ? ' de ' + p.modalidad.toLowerCase() : ''}` +
    `${cats ? ' (' + cats.toLowerCase() + ')' : ''} el ${fmtLarga(p.fecha)}${p.localidad ? ' en ' + p.localidad : ''}` +
    `${p.federacion ? ' · ' + p.federacion : ''}. Fecha, ${p.hora ? 'hora, ' : ''}organizador y web oficial.`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'SportsEvent',
    name: p.prueba, startDate: fechaISO(p.fecha), sport: 'Cycling',
    eventStatus: STATUS[est] || STATUS.activa,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: url, isAccessibleForFree: true, description: desc
  };
  if (p.localidad) {
    jsonld.location = {
      '@type': 'Place', name: p.localidad,
      address: { '@type': 'PostalAddress', addressLocality: p.localidad, addressRegion: p.provincia || undefined, addressCountry: 'ES' }
    };
  }
  if (p.club) jsonld.organizer = { '@type': 'Organization', name: p.club };
  const head =
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="article">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(p.prueba)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const row = (k, v) => v ? `<li><div class="k">${k}</div><div class="v">${v}</div></li>` : '';
  const estTxt = est === 'aplazada' ? '<span class="chip st-aplazada">Aplazada</span>' : (est === 'anulada' ? '<span class="chip st-anulada">Anulada</span>' : '');
  const fuente = (p.fuente || '').trim();
  const cuerpo =
    `<p class="mig"><a href="${BASE}/calendario/">Calendario</a>${comuRuta ? ' › <a href="' + BASE + comuRuta + '">' + esc(p.federacion) + '</a>' : ''} › ${esc(p.prueba)}</p>\n` +
    `<h1>${esc(p.prueba)}</h1>\n` +
    '<div class="chips">' +
    `<span class="chip">${esc(fmtLarga(p.fecha))}</span>` +
    (p.hora ? `<span class="chip">Salida ${esc(p.hora)}</span>` : '') +
    (p.modalidad ? `<span class="chip">${esc(p.modalidad)}</span>` : '') +
    estTxt +
    '</div>\n' +
    `<p class="intro">${esc(p.prueba)} es una prueba ciclista${p.modalidad ? ' de <b>' + esc(p.modalidad) + '</b>' : ''}` +
    ` que se celebra el <b>${esc(fmtLarga(p.fecha))}</b>${p.localidad ? ' en <b>' + esc(p.localidad) + '</b>' : ''}` +
    `${p.federacion ? ', organizada dentro del calendario de la <b>' + esc(p.federacion) + '</b>' : ''}.</p>\n` +
    '<ul class="datos">' +
    row('Fecha', esc(fmtLarga(p.fecha))) +
    row('Hora de salida', esc(p.hora)) +
    row('Localidad', esc(lugar)) +
    row('Organiza', esc(p.club)) +
    row('Federación', esc(p.federacion)) +
    row('Categorías', esc(cats)) +
    row('Sexo', esc(sexoTxt(p.sexo))) +
    row('Modalidad', esc(p.modalidad)) +
    row('Clase', esc(p.clase)) +
    row('Estado', est === 'aplazada' ? 'Aplazada' : (est === 'anulada' ? 'Anulada' : 'Programada')) +
    row('Observaciones', esc(p.observaciones)) +
    row('Actualizado', esc(fmtCorta(p.actualizado))) +
    '</ul>\n' +
    '<p>' +
    `<a class="btn" href="${CAL}?q=${encodeURIComponent(p.prueba)}&per=temp">Ver en el calendario interactivo →</a> ` +
    (fuente ? `<a class="btn alt" href="${esc(fuente)}" rel="nofollow" target="_blank">Web oficial de la federación ↗</a>` : '') +
    '</p>\n' +
    '<p class="sub">Antes de desplazarte, confirma fecha, hora y lugar en la web oficial de la federación: los organizadores pueden aplazar, modificar o anular pruebas.</p>\n';
  return pagina({ titulo, head, cuerpo });
}

// ── Landing (comunidad o comunidad+modalidad): lista de pruebas ──
function paginaLanding({ titulo, h1, intro, ruta, pruebas, rutasEvento, filtroWidget }) {
  const url = BASE + ruta;
  const desc = `${intro} Fechas, localidades, organizadores y web oficial. Calendario ciclista de MFPP CYCLING.`.slice(0, 300);
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: h1, url,
    numberOfItems: pruebas.length,
    itemListElement: pruebas.slice(0, 100).map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.prueba, url: BASE + rutasEvento.get(p) }))
  };
  const head =
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(h1)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const cards = pruebas.map(p => {
    const rr = rutasEvento.get(p);
    return '<a class="card" href="' + BASE + rr + '">' +
      `<div class="f">${esc(fmtLarga(p.fecha))}</div>` +
      `<h3>${esc(p.prueba)}</h3>` +
      `<p class="loc">${esc([p.localidad, p.federacion].filter(Boolean).join(' · '))}${p.modalidad ? ' · ' + esc(p.modalidad) : ''}</p>` +
      '</a>';
  }).join('\n');
  const cuerpo =
    `<p class="mig"><a href="${BASE}/calendario/">Calendario</a> › ${esc(h1)}</p>\n` +
    `<h1>${esc(h1)}</h1>\n` +
    `<p class="intro">${esc(intro)} A continuación tienes las <b>${pruebas.length}</b> pruebas, con su ficha (fecha, hora, organizador y web oficial).</p>\n` +
    (filtroWidget ? `<p><a class="btn" href="${CAL}?${filtroWidget}">Abrir estas pruebas en el calendario interactivo →</a></p>\n` : '') +
    '<h2>Pruebas</h2>\n<div class="grid">\n' + (cards || '<p>Sin pruebas.</p>') + '\n</div>\n';
  return pagina({ titulo, head, cuerpo });
}

// ── HUB del calendario ──
function paginaHub(porComunidad, totalEventos) {
  const url = BASE + '/calendario/';
  const titulo = 'Calendario de carreras ciclistas en España 2026 | MFPP CYCLING';
  const desc = 'Calendario de carreras y pruebas ciclistas de las federaciones autonómicas de España. Fichas por prueba con fecha, hora, organizador y web oficial. Filtra por comunidad y modalidad.';
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: titulo, url,
    publisher: { '@type': 'SportsOrganization', name: 'MFPP Cycling', url: WEB, logo: LOGO }
  };
  const head =
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const nav = porComunidad.map(c => `<a href="${BASE}${c.ruta}">${esc(c.nombre)} (${c.n})</a>`).join('');
  const cuerpo =
    `<h1>Calendario de carreras ciclistas en España</h1>\n` +
    `<p class="intro">Reunimos <b>${totalEventos}</b> pruebas ciclistas de las federaciones autonómicas de España: carretera, BTT, ciclocross, pista, BMX, gravel y más. ` +
    `Cada prueba tiene su ficha con fecha, hora, organizador y enlace a la web oficial. También puedes usar el ` +
    `<a href="${CAL}">calendario interactivo</a> para filtrar por fecha, categoría, sexo, modalidad, comunidad y provincia.</p>\n` +
    '<h2>Por comunidad autónoma</h2>\n<div class="rnav">' + nav + '</div>\n' +
    `<p><a class="btn" href="${CAL}">Abrir el calendario interactivo →</a></p>\n`;
  return pagina({ titulo, head, cuerpo });
}

// ── Orquestador ──
async function generarCalendarioSEO(distDir) {
  let pruebas = dedupe(await leerPruebas());
  // Indexamos las FUTURAS + recientes (últimos 30 días) y sin retiradas.
  const hoy = new Date(); hoy.setDate(hoy.getDate() - 30);
  const limite = hoy.toISOString().slice(0, 10);
  pruebas = pruebas.filter(p => {
    const st = (p.estado || 'activa').toLowerCase().trim();
    if (st === 'retirada') return false;
    return fechaISO(p.fecha) >= limite && p.prueba;
  }).sort((a, b) => fechaISO(a.fecha).localeCompare(fechaISO(b.fecha)));

  const outDir = path.join(distDir, 'calendario');
  fs.mkdirSync(path.join(outDir, 'prueba'), { recursive: true });

  // Rutas de evento (slug estable = nombre + fecha; sin id, que cambia al reescanear)
  const rutasEvento = new Map();   // prueba → ruta ("/calendario/prueba/<slug>/")
  const usados = new Set();
  const urls = [{ loc: BASE + '/calendario/', lastmod: null }];
  for (const p of pruebas) {
    let sl = slug(p.prueba) + '-' + fechaISO(p.fecha);
    if (usados.has(sl)) sl += '-' + slug(p.federacion);
    let s2 = sl, k = 2; while (usados.has(s2)) { s2 = sl + '-' + (k++); }
    usados.add(s2);
    rutasEvento.set(p, '/calendario/prueba/' + s2 + '/');
  }

  // Agrupar por comunidad (federación) y por comunidad+modalidad
  const comus = {};
  pruebas.forEach(p => { const f = p.federacion || '(Otras)'; (comus[f] = comus[f] || []).push(p); });
  const comuNombres = Object.keys(comus).sort((a, b) => a.localeCompare(b, 'es'));

  // Fichas de evento
  for (const p of pruebas) {
    const rr = rutasEvento.get(p);
    const comuRuta = '/calendario/' + slug(p.federacion || 'otras') + '/';
    const dir = path.join(outDir, 'prueba', rr.split('/')[3]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), paginaEvento(p, rr, comuRuta), 'utf8');
    urls.push({ loc: BASE + rr, lastmod: fechaISO(p.actualizado) || fechaISO(p.fecha) });
  }

  // Landings por comunidad (+ por modalidad si hay bastantes pruebas)
  const porComunidad = [];
  for (const fed of comuNombres) {
    const lista = comus[fed].slice().sort((a, b) => fechaISO(a.fecha).localeCompare(fechaISO(b.fecha)));
    const cslug = slug(fed || 'otras');
    const cruta = '/calendario/' + cslug + '/';
    fs.mkdirSync(path.join(outDir, cslug), { recursive: true });
    fs.writeFileSync(path.join(outDir, cslug, 'index.html'), paginaLanding({
      titulo: `Calendario de ciclismo en ${fed} 2026 | MFPP CYCLING`,
      h1: `Calendario de carreras ciclistas en ${fed}`,
      intro: `Próximas carreras y pruebas ciclistas de ${fed} (todas las modalidades y categorías).`,
      ruta: cruta, pruebas: lista, rutasEvento,
      filtroWidget: 'fed=' + encodeURIComponent(fed) + '&per=temp'
    }), 'utf8');
    urls.push({ loc: BASE + cruta, lastmod: null });
    porComunidad.push({ nombre: fed, ruta: cruta, n: lista.length });

    // Por modalidad (solo combinaciones con >= 4 pruebas → evita páginas pobres)
    const porMod = {};
    lista.forEach(p => { const m = p.modalidad || 'Otras'; (porMod[m] = porMod[m] || []).push(p); });
    for (const mod of Object.keys(porMod)) {
      if (porMod[mod].length < 4) continue;
      const mslug = slug(mod);
      const mruta = cruta + mslug + '/';
      fs.mkdirSync(path.join(outDir, cslug, mslug), { recursive: true });
      fs.writeFileSync(path.join(outDir, cslug, mslug, 'index.html'), paginaLanding({
        titulo: `Calendario de ${mod} en ${fed} 2026 | MFPP CYCLING`,
        h1: `Calendario de ${mod} en ${fed}`,
        intro: `Próximas carreras de ${mod.toLowerCase()} de ${fed}.`,
        ruta: mruta, pruebas: porMod[mod], rutasEvento,
        filtroWidget: 'fed=' + encodeURIComponent(fed) + '&mod=' + encodeURIComponent(mod) + '&per=temp'
      }), 'utf8');
      urls.push({ loc: BASE + mruta, lastmod: null });
    }
  }

  // HUB
  fs.writeFileSync(path.join(outDir, 'index.html'), paginaHub(porComunidad, pruebas.length), 'utf8');

  // Sitemap propio del calendario
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => '<url><loc>' + esc(u.loc) + '</loc>' + (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') + '</url>').join('\n') +
    '\n</urlset>\n';
  fs.writeFileSync(path.join(distDir, 'sitemap-calendario.xml'), sitemap, 'utf8');

  // robots.txt: incluir AMBOS sitemaps (ranking + calendario). Este módulo corre
  // DESPUÉS del SEO del ranking, así que reescribimos el robots con los dos.
  const robots = 'User-agent: *\nAllow: /\n\nSitemap: ' + BASE + '/sitemap.xml\nSitemap: ' + BASE + '/sitemap-calendario.xml\n';
  fs.writeFileSync(path.join(distDir, 'robots.txt'), robots, 'utf8');

  return { eventos: pruebas.length, comunidades: porComunidad.length, urls: urls.length };
}

module.exports = { generarCalendarioSEO };
