/* ============================================================
   GENERADOR DE PÁGINAS SEO ESTÁTICAS DEL RANKING
   ------------------------------------------------------------
   Crea, a partir de los datos de Supabase (solo lectura, clave
   pública), páginas HTML "de piedra" que Google puede leer sin
   ejecutar JavaScript, PERO con la imagen del ranking (marca,
   tarjetas, podios) para que la gente que llegue desde Google
   vea algo bonito y de marca:
     - Un HUB con las últimas carreras (tarjetas con podio).
     - Una página por carrera con su clasificación completa.
     - Un sitemap.xml.
   Se sirven bajo ranking.mfppcycling.com. NO toca el widget.
   Si la lectura falla, se omite sin romper el build.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./ranking-core.js'); // motor de cálculo (réplica del widget)

const TEMPORADA = 2026;

const SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';
const BASE = 'https://ranking.mfppcycling.com';        // subdominio SEO
const WEB = 'https://mfppcycling.com';                 // web principal (entrenador)
const LOGO = 'https://mfppcycling.com/wp-content/uploads/2023/05/Recurso-3.png';

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const CCAA_CV = new Set(['', 'comunitat valenciana', 'comunidad valenciana', 'c valenciana', 'cv', 'valencia', 'pais valenciano', 'pais valencia']);
const MEDALLAS = ['🥇', '🥈', '🥉'];

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
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
function fmtFecha(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}
function diaSemana(iso) {
  const d = new Date(iso + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? '' : DIAS[d.getDay()];
}
function diaMes(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { dia: String(parseInt(m[3], 10)), mes: MESES[parseInt(m[2], 10) - 1] || '' } : { dia: '', mes: '' };
}
function anyoDe(iso) { const m = String(iso || '').match(/^(\d{4})/); return m ? m[1] : ''; }
function tipoCarrera(nombre, extra) {
  if (/etapa/i.test(nombre || '')) return { etq: 'Etapa', cls: 'etapa' };
  if (extra.challengeCV === true) return { etq: 'Challenge CV', cls: 'challenge' };
  if (!CCAA_CV.has(norm(extra.ccaa))) return { etq: 'Fuera de la CV', cls: 'fuera' };
  return { etq: 'Ordinaria CV', cls: 'ordinaria' };
}

// ── Plantilla común: cabecera de marca, estilos (imagen del ranking) y pie ──
function pagina({ titulo, head, cuerpo }) {
  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `<title>${esc(titulo)}</title>\n` + head +
    '<style>' +
    ':root{--p:#0e7490;--a:#0891b2;--t:#1f2937;--s:#6b7280;--b:#e5e7eb;--f:#f8fafc;--g:#059669}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--t);line-height:1.5;background:#fff;-webkit-text-size-adjust:100%}' +
    '.wrap{max-width:1000px;margin:0 auto;padding:20px 16px 48px}' +
    'a{color:var(--p);text-decoration:none}a:hover{text-decoration:underline}' +
    '.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--b);padding-bottom:12px;margin-bottom:16px}' +
    '.marca{color:var(--p);font-weight:800;letter-spacing:.04em;font-size:1.05rem}.marca .sep{color:var(--b);margin:0 8px;font-weight:400}.marca .k{color:var(--t)}' +
    '.top .go{font-size:.85rem;font-weight:700}' +
    '.mig{font-size:.85rem;color:var(--s);margin:0 0 10px}' +
    'h1{font-size:1.55rem;margin:.1em 0 .1em;line-height:1.25}h2{font-size:1.15rem;margin:1.5em 0 .6em}' +
    '.sub{color:var(--s);font-size:.95rem;margin:.2em 0 1.1em}' +
    '.intro{font-size:.98rem;margin:0 0 1.2em}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;margin:.4em 0 1.2em}' +
    '.chip{font-size:.82rem;font-weight:700;color:var(--t);background:var(--f);border:1px solid var(--b);border-radius:99px;padding:5px 12px}' +
    '.chip.tipo{color:var(--p)}.chip.pts{color:#fff;background:var(--a);border-color:var(--a)}' +
    // Rejilla de tarjetas (hub)
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}' +
    '.card{border:1px solid var(--b);border-radius:14px;padding:14px 16px;background:#fff;transition:box-shadow .15s,border-color .15s}' +
    '.card:hover{border-color:var(--p);box-shadow:0 4px 16px rgba(14,116,144,.10)}' +
    '.card .cab{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}' +
    '.card .f{font-size:.78rem;font-weight:700;color:var(--s);text-transform:capitalize}' +
    '.card .tp{margin-left:auto;font-size:.68rem;font-weight:800;border-radius:99px;padding:2px 9px;background:var(--f);border:1px solid var(--b);color:var(--s)}' +
    '.card .tp.ordinaria{color:var(--p)}.card .tp.challenge{background:#fef3c7;color:#92400e;border-color:#fde68a}.card .tp.fuera{background:#dbeafe;color:#1e40af;border-color:#bfdbfe}.card .tp.etapa{background:#ede9fe;color:#5b21b6;border-color:#ddd6fe}' +
    '.card h3{font-size:1.02rem;margin:.1em 0 .2em;line-height:1.3}' +
    '.card .loc{margin:0 0 8px;font-size:.82rem;color:var(--s)}' +
    '.podio{list-style:none;margin:6px 0 2px;padding:0;display:flex;flex-direction:column;gap:7px}' +
    '.podio li{display:flex;gap:7px;font-size:.88rem}.podio .med{flex:none;line-height:1.3}' +
    '.podio .pdatos{display:flex;flex-direction:column;min-width:0}.podio .n{font-weight:700}' +
    '.podio .l1{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}' +
    '.podio .rk{font-size:.72rem;font-weight:700;color:var(--a);background:var(--f);border:1px solid var(--b);border-radius:99px;padding:1px 7px;white-space:nowrap}' +
    '.podio .eq{color:var(--s);font-size:.8rem;overflow-wrap:anywhere}' +
    '.nom a{color:var(--p);font-weight:600}' +
    // Menú de clasificaciones generales (enlaces a las páginas de ranking)
    '.rnav{display:flex;flex-wrap:wrap;gap:8px;margin:.4em 0 1.4em}' +
    '.rnav a{font-size:.85rem;font-weight:700;color:var(--p);background:var(--f);border:1px solid var(--b);border-radius:99px;padding:7px 14px}' +
    '.rnav a:hover{border-color:var(--p);text-decoration:none}' +
    '.card .ver{display:block;margin-top:10px;padding-top:9px;border-top:1px dashed var(--b);font-size:.84rem;font-weight:700}' +
    // Tabla de clasificación (página de carrera)
    '.tablabox{overflow-x:auto;border:1px solid var(--b);border-radius:12px}' +
    'table{width:100%;border-collapse:collapse;font-size:.93rem}' +
    'th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--s);border-bottom:2px solid var(--b);padding:10px 8px;background:var(--f)}' +
    'td{padding:9px 8px;border-bottom:1px solid var(--b)}.c{text-align:center}tr:last-child td{border-bottom:none}' +
    '.podiofila td{background:#ecfdf5}.pos{font-weight:800;color:var(--p)}.podiofila .pos{color:var(--g)}.nom{font-weight:600}.pts{font-weight:700;color:var(--a)}' +
    // CTA y pie
    '.cta{margin:26px 0;padding:18px;background:var(--f);border:1px solid var(--b);border-radius:14px}' +
    '.cta b{font-size:1.02rem}.btn{display:inline-block;margin-top:10px;background:var(--p);color:#fff;font-weight:700;padding:11px 18px;border-radius:10px}.btn:hover{background:#0b5f74;text-decoration:none}' +
    'footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--b);color:var(--s);font-size:.85rem}' +
    '@media(max-width:600px){.grid{grid-template-columns:1fr}h1{font-size:1.3rem}' +
    // Fallito 1: la tabla de clasificación general se convierte en tarjetas en móvil
    // (nombre arriba, equipo abajo; se ocultan categoría y pruebas para que no se corte)
    '.rk-tabla{overflow-x:visible;border:0;border-radius:0}' +
    '.rk-tabla table,.rk-tabla tbody{display:block;width:100%}' +
    '.rk-tabla thead{display:none}' +
    '.rk-tabla tr{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"pos nom pts" "pos eq pts";column-gap:12px;align-items:center;border:1px solid var(--b);border-radius:12px;padding:10px 13px;margin:0 0 8px}' +
    '.rk-tabla td{display:block;padding:0;border:0}' +
    '.rk-tabla .pos{grid-area:pos;font-size:1.05rem;text-align:center;min-width:1.4em}' +
    '.rk-tabla .nom{grid-area:nom;font-size:.98rem;line-height:1.25;min-width:0;overflow-wrap:anywhere}' +
    '.rk-tabla .eq{grid-area:eq;font-size:.8rem;color:var(--s);font-weight:400;line-height:1.3;min-width:0;overflow-wrap:anywhere}' +
    '.rk-tabla .pts{grid-area:pts;font-size:1rem;text-align:right;white-space:nowrap}' +
    '.rk-tabla .cat,.rk-tabla .pru{display:none}' +
    '.rk-tabla .podiofila{background:#ecfdf5}' +
    '}' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<div class="top">' +
    `<span class="marca"><a href="${WEB}">MFPP CYCLING</a><span class="sep">·</span><span class="k">Ranking</span></span>` +
    `<a class="go" href="${WEB}/ranking/">Ranking interactivo →</a>` +
    '</div>\n' +
    cuerpo +
    '<div class="cta"><b>¿Quieres mejorar tu rendimiento y escalar en el ranking?</b><br>' +
    'Entrenamiento personalizado de ciclismo por potencia para cadetes, juveniles y amateurs, con un método probado. ' +
    `<br><a class="btn" href="${WEB}">Descubre el método MFPP →</a></div>\n` +
    `<footer><a class="marca" href="${WEB}" style="font-size:.9rem">MFPP CYCLING</a> · Ranking de rendimiento del ciclismo base · ` +
    `Datos actualizados cada semana · <a href="${WEB}/ranking/">Ver el ranking interactivo</a></footer>\n` +
    '</div>\n</body>\n</html>\n';
}

async function leerCarreras() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const url = SUPABASE_URL + '/rest/v1/races?select=id,name,date,notes,' +
      'race_results(pos,bib,name,team,cat,time,gap_seconds,total_seconds)&race_type=eq.clasificacion&order=date.desc';
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const filas = await res.json();
    // Reparar nombres/equipos con caracteres corruptos (mojibake) para que los
    // corredores duplicados se fusionen y no distorsionen el ranking.
    for (const r of filas) for (const x of (r.race_results || [])) {
      if (x.name) x.name = core.rpRepararMojibake(x.name);
      if (x.team) x.team = core.rpRepararMojibake(x.team);
    }
    return filas;
  } finally { clearTimeout(t); }
}

function enlaceFicha(nombre) {
  // Abre la ficha del corredor en el ranking interactivo (no crea página
  // indexable: rel=nofollow para no generar señales por corredor menor)
  return `${WEB}/ranking/?ficha=${encodeURIComponent(nombre)}`;
}

function podioHTML(resultados, posCV) {
  return [1, 2, 3].map((p, i) => {
    const r = resultados.find(x => parseInt(x.pos, 10) === p);
    if (!r) return '';
    // Puesto y puntos del corredor en el ranking general (CV), igual que el
    // widget: solo si está en esa clasificación (los de fuera no llevan badge)
    const rk = posCV && posCV.get(core.rpNormalizarClave(r.name));
    const badge = rk ? ` <span class="rk">${rk.pos}º · ${core.rpFormatearPuntos(rk.puntos)} pts</span>` : '';
    return `<li><span class="med">${MEDALLAS[i]}</span><span class="pdatos">` +
      `<span class="l1"><a class="n" href="${esc(enlaceFicha(r.name))}" rel="nofollow">${esc(r.name)}</a>${badge}</span>` +
      (r.team ? `<span class="eq">${esc(r.team)}</span>` : '') +
      '</span></li>';
  }).join('');
}

function paginaCarrera(r, extra, ruta, resultados, rankings) {
  const url = BASE + '/ranking/resultados/' + ruta;
  const localidad = extra.localidad || '';
  const anyo = anyoDe(r.date);
  const tipo = tipoCarrera(r.name, extra);
  const hayTiempo = resultados.some(x => x.time);
  const filas = resultados.map(x => {
    const pos = parseInt(x.pos, 10);
    return `<tr class="${pos <= 3 ? 'podiofila' : ''}">` +
      `<td class="c pos">${pos}</td>` +
      `<td class="c">${x.bib != null && x.bib !== '' ? esc(x.bib) : ''}</td>` +
      `<td class="nom"><a href="${esc(enlaceFicha(x.name))}" rel="nofollow">${esc(x.name)}</a></td>` +
      `<td>${esc(x.team)}</td><td class="c">${esc(x.cat)}</td>` +
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
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="article">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const cuerpo =
    '<p class="mig"><a href="' + BASE + '/ranking/resultados/">Ranking y resultados</a> › ' + esc(r.name) + '</p>\n' +
    `<h1>${esc(r.name)}</h1>\n` +
    '<div class="chips">' +
    `<span class="chip tipo">${esc(tipo.etq)}</span>` +
    `<span class="chip">📅 ${esc(diaSemana(r.date))} ${esc(fmtFecha(r.date))}</span>` +
    (localidad ? `<span class="chip">📍 ${esc(localidad)}</span>` : '') +
    `<span class="chip pts">${resultados.length} clasificados</span>` +
    '</div>\n' +
    `<p class="intro">▶ <a href="${WEB}/ranking/?carrera=${encodeURIComponent(r.id)}">Abrir en el ranking interactivo</a> ` +
    'para ver mapa, perfil de altimetría y fichas de corredores.</p>\n' +
    '<h2>Clasificación</h2>\n<div class="tablabox"><table><thead><tr><th class="c">Pos.</th><th class="c">Dorsal</th>' +
    '<th>Corredor</th><th>Equipo</th><th class="c">Cat.</th>' + (hayTiempo ? '<th class="c">Tiempo</th>' : '') +
    `</tr></thead>\n<tbody>\n${filas || '<tr><td colspan="6">Sin datos.</td></tr>'}\n</tbody></table></div>\n` +
    ((rankings && rankings.length)
      ? '<h2>Clasificación general del ranking</h2>\n<div class="rnav">' +
        rankings.map(rc => `<a href="${esc(rc.ruta)}">🏆 Ranking ${esc(rc.label)} ${TEMPORADA}</a>`).join('') +
        '</div>\n'
      : '');
  return pagina({ titulo, head, cuerpo });
}

// ── Página de RANKING (clasificación general) de una categoría ──
// La página más valiosa para SEO ("ranking cadetes ciclismo"). Muestra la
// clasificación general filtrada por la Comunidad Valenciana (como el widget
// por defecto), con puesto, corredor, equipo y puntos.
function paginaRanking(catKey, catLabel, corredores, ruta, todosRankings, recientes, ultimaISO) {
  const url = BASE + '/ranking/resultados/' + ruta;
  const titulo = `Ranking ${catLabel} ${TEMPORADA} · Ciclismo Comunidad Valenciana | MFPP Cycling`;
  const desc = `Clasificación general del ranking de rendimiento de ${catLabel.toLowerCase()} ` +
    `${TEMPORADA} de la Comunidad Valenciana: puestos, puntos y equipos. Actualizado cada semana. MFPP Cycling.`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: titulo, url,
    numberOfItems: corredores.length,
    itemListElement: corredores.slice(0, 50).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.nombre }))
  };
  if (ultimaISO) jsonld.dateModified = ultimaISO;
  const head =
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const filas = corredores.map((c, i) =>
    `<tr class="${i < 3 ? 'podiofila' : ''}"><td class="c pos">${i + 1}</td>` +
    `<td class="nom"><a href="${esc(enlaceFicha(c.nombre))}" rel="nofollow">${esc(c.nombre)}</a></td>` +
    `<td class="eq">${esc(c.equipo)}</td><td class="c cat">${esc(c.subcatPrincipal || '')}</td>` +
    `<td class="c pru">${c.pruebasContadas}/${c.pruebasTotales}</td><td class="c pts">${core.rpFormatearPuntos(c.puntosTotales)}</td></tr>`
  ).join('\n');
  const nav = todosRankings.map(r =>
    r.ruta === ruta ? `<a style="background:var(--p);color:#fff" href="${esc(r.ruta)}">${esc(r.label)}</a>`
                    : `<a href="${esc(r.ruta)}">${esc(r.label)}</a>`
  ).join('');
  const cuerpo =
    '<p class="mig"><a href="' + BASE + '/ranking/resultados/">Ranking y resultados</a> › Ranking ' + esc(catLabel) + '</p>\n' +
    `<h1>Ranking ${esc(catLabel)} ${TEMPORADA}</h1>\n` +
    '<p class="sub">Clasificación general de rendimiento · Comunidad Valenciana</p>\n' +
    '<div class="rnav">' + nav + '</div>\n' +
    '<p class="intro">Clasificación general del ranking MFPP de rendimiento. ' +
    `Pulsa un corredor para ver su ficha completa (historial y evolución) en el <a href="${WEB}/ranking/">ranking interactivo</a>.</p>\n` +
    '<div class="tablabox rk-tabla"><table><thead><tr><th class="c">#</th><th>Corredor</th><th>Equipo</th>' +
    '<th class="c">Cat.</th><th class="c">Pruebas</th><th class="c">Puntos</th></tr></thead>\n' +
    `<tbody>\n${filas || '<tr><td colspan="6">Sin datos.</td></tr>'}\n</tbody></table></div>\n` +
    ((recientes && recientes.length)
      ? '<h2>Últimas carreras</h2>\n<div class="rnav">' +
        recientes.map(it => `<a href="${esc(it.ruta)}">${esc(diaSemana(it.fecha))} ${esc(fmtFecha(it.fecha))} · ${esc(it.nombre)}</a>`).join('') +
        `</div>\n<p class="intro"><a href="${BASE}/ranking/resultados/">Ver todas las carreras y clasificaciones →</a></p>\n`
      : '');
  return pagina({ titulo, head, cuerpo });
}

function paginaHub(items, rankings, ultimaISO) {
  const url = BASE + '/ranking/resultados/';
  const titulo = 'Ranking y Resultados de Ciclismo Base 2026 · Cadetes y Juveniles | MFPP Cycling';
  const desc = 'Resultados y clasificaciones del ciclismo base de la Comunidad Valenciana: ' +
    'cadetes, juveniles y sub-23. Podios, tiempos y ranking de rendimiento. Actualizado cada semana.';
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: titulo, url: url, inLanguage: 'es',
    publisher: { '@type': 'SportsOrganization', name: 'MFPP Cycling', url: WEB, logo: LOGO }
  };
  if (ultimaISO) jsonld.dateModified = ultimaISO;
  const head =
    `<meta name="description" content="${esc(desc)}">\n<meta name="robots" content="index, follow">\n` +
    `<link rel="canonical" href="${esc(url)}">\n` +
    '<meta property="og:type" content="website">\n<meta property="og:site_name" content="MFPP Cycling">\n' +
    `<meta property="og:title" content="${esc(titulo)}">\n<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:url" content="${esc(url)}">\n<meta property="og:image" content="${LOGO}">\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>\n`;
  const tarjetas = items.map(it =>
    '<article class="card">' +
    '<div class="cab">' +
    `<span class="f">${esc(diaSemana(it.fecha))} ${esc(fmtFecha(it.fecha))}</span>` +
    `<span class="tp ${it.tipo.cls}">${esc(it.tipo.etq)}</span>` +
    '</div>' +
    `<h3><a href="${esc(it.ruta)}">${esc(it.nombre)}</a></h3>` +
    (it.localidad ? `<p class="loc">📍 ${esc(it.localidad)}</p>` : '') +
    (it.podio ? `<ul class="podio">${it.podio}</ul>` : '') +
    `<a class="ver" href="${esc(it.ruta)}">Ver clasificación completa →</a>` +
    '</article>'
  ).join('\n');
  const navRank = (rankings || []).map(r => `<a href="${esc(r.ruta)}">🏆 Ranking ${esc(r.label)}</a>`).join('');
  const cuerpo =
    '<h1>Ranking y resultados de ciclismo base</h1>\n' +
    '<p class="sub">Cadetes, juveniles y sub-23 · Comunidad Valenciana · Temporada 2026</p>\n' +
    '<p class="intro">Aquí encontrarás las <b>clasificaciones y podios</b> de las pruebas del ciclismo base, ' +
    'con el ranking de rendimiento que elabora MFPP Cycling. ' +
    `Para filtros, fichas de corredores, mapas y perfiles, entra en el <a href="${WEB}/ranking/">ranking interactivo</a>.</p>\n` +
    (navRank ? '<h2>Clasificación general por categoría</h2>\n<div class="rnav">' + navRank + '</div>\n' : '') +
    '<h2>Últimas carreras</h2>\n<div class="grid">\n' + tarjetas + '\n</div>\n';
  return pagina({ titulo, head, cuerpo });
}

async function generarSEO(distDir) {
  const filas = await leerCarreras();
  const outDir = path.join(distDir, 'ranking', 'resultados');
  fs.mkdirSync(outDir, { recursive: true });

  // Fecha de la última jornada disputada → lastmod/dateModified de las páginas
  // "vivas" (hub y rankings), que cambian con cada nueva jornada publicada.
  const fechas = filas.map(r => String(r.date || '').slice(0, 10)).filter(Boolean).sort();
  const ultimaISO = fechas.length ? fechas[fechas.length - 1] : null;

  // ── Ranking calculado (motor idéntico al widget) ──
  const rk = core.calcularRanking(filas);
  const posCV = new Map();     // clave → { pos, puntos } en el ranking CV
  const rankings = [];         // páginas de clasificación general por categoría
  for (const cat of rk.categorias) {
    const cv = cat.corredores.filter(c => core.rpNormalizarTexto(c.region) === 'comunitat valenciana');
    cv.forEach((c, i) => posCV.set(c.clave, { pos: i + 1, puntos: c.puntosTotales }));
    if (cv.length) rankings.push({ key: cat.key, label: cat.label, ruta: 'ranking-' + cat.key + '-' + TEMPORADA + '.html', corredores: cv });
  }

  // ── Carreras: calculamos rutas/items ANTES para poder enlazarlas desde los
  // rankings (enlaces internos cruzados). `filas` viene ordenado por fecha desc. ──
  const carreras = filas.filter(r => (r.race_results || []).length);
  const items = [];
  for (const r of carreras) {
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    const resultados = (r.race_results || [])
      .filter(x => Number.isFinite(parseInt(x.pos, 10)) && parseInt(x.pos, 10) > 0)
      .sort((a, b) => parseInt(a.pos, 10) - parseInt(b.pos, 10));
    const ruta = slug(r.name) + '-' + String(r.id).slice(0, 6) + '.html';
    items.push({
      r, extra, resultados, ruta, nombre: r.name, fecha: r.date, localidad: extra.localidad || '',
      tipo: tipoCarrera(r.name, extra), podio: podioHTML(resultados, posCV)
    });
  }
  const recientes = items.slice(0, 8); // últimas 8 carreras (para enlazar desde los rankings)

  const urls = [{ loc: BASE + '/ranking/resultados/', lastmod: ultimaISO }];

  // Páginas de RANKING por categoría (con enlaces a las últimas carreras)
  for (const rc of rankings) {
    fs.writeFileSync(path.join(outDir, rc.ruta), paginaRanking(rc.key, rc.label, rc.corredores, rc.ruta, rankings, recientes, ultimaISO), 'utf8');
    urls.push({ loc: BASE + '/ranking/resultados/' + rc.ruta, lastmod: ultimaISO });
  }
  // Páginas por CARRERA (con enlaces a los rankings generales)
  for (const it of items) {
    fs.writeFileSync(path.join(outDir, it.ruta), paginaCarrera(it.r, it.extra, it.ruta, it.resultados, rankings), 'utf8');
    urls.push({ loc: BASE + '/ranking/resultados/' + it.ruta, lastmod: String(it.fecha || '').slice(0, 10) });
  }
  // HUB
  fs.writeFileSync(path.join(outDir, 'index.html'), paginaHub(items, rankings, ultimaISO), 'utf8');

  // ── Sitemap: en la RAÍZ del dominio (ranking.mfppcycling.com/sitemap.xml, que
  // es donde Google lo busca) y también en /ranking/resultados/. + robots.txt. ──
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => '<url><loc>' + esc(u.loc) + '</loc>' +
      (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') + '</url>').join('\n') +
    '\n</urlset>\n';
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemap, 'utf8');
  fs.writeFileSync(path.join(distDir, 'sitemap.xml'), sitemap, 'utf8');
  const robots = 'User-agent: *\nAllow: /\n\nSitemap: ' + BASE + '/sitemap.xml\n';
  fs.writeFileSync(path.join(distDir, 'robots.txt'), robots, 'utf8');

  return carreras.length;
}

module.exports = { generarSEO };
