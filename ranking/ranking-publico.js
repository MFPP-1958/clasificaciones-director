/* ============================================================
   RANKING PÚBLICO — Comunidad Valenciana
   Archivo 100% independiente del dashboard de administración.

   REGLAS ESTRICTAS DE ESTE ARCHIVO:
   - Conexión con la clave pública (anon/publishable). Nunca la service_role.
   - SOLO lecturas: .select(). PROHIBIDO .insert(), .update(),
     .upsert(), .delete(), .rpc() de escritura o cualquier mutación.
   - Sin sesión de usuario: persistSession desactivado para que el
     embed en la web externa jamás arrastre una sesión de admin.

   LIMITACIONES CONOCIDAS (heredadas del modelo de datos):
   - La identidad de un ciclista entre pruebas es su nombre normalizado
     (no hay licencia en BD): dos personas con el mismo "apellido, nombre"
     se fusionan, igual que ocurre en el dashboard.
   - En pruebas mixtas, una fémina puntúa con su posición scratch tal
     cual está en race_results (no existe dato fiable para recalcular
     su posición entre féminas).
   ============================================================ */

'use strict';

// ── Configuración Supabase (misma base de datos, acceso público) ──
const RP_SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const RP_SUPABASE_ANON_KEY = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';

// Cliente en modo lectura: sin persistencia de sesión ni auto-refresh,
// para que este embed nunca tenga credenciales más allá de la clave anon.
const rpDb = (typeof supabase !== 'undefined')
  ? supabase.createClient(RP_SUPABASE_URL, RP_SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  : null;

// ── Helper de lectura ──
// Único punto de acceso a datos de este proyecto: solo permite SELECT.
// `ajustar` recibe el query builder ya en .select() y solo debe encadenar
// filtros de lectura (.eq, .order, .in, .limit...).
async function rpLeer(tabla, columnas = '*', ajustar = null) {
  if (!rpDb) {
    console.error('[ranking-publico] Supabase no está disponible (¿falló la carga del CDN?)');
    return { data: null, error: new Error('Supabase no disponible') };
  }
  let q = rpDb.from(tabla).select(columnas);
  if (ajustar) q = ajustar(q);
  return q;
}

/* ============================================================
   CONFIGURACIÓN DEL SISTEMA DE PUNTUACIÓN
   ============================================================ */

// Puntos base por posición final (carreras de un día / generales). >20º → 0.
const RP_PUNTOS_BASE = {
  1: 100, 2: 80, 3: 65, 4: 55, 5: 48, 6: 42, 7: 36, 8: 32, 9: 28, 10: 24,
  11: 21, 12: 18, 13: 15, 14: 13, 15: 11, 16: 9, 17: 7, 18: 5, 19: 3, 20: 1
};

// Puntuación directa de etapas sueltas (top-10, SIN coeficiente). >10º → 0.
const RP_PUNTOS_ETAPA = { 1: 25, 2: 20, 3: 16, 4: 13, 5: 11, 6: 9, 7: 7, 8: 5, 9: 3, 10: 1 };

// Bono de regularidad: +3 por terminar una prueba (posición válida).
const RP_BONO_FINALIZAR = 3;

// Solo suman los 12 mejores resultados de cada corredor por temporada.
const RP_MAX_RESULTADOS_CONTADOS = 12;

// Coeficientes multiplicadores por tipología. Mapa extensible: cuando exista
// el dato en la BD se podrán añadir aquí 'cri':1.25, 'autonomico':1.50,
// 'especial':1.50, etc. sin tocar el motor.
const RP_COEFICIENTES = { ordinaria: 1.00, challenge: 1.30, fuera_cv: 1.35 };

const RP_ETIQUETAS_TIPO = {
  ordinaria: 'Ordinaria CV',
  challenge: 'Challenge CV',
  fuera_cv: 'Fuera de la CV',
  etapa: 'Etapa'
};

// Una etapa suelta se detecta por el nombre (no hay modelo de vueltas en BD).
const RP_RE_ETAPA = /etapa/i;

// Valores de notes.ccaa considerados "dentro de la CV", ya normalizados con
// rpNormalizarTexto. Vacío/ausente → dentro (por defecto).
const RP_CCAA_CV = new Set([
  '', 'comunitat valenciana', 'comunidad valenciana', 'c valenciana', 'cv',
  'valencia', 'pais valenciano', 'pais valencia'
]);

// Grupos de categoría — replicado de _CAL_CAT_GROUPS (assets/js/app.js:2323),
// mantener sincronizado a mano si el dashboard cambia.
const RP_GRUPOS_CATEGORIA = [
  { key: 'cadete',   label: 'Cadetes',    re: /cadet|\bcad\b|\bcad[-\s]?\d/i },
  { key: 'juvenil',  label: 'Juveniles',  re: /juvenil|j[uú]nior|\bjuv\b|\bjun\b/i },
  { key: 'sub23',    label: 'Sub-23',     re: /sub[-\s]?23/i },
  { key: 'elite',    label: 'Élite',      re: /[eé]lite|\belit\b/i },
  { key: 'master',   label: 'Máster',     re: /m[aá]ster|veterano/i },
  { key: 'fem',      label: 'Féminas',    re: /femen|f[eé]mina|mujer|dones/i },
  { key: 'infantil', label: 'Infantiles', re: /infantil/i },
  { key: 'alevin',   label: 'Alevines',   re: /alev[ií]n/i },
  { key: 'escuela',  label: 'Escuelas',   re: /escuela|promesa|principiante/i }
];
const RP_GRUPO_OTROS = { key: 'otros', label: 'Otras' };

/* ============================================================
   UTILIDADES PURAS DE DOMINIO
   ============================================================ */

// Identidad de un ciclista entre pruebas: "apellido, nombre" en minúsculas,
// sin acentos, solo primer apellido — replicado de normalizeForMatching
// (assets/js/app.js:10052), mantener sincronizado a mano.
function rpNormalizarClave(nombre) {
  if (!nombre) return '';
  const s = String(nombre).trim();
  const coma = s.match(/^([^,]+),\s*(.+)$/);
  let ap, nm;
  if (coma) {
    ap = (coma[1].trim().split(/\s+/)[0]) || '';
    nm = (coma[2].trim().split(/\s+/)[0]) || '';
  } else {
    const partes = s.split(/\s+/).filter(Boolean);
    if (partes.length < 2) return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    nm = partes[0]; ap = partes[1];
  }
  return (ap + ', ' + nm).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Normalización genérica para comparar/buscar: minúsculas, sin acentos,
// sin puntuación, espacios colapsados.
function rpNormalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Grupo de categoría de una cat de resultado — replicado de _calCatGroup
// (assets/js/app.js:2334), mantener sincronizado a mano. Las categorías
// femeninas (F-CAD, F-JUN, Femenino…) van SIEMPRE a 'fem' y hay que
// comprobarlo ANTES porque "F-JUN" contiene "JUN" y "F-CAD" contiene "CAD".
function rpGrupoCategoria(cat) {
  const s = String(cat || '');
  if (/^\s*f[-\s.]?(cad|jun|juv|elit|sub|mast|inf|alev)/i.test(s) || /femen|f[eé]mina|mujer|dones/i.test(s)) {
    return 'fem';
  }
  for (const g of RP_GRUPOS_CATEGORIA) { if (g.re.test(s)) return g.key; }
  return null;
}

function rpEsFueraCV(ccaa) {
  return !RP_CCAA_CV.has(rpNormalizarTexto(ccaa));
}

// Tipología de la carrera. Precedencia: etapa > challenge > fuera_cv >
// ordinaria. Etapa primero porque su tabla anula el coeficiente; challenge
// antes que fuera_cv porque challengeCV es un flag manual explícito y
// prevalece sobre un ccaa posiblemente mal escrito.
function rpTipoCarrera(carrera) {
  if (RP_RE_ETAPA.test(carrera.nombre || '')) return 'etapa';
  if (carrera.challengeCV === true) return 'challenge';
  if (rpEsFueraCV(carrera.ccaa)) return 'fuera_cv';
  return 'ordinaria';
}

// Puntos de un resultado. pos null/0 → todo a 0 (no clasificado, sin bono).
// Posición válida fuera de tabla → base 0 pero el bono de terminar SÍ cuenta.
function rpPuntosResultado(pos, tipo) {
  const p = parseInt(pos, 10);
  if (!Number.isFinite(p) || p <= 0) return { base: 0, coef: 0, bono: 0, puntos: 0 };
  if (tipo === 'etapa') {
    const base = RP_PUNTOS_ETAPA[p] || 0;
    return { base, coef: 1, bono: RP_BONO_FINALIZAR, puntos: base + RP_BONO_FINALIZAR };
  }
  const base = RP_PUNTOS_BASE[p] || 0;
  const coef = RP_COEFICIENTES[tipo] ?? 1;
  // Redondeo a 2 decimales para evitar artefactos float de ×1.35.
  const puntos = Math.round((base * coef + RP_BONO_FINALIZAR) * 100) / 100;
  return { base, coef, bono: RP_BONO_FINALIZAR, puntos };
}

function rpTemporada(fechaISO) {
  const a = parseInt(String(fechaISO || '').slice(0, 4), 10);
  return Number.isFinite(a) ? a : null;
}

/* ============================================================
   ADAPTACIÓN DE DATOS CRUDOS
   ============================================================ */

// Transforma la respuesta cruda de Supabase en carreras "slim", descartando
// de inmediato notes (que puede incluir un GPX enorme en notes.route) para
// no retenerlo en memoria. try/catch como en el dashboard (app.js:8030):
// notes corrupto → carrera ordinaria.
function rpAdaptarCarreras(filas) {
  return (filas || []).map(r => {
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    // notes.regions = { nombreCorredor → comunidad/país } (lo rellena el
    // dashboard para las clasificaciones autonómicas). Reindexamos por la
    // clave normalizada para poder cruzarlo con los resultados.
    const regiones = {};
    const rawRegs = extra.regions || {};
    for (const k in rawRegs) {
      const v = String(rawRegs[k] || '').trim();
      if (v) regiones[rpNormalizarClave(k)] = v;
    }
    const carrera = {
      id: r.id,
      nombre: r.name || '',
      fecha: r.date || '',
      temporada: rpTemporada(r.date),
      challengeCV: extra.challengeCV === true,
      ccaa: extra.ccaa || '',
      localidad: extra.localidad || '',
      km: extra.km || '',
      regiones,
      resultados: (r.race_results || []).map(x => ({
        pos: x.pos, nombre: x.name || '', equipo: x.team || '', cat: x.cat || ''
      }))
    };
    carrera.tipo = rpTipoCarrera(carrera);
    return carrera;
  }).filter(c => c.temporada !== null);
}

/* ============================================================
   MOTOR DE CÁLCULO (puro, sin DOM)
   ============================================================ */

// Desempate del ranking: puntos desc → countback (más 1ºs, luego 2ºs…
// entre resultados contados) → mejor puesto en la carrera contada más
// reciente → alfabético.
function rpCompararCorredores(a, b) {
  if (b.puntosTotales !== a.puntosTotales) return b.puntosTotales - a.puntosTotales;
  for (let i = 0; i < 20; i++) {
    if (b.conteoPuestos[i] !== a.conteoPuestos[i]) return b.conteoPuestos[i] - a.conteoPuestos[i];
  }
  const ua = a.resultados.find(r => r.contado);
  const ub = b.resultados.find(r => r.contado);
  if (ua && ub && ua.pos !== ub.pos) return ua.pos - ub.pos;
  return a.nombre.localeCompare(b.nombre, 'es');
}

// Función principal: recibe las carreras slim y devuelve el ranking completo
// de una temporada, con TODOS los corredores puntuados y su desglose.
// `hastaFecha` (exclusiva) permite recalcular el ranking "a jornada anterior"
// para las flechas de evolución.
function calcularRankingPublico(carreras, { temporada, hastaFecha } = {}) {
  const temporadasDisponibles = [...new Set(carreras.map(c => c.temporada))].sort((x, y) => y - x);
  const anyo = temporada ?? temporadasDisponibles[0] ?? null;
  const delAnyo = carreras.filter(c =>
    c.temporada === anyo && (!hastaFecha || c.fecha < hastaFecha));

  // Agrupar resultados por corredor (clave = nombre normalizado).
  const porCorredor = new Map();
  for (const carrera of delAnyo) {
    for (const res of carrera.resultados) {
      const clave = rpNormalizarClave(res.nombre);
      if (!clave) continue;
      if (!porCorredor.has(clave)) porCorredor.set(clave, []);
      const pts = rpPuntosResultado(res.pos, carrera.tipo);
      porCorredor.get(clave).push({
        raceId: carrera.id,
        carrera: carrera.nombre,
        fecha: carrera.fecha,
        pos: (Number.isFinite(parseInt(res.pos, 10)) && parseInt(res.pos, 10) > 0) ? parseInt(res.pos, 10) : null,
        tipo: carrera.tipo,
        base: pts.base, coef: pts.coef, bono: pts.bono, puntos: pts.puntos,
        contado: false,
        motivoNoContado: null,
        _nombre: res.nombre, _equipo: res.equipo, _cat: res.cat,
        _region: carrera.regiones[clave] || ''
      });
    }
  }

  const corredores = [];
  for (const [clave, resultados] of porCorredor) {
    // Orden cronológico descendente para display y para "más reciente".
    resultados.sort((x, y) => (y.fecha || '').localeCompare(x.fecha || ''));

    // Corte top-12: entre los resultados con puntos, de mayor a menor
    // (empate → el más reciente primero, que ya lo garantiza el orden previo
    //  al ser sort estable).
    const puntuables = resultados.filter(r => r.puntos > 0).sort((x, y) => y.puntos - x.puntos);
    puntuables.forEach((r, i) => {
      if (i < RP_MAX_RESULTADOS_CONTADOS) r.contado = true;
      else r.motivoNoContado = 'fuera_top12';
    });
    resultados.forEach(r => { if (!r.contado && !r.motivoNoContado) r.motivoNoContado = r.puntos > 0 ? 'fuera_top12' : 'sin_posicion'; });

    const contados = resultados.filter(r => r.contado);
    const puntosTotales = Math.round(contados.reduce((s, r) => s + r.puntos, 0) * 100) / 100;
    if (puntosTotales === 0) continue; // corredores sin puntos no entran en la tabla

    // Categoría del corredor: grupo más frecuente entre sus resultados de la
    // temporada; empate → el del resultado más reciente; ninguno → 'otros'.
    const votos = new Map();
    for (const r of resultados) {
      const g = rpGrupoCategoria(r._cat);
      if (g) votos.set(g, (votos.get(g) || 0) + 1);
    }
    let categoria = 'otros';
    if (votos.size) {
      const max = Math.max(...votos.values());
      const empatados = [...votos.entries()].filter(([, n]) => n === max).map(([g]) => g);
      categoria = empatados.length === 1
        ? empatados[0]
        : (resultados.map(r => rpGrupoCategoria(r._cat)).find(g => empatados.includes(g)) || empatados[0]);
    }

    // Comunidad del corredor: la más repetida en los mapas notes.regions de
    // sus pruebas (empate → la del resultado más reciente). '' = sin dato.
    // Se compara normalizada para que "Comunitat Valenciana" y "comunidad
    // valenciana" cuenten como la misma; se muestra el literal más frecuente.
    const votosReg = new Map();
    for (const r of resultados) {
      if (!r._region) continue;
      const k = rpNormalizarTexto(r._region);
      const e = votosReg.get(k) || { n: 0, display: r._region };
      e.n++;
      votosReg.set(k, e);
    }
    let region = '';
    if (votosReg.size) {
      const maxReg = Math.max(...[...votosReg.values()].map(e => e.n));
      const empatadosReg = [...votosReg.entries()].filter(([, e]) => e.n === maxReg);
      if (empatadosReg.length === 1) {
        region = empatadosReg[0][1].display;
      } else {
        const claves = new Set(empatadosReg.map(([k]) => k));
        const rec = resultados.find(r => r._region && claves.has(rpNormalizarTexto(r._region)));
        region = rec ? votosReg.get(rpNormalizarTexto(rec._region)).display : empatadosReg[0][1].display;
      }
    }

    // Countback de puestos (solo contados) para desempates y medallas.
    const conteoPuestos = new Array(20).fill(0);
    for (const r of contados) { if (r.pos >= 1 && r.pos <= 20) conteoPuestos[r.pos - 1]++; }

    const masReciente = resultados[0];
    // Etiquetas de categoría tal cual las escribe el organizador (CAD-1,
    // CAD-2, CADETE…): alimentan el filtro de subcategoría de la UI.
    const subcats = [...new Set(resultados.map(r => String(r._cat || '').trim().toUpperCase()).filter(Boolean))];
    corredores.push({
      clave,
      nombre: masReciente._nombre,
      equipo: masReciente._equipo,
      categoria,
      subcats,
      region,
      puntosTotales,
      pruebasContadas: contados.length,
      pruebasTotales: resultados.length,
      conteoPuestos,
      resultados: resultados.map(({ _nombre, _equipo, _cat, _region, ...r }) => r)
    });
  }

  // Agrupar por categoría en el orden canónico (+ 'otros' al final).
  const categorias = [];
  for (const g of [...RP_GRUPOS_CATEGORIA, RP_GRUPO_OTROS]) {
    const lista = corredores.filter(c => c.categoria === g.key).sort(rpCompararCorredores);
    if (lista.length) categorias.push({ key: g.key, label: g.label, corredores: lista });
  }

  return { temporada: anyo, temporadasDisponibles, categorias };
}

/* ============================================================
   CAPA DE UI
   ============================================================ */

const rpEstado = {
  carreras: null,     // CarreraSlim[] (todas las temporadas)
  temporada: null,
  categoria: null,    // key de la pestaña activa
  subcategoria: '',   // etiqueta de organizador (CAD-1, CAD-2…); '' = todas
  // Arranca filtrado por la Comunitat Valenciana (la mayoría de los datos son
  // de aquí). rpRenderRegiones lo valida contra los datos: si una temporada no
  // tuviera corredores CV, cae a '' (todas). La URL ?comunidad=... lo cambia.
  region: 'comunitat valenciana', // normalizada; '' = todas; RP_REGION_SIN = sin dato
  equipo: '',         // equipo normalizado; '' = todos
  busqueda: '',
  ranking: null       // salida de calcularRankingPublico
};

function rpEscapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rpFormatearPuntos(n) {
  return (Math.round(n * 100) / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

function rpFormatearFecha(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

function rpMostrarEstado(html) {
  const el = document.getElementById('rp-estado');
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}
function rpMostrarCargando() {
  rpMostrarEstado('<div class="rp-cargando-caja"><div class="rp-spinner" aria-hidden="true"></div><p class="rp-cargando">Cargando ranking…</p></div>');
}
function rpMostrarError(msg) {
  rpMostrarEstado(
    `<p class="rp-error">No se ha podido cargar el ranking. ${rpEscapar(msg || '')}</p>` +
    '<button type="button" class="rp-reintentar" onclick="rpIniciar()">Reintentar</button>'
  );
}
function rpMostrarVacio() {
  rpMostrarEstado(`<p class="rp-vacio">No hay pruebas puntuables en la temporada ${rpEscapar(rpEstado.temporada)}.</p>`);
}

// Subtítulo de la cabecera y title del documento según los filtros activos,
// p.ej. "Cadetes · Comunitat Valenciana · Temporada 2026".
function rpRenderSubtitulo() {
  const el = document.getElementById('rp-subtitulo');
  if (!rpEstado.ranking) { el.textContent = ''; return; }
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  const partes = [];
  if (cat) partes.push(cat.label);
  if (rpEstado.region === RP_REGION_SIN) partes.push('Sin comunidad asignada');
  else if (rpEstado.region) partes.push(rpEstado.regionDisplay || '');
  partes.push('Temporada ' + rpEstado.temporada);
  const texto = partes.filter(Boolean).join(' · ');
  el.textContent = texto;
  document.title = 'Ranking MFPP Cycling — ' + texto;
}

// Bloque "Últimos resultados" (estilo portada de FirstCycling): las carreras
// de las últimas jornadas de la temporada activa, con su ganador y equipo.
// Carrera y ganador son clicables → ficha correspondiente.
function rpRenderUltimos() {
  const caja = document.getElementById('rp-ultimos-caja');
  const cont = document.getElementById('rp-ultimos');
  const conResultados = (rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.resultados.length)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  const fechas = [...new Set(conResultados.map(c => c.fecha))].slice(0, 3);
  const recientes = conResultados.filter(c => fechas.includes(c.fecha));
  if (!recientes.length) { caja.style.display = 'none'; cont.innerHTML = ''; return; }
  caja.style.display = '';
  cont.innerHTML = recientes.map(c => {
    const ganador = c.resultados.find(r => parseInt(r.pos, 10) === 1);
    return '<div class="rp-ultimo">' +
      `<span class="rp-ultimo-fecha">${rpEscapar(rpFormatearFecha(c.fecha))}</span>` +
      `<button type="button" class="rp-enlace rp-ultimo-nombre" data-carrera="${rpEscapar(c.id)}">${rpEscapar(c.nombre)}</button>` +
      (ganador
        ? `<span class="rp-ultimo-ganador">🏆 <button type="button" class="rp-enlace" data-corredor="${rpEscapar(rpNormalizarClave(ganador.nombre))}">${rpEscapar(ganador.nombre)}</button>` +
          `${ganador.equipo ? ` <span class="rp-ultimo-equipo">(${rpEscapar(ganador.equipo)})</span>` : ''}</span>`
        : '') +
      '</div>';
  }).join('');
}

function rpRenderTemporadas() {
  const sel = document.getElementById('rp-temporada');
  sel.innerHTML = rpEstado.ranking.temporadasDisponibles
    .map(a => `<option value="${a}"${a === rpEstado.temporada ? ' selected' : ''}>${a}</option>`)
    .join('');
}

const RP_REGION_SIN = '__sin__'; // valor del select para "sin comunidad asignada"

// Insignia corta por comunidad (clave normalizada con rpNormalizarTexto) y
// bandera emoji para países. Lo que no esté aquí cae a las 3 primeras letras.
const RP_BADGE_REGION = {
  'comunitat valenciana': 'CV', 'comunidad valenciana': 'CV',
  'murcia': 'MUR', 'madrid': 'MAD', 'cataluna': 'CAT', 'andalucia': 'AND',
  'castilla la mancha': 'CLM', 'castilla y leon': 'CYL', 'extremadura': 'EXT',
  'galicia': 'GAL', 'canarias': 'CAN', 'cantabria': 'CNT', 'aragon': 'ARA',
  'pais vasco': 'EUS', 'euskadi': 'EUS', 'c foral navarra': 'NAV', 'navarra': 'NAV',
  'la rioja': 'RIO', 'asturias': 'AST', 'illes balears': 'IB', 'islas baleares': 'IB',
  'iba': 'IB', 'ceuta': 'CEU', 'melilla': 'MEL',
  'belgica': '🇧🇪', 'portugal': '🇵🇹', 'paises bajos': '🇳🇱', 'francia': '🇫🇷',
  'italia': '🇮🇹', 'alemania': '🇩🇪', 'reino unido': '🇬🇧', 'suiza': '🇨🇭', 'andorra': '🇦🇩'
};
function rpBadgeRegion(region) {
  if (!region) return '';
  const k = rpNormalizarTexto(region);
  return RP_BADGE_REGION[k] || k.slice(0, 3).toUpperCase();
}

// Población de la pestaña activa tras aplicar los filtros de comunidad y
// subcategoría. Estos filtros REDEFINEN el ranking (las posiciones se
// renumeran 1..n sobre la población filtrada); el buscador, en cambio, solo
// oculta filas conservando la posición.
function rpPoblacion(cat) {
  return cat.corredores.filter(c => {
    if (rpEstado.region === RP_REGION_SIN) { if (c.region) return false; }
    else if (rpEstado.region && rpNormalizarTexto(c.region) !== rpEstado.region) return false;
    if (rpEstado.subcategoria && !c.subcats.includes(rpEstado.subcategoria)) return false;
    if (rpEstado.equipo && rpNormalizarTexto(c.equipo) !== rpEstado.equipo) return false;
    return true;
  });
}

// Desplegable de equipo: equipos presentes en la pestaña activa, alfabético.
// Mismo patrón que el de subcategoría (dinámico, se oculta si no aporta).
function rpRenderEquipos() {
  const sel = document.getElementById('rp-equipo');
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  const vistos = new Map(); // normalizado → display
  if (cat) for (const c of cat.corredores) {
    if (c.equipo) vistos.set(rpNormalizarTexto(c.equipo), c.equipo);
  }
  if (vistos.size < 2) {
    rpEstado.equipo = '';
    sel.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  if (rpEstado.equipo && !vistos.has(rpEstado.equipo)) rpEstado.equipo = '';
  const claves = [...vistos.keys()].sort((a, b) => vistos.get(a).localeCompare(vistos.get(b), 'es'));
  sel.style.display = '';
  sel.innerHTML = '<option value="">Todos los equipos</option>' +
    claves.map(k =>
      `<option value="${rpEscapar(k)}"${k === rpEstado.equipo ? ' selected' : ''}>${rpEscapar(vistos.get(k))}</option>`
    ).join('');
}

// Desplegable de comunidad autónoma: opciones dinámicas a partir de los datos
// (ampliable solo: cuando aparezcan corredores de una comunidad nueva, sale
// aquí). Comunitat Valenciana primero, resto alfabético, "Sin comunidad" al
// final solo si hay corredores sin dato.
function rpRenderRegiones() {
  const sel = document.getElementById('rp-region');
  const vistas = new Map(); // normalizada → display
  let haySinRegion = false;
  for (const cat of rpEstado.ranking.categorias) {
    for (const c of cat.corredores) {
      if (c.region) vistas.set(rpNormalizarTexto(c.region), c.region);
      else haySinRegion = true;
    }
  }
  if (!vistas.size) { sel.style.display = 'none'; sel.innerHTML = ''; rpEstado.region = ''; return; }
  const esCV = k => k === 'comunitat valenciana' || k === 'comunidad valenciana';
  const claves = [...vistas.keys()].sort((a, b) =>
    (esCV(b) - esCV(a)) || vistas.get(a).localeCompare(vistas.get(b), 'es'));
  if (rpEstado.region && rpEstado.region !== RP_REGION_SIN && !vistas.has(rpEstado.region)) {
    // "comunitat valenciana" y "comunidad valenciana" son la misma comunidad:
    // si el literal exacto no está en los datos, probamos el alias antes de
    // caer a "Todas".
    rpEstado.region = (esCV(rpEstado.region) && claves.find(esCV)) || '';
  }
  if (rpEstado.region === RP_REGION_SIN && !haySinRegion) rpEstado.region = '';
  rpEstado.regionDisplay = vistas.get(rpEstado.region) || '';
  sel.style.display = '';
  sel.innerHTML = '<option value="">Todas las comunidades</option>' +
    claves.map(k =>
      `<option value="${rpEscapar(k)}"${k === rpEstado.region ? ' selected' : ''}>${rpEscapar(vistas.get(k))}</option>`
    ).join('') +
    (haySinRegion ? `<option value="${RP_REGION_SIN}"${rpEstado.region === RP_REGION_SIN ? ' selected' : ''}>Sin comunidad asignada</option>` : '');
}

// Desplegable de subcategoría: se rellena con las etiquetas reales presentes
// en la pestaña activa (p.ej. en Cadetes: CAD-1, CAD-2, CADETE). Si la pestaña
// solo tiene una etiqueta (o ninguna), el filtro no aporta nada y se oculta.
function rpRenderSubcats() {
  const sel = document.getElementById('rp-subcat');
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  const etiquetas = cat
    ? [...new Set(cat.corredores.flatMap(c => c.subcats))].sort((a, b) => a.localeCompare(b, 'es'))
    : [];
  if (etiquetas.length < 2) {
    rpEstado.subcategoria = '';
    sel.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  if (!etiquetas.includes(rpEstado.subcategoria)) rpEstado.subcategoria = '';
  sel.style.display = '';
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    etiquetas.map(e =>
      `<option value="${rpEscapar(e)}"${e === rpEstado.subcategoria ? ' selected' : ''}>${rpEscapar(e)}</option>`
    ).join('');
}

function rpRenderPestanas() {
  const nav = document.getElementById('rp-pestanas');
  // El contador refleja el filtro de comunidad (la subcategoría no, porque
  // sus etiquetas son propias de cada pestaña).
  const cuenta = cat => cat.corredores.filter(c => {
    if (rpEstado.region === RP_REGION_SIN) return !c.region;
    return !rpEstado.region || rpNormalizarTexto(c.region) === rpEstado.region;
  }).length;
  nav.innerHTML = rpEstado.ranking.categorias.map(c =>
    `<button type="button" role="tab" data-cat="${c.key}"` +
    ` aria-selected="${c.key === rpEstado.categoria}"` +
    ` class="rp-pestana${c.key === rpEstado.categoria ? ' rp-activa' : ''}">` +
    `${rpEscapar(c.label)} <span class="rp-num">${cuenta(c)}</span></button>`
  ).join('');
}

const RP_MOTIVOS = {
  fuera_top12: 'Descartado (fuera de los 12 mejores)',
  sin_posicion: 'Sin posición válida (no puntúa)'
};

function rpEtiquetaCategoria(key) {
  const g = RP_GRUPOS_CATEGORIA.find(x => x.key === key);
  return g ? g.label : (key === 'otros' ? RP_GRUPO_OTROS.label : key);
}

// Historial de la temporada para la ficha: todos los resultados, con podios
// (1º-3º) resaltados en verde y los descartados en gris.
function rpRenderHistorial(corredor) {
  const filas = corredor.resultados.map(r => {
    const clases = [];
    if (!r.contado) clases.push('rp-descartado');
    if (r.pos >= 1 && r.pos <= 3) clases.push('rp-podio');
    const coefTxt = r.tipo === 'etapa' ? '—' : `×${r.coef.toFixed(2)}`;
    const motivo = !r.contado ? ` title="${rpEscapar(RP_MOTIVOS[r.motivoNoContado] || '')}"` : '';
    return `<tr class="${clases.join(' ')}"${motivo}>` +
      `<td>${rpEscapar(rpFormatearFecha(r.fecha))}</td>` +
      `<td class="rp-col-carrera"><button type="button" class="rp-enlace" data-carrera="${rpEscapar(r.raceId)}">${rpEscapar(r.carrera)}</button><span class="rp-tipo rp-tipo-${r.tipo}">${rpEscapar(RP_ETIQUETAS_TIPO[r.tipo] || r.tipo)}</span></td>` +
      `<td class="rp-c"><span class="rp-posicion">${r.pos ?? '—'}</span></td>` +
      `<td class="rp-c rp-col-mat">${rpFormatearPuntos(r.base)}</td>` +
      `<td class="rp-c rp-col-mat">${coefTxt}</td>` +
      `<td class="rp-c rp-col-mat">${r.bono ? '+' + r.bono : '—'}</td>` +
      `<td class="rp-c rp-pts">${rpFormatearPuntos(r.puntos)}${!r.contado ? ' *' : ''}</td>` +
      `</tr>`;
  }).join('');
  return '<div class="rp-tabla-historial"><table class="rp-subtabla">' +
    '<thead><tr><th>Fecha</th><th>Prueba</th><th>Pos.</th><th class="rp-col-mat">Base</th><th class="rp-col-mat">Coef.</th><th class="rp-col-mat">Bono</th><th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    '<p class="rp-nota">* Resultado descartado: solo suman los 12 mejores de la temporada. En gris también los resultados sin posición válida (0 puntos). En verde, los podios.</p>';
}

// Mini-gráfico SVG de evolución: puntos acumulados carrera a carrera (solo
// suman los resultados contados, así el final coincide con el total del
// ranking; las carreras descartadas aparecen como tramo plano con marcador
// gris). Una sola serie → sin leyenda; color de datos #0891b2 (validado con
// la skill dataviz: banda de luminosidad, croma, contraste sobre blanco).
function rpSparkline(corredor) {
  const datos = [...corredor.resultados].reverse(); // cronológico ascendente
  if (datos.length < 2) return '';
  let acum = 0;
  const serie = datos.map(r => {
    if (r.contado) acum = Math.round((acum + r.puntos) * 100) / 100;
    return { ...r, acum };
  });
  const W = 600, H = 150, PL = 10, PR = 56, PT = 16, PB = 22;
  const max = serie[serie.length - 1].acum || 1;
  const x = i => PL + i * (W - PL - PR) / (serie.length - 1);
  const y = v => PT + (1 - v / max) * (H - PT - PB);
  const linea = serie.map((p, i) => `${x(i).toFixed(1)},${y(p.acum).toFixed(1)}`).join(' ');
  const marcas = serie.map((p, i) => {
    const cx = x(i).toFixed(1), cy = y(p.acum).toFixed(1);
    const detalle = `${rpFormatearFecha(p.fecha)} · ${p.carrera}\n` +
      `Posición: ${p.pos ?? '—'} · ${p.contado ? '+' + rpFormatearPuntos(p.puntos) + ' pts' : 'no cuenta'}\n` +
      `Acumulado: ${rpFormatearPuntos(p.acum)} pts`;
    return `<g class="rp-spark-punto"><circle cx="${cx}" cy="${cy}" r="9" fill="transparent"></circle>` +
      `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${p.contado ? 'var(--rp-color-acento)' : 'var(--rp-color-borde)'}" stroke="var(--rp-color-fondo)" stroke-width="2"></circle>` +
      `<title>${rpEscapar(detalle)}</title></g>`;
  }).join('');
  const y0 = y(0).toFixed(1);
  return '<figure class="rp-spark">' +
    '<figcaption class="rp-spark-titulo">Evolución de puntos en la temporada</figcaption>' +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de puntos acumulados de ${rpEscapar(corredor.nombre)}: ${rpFormatearPuntos(corredor.puntosTotales)} puntos en ${serie.length} pruebas">` +
    `<line x1="${PL}" y1="${y0}" x2="${W - PR}" y2="${y0}" stroke="var(--rp-color-borde)" stroke-width="1"></line>` +
    `<polyline points="${linea}" fill="none" stroke="var(--rp-color-acento)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>` +
    marcas +
    `<text x="${(W - PR + 8).toFixed(1)}" y="${(y(max) + 4).toFixed(1)}" class="rp-spark-valor">${rpFormatearPuntos(corredor.puntosTotales)}</text>` +
    '</svg></figure>';
}

// ── Modal de ficha del ciclista ──
function rpAbrirModal(clave) {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) return;
  // El puesto mostrado es el del ranking filtrado que se ve en la tabla.
  const poblacion = rpPoblacion(cat);
  const idx = poblacion.findIndex(c => c.clave === clave);
  let c = idx >= 0 ? poblacion[idx] : cat.corredores.find(x => x.clave === clave);
  if (!c) {
    // El corredor puede ser de otra categoría (p.ej. clic desde la
    // clasificación de una carrera mixta): buscarlo en todas.
    for (const g of rpEstado.ranking.categorias) {
      c = g.corredores.find(x => x.clave === clave);
      if (c) break;
    }
  }
  if (!c) return;
  rpEstado.modalClave = c.clave;
  // Estadísticas de la temporada completa (incluye resultados descartados:
  // una victoria es una victoria aunque no cuente para el total).
  const posValidas = c.resultados.map(r => r.pos).filter(p => p >= 1);
  const victorias = posValidas.filter(p => p === 1).length;
  const podios = posValidas.filter(p => p <= 3).length;
  const top10 = posValidas.filter(p => p <= 10).length;
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(c.nombre)}</h2>` +
    `<p class="rp-ficha-equipo">${rpEscapar(c.equipo)}</p>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(rpEtiquetaCategoria(c.categoria))}</span>` +
    (c.region ? `<span class="rp-chip">${rpEscapar(c.region)}</span>` : '') +
    `<span class="rp-chip">Temporada ${rpEscapar(rpEstado.temporada)}</span>` +
    (idx >= 0 ? `<span class="rp-chip">Puesto ${idx + 1}º</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${rpFormatearPuntos(c.puntosTotales)} pts</span>` +
    '</div>' +
    '<div class="rp-ficha-stats">' +
    `<span class="rp-stat">🥇 <b>${victorias}</b> victorias</span>` +
    `<span class="rp-stat">🏆 <b>${podios}</b> podios</span>` +
    `<span class="rp-stat">🔟 <b>${top10}</b> top-10</span>` +
    `<span class="rp-stat">🚴 <b>${c.pruebasTotales}</b> pruebas</span>` +
    '</div></header>' +
    rpSparkline(c) +
    rpRenderHistorial(c);
  // Navegación ‹ › sobre el ranking filtrado actual
  const btnAnt = document.getElementById('rp-modal-ant');
  const btnSig = document.getElementById('rp-modal-sig');
  btnAnt.disabled = idx <= 0;
  btnSig.disabled = idx < 0 || idx >= poblacion.length - 1;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden'; // no scroll de fondo con el modal abierto
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

function rpCarreraPorId(id) {
  return (rpEstado.carreras || []).find(c => String(c.id) === String(id)) || null;
}

// ── Ficha de carrera (modal) ──
// Info de la prueba, podio destacado y clasificación completa con los puntos
// que otorga cada puesto según el sistema del ranking. Los corredores son
// clicables y llevan a su ficha.
function rpAbrirModalCarrera(raceId) {
  const carrera = rpCarreraPorId(raceId);
  if (!carrera) return;
  rpEstado.modalClave = null; // las flechas ‹ › solo navegan entre corredores
  const ordenados = [...carrera.resultados].sort((a, b) => {
    const pa = parseInt(a.pos, 10), pb = parseInt(b.pos, 10);
    const va = Number.isFinite(pa) && pa > 0, vb = Number.isFinite(pb) && pb > 0;
    if (va && vb) return pa - pb;
    return va ? -1 : (vb ? 1 : 0); // sin posición válida, al final
  });
  const nClasificados = ordenados.filter(r => parseInt(r.pos, 10) > 0).length;
  const coefTxt = carrera.tipo === 'etapa'
    ? 'Tabla de etapa (25…1)'
    : `Coef. ×${(RP_COEFICIENTES[carrera.tipo] ?? 1).toFixed(2)}`;
  const filas = ordenados.map(r => {
    const pos = parseInt(r.pos, 10) > 0 ? parseInt(r.pos, 10) : null;
    const pts = rpPuntosResultado(r.pos, carrera.tipo);
    const clases = [];
    if (!pos) clases.push('rp-descartado');
    if (pos && pos <= 3) clases.push('rp-podio');
    return `<tr class="${clases.join(' ')}">` +
      `<td class="rp-c"><span class="rp-posicion">${pos ?? '—'}</span></td>` +
      `<td><button type="button" class="rp-enlace" data-corredor="${rpEscapar(rpNormalizarClave(r.nombre))}">${rpEscapar(r.nombre)}</button></td>` +
      `<td>${rpEscapar(r.equipo)}</td>` +
      `<td class="rp-c">${rpEscapar(r.cat)}</td>` +
      `<td class="rp-c rp-pts">${pts.puntos ? rpFormatearPuntos(pts.puntos) : '—'}</td>` +
      `</tr>`;
  }).join('');
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(carrera.nombre)}</h2>` +
    `<p class="rp-ficha-equipo">${rpEscapar(rpFormatearFecha(carrera.fecha))}${carrera.localidad ? ' · ' + rpEscapar(carrera.localidad) : ''}</p>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(RP_ETIQUETAS_TIPO[carrera.tipo] || carrera.tipo)}</span>` +
    `<span class="rp-chip">${rpEscapar(coefTxt)}</span>` +
    (carrera.km ? `<span class="rp-chip">${rpEscapar(carrera.km)} km</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${nClasificados} clasificados</span>` +
    '</div></header>' +
    '<div class="rp-tabla-historial"><table class="rp-subtabla">' +
    '<thead><tr><th>Pos.</th><th>Corredor</th><th>Equipo</th><th>Cat.</th><th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    '<p class="rp-nota">Puntos que otorga cada puesto según el sistema del ranking (bono de +3 por terminar incluido). En verde, el podio; en gris, sin posición válida.</p>';
  document.getElementById('rp-modal-ant').disabled = true;
  document.getElementById('rp-modal-sig').disabled = true;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

// Abre la ficha del corredor adyacente (dir = -1 anterior, +1 siguiente).
function rpNavegarModal(dir) {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat || !rpEstado.modalClave) return;
  const poblacion = rpPoblacion(cat);
  const idx = poblacion.findIndex(c => c.clave === rpEstado.modalClave);
  const destino = poblacion[idx + dir];
  if (idx >= 0 && destino) rpAbrirModal(destino.clave);
}

function rpCerrarModal() {
  rpEstado.modalClave = null;
  document.getElementById('rp-modal').hidden = true;
  document.body.style.overflow = '';
}

function rpRenderTabla() {
  const cont = document.querySelector('.rp-tabla-scroll');
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) { cont.innerHTML = ''; return; }

  const filtro = rpNormalizarTexto(rpEstado.busqueda);

  // Posiciones de la jornada anterior (misma población filtrada) para las
  // flechas de evolución.
  const posPrevias = new Map();
  const catPrev = rpEstado.rankingPrevio &&
    rpEstado.rankingPrevio.categorias.find(x => x.key === rpEstado.categoria);
  if (catPrev) rpPoblacion(catPrev).forEach((c, i) => posPrevias.set(c.clave, i + 1));

  const filas = [];
  rpPoblacion(cat).forEach((c, i) => {
    // i+1 es la posición dentro del ranking filtrado (comunidad/subcategoría
    // renumeran); el buscador solo oculta filas y conserva esa posición.
    if (filtro &&
        !rpNormalizarTexto(c.nombre).includes(filtro) &&
        !rpNormalizarTexto(c.equipo).includes(filtro)) return;
    const medallas =
      (c.conteoPuestos[0] ? '🥇'.repeat(Math.min(c.conteoPuestos[0], 3)) : '') +
      (c.conteoPuestos[1] ? '🥈'.repeat(Math.min(c.conteoPuestos[1], 2)) : '');
    let evo;
    const previa = posPrevias.get(c.clave);
    if (!previa) {
      evo = '<span class="rp-evo rp-evo-nuevo" title="Nuevo en el ranking">N</span>';
    } else if (previa > i + 1) {
      evo = `<span class="rp-evo rp-evo-sube" title="Sube ${previa - i - 1} desde el puesto ${previa}">▲${previa - i - 1}</span>`;
    } else if (previa < i + 1) {
      evo = `<span class="rp-evo rp-evo-baja" title="Baja ${i + 1 - previa} desde el puesto ${previa}">▼${i + 1 - previa}</span>`;
    } else {
      evo = '<span class="rp-evo rp-evo-igual" title="Mantiene el puesto">=</span>';
    }
    const badge = rpBadgeRegion(c.region);
    filas.push(
      `<tr class="rp-fila" data-clave="${rpEscapar(c.clave)}" tabindex="0" aria-label="Ver ficha de ${rpEscapar(c.nombre)}">` +
      `<td class="rp-c rp-rank">${i + 1}</td>` +
      `<td class="rp-c rp-col-evo">${evo}</td>` +
      `<td class="rp-col-nombre"><span class="rp-nombre">${rpEscapar(c.nombre)}</span>` +
      `${badge ? `<span class="rp-badge-region" title="${rpEscapar(c.region)}">${rpEscapar(badge)}</span>` : ''}` +
      `<span class="rp-equipo-sub">${rpEscapar(c.equipo)}</span>` +
      `${medallas ? `<span class="rp-medallas">${medallas}</span>` : ''}</td>` +
      `<td class="rp-col-equipo">${rpEscapar(c.equipo)}</td>` +
      `<td class="rp-c">${c.pruebasContadas}/${c.pruebasTotales}</td>` +
      `<td class="rp-c rp-pts">${rpFormatearPuntos(c.puntosTotales)}</td>` +
      `</tr>`
    );
  });

  rpRenderSubtitulo(); // cualquier cambio de filtro pasa por aquí
  rpGuardarPrefs();    // y se recuerda para la próxima visita
  cont.innerHTML =
    '<table id="rp-tabla"><thead><tr>' +
    '<th class="rp-c">#</th><th class="rp-c rp-col-evo" title="Evolución respecto a la jornada anterior">±</th>' +
    '<th>Corredor</th><th class="rp-col-equipo">Equipo</th>' +
    '<th class="rp-c" title="Pruebas que puntúan / pruebas disputadas">Pruebas</th><th class="rp-c">Puntos</th>' +
    '</tr></thead>' +
    `<tbody>${filas.join('') || '<tr><td colspan="6" class="rp-vacio">Sin resultados para esa búsqueda.</td></tr>'}</tbody></table>`;
}

function rpRenderTodo() {
  rpRenderTemporadas();
  rpRenderUltimos();    // depende solo de la temporada
  rpRenderRegiones();   // antes que las pestañas: valida el filtro de comunidad
  rpRenderPestanas();   // y sus contadores dependen de él
  rpRenderSubcats();
  rpRenderEquipos();
  rpRenderTabla();
}

// ── Preferencias del visitante (localStorage) ──
// Recuerda temporada, comunidad, pestaña y filtros entre visitas. En iframes
// con almacenamiento bloqueado localStorage puede lanzar: degradar en silencio.
function rpGuardarPrefs() {
  try {
    localStorage.setItem('rp-prefs', JSON.stringify({
      temporada: rpEstado.temporada,
      categoria: rpEstado.categoria,
      region: rpEstado.region,
      subcategoria: rpEstado.subcategoria,
      equipo: rpEstado.equipo
    }));
  } catch (_) { /* almacenamiento no disponible */ }
}
function rpCargarPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('rp-prefs') || 'null');
    if (!p || typeof p !== 'object') return;
    if (Number.isFinite(p.temporada)) rpEstado.temporada = p.temporada;
    if (typeof p.categoria === 'string') rpEstado.categoria = p.categoria;
    if (typeof p.region === 'string') rpEstado.region = p.region;
    if (typeof p.subcategoria === 'string') rpEstado.subcategoria = p.subcategoria;
    if (typeof p.equipo === 'string') rpEstado.equipo = p.equipo;
  } catch (_) { /* almacenamiento no disponible o corrupto */ }
}

function rpRecalcular() {
  rpEstado.ranking = calcularRankingPublico(rpEstado.carreras, { temporada: rpEstado.temporada });
  rpEstado.temporada = rpEstado.ranking.temporada;
  // Ranking "a jornada anterior" (sin las carreras de la última fecha) para
  // las flechas de evolución ▲▼ de la tabla.
  const fechas = rpEstado.carreras
    .filter(c => c.temporada === rpEstado.temporada && c.resultados.length)
    .map(c => c.fecha);
  const ultimaFecha = fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : null;
  rpEstado.rankingPrevio = ultimaFecha
    ? calcularRankingPublico(rpEstado.carreras, { temporada: rpEstado.temporada, hastaFecha: ultimaFecha })
    : null;
  rpCerrarModal();
  const cats = rpEstado.ranking.categorias;
  if (!cats.find(c => c.key === rpEstado.categoria)) rpEstado.categoria = cats[0]?.key || null;
  if (!cats.length) rpMostrarVacio(); else rpMostrarEstado('');
}

async function rpIniciar() {
  rpMostrarCargando();
  try {
    const { data, error } = await rpLeer(
      'races',
      'id, name, date, notes, race_results(pos, name, team, cat)',
      q => q.eq('race_type', 'clasificacion').order('date', { ascending: false })
    );
    if (error) throw error;
    rpEstado.carreras = rpAdaptarCarreras(data);
    rpEstado.temporada = null; // → la más reciente con datos
    // Preferencias guardadas del visitante (la URL manda sobre ellas después).
    rpCargarPrefs();
    if (rpEstado.temporada !== null &&
        !rpEstado.carreras.some(c => c.temporada === rpEstado.temporada)) {
      rpEstado.temporada = null; // la temporada guardada ya no tiene datos
    }
    rpRecalcular();
    rpRenderTodo();
    // Filtro inicial por URL: ?comunidad=Comunitat Valenciana (o el nombre de
    // cualquier comunidad de los datos). Útil para incrustar en la web una
    // versión que arranque mostrando solo la CV.
    const comunidad = new URLSearchParams(location.search).get('comunidad');
    if (comunidad) {
      rpEstado.region = rpNormalizarTexto(comunidad);
      rpRenderRegiones();   // valida contra los datos (si no existe, la resetea)
      rpRenderPestanas();
      rpRenderTabla();
    }
    // Enlace directo a una carrera: ?carrera=<id de la prueba>.
    const carreraParam = new URLSearchParams(location.search).get('carrera');
    if (carreraParam) rpAbrirModalCarrera(carreraParam);
    // Enlace directo a una ficha: ?ficha=Apellido, Nombre (se normaliza igual
    // que la identidad, así que admite variantes de mayúsculas/acentos).
    const ficha = new URLSearchParams(location.search).get('ficha');
    if (ficha) {
      const clave = rpNormalizarClave(ficha);
      const cat = rpEstado.ranking.categorias.find(c => c.corredores.some(x => x.clave === clave));
      if (cat) {
        rpEstado.categoria = cat.key;
        rpRenderPestanas();
        rpRenderSubcats();
        rpRenderTabla();
        rpAbrirModal(clave);
      }
    }
    if (new URLSearchParams(location.search).get('debug') === '1') {
      console.log('[ranking-publico] carreras adaptadas:', rpEstado.carreras);
      console.log('[ranking-publico] ranking:', rpEstado.ranking);
      const primero = rpEstado.ranking.categorias[0]?.corredores[0];
      if (primero) console.table(primero.resultados);
    }
  } catch (e) {
    console.error('[ranking-publico]', e);
    rpMostrarError(e && e.message ? e.message : '');
  }
}

// ── Arranque y eventos (delegados, registrados una sola vez) ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rp-temporada').addEventListener('change', e => {
    rpEstado.temporada = parseInt(e.target.value, 10);
    rpRecalcular();
    rpRenderTodo();
  });

  document.getElementById('rp-pestanas').addEventListener('click', e => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    rpEstado.categoria = btn.dataset.cat;
    rpRenderPestanas();
    rpRenderSubcats();
    rpRenderEquipos();
    rpRenderTabla();
  });

  document.getElementById('rp-equipo').addEventListener('change', e => {
    rpEstado.equipo = e.target.value;
    rpRenderTabla();
  });

  document.getElementById('rp-subcat').addEventListener('change', e => {
    rpEstado.subcategoria = e.target.value;
    rpRenderTabla();
  });

  document.getElementById('rp-region').addEventListener('change', e => {
    rpEstado.region = e.target.value;
    rpRenderPestanas();
    rpRenderTabla();
  });

  let tBusqueda = null;
  document.getElementById('rp-buscador').addEventListener('input', e => {
    clearTimeout(tBusqueda);
    tBusqueda = setTimeout(() => {
      rpEstado.busqueda = e.target.value;
      rpRenderTabla();
    }, 150);
  });

  // Abrir la ficha del ciclista (clic o teclado en la fila)
  document.querySelector('.rp-tabla-scroll').addEventListener('click', e => {
    const fila = e.target.closest('tr.rp-fila');
    if (fila) rpAbrirModal(fila.dataset.clave);
  });
  document.querySelector('.rp-tabla-scroll').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const fila = e.target.closest('tr.rp-fila');
    if (fila) { e.preventDefault(); rpAbrirModal(fila.dataset.clave); }
  });

  // Enlaces cruzados: clic en un corredor o una carrera (dentro del modal o
  // en "Últimos resultados") abre la ficha correspondiente.
  const alClicEnlace = e => {
    const bCorredor = e.target.closest('[data-corredor]');
    if (bCorredor) { rpAbrirModal(bCorredor.dataset.corredor); return; }
    const bCarrera = e.target.closest('[data-carrera]');
    if (bCarrera) rpAbrirModalCarrera(bCarrera.dataset.carrera);
  };
  document.getElementById('rp-modal-contenido').addEventListener('click', alClicEnlace);
  document.getElementById('rp-ultimos').addEventListener('click', alClicEnlace);

  // Cerrar la ficha: botón X, toque fuera del cuadro, o tecla Escape.
  // Navegar entre fichas: botones ‹ › o flechas del teclado.
  document.getElementById('rp-modal-cerrar').addEventListener('click', rpCerrarModal);
  document.getElementById('rp-modal-ant').addEventListener('click', () => rpNavegarModal(-1));
  document.getElementById('rp-modal-sig').addEventListener('click', () => rpNavegarModal(1));
  document.getElementById('rp-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) rpCerrarModal();
  });
  document.addEventListener('keydown', e => {
    if (document.getElementById('rp-modal').hidden) return;
    if (e.key === 'Escape') rpCerrarModal();
    else if (e.key === 'ArrowLeft') rpNavegarModal(-1);
    else if (e.key === 'ArrowRight') rpNavegarModal(1);
  });

  rpIniciar();
});
