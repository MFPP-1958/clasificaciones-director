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

// Puntuación de etapas: MEDIA tabla de una carrera de un día (RP_PUNTOS_BASE
// ÷2, redondeado al alza), top-20. Así ganar una etapa (50) vale la mitad que
// ganar una clásica (100): un premio digno aunque el corredor abandone la
// vuelta y no entre en la general, sin que la vuelta pese como dos carreras.
const RP_PUNTOS_ETAPA = {
  1: 50, 2: 40, 3: 33, 4: 28, 5: 24, 6: 21, 7: 18, 8: 16, 9: 14, 10: 12,
  11: 11, 12: 9, 13: 8, 14: 7, 15: 6, 16: 5, 17: 4, 18: 3, 19: 2, 20: 1
};

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
  etapa: 'Etapa',
  general: 'General de vuelta'
};

// ── Coeficiente de participación ──
// Ganar con un pelotón venido de media España (o de fuera) vale más que
// ganar un critérium local. Se calcula SOLO a partir de las procedencias
// que el dashboard anota en cada clasificación (notes.regions):
//   · internacional ×1.20 → 5+ corredores extranjeros
//   · nacional      ×1.10 → corredores de 4+ comunidades distintas de la CV
//                           Y al menos el 25% del pelotón de fuera
// Se aplica a ordinarias y etapas. Challenge CV (×1.30) y fuera de la CV
// (×1.35) conservan su coeficiente propio, sin acumular. El modo Challenge
// CV Oficial no usa coeficientes (sistema FCCV puro).
const RP_PAISES = new Set([
  'belgica', 'portugal', 'paises bajos', 'francia', 'italia', 'alemania',
  'reino unido', 'suiza', 'andorra'
]);
const RP_COEF_PARTICIPACION = { internacional: 1.20, nacional: 1.10 };
const RP_ETIQUETAS_PARTICIPACION = {
  internacional: { chip: '🌍 Participación internacional ×1.20', corto: '🌍 Internacional' },
  nacional: { chip: '🇪🇸 Participación nacional ×1.10', corto: '🇪🇸 Nacional' }
};

function rpNivelParticipacion(carrera) {
  const total = carrera.resultados.length;
  if (!total) return { nivel: null, coef: 1 };
  let fuera = 0;
  let extranjeros = 0;
  const ccaas = new Set();
  for (const r of carrera.resultados) {
    const region = carrera.regiones[rpNormalizarClave(r.nombre)];
    if (!region) continue;
    const k = rpNormalizarTexto(region);
    if (RP_CCAA_CV.has(k)) continue;
    fuera++;
    if (RP_PAISES.has(k)) extranjeros++;
    else ccaas.add(k);
  }
  if (extranjeros >= 5) return { nivel: 'internacional', coef: RP_COEF_PARTICIPACION.internacional };
  if (ccaas.size >= 4 && fuera / total >= 0.25) return { nivel: 'nacional', coef: RP_COEF_PARTICIPACION.nacional };
  return { nivel: null, coef: 1 };
}

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

// Repara "mojibake": la ñ y las vocales acentuadas que se guardaron mal en los
// datos (UTF-8 interpretado como Mac Roman): "Ba√±uls" → "Bañuls". Así los
// corredores duplicados por el error de codificación se fusionan en uno solo.
function rpRepararMojibake(s) {
  if (typeof s !== 'string' || (s.indexOf('√') < 0 && s.indexOf('Ã') < 0)) return s;
  const pares = [
    ['√±', 'ñ'], ['√°', 'á'], ['√©', 'é'], ['√≠', 'í'], ['√≥', 'ó'], ['√∫', 'ú'], ['√º', 'ü'],
    ['√ë', 'Ñ'], ['√Å', 'Á'], ['√â', 'É'], ['√ç', 'Í'], ['√ì', 'Ó'], ['√ö', 'Ú'], ['√ú', 'Ü'],
    ['Ã±', 'ñ'], ['Ã¡', 'á'], ['Ã©', 'é'], ['Ã­', 'í'], ['Ã³', 'ó'], ['Ãº', 'ú'], ['Ã‘', 'Ñ']
  ];
  for (const [mal, bien] of pares) if (s.indexOf(mal) >= 0) s = s.split(mal).join(bien);
  return s;
}

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

// ── Banderas de las comunidades autónomas ──
// Archivos PNG en ranking/banderas/ (subidos por el equipo). Diccionario:
// nombre normalizado con rpNormalizarTexto → archivo. Incluye los alias
// habituales; lo que no esté aquí simplemente no muestra bandera.
const RP_BANDERAS = {
  'andalucia': 'andalucia.png',
  'aragon': 'aragon.png',
  'asturias': 'asturias.png',
  'principado de asturias': 'asturias.png',
  'islas baleares': 'islas_baleares.png',
  'baleares': 'islas_baleares.png',
  'illes balears': 'islas_baleares.png',
  'canarias': 'canarias.png',
  'islas canarias': 'canarias.png',
  'cantabria': 'cantabria.png',
  'castilla la mancha': 'castilla_la_mancha.png',
  'castilla y leon': 'castilla_y_leon.png',
  'cataluna': 'cataluna.png',
  'catalunya': 'cataluna.png',
  'comunidad de madrid': 'comunidad_madrid.png',
  'madrid': 'comunidad_madrid.png',
  'extremadura': 'extremadura.png',
  'galicia': 'galicia.png',
  'la rioja': 'la_rioja.png',
  'rioja': 'la_rioja.png',
  'navarra': 'navarra.png',
  'comunidad foral de navarra': 'navarra.png',
  'pais vasco': 'pais_vasco.png',
  'euskadi': 'pais_vasco.png',
  'region de murcia': 'region_murcia.png',
  'murcia': 'region_murcia.png'
};
// Los alias de la CV ya viven en RP_CCAA_CV (vacío incluido = CV)
for (const alias of RP_CCAA_CV) RP_BANDERAS[alias] = 'comunidad_valenciana.png';

// <img> de la bandera de una comunidad (o '' si no hay bandera para ella).
// onerror se autodestruye: si el PNG faltara, jamás se ve una imagen rota.
function rpBanderaCCAA(ccaa) {
  const archivo = RP_BANDERAS[rpNormalizarTexto(ccaa)];
  if (!archivo) return '';
  return `<img class="rp-bandera" src="banderas/${archivo}" alt="" loading="lazy" onerror="this.remove()">`;
}

// ¿La carrera pertenece a la comunidad seleccionada en el filtro?
// Convención del dashboard: notes.ccaa vacío = Comunitat Valenciana.
// "Sin comunidad asignada" (RP_REGION_SIN) es un filtro de CORREDORES sin
// dato, no de carreras: para las tarjetas de la portada equivale a "todas".
function rpCarreraEnRegion(c) {
  const region = rpEstado.region;
  if (!region || region === RP_REGION_SIN) return true;
  if (region === 'comunitat valenciana' || region === 'comunidad valenciana') {
    return !rpEsFueraCV(c.ccaa);
  }
  return rpNormalizarTexto(c.ccaa) === region;
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
// coefPart = coeficiente de participación de la carrera (1 / 1.10 / 1.20).
// Multiplica ordinarias y etapas; challenge y fuera_cv mantienen el suyo.
// La General de una vuelta usa la tabla completa con su coeficiente ya
// resuelto (participación, o ×1.35 si la vuelta fue fuera de la CV) y SIN
// bono de +3: la general no es una carrera corrida aparte.
function rpPuntosResultado(pos, tipo, coefPart = 1) {
  const p = parseInt(pos, 10);
  if (!Number.isFinite(p) || p <= 0) return { base: 0, coef: 0, bono: 0, puntos: 0 };
  if (tipo === 'etapa') {
    const base = RP_PUNTOS_ETAPA[p] || 0;
    const puntos = Math.round((base * coefPart + RP_BONO_FINALIZAR) * 100) / 100;
    return { base, coef: coefPart, bono: RP_BONO_FINALIZAR, puntos };
  }
  if (tipo === 'general') {
    const base = RP_PUNTOS_BASE[p] || 0;
    const puntos = Math.round(base * coefPart * 100) / 100;
    return { base, coef: coefPart, bono: 0, puntos };
  }
  const base = RP_PUNTOS_BASE[p] || 0;
  const coef = tipo === 'ordinaria' ? coefPart : (RP_COEFICIENTES[tipo] ?? 1);
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
      // Resumen del recorrido GPX/FIT subido desde el dashboard (notes.route):
      // distancia, desnivel, terreno… Los puntos del trazado NO van aquí:
      // viven en Storage (race-tracks/{id}/course.json) y se descargan solo
      // si alguien abre la pestaña "Recorrido y perfil" de la carrera.
      ruta: (extra.route && typeof extra.route === 'object') ? extra.route : null,
      resultados: (r.race_results || []).map(x => ({
        pos: x.pos, nombre: rpRepararMojibake(x.name || ''), equipo: rpRepararMojibake(x.team || ''), cat: x.cat || '',
        // Datos de la clasificación oficial (pueden faltar en pruebas antiguas)
        bib: x.bib ?? '', tiempo: x.time || '',
        gap: Number.isFinite(x.gap_seconds) ? x.gap_seconds : null,
        // Tiempo total en segundos: permite calcular la General de una
        // vuelta sumando etapas (como el ciclismo de verdad)
        segundosTotales: Number.isFinite(x.total_seconds) ? x.total_seconds : null
      }))
    };
    carrera.tipo = rpTipoCarrera(carrera);
    carrera.participacion = rpNivelParticipacion(carrera);
    return carrera;
  }).filter(c => c.temporada !== null);
}

/* ── GENERAL DE VUELTA (calculada) ──
   Cuando una vuelta tiene 2+ etapas ("Etapa N-<nombre>", días próximos),
   se calcula su clasificación General sumando el tiempo total de cada
   corredor en TODAS las etapas — como el ciclismo de verdad, sin
   bonificaciones (si el organizador publica la general oficial y se sube
   al dashboard, esta calculada se descarta sola). La General se comporta
   como una prueba más: tarjeta en la portada, ficha con tiempos
   acumulados y puntos de tabla completa (ver rpPuntosResultado). */
function rpSintetizarGenerales(carreras) {
  const grupos = new Map(); // temporada|nombre-vuelta → [{c, display}]
  for (const c of carreras) {
    if (c.tipo !== 'etapa') continue;
    const resto = (c.nombre || '').replace(/^\s*etapa\s*\d+\s*[-–—:.]?\s*/i, '');
    const display = resto.replace(/[-\s]*CRI\.?\s*$/i, '').trim();
    const claveVuelta = rpNormalizarTexto(display);
    if (!claveVuelta || claveVuelta === rpNormalizarTexto(c.nombre)) continue;
    const k = c.temporada + '|' + claveVuelta;
    if (!grupos.has(k)) grupos.set(k, { claveVuelta, etapas: [] });
    grupos.get(k).etapas.push({ c, display });
  }
  const generales = [];
  for (const { claveVuelta, etapas } of grupos.values()) {
    if (etapas.length < 2) continue;
    etapas.sort((a, b) => (a.c.fecha || '').localeCompare(b.c.fecha || ''));
    const primera = etapas[0].c, ultima = etapas[etapas.length - 1].c;
    // Etapas a más de 10 días: probablemente no son la misma vuelta
    if ((new Date(ultima.fecha) - new Date(primera.fecha)) / 864e5 > 10) continue;
    // Si existe una general oficial subida al dashboard, manda ella
    const hayOficial = carreras.some(o => o.tipo !== 'etapa' &&
      o.temporada === primera.temporada &&
      rpNormalizarTexto(o.nombre).includes(claveVuelta));
    if (hayOficial) continue;
    // Todas las etapas deben traer tiempos totales
    if (!etapas.every(e => e.c.resultados.some(r => Number.isFinite(r.segundosTotales)))) continue;
    // Acumular: solo corredores con posición válida y tiempo en TODAS las etapas
    const acum = new Map();
    etapas.forEach(({ c }, i) => {
      for (const r of c.resultados) {
        const pos = parseInt(r.pos, 10);
        if (!Number.isFinite(pos) || pos <= 0 || !Number.isFinite(r.segundosTotales)) continue;
        const clave = rpNormalizarClave(r.nombre);
        if (!clave) continue;
        if (i === 0) {
          acum.set(clave, { seg: r.segundosTotales, n: 1, r });
        } else {
          const a = acum.get(clave);
          if (a && a.n === i) { a.seg += r.segundosTotales; a.n++; a.r = r; }
        }
      }
    });
    const gc = [...acum.values()].filter(a => a.n === etapas.length)
      .sort((x, y) => x.seg - y.seg);
    if (gc.length < 2) continue;
    const lider = gc[0].seg;
    const regiones = Object.assign({}, ...etapas.map(e => e.c.regiones));
    const carrera = {
      id: 'general-' + ultima.id,
      nombre: 'General — ' + etapas[etapas.length - 1].display,
      fecha: ultima.fecha,
      temporada: ultima.temporada,
      challengeCV: false,
      ccaa: ultima.ccaa || '',
      localidad: '',
      km: '',
      regiones,
      ruta: null,
      esGeneral: true,
      resultados: gc.map((a, i) => ({
        pos: i + 1, nombre: a.r.nombre, equipo: a.r.equipo, cat: a.r.cat, bib: '',
        tiempo: i === 0 ? rpFormatearGap(a.seg) : '',
        gap: Math.round((a.seg - lider) * 100) / 100,
        segundosTotales: a.seg
      }))
    };
    carrera.tipo = 'general';
    // Coeficiente de la General: el de fuera de la CV si la vuelta fue
    // fuera (sin acumular), o el de participación si se corrió en la CV
    carrera.participacion = rpEsFueraCV(carrera.ccaa)
      ? { nivel: null, coef: RP_COEFICIENTES.fuera_cv }
      : rpNivelParticipacion(carrera);
    generales.push(carrera);
  }
  return generales;
}

// Fecha de HOY en ISO local (no UTC): una prueba de hoy sigue visible hasta
// que acabe la jornada a las 00:00.
function rpHoyISO() {
  const hoy = new Date();
  return hoy.getFullYear() + '-' +
    String(hoy.getMonth() + 1).padStart(2, '0') + '-' +
    String(hoy.getDate()).padStart(2, '0');
}

// Pruebas del calendario (race_type='planificada'): solo las de HOY en
// adelante (fecha >= hoy), con su startlist (notes.inscritos). El resto de
// notes (GPX, meteo…) se descarta.
function rpAdaptarPlanificadas(filas) {
  const hoyISO = rpHoyISO();
  return (filas || []).map(r => {
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    return {
      id: r.id,
      nombre: r.name || '',
      fecha: r.date || '',
      // Solo CARRERAS en el calendario público: concentraciones y
      // entrenamientos del equipo (notes.tipo) son actividad interna. Algunas
      // filas antiguas no llevan tipo pero se delatan por el nombre.
      _tipo: extra.tipo || (/concentraci|entrenamiento/i.test(r.name || '') ? 'actividad' : 'carrera'),
      localidad: extra.localidad || '',
      hora: extra.hora_inicio || '',
      cat: [extra.cat, extra.raceCat].filter(Boolean).join(' '),
      // Origen: sincronizada del calendario oficial FCCV (calendario global
      // de la CV) o añadida a mano por el equipo (agenda propia).
      fccvSync: !!(extra.fccvSync || extra.fccvId),
      _avail: !!extra.availability,
      inscritos: (Array.isArray(extra.inscritos) ? extra.inscritos : []).map(x => ({
        bib: x.bib || '', nombre: x.name || '', equipo: x.team || '', cat: x.cat || ''
      }))
    };
  }).filter(p => p.fecha >= hoyISO && p._tipo === 'carrera')
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
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
      const pts = rpPuntosResultado(res.pos, carrera.tipo, carrera.participacion.coef);
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
    // Etiqueta principal del corredor: la más repetida en sus resultados
    // (empate → la del más reciente). Se muestra como columna en el ranking.
    const votosSub = new Map();
    for (const r of resultados) {
      const s = String(r._cat || '').trim().toUpperCase();
      if (s) votosSub.set(s, (votosSub.get(s) || 0) + 1);
    }
    let subcatPrincipal = '';
    if (votosSub.size) {
      const maxSub = Math.max(...votosSub.values());
      subcatPrincipal = resultados
        .map(r => String(r._cat || '').trim().toUpperCase())
        .find(s => s && votosSub.get(s) === maxSub) || '';
    }
    corredores.push({
      clave,
      nombre: masReciente._nombre,
      equipo: masReciente._equipo,
      categoria,
      subcats,
      subcatPrincipal,
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
  vista: 'corredores',// 'corredores' | 'equipos' (ranking individual o por equipos)
  modo: 'mfpp',       // 'mfpp' (rendimiento) | 'challenge' (Challenge CV oficial)
  // Vista principal: al entrar se muestran las últimas carreras con sus
  // podios (portada estilo FirstCycling); el ranking queda a un toque.
  // A propósito NO se guarda en preferencias: cada visita arranca aquí.
  pantalla: 'carreras',   // 'carreras' | 'ranking'
  ultimosVisibles: 10,    // tarjetas de carrera mostradas ("Ver más" amplía)
  _ultimosClave: null,    // temporada|categoría del último render de tarjetas
  modalEquipo: null,  // equipo normalizado cuya ficha está abierta (o null)
  planificadas: [],   // próximas pruebas del calendario (con startlist)
  calVista: 'global', // apartado activo del calendario: 'global' | 'equipo'
  agendaIds: new Set(), // race_ids con disponibilidad del equipo (race_availability)
  clavesRanking: new Set(), // claves de todos los corredores puntuados (para enlazar startlists)
  indiceBusqueda: [], // índice del buscador global (corredores, equipos, pruebas)
  busqueda: '',
  ranking: null       // salida de calcularRankingPublico
};

function rpEscapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Los puntos se muestran SIEMPRE redondeados al entero superior (los
// decimales de los coeficientes quedan feos en pantalla). El cálculo interno
// mantiene los decimales: solo se redondea al pintar.
function rpFormatearPuntos(n) {
  return Math.ceil(Math.round(n * 100) / 100).toLocaleString('es-ES');
}

function rpFormatearFecha(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

// Diferencia de tiempo en segundos → "m:ss" (u "h:mm:ss" si llega a la hora)
function rpFormatearGap(segundos) {
  const t = Math.round(segundos);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
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
  if (rpEstado.modo === 'challenge') partes.push('Challenge CV Oficial');
  else if (rpEstado.vista === 'equipos') partes.push('Equipos');
  if (rpEstado.region === RP_REGION_SIN) partes.push('Sin comunidad asignada');
  else if (rpEstado.region) partes.push(rpEstado.regionDisplay || '');
  partes.push('Temporada ' + rpEstado.temporada);
  const texto = partes.filter(Boolean).join(' · ');
  el.textContent = texto;
  document.title = 'Ranking MFPP Cycling — ' + texto;
}

// Conmutador de vista Corredores / Equipos: marca el botón activo.
function rpRenderVista() {
  document.querySelectorAll('#rp-vista button[data-vista]').forEach(b => {
    b.classList.toggle('rp-activa', b.dataset.vista === rpEstado.vista);
    b.setAttribute('aria-pressed', String(b.dataset.vista === rpEstado.vista));
  });
}

// Conmutador de modo: Ranking Rendimiento MFPP / Challenge CV Oficial.
// En modo Challenge el toggle Corredores/Equipos se oculta (la Challenge
// oficial es individual).
function rpRenderModo() {
  document.querySelectorAll('#rp-modo button[data-modo]').forEach(b => {
    b.classList.toggle('rp-activa', b.dataset.modo === rpEstado.modo);
    b.setAttribute('aria-pressed', String(b.dataset.modo === rpEstado.modo));
  });
  document.getElementById('rp-vista').style.display =
    rpEstado.modo === 'challenge' ? 'none' : '';
  // La Challenge oficial no filtra por comunidad: se oculta el desplegable
  // (rpRenderRegiones lo re-muestra al volver al modo MFPP).
  if (rpEstado.modo === 'challenge') {
    document.getElementById('rp-region').style.display = 'none';
  } else if (rpEstado.ranking) {
    rpRenderRegiones();
    rpRenderPestanas();
  }
}

// Bloque "Últimos resultados" (estilo portada de FirstCycling): las carreras
// de las últimas jornadas de la temporada activa, con su ganador y equipo.
// Carrera y ganador son clicables → ficha correspondiente.
// Conmutador de vista principal: portada de carreras ↔ ranking. Enseña u
// oculta los bloques que pertenecen a cada una (los conmutadores MFPP/
// Challenge y Corredores/Equipos solo tienen sentido en el ranking).
function rpRenderPantalla() {
  document.querySelectorAll('#rp-pantalla button[data-pantalla]').forEach(b => {
    b.classList.toggle('rp-activa', b.dataset.pantalla === rpEstado.pantalla);
    b.setAttribute('aria-pressed', String(b.dataset.pantalla === rpEstado.pantalla));
  });
  const esRanking = rpEstado.pantalla === 'ranking';
  document.getElementById('rp-solo-ranking').hidden = !esRanking;
  document.getElementById('rp-ultimos').style.display = esRanking ? 'none' : '';
  document.querySelector('.rp-tabla-scroll').style.display = esRanking ? '' : 'none';
  document.querySelector('.rp-pie').style.display = esRanking ? '' : 'none';
  // El aviso del modo Challenge lo gestiona rpRenderTabla dentro del ranking
  if (!esRanking) document.getElementById('rp-challenge-info').style.display = 'none';
}

// ── Portada "Últimas carreras": tarjetas con podio (estilo FirstCycling) ──
// Filtradas por temporada y pestaña de categoría activa, de más reciente a
// más antigua. Las de los últimos 7 días se destacan; "Ver más" amplía.
const RP_MEDALLAS_PODIO = ['🥇', '🥈', '🥉'];

function rpTarjetaCarrera(c, reciente, posRanking) {
  const lineas = [1, 2, 3].map((p, i) => {
    const r = c.resultados.find(x => parseInt(x.pos, 10) === p);
    if (!r) return '';
    const clave = rpNormalizarClave(r.nombre);
    const nombre = rpEstado.clavesRanking.has(clave)
      ? `<button type="button" class="rp-enlace rp-podio-nombre" data-corredor="${rpEscapar(clave)}">${rpEscapar(r.nombre)}</button>`
      : `<span class="rp-podio-nombre">${rpEscapar(r.nombre)}</span>`;
    // Posición y puntos del corredor EN EL RANKING FILTRADO actual (año +
    // comunidad + categoría + subcategoría). Solo si está en esa vista: un
    // corredor de otra comunidad no tiene puesto en el ranking de la CV.
    const rk = posRanking && posRanking.get(clave);
    const insignia = rk
      ? `<span class="rp-podio-rank" title="Puesto ${rk.pos}º del ranking con los filtros actuales">${rk.pos}º · ${rpFormatearPuntos(rk.puntos)} pts</span>`
      : '';
    return '<li>' +
      `<span class="rp-podio-medalla">${RP_MEDALLAS_PODIO[i]}</span>` +
      '<span class="rp-podio-datos">' +
        `<span class="rp-podio-l1">${nombre}${insignia}</span>` +
        (r.equipo ? `<span class="rp-podio-equipo">${rpEscapar(r.equipo)}</span>` : '') +
      '</span></li>';
  }).join('');
  return `<article class="rp-carrera${reciente ? ' rp-carrera-reciente' : ''}" data-carrera="${rpEscapar(c.id)}">` +
    '<header class="rp-carrera-cab">' +
    `<span class="rp-carrera-fecha">${rpEscapar(rpDiaSemana(c.fecha))} ${rpEscapar(rpFormatearFecha(c.fecha))}</span>` +
    (reciente ? '<span class="rp-chip-reciente">Reciente</span>' : '') +
    (c.participacion.nivel
      ? `<span class="rp-chip-part" title="${RP_ETIQUETAS_PARTICIPACION[c.participacion.nivel].chip}">${RP_ETIQUETAS_PARTICIPACION[c.participacion.nivel].corto}</span>`
      : '') +
    (c.ruta ? '<span class="rp-chip-ruta" title="Esta prueba tiene mapa y perfil del recorrido">🗺️ Mapa y perfil</span>' : '') +
    `<span class="rp-tipo rp-tipo-${c.tipo}">${rpEscapar(RP_ETIQUETAS_TIPO[c.tipo] || c.tipo)}</span>` +
    '</header>' +
    `<h3 class="rp-carrera-nombre"><button type="button" class="rp-enlace" data-carrera="${rpEscapar(c.id)}">${rpEscapar(c.nombre)}</button></h3>` +
    // Bandera de la comunidad (📍 solo si no hay bandera) y, en carreras de
    // fuera de la CV, el nombre de la comunidad junto a la localidad
    (() => {
      const bandera = rpBanderaCCAA(c.ccaa);
      const texto = [c.localidad, rpEsFueraCV(c.ccaa) ? c.ccaa : ''].filter(Boolean).map(rpEscapar).join(' · ');
      if (!bandera && !texto) return '';
      return `<p class="rp-carrera-loc">${bandera || '📍'} ${texto}</p>`;
    })() +
    (lineas ? `<ul class="rp-podio-lista">${lineas}</ul>` : '') +
    `<button type="button" class="rp-carrera-cta" data-carrera="${rpEscapar(c.id)}">Ver clasificación completa ➔</button>` +
    '</article>';
}

function rpRenderUltimos() {
  const cont = document.getElementById('rp-ultimos');
  // Al cambiar de temporada, pestaña, comunidad o filtro de tipo → reinicia "Ver más"
  const clave = rpEstado.temporada + '|' + rpEstado.categoria + '|' + rpEstado.region + '|' + (rpEstado.filtroTipoCarrera || '');
  if (rpEstado._ultimosClave !== clave) {
    rpEstado._ultimosClave = clave;
    rpEstado.ultimosVisibles = 10;
  }
  // Todas las carreras de la categoría + comunidad (sin filtrar aún por tipo)
  const base = (rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.resultados.length &&
                 rpGruposDeCarrera(c).has(rpEstado.categoria) && rpCarreraEnRegion(c))
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  if (!base.length) {
    cont.innerHTML = '<p class="rp-vacio">Aún no hay carreras disputadas de esta categoría con la temporada y comunidad seleccionadas.</p>';
    return;
  }
  // Tipos presentes (para las pastillas de filtro), en orden fijo
  const orden = ['ordinaria', 'challenge', 'general', 'etapa', 'fuera_cv'];
  const cuentaTipo = {};
  base.forEach(c => { cuentaTipo[c.tipo] = (cuentaTipo[c.tipo] || 0) + 1; });
  const tiposPresentes = orden.filter(t => cuentaTipo[t]);
  // Si el tipo filtrado ya no está disponible, volver a "Todas"
  if (rpEstado.filtroTipoCarrera && !cuentaTipo[rpEstado.filtroTipoCarrera]) rpEstado.filtroTipoCarrera = '';
  const filtro = rpEstado.filtroTipoCarrera || '';
  const todas = filtro ? base.filter(c => c.tipo === filtro) : base;

  const hace7 = new Date(Date.now() - 7 * 864e5);
  const corteISO = hace7.getFullYear() + '-' +
    String(hace7.getMonth() + 1).padStart(2, '0') + '-' +
    String(hace7.getDate()).padStart(2, '0');
  // Puesto y puntos de cada corredor en el ranking FILTRADO actual
  const posRanking = new Map();
  const catActiva = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (catActiva) rpPoblacion(catActiva).forEach((cor, i) =>
    posRanking.set(cor.clave, { pos: i + 1, puntos: cor.puntosTotales }));

  // Pastillas de filtro por tipo (solo si hay más de un tipo de prueba)
  const chip = (val, texto, n) =>
    `<button type="button" class="rp-tipo-chip${filtro === val ? ' rp-activa' : ''}" data-tipofiltro="${val}">${texto} <span class="rp-num">${n}</span></button>`;
  const filtroHTML = tiposPresentes.length > 1
    ? '<div class="rp-tipo-filtro">' +
      chip('', 'Todas', base.length) +
      tiposPresentes.map(t => chip(t, rpEscapar(RP_ETIQUETAS_TIPO[t] || t), cuentaTipo[t])).join('') +
      '</div>'
    : '';

  const visibles = todas.slice(0, rpEstado.ultimosVisibles);
  cont.innerHTML = filtroHTML +
    visibles.map(c => rpTarjetaCarrera(c, c.fecha >= corteISO, posRanking)).join('') +
    (todas.length > visibles.length
      ? `<button type="button" class="rp-ver-mas">Ver más carreras (${todas.length - visibles.length} anteriores)</button>`
      : '');
}

// ── Buscador global (estilo FirstCycling): corredores, equipos y pruebas ──
// El índice se reconstruye en cada recálculo (temporada). Cada entrada:
// { tipo, id, etiqueta, sub, norm } — norm es el texto normalizado buscable.
function rpConstruirIndice() {
  const idx = [];
  for (const cat of rpEstado.ranking.categorias) {
    for (const c of cat.corredores) {
      idx.push({ tipo: 'corredor', id: c.clave, etiqueta: c.nombre,
        sub: c.equipo, norm: rpNormalizarTexto(c.nombre + ' ' + c.equipo) });
    }
  }
  const equiposVistos = new Set();
  for (const cat of rpEstado.ranking.categorias) {
    for (const c of cat.corredores) {
      const k = rpNormalizarTexto(c.equipo);
      if (!k || equiposVistos.has(k)) continue;
      equiposVistos.add(k);
      idx.push({ tipo: 'equipo', id: k, etiqueta: c.equipo, sub: 'Equipo', norm: k });
    }
  }
  for (const c of (rpEstado.carreras || [])) {
    if (c.temporada !== rpEstado.temporada) continue;
    idx.push({ tipo: 'carrera', id: c.id, etiqueta: c.nombre,
      sub: rpFormatearFecha(c.fecha), norm: rpNormalizarTexto(c.nombre) });
  }
  for (const p of (rpEstado.planificadas || [])) {
    idx.push({ tipo: 'planificada', id: p.id, etiqueta: p.nombre,
      sub: rpFormatearFecha(p.fecha) + ' · próxima', norm: rpNormalizarTexto(p.nombre) });
  }
  return idx;
}

const RP_ICONO_SUGERENCIA = { corredor: '👤', equipo: '👥', carrera: '🏁', planificada: '📅' };

function rpBuscarSugerencias(texto) {
  const q = rpNormalizarTexto(texto);
  if (q.length < 2) return [];
  // Cupos por tipo para que un equipo o una prueba no queden enterrados bajo
  // los corredores que coinciden por llevar ese equipo en su texto buscable.
  const porTipo = { corredor: [], equipo: [], carrera: [], planificada: [] };
  for (const e of rpEstado.indiceBusqueda) {
    const i = e.norm.indexOf(q);
    if (i < 0) continue;
    porTipo[e.tipo].push({ e, peso: e.norm.startsWith(q) ? 0 : i });
  }
  for (const t in porTipo) porTipo[t].sort((a, b) => a.peso - b.peso);
  const cupos = [['corredor', 4], ['equipo', 2], ['carrera', 1], ['planificada', 1]];
  const resultado = [];
  for (const [tipo, n] of cupos) resultado.push(...porTipo[tipo].splice(0, n));
  // rellenar hasta 8 con lo que sobre, en el mismo orden de tipos
  for (const [tipo] of cupos) {
    while (resultado.length < 8 && porTipo[tipo].length) resultado.push(porTipo[tipo].shift());
  }
  return resultado.sort((a, b) => a.peso - b.peso).map(x => x.e).slice(0, 8);
}

function rpRenderSugerencias() {
  const caja = document.getElementById('rp-sugerencias');
  const sugerencias = rpBuscarSugerencias(rpEstado.busqueda);
  if (!sugerencias.length) { caja.hidden = true; caja.innerHTML = ''; return; }
  caja.innerHTML = sugerencias.map(s =>
    `<button type="button" class="rp-sug" data-sug-tipo="${s.tipo}" data-sug-id="${rpEscapar(s.id)}">` +
    `<span class="rp-sug-icono">${RP_ICONO_SUGERENCIA[s.tipo] || ''}</span>` +
    `<span class="rp-sug-texto">${rpEscapar(s.etiqueta)}</span>` +
    `<span class="rp-sug-sub">${rpEscapar(s.sub || '')}</span></button>`
  ).join('');
  caja.hidden = false;
}

function rpOcultarSugerencias() {
  const caja = document.getElementById('rp-sugerencias');
  caja.hidden = true;
  caja.innerHTML = '';
}

function rpAbrirSugerencia(tipo, id) {
  rpOcultarSugerencias();
  if (tipo === 'corredor') rpAbrirModal(id);
  else if (tipo === 'equipo') rpAbrirModalEquipo(id);
  else if (tipo === 'carrera') rpAbrirModalCarrera(id);
  else if (tipo === 'planificada') rpAbrirModalPlanificada(id);
}

// Grupos de categoría de una carrera DISPUTADA, a partir de las categorías de
// sus resultados. Umbral de significancia como el dashboard (≥3 corredores y
// ≥15%) para que 1 corredor "colado" de otra categoría no etiquete la prueba;
// si ninguna alcanza el umbral (pruebas pequeñas), valen todas las vistas.
function rpGruposDeCarrera(carrera) {
  const conteo = new Map();
  for (const r of carrera.resultados) {
    const g = rpGrupoCategoria(r.cat);
    if (g) conteo.set(g, (conteo.get(g) || 0) + 1);
  }
  const total = carrera.resultados.length || 1;
  const significativos = [...conteo].filter(([, n]) => n >= 3 && n / total >= 0.15).map(([g]) => g);
  return new Set(significativos.length ? significativos : [...conteo.keys()]);
}

// Grupos de una prueba del CALENDARIO: de su campo de categoría (tokens) y,
// si no lo trae, del nombre ("Copa Catalana Cadete" → cadete). Sin grupo
// identificable → no se muestra bajo una categoría concreta (estricto).
function rpGruposDePlanificada(p) {
  const grupos = new Set();
  String(p.cat || '').split(/[\s,;]+/).filter(Boolean).forEach(t => {
    const g = rpGrupoCategoria(t);
    if (g) grupos.add(g);
  });
  (p.inscritos || []).forEach(i => {
    const g = rpGrupoCategoria(i.cat);
    if (g) grupos.add(g);
  });
  if (!grupos.size) {
    const g = rpGrupoCategoria(p.nombre || '');
    if (g) grupos.add(g);
  }
  return grupos;
}

const RP_DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function rpDiaSemana(fechaISO) {
  const d = new Date(fechaISO + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? '' : RP_DIAS_SEMANA[d.getDay()];
}

// Día del mes y mes abreviado (para el minicalendario de próximas pruebas)
const RP_MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function rpDiaMes(fechaISO) {
  const m = String(fechaISO || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m
    ? { dia: String(parseInt(m[3], 10)), mes: RP_MESES_CORTO[parseInt(m[2], 10) - 1] || '' }
    : { dia: '', mes: '' };
}

// Clasificación ya cargada de una prueba planificada (misma fecha y nombre
// equivalente): permite enlazar "🏆 Clasificación disponible" el mismo día.
function rpClasificacionDe(p) {
  const n = rpNormalizarTexto(p.nombre);
  if (!n) return null;
  return (rpEstado.carreras || []).find(c => {
    if (c.fecha !== p.fecha || !c.resultados.length) return false;
    const m = rpNormalizarTexto(c.nombre);
    return m === n || m.includes(n) || n.includes(m);
  }) || null;
}

// Bloque "Próximas pruebas" en dos apartados:
//  🌍 Calendario Global CV (por defecto): TODAS las pruebas sincronizadas del
//     calendario oficial FCCV, sin filtrar por equipo.
//  🚴 Agenda TBG-WIXUM: las que el equipo tiene previsto correr (añadidas a
//     mano por el director o con disponibilidad marcada en race_availability).
// Ambos respetan estrictamente el filtro de categoría y muestran fecha>=HOY.
function rpRenderCalendario() {
  const caja = document.getElementById('rp-calendario-caja');
  const cont = document.getElementById('rp-calendario');
  const base = (rpEstado.planificadas || [])
    .filter(p => rpGruposDePlanificada(p).has(rpEstado.categoria));
  const global = base.filter(p => p.fccvSync);
  // Agenda del equipo: añadidas a mano, con disponibilidad marcada, o
  // pre-inscripciones (si el director subió los inscritos, el equipo va).
  const equipo = base.filter(p => !p.fccvSync || p._avail || p._pre || rpEstado.agendaIds.has(String(p.id)));
  if (!base.length) { caja.style.display = 'none'; cont.innerHTML = ''; return; }
  caja.style.display = '';
  const activa = rpEstado.calVista === 'equipo' ? equipo : global;
  const hoyISO = rpHoyISO();
  const tarjeta = p => {
    const clasif = p.fecha === hoyISO ? rpClasificacionDe(p) : null; // solo el día de la prueba
    const dm = rpDiaMes(p.fecha);
    const chips =
      (p.inscritos.length
        ? `<button type="button" class="rp-cal-chip" data-planificada="${rpEscapar(p.id)}">📋 Inscritos (${p.inscritos.length})</button>`
        : '<span class="rp-cal-chip rp-cal-chip-off">Sin inscritos</span>') +
      (clasif ? `<button type="button" class="rp-cal-chip rp-cal-chip-ok" data-carrera="${rpEscapar(clasif.id)}">🏆 Clasificación</button>` : '') +
      `<a class="rp-cal-chip" href="${rpEscapar(rpEnlaceGoogleCal(p))}" target="_blank" rel="noopener">📅 Añadir a mi calendario</a>`;
    // Detalle de localidad/hora (o solo hora si no hay localidad)
    const detalle = p.localidad
      ? `<span class="rp-prueba-loc">📍 ${rpEscapar(p.localidad)}${p.hora ? ' · 🕐 ' + rpEscapar(p.hora) : ''}</span>`
      : (p.hora ? `<span class="rp-prueba-loc">🕐 ${rpEscapar(p.hora)}</span>` : '');
    return '<article class="rp-prueba-card">' +
      '<span class="rp-prueba-cal" aria-hidden="true">' +
        `<span class="rp-prueba-cal-dow">${rpEscapar(rpDiaSemana(p.fecha))}</span>` +
        `<span class="rp-prueba-cal-dia">${dm.dia}</span>` +
        `<span class="rp-prueba-cal-mes">${dm.mes}</span>` +
      '</span>' +
      '<div class="rp-prueba-info">' +
        `<button type="button" class="rp-enlace rp-prueba-nombre" data-planificada="${rpEscapar(p.id)}">${rpEscapar(p.nombre)}</button>` +
        '<div class="rp-prueba-bot">' +
          detalle +
          `<span class="rp-prueba-chips">${chips}</span>` +
        '</div>' +
      '</div>' +
    '</article>';
  };
  cont.innerHTML =
    '<div class="rp-cal-tabs">' +
    `<button type="button" data-calvista="global" class="rp-cal-tab${rpEstado.calVista !== 'equipo' ? ' rp-activa' : ''}">🌍 Calendario Global CV <span class="rp-num">${global.length}</span></button>` +
    `<button type="button" data-calvista="equipo" class="rp-cal-tab${rpEstado.calVista === 'equipo' ? ' rp-activa' : ''}">🚴 Agenda TBG-WIXUM <span class="rp-num">${equipo.length}</span></button>` +
    '</div>' +
    (activa.length
      ? activa.slice(0, 10).map(tarjeta).join('')
      : '<p class="rp-vacio">No hay próximas pruebas en este apartado para la categoría seleccionada.</p>');
}

// Ficha de una prueba del calendario: datos y startlist. Los inscritos que ya
// puntúan en el ranking son clicables hacia su ficha.
function rpAbrirModalPlanificada(id) {
  const p = (rpEstado.planificadas || []).find(x => String(x.id) === String(id));
  if (!p) return;
  rpSalirDeFichaCarrera();
  rpEstado.modalClave = null;
  rpEstado.modalEquipo = null;
  const inscritos = [...p.inscritos].sort((a, b) =>
    (a.equipo || '').localeCompare(b.equipo || '', 'es') ||
    (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  const filas = inscritos.map(x => {
    const clave = rpNormalizarClave(x.nombre);
    const enRanking = rpEstado.clavesRanking.has(clave);
    const nombre = enRanking
      ? `<button type="button" class="rp-enlace" data-corredor="${rpEscapar(clave)}">${rpEscapar(x.nombre)}</button>`
      : rpEscapar(x.nombre);
    return `<tr><td class="rp-c">${rpEscapar(x.bib)}</td><td>${nombre}</td>` +
      `<td>${rpEscapar(x.equipo)}</td><td class="rp-c">${rpEscapar(x.cat)}</td></tr>`;
  }).join('');
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(p.nombre)}</h2>` +
    `<p class="rp-ficha-equipo">${rpEscapar(rpDiaSemana(p.fecha))} ${rpEscapar(rpFormatearFecha(p.fecha))}${p.localidad ? ' · ' + rpEscapar(p.localidad) : ''}</p>` +
    '<div class="rp-ficha-datos">' +
    '<span class="rp-chip">Próxima prueba</span>' +
    (p.hora ? `<span class="rp-chip">🕐 ${rpEscapar(p.hora)}</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${p.inscritos.length} inscritos</span>` +
    '</div></header>' +
    (inscritos.length
      ? '<div class="rp-tabla-historial"><table class="rp-subtabla">' +
        '<thead><tr><th>Dorsal</th><th>Corredor</th><th>Equipo</th><th>Cat.</th></tr></thead>' +
        `<tbody>${filas}</tbody></table></div>` +
        '<p class="rp-nota">Startlist provisional. Los corredores que ya puntúan en el ranking están enlazados a su ficha.</p>'
      : '<p class="rp-nota">Aún no hay inscritos publicados para esta prueba.</p>');
  document.getElementById('rp-modal-ant').disabled = true;
  document.getElementById('rp-modal-sig').disabled = true;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
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

// Insignia de región junto al nombre del corredor: bandera PNG si es una
// comunidad con bandera en ranking/banderas/; si no (países, valores sin
// mapear), la etiqueta de texto de siempre (o bandera emoji del país).
function rpInsigniaRegion(region) {
  if (!region) return '';
  const archivo = RP_BANDERAS[rpNormalizarTexto(region)];
  if (archivo) {
    return `<img class="rp-bandera rp-bandera-mini" src="banderas/${archivo}"` +
      ` alt="${rpEscapar(region)}" title="${rpEscapar(region)}" loading="lazy" onerror="this.remove()">`;
  }
  const badge = rpBadgeRegion(region);
  return badge ? `<span class="rp-badge-region" title="${rpEscapar(region)}">${rpEscapar(badge)}</span>` : '';
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

/* ── CHALLENGE COMUNITAT VALENCIANA (sistema oficial FCCV) ──
   Los puntos Challenge NO están persistidos en Supabase: el dashboard los
   deriva en runtime. Réplica exacta de calcularPuntosChallenge
   (assets/js/app.js:9369) y del desempate oficial _compararChallengeRiders
   (app.js:9401) — mantener sincronizado a mano si el dashboard cambia. */
function rpPuntosChallenge(pos) {
  const p = parseInt(pos, 10);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p === 1) return 45;
  if (p === 2) return 42;
  if (p === 3) return 40;
  if (p === 4) return 38;
  if (p === 5) return 36;
  if (p <= 39) return 41 - p;
  return 1;
}

// Pruebas Challenge de la temporada activa, en orden cronológico (una columna
// por prueba en la clasificación, como en el dashboard).
function rpPruebasChallenge() {
  return (rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.tipo === 'challenge')
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
}

// Clasificación Challenge de la pestaña activa. Sin coeficientes, sin corte
// de 12, sin bono: suma pura del sistema oficial. OJO: el filtro de comunidad
// NO se aplica (igual que en el dashboard) — es una clasificación oficial
// abierta y filtrar por CCAA cambiaría al líder real. Subcategoría y equipo
// sí actúan como zoom.
function rpCalcularChallenge(cat) {
  const pruebas = rpPruebasChallenge();
  const ultimaId = pruebas.length ? pruebas[pruebas.length - 1].id : null;
  const poblacion = cat.corredores.filter(c => {
    if (rpEstado.subcategoria && !c.subcats.includes(rpEstado.subcategoria)) return false;
    if (rpEstado.equipo && rpNormalizarTexto(c.equipo) !== rpEstado.equipo) return false;
    return true;
  });
  const lista = [];
  for (const c of poblacion) {
    const res = c.resultados.filter(r => r.tipo === 'challenge' && r.pos);
    if (!res.length) continue;
    const porCarrera = {};
    const conteo = new Array(20).fill(0);
    let total = 0, top10 = 0;
    for (const r of res) {
      const pts = rpPuntosChallenge(r.pos);
      porCarrera[r.raceId] = { pts, pos: r.pos };
      total += pts;
      if (r.pos <= 20) conteo[r.pos - 1]++;
      if (r.pos <= 10) top10++;
    }
    if (!total) continue;
    lista.push({
      corredor: c, total, porCarrera, conteo, top10,
      disputadas: res.length,
      ultimaPos: res[0].pos, // resultados van en orden cronológico desc
      posEnUltimaPrueba: ultimaId && porCarrera[ultimaId] ? porCarrera[ultimaId].pos : Infinity,
      desempate: false
    });
  }
  // Desempate oficial: más 1ºs, luego 2ºs, 3ºs… y mejor puesto en la última
  // prueba Challenge de la temporada.
  lista.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    for (let i = 0; i < 20; i++) {
      if (b.conteo[i] !== a.conteo[i]) return b.conteo[i] - a.conteo[i];
    }
    if (a.posEnUltimaPrueba !== b.posEnUltimaPrueba) return a.posEnUltimaPrueba - b.posEnUltimaPrueba;
    return a.corredor.nombre.localeCompare(b.corredor.nombre, 'es');
  });
  lista.forEach((x, i) => {
    x.desempate = (i > 0 && lista[i - 1].total === x.total) ||
                  (i < lista.length - 1 && lista[i + 1].total === x.total);
  });
  return { pruebas, lista };
}

// Ranking por equipos de una población filtrada. Los puntos del equipo son la
// suma de sus 3 MEJORES corredores (evita que gane el club con más licencias
// en vez del más fuerte); las estadísticas cuentan toda la plantilla.
const RP_EQUIPO_TOP_N = 3;
function rpCalcularEquipos(poblacion) {
  const porEquipo = new Map();
  for (const c of poblacion) {
    const clave = rpNormalizarTexto(c.equipo);
    if (!clave) continue;
    if (!porEquipo.has(clave)) porEquipo.set(clave, { clave, nombre: c.equipo, corredores: [] });
    porEquipo.get(clave).corredores.push(c);
  }
  const equipos = [...porEquipo.values()].map(e => {
    e.corredores.sort((a, b) => b.puntosTotales - a.puntosTotales);
    e.puntos = Math.round(e.corredores.slice(0, RP_EQUIPO_TOP_N)
      .reduce((s, c) => s + c.puntosTotales, 0) * 100) / 100;
    const posValidas = e.corredores.flatMap(c => c.resultados.map(r => r.pos).filter(p => p >= 1));
    e.victorias = posValidas.filter(p => p === 1).length;
    e.podios = posValidas.filter(p => p <= 3).length;
    e.top10 = posValidas.filter(p => p <= 10).length;
    return e;
  });
  equipos.sort((a, b) =>
    (b.puntos - a.puntos) || (b.victorias - a.victorias) || a.nombre.localeCompare(b.nombre, 'es'));
  return equipos;
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

// Nombre amigable de una etiqueta de organizador dentro de su bloque.
// Lo que no esté aquí se muestra tal cual viene de los datos.
const RP_ETIQUETAS_SUBCAT = {
  'CAD-1': 'Cadetes 1º Año (CAD-1)',
  'CAD-2': 'Cadetes 2º Año (CAD-2)',
  'CADETE': 'Cadetes Genéricos (CADETE)',
  'JUN-1': 'Juveniles 1º Año (JUN-1)',
  'JUN-2': 'Juveniles 2º Año (JUN-2)',
  'JUV-1': 'Juveniles 1º Año (JUV-1)',
  'JUV-2': 'Juveniles 2º Año (JUV-2)',
  'JUVENIL': 'Juveniles Genéricos (JUVENIL)',
  'JUNIOR': 'Juveniles Genéricos (JUNIOR)'
};
// "Todos los X" por bloque (con género gramatical correcto).
const RP_TODOS_LABEL = { fem: 'Todas las Féminas', escuela: 'Todas las Escuelas' };
function rpEtiquetaTodos(cat) {
  return RP_TODOS_LABEL[cat.key] || `Todos los ${cat.label}`;
}

// Desplegable de categoría JERÁRQUICO: cada bloque ofrece primero su opción
// agrupada ("Todos los Cadetes" = CADETE + CAD-1 + CAD-2) y después sus
// etiquetas individuales con nombre amigable. Elegir cualquier opción de otro
// bloque cambia de pestaña automáticamente. Value = "clavePestaña|etiqueta"
// (etiqueta vacía = todos los del bloque).
function rpRenderSubcats() {
  const sel = document.getElementById('rp-subcat');
  if (!rpEstado.ranking.categorias.length) {
    rpEstado.subcategoria = '';
    sel.style.display = 'none';
    sel.innerHTML = '';
    return;
  }
  // Validar la selección actual contra la pestaña activa
  const catActiva = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  const etiquetasActiva = catActiva ? new Set(catActiva.corredores.flatMap(c => c.subcats)) : new Set();
  if (rpEstado.subcategoria && !etiquetasActiva.has(rpEstado.subcategoria)) rpEstado.subcategoria = '';
  const seleccion = `${rpEstado.categoria}|${rpEstado.subcategoria || ''}`;
  sel.style.display = '';
  sel.innerHTML = rpEstado.ranking.categorias.map(cat => {
    // Solo etiquetas que pertenecen al bloque: un juvenil con un resultado
    // suelto etiquetado "CADETE" no debe meter esa opción en Juveniles.
    const etiquetas = [...new Set(cat.corredores.flatMap(c => c.subcats))]
      .filter(e => rpGrupoCategoria(e) === cat.key)
      .sort((a, b) => a.localeCompare(b, 'es'));
    const opcion = (val, texto) =>
      `<option value="${rpEscapar(val)}"${val === seleccion ? ' selected' : ''}>${rpEscapar(texto)}</option>`;
    return `<optgroup label="${rpEscapar(cat.label)}">` +
      opcion(`${cat.key}|`, rpEtiquetaTodos(cat)) +
      (etiquetas.length > 1
        ? etiquetas.map(e => opcion(`${cat.key}|${e}`, RP_ETIQUETAS_SUBCAT[e.toUpperCase()] || e)).join('')
        : '') +
      '</optgroup>';
  }).join('');
}

// ── Filtros con búsqueda (fallito 2) ──
// Convierte un <select> en un desplegable donde SE PUEDE TECLEAR para filtrar
// las opciones (empiezan-por, sin acentos ni mayúsculas). Útil sobre todo en
// móvil (iOS), donde el <select> nativo abre una ruleta sin teclado.
// El <select> se mantiene oculto como fuente de la verdad: valor, evento
// "change" (los manejadores existentes siguen funcionando) y repoblado
// dinámico. Un MutationObserver sincroniza el texto visible y la visibilidad.
function rpFiltroBuscable(sel, claseExtra) {
  if (!sel || sel.dataset.cbHecho) return;
  sel.dataset.cbHecho = '1';
  const wrap = document.createElement('div');
  wrap.className = 'rp-cb' + (claseExtra ? ' ' + claseExtra : '');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rp-cb-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  const etq = sel.getAttribute('aria-label');
  if (etq) input.setAttribute('aria-label', etq);
  const list = document.createElement('div');
  list.className = 'rp-cb-list';
  list.hidden = true;
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  wrap.appendChild(input);
  wrap.appendChild(list);
  sel.classList.add('rp-cb-native');
  sel.setAttribute('tabindex', '-1');
  sel.setAttribute('aria-hidden', 'true');

  let abierto = false, activo = -1;
  const textoSel = () => (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '');
  const syncVisibilidad = () => { wrap.hidden = (sel.style.display === 'none'); };
  const syncTexto = () => { if (!abierto) input.value = textoSel(); };

  function coincide(txt, f) {
    if (!f) return true;
    const n = rpNormalizarTexto(txt);
    if (n.indexOf(f) === 0) return true;                 // empieza por…
    return n.split(/[\s\-/|]+/).some(p => p.indexOf(f) === 0); // …o alguna palabra
  }
  function crearOpcion(op, f) {
    if (!coincide(op.textContent, f)) return null;
    const el = document.createElement('div');
    el.className = 'rp-cb-opt';
    if (op.value === sel.value) el.classList.add('rp-cb-sel');
    el.textContent = op.textContent;
    el.dataset.val = op.value;
    el.addEventListener('mousedown', e => { e.preventDefault(); elegir(op.value, op.textContent); });
    return el;
  }
  function construir(filtro) {
    const f = filtro ? rpNormalizarTexto(filtro) : '';
    list.innerHTML = '';
    activo = -1;
    let hay = false;
    for (const hijo of sel.children) {
      if (hijo.tagName === 'OPTGROUP') {
        const ops = [];
        for (const op of hijo.children) { const el = crearOpcion(op, f); if (el) ops.push(el); }
        if (ops.length) {
          const grp = document.createElement('div');
          grp.className = 'rp-cb-opt rp-cb-grp';
          grp.textContent = hijo.label;
          list.appendChild(grp);
          ops.forEach(o => list.appendChild(o));
          hay = true;
        }
      } else if (hijo.tagName === 'OPTION') {
        const el = crearOpcion(hijo, f);
        if (el) { list.appendChild(el); hay = true; }
      }
    }
    if (!hay) {
      const v = document.createElement('div');
      v.className = 'rp-cb-opt rp-cb-vacio';
      v.textContent = 'Sin coincidencias';
      list.appendChild(v);
    }
  }
  const opciones = () => [...list.querySelectorAll('.rp-cb-opt:not(.rp-cb-grp):not(.rp-cb-vacio)')];
  function marcar(i) {
    const ops = opciones();
    ops.forEach(o => o.classList.remove('rp-cb-on'));
    if (i < 0 || i >= ops.length) { activo = -1; return; }
    activo = i;
    ops[i].classList.add('rp-cb-on');
    ops[i].scrollIntoView({ block: 'nearest' });
  }
  function abrir(conTexto) {
    abierto = true;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    construir(conTexto ? input.value : '');
    if (!conTexto) input.select();
  }
  function cerrar() {
    if (!abierto) return;
    abierto = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.value = textoSel();
  }
  function elegir(val, txt) {
    sel.value = val;
    abierto = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.value = txt;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => abrir(false));
  input.addEventListener('click', () => { if (!abierto) abrir(false); });
  input.addEventListener('input', () => abrir(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!abierto) abrir(false); marcar(Math.min(activo + 1, opciones().length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); marcar(Math.max(activo - 1, 0)); }
    else if (e.key === 'Enter') { const ops = opciones(); if (abierto && activo >= 0 && ops[activo]) { e.preventDefault(); elegir(ops[activo].dataset.val, ops[activo].textContent); } }
    else if (e.key === 'Escape') { cerrar(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(cerrar, 130));

  new MutationObserver(muts => {
    let opts = false, estilo = false;
    for (const m of muts) {
      if (m.type === 'childList') opts = true;
      if (m.type === 'attributes' && m.attributeName === 'style') estilo = true;
    }
    if (estilo) syncVisibilidad();
    if (opts) syncTexto();
  }).observe(sel, { childList: true, attributes: true, attributeFilter: ['style'] });

  syncVisibilidad();
  syncTexto();
}

function rpRenderPestanas() {
  const nav = document.getElementById('rp-pestanas');
  // El contador refleja el filtro de comunidad (la subcategoría no, porque
  // sus etiquetas son propias de cada pestaña) y depende de la vista
  // principal: en la portada cuenta PRUEBAS DISPUTADAS de la categoría; en
  // el ranking, corredores (o EQUIPOS ÚNICOS en la vista Equipos).
  const esPortada = rpEstado.pantalla === 'carreras';
  const cuenta = cat => {
    if (esPortada) {
      return (rpEstado.carreras || []).filter(c =>
        c.temporada === rpEstado.temporada && c.resultados.length &&
        rpGruposDeCarrera(c).has(cat.key) && rpCarreraEnRegion(c)).length;
    }
    const visibles = cat.corredores.filter(c => {
      if (rpEstado.region === RP_REGION_SIN) return !c.region;
      return !rpEstado.region || rpNormalizarTexto(c.region) === rpEstado.region;
    });
    if (rpEstado.vista === 'equipos' && rpEstado.modo !== 'challenge') {
      return new Set(visibles.map(c => rpNormalizarTexto(c.equipo)).filter(Boolean)).size;
    }
    return visibles.length;
  };
  const titulo = (c, n) => esPortada
    ? `${n} pruebas disputadas de ${c.label} (temporada ${rpEstado.temporada}${rpEstado.regionDisplay ? ' · ' + rpEstado.regionDisplay : ''})`
    : `${n} ${rpEstado.vista === 'equipos' && rpEstado.modo !== 'challenge' ? 'equipos' : 'corredores'} de ${c.label} en el ranking`;
  nav.innerHTML = rpEstado.ranking.categorias.map(c => {
    const n = cuenta(c);
    return `<button type="button" role="tab" data-cat="${c.key}"` +
      ` aria-selected="${c.key === rpEstado.categoria}"` +
      ` title="${rpEscapar(titulo(c, n))}"` +
      ` class="rp-pestana${c.key === rpEstado.categoria ? ' rp-activa' : ''}">` +
      `${rpEscapar(c.label)} <span class="rp-num">${n}</span></button>`;
  }).join('');
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
    // Etapas sin coeficiente muestran '—'; con participación, su multiplicador
    const coefTxt = (r.tipo === 'etapa' && (!r.coef || r.coef === 1)) ? '—' : `×${(r.coef || 0).toFixed(2)}`;
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

// Highlights de la ficha: los mejores resultados de la temporada (por puntos),
// clicables hacia la ficha de la carrera.
function rpRenderHighlights(corredor) {
  const mejores = corredor.resultados
    .filter(r => r.pos && r.puntos > 0)
    .sort((a, b) => (b.puntos - a.puntos) || (a.pos - b.pos))
    .slice(0, 3);
  if (!mejores.length) return '';
  return '<div class="rp-highlights">' +
    '<span class="rp-highlights-titulo">⭐ Mejores resultados</span>' +
    mejores.map(r =>
      `<button type="button" class="rp-highlight" data-carrera="${rpEscapar(r.raceId)}">` +
      `<span class="rp-highlight-pos${r.pos <= 3 ? ' rp-highlight-podio' : ''}">${r.pos}º</span>` +
      `<span class="rp-highlight-nombre">${rpEscapar(r.carrera)}</span>` +
      `<span class="rp-highlight-fecha">${rpEscapar(rpFormatearFecha(r.fecha))}</span></button>`
    ).join('') + '</div>';
}

// Mini-gráfico SVG de evolución: puntos acumulados carrera a carrera (solo
// suman los resultados contados, así el final coincide con el total del
// ranking; las carreras descartadas aparecen como tramo plano con marcador
// gris). Una sola serie → sin leyenda; color de datos #0891b2 (validado con
// la skill dataviz: banda de luminosidad, croma, contraste sobre blanco).
// ── Perfil del corredor: radar de 5 métricas ──
// Todas 0-100. Regularidad y Forma son absolutas; Eficiencia, Palmarés y
// Participación se normalizan al mejor de la categoría (mismo criterio para
// todos). Definición acordada con el director deportivo.
function rpMetricasRaw(c) {
  const R = c.resultados || [];
  const disp = R.length;
  const fin = R.filter(r => r.pos != null);
  const finPts = fin.map(r => r.puntos || 0);
  const media = disp ? R.reduce((s, r) => s + (r.puntos || 0), 0) / disp : 0;
  // Constancia = 1 − coeficiente de variación de los puntos de las terminadas
  let constancia = finPts.length === 1 ? 1 : 0;
  if (finPts.length >= 2) {
    const m = finPts.reduce((a, b) => a + b, 0) / finPts.length;
    if (m > 0) {
      const sd = Math.sqrt(finPts.reduce((a, b) => a + (b - m) * (b - m), 0) / finPts.length);
      constancia = Math.max(0, 1 - Math.min(sd / m, 1));
    }
  }
  const tasaFin = disp ? fin.length / disp : 0;
  const vic = fin.filter(r => r.pos === 1).length;
  const pod = fin.filter(r => r.pos === 2 || r.pos === 3).length;
  const t10 = fin.filter(r => r.pos >= 4 && r.pos <= 10).length;
  // Forma: media de las últimas 3 terminadas frente a la media de la temporada
  let forma = 50;
  if (finPts.length >= 2) {
    const rec = [...fin].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 3).map(r => r.puntos || 0);
    const mRec = rec.reduce((a, b) => a + b, 0) / rec.length;
    const mAll = finPts.reduce((a, b) => a + b, 0) / finPts.length;
    forma = mAll > 0 ? 50 * (mRec / mAll) : 50;
  }
  return { disp, media, regularidad: tasaFin * constancia, palmares: 5 * vic + 3 * pod + t10, forma };
}

function rpRadar(c) {
  const cat = rpEstado.ranking.categorias.find(g => g.key === c.categoria);
  const pool = (cat && cat.corredores.length) ? cat.corredores : [c];
  let maxEf = 1, maxPa = 1, maxPt = 1;
  for (const x of pool) {
    const m = rpMetricasRaw(x);
    if (m.media > maxEf) maxEf = m.media;
    if (m.palmares > maxPa) maxPa = m.palmares;
    if (m.disp > maxPt) maxPt = m.disp;
  }
  const me = rpMetricasRaw(c);
  const clip = v => Math.round(Math.max(0, Math.min(100, v)));
  return {
    suficiente: me.disp >= 3,
    ejes: {
      'Regularidad': clip(100 * me.regularidad),
      'Eficiencia': clip(100 * me.media / maxEf),
      'Palmarés': clip(100 * me.palmares / maxPa),
      'Participación': clip(100 * me.disp / maxPt),
      'Forma': clip(me.forma)
    }
  };
}

const RP_RADAR_EJES = [['Regularidad', '🎯'], ['Eficiencia', '⚡'], ['Palmarés', '🏆'], ['Participación', '📅'], ['Forma', '🔥']];

function rpRadarSVG(ejes) {
  return rpRadarSVGmulti([{ ejes, stroke: 'var(--rp-color-primario)', fill: 'rgba(14,116,144,.28)' }]);
}
// Dibuja uno o varios perfiles superpuestos (para el comparador head-to-head).
function rpRadarSVGmulti(series) {
  const S = 340, cx = 170, cy = 170, R = 112, n = 5;
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const P = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  const poly = r => RP_RADAR_EJES.map((_, i) => P(i, r).map(v => v.toFixed(1)).join(',')).join(' ');
  let grid = '';
  [0.25, 0.5, 0.75, 1].forEach(g => { grid += `<polygon points="${poly(R * g)}" fill="none" stroke="rgba(100,116,139,.20)" stroke-width="1"/>`; });
  let axes = '', ic = '';
  RP_RADAR_EJES.forEach(([k, emo], i) => {
    const [ax, ay] = P(i, R);
    axes += `<line x1="${cx}" y1="${cy}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="rgba(100,116,139,.20)" stroke-width="1"/>`;
    const [ix, iy] = P(i, R + 20);
    ic += `<text x="${ix.toFixed(1)}" y="${(iy + 7).toFixed(1)}" text-anchor="middle" font-size="22">${emo}</text>`;
  });
  let shapes = '';
  series.forEach(s => {
    let datos = '', pts = '';
    RP_RADAR_EJES.forEach(([k], i) => {
      const [dx, dy] = P(i, R * Math.max(4, s.ejes[k] || 0) / 100);
      datos += `${dx.toFixed(1)},${dy.toFixed(1)} `;
      pts += `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="3.6" fill="${s.stroke}"/>`;
    });
    shapes += `<polygon points="${datos.trim()}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2.5" stroke-linejoin="round"/>${pts}`;
  });
  return `<svg viewBox="0 0 ${S} ${S}" class="rp-radar-svg" role="img" aria-label="Perfil del corredor">` +
    grid + axes + shapes + ic + '</svg>';
}

function rpRenderRadar(c) {
  const r = rpRadar(c);
  if (!r.suficiente) return ''; // con menos de 3 carreras no es fiable
  const leyenda = RP_RADAR_EJES.map(([k, emo]) =>
    `<li><span class="rp-radar-k">${emo} ${k}</span>` +
    `<span class="rp-radar-bar"><span style="width:${r.ejes[k]}%"></span></span>` +
    `<b class="rp-radar-num">${r.ejes[k]}</b></li>`).join('');
  return '<section class="rp-radar">' +
    '<h3 class="rp-radar-tit">📊 Perfil del corredor</h3>' +
    '<div class="rp-radar-wrap">' + rpRadarSVG(r.ejes) +
    '<ul class="rp-radar-leg">' + leyenda + '</ul></div>' +
    '<p class="rp-radar-nota">De 0 a 100 comparado con su categoría · <b>Forma</b>: 50 = en su nivel actual.</p>' +
    '</section>';
}

// ── Comparador head-to-head (Fase B) ──
function rpCorredorPorClave(clave) {
  for (const g of rpEstado.ranking.categorias) {
    const c = g.corredores.find(x => x.clave === clave);
    if (c) return c;
  }
  return null;
}

// Muestra el modal ya poblado (arriba se rellena #rp-modal-contenido). Sin
// navegación ‹ › (esa es solo para fichas de corredor).
function rpModalMostrar() {
  document.getElementById('rp-modal-ant').disabled = true;
  document.getElementById('rp-modal-sig').disabled = true;
  const modal = document.getElementById('rp-modal');
  const abierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!abierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

function rpStatsCorredor(c) {
  const pos = c.resultados.map(r => r.pos).filter(p => p >= 1);
  const cat = rpEstado.ranking.categorias.find(g => g.key === c.categoria);
  return {
    puesto: cat ? cat.corredores.findIndex(x => x.clave === c.clave) + 1 : 0,
    puntos: c.puntosTotales,
    victorias: pos.filter(p => p === 1).length,
    podios: pos.filter(p => p <= 3).length,
    top10: pos.filter(p => p <= 10).length,
    pruebas: c.pruebasTotales != null ? c.pruebasTotales : c.resultados.length,
    mejor: pos.length ? Math.min(...pos) : null
  };
}

function rpBotonComparar() {
  return '<button type="button" class="rp-comparar-btn">⚔️ Comparar con otro corredor</button>';
}

// Paso 1: elegir rival (misma categoría), con buscador.
function rpMostrarSelectorComparar(claveA) {
  const a = rpCorredorPorClave(claveA);
  if (!a) return;
  rpEstado.compararA = claveA;
  const cat = rpEstado.ranking.categorias.find(g => g.key === a.categoria);
  const rivales = (cat ? cat.corredores : []).filter(x => x.clave !== claveA);
  const items = rivales.map((x, i) =>
    `<button type="button" class="rp-cmp-item" data-cmp="${rpEscapar(x.clave)}" ` +
    `data-norm="${rpEscapar(rpNormalizarTexto(x.nombre + ' ' + (x.equipo || '')))}">` +
    `<span class="rp-cmp-ipos">${i + 1}º</span>` +
    `<span class="rp-cmp-inom">${rpEscapar(x.nombre)}<small>${rpEscapar(x.equipo || '')}</small></span>` +
    `<span class="rp-cmp-ipts">${rpFormatearPuntos(x.puntosTotales)}</span></button>`).join('');
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera"><h2 id="rp-modal-titulo">⚔️ Comparar</h2>' +
    `<p class="rp-ficha-equipo">Elige con quién medir a <b>${rpEscapar(a.nombre)}</b></p></header>` +
    '<input type="text" class="rp-cmp-buscar" placeholder="🔍 Buscar corredor…" autocomplete="off" spellcheck="false">' +
    `<div class="rp-cmp-lista">${items || '<p class="rp-radar-nota">No hay más corredores en esta categoría.</p>'}</div>` +
    `<button type="button" class="rp-cmp-volver" data-cmp-volver="${rpEscapar(claveA)}">← Volver a la ficha</button>`;
  rpModalMostrar();
  const inp = document.querySelector('.rp-cmp-buscar');
  if (inp) inp.focus();
}

// Paso 2: el duelo
function rpAbrirComparador(claveA, claveB) {
  const a = rpCorredorPorClave(claveA), b = rpCorredorPorClave(claveB);
  if (!a || !b) return;
  rpEstado.compararA = claveA;
  const sa = rpStatsCorredor(a), sb = rpStatsCorredor(b);
  // Cara a cara en carreras comunes (ambos con posición)
  const posA = new Map(a.resultados.filter(r => r.pos != null).map(r => [r.raceId, r.pos]));
  const comunes = b.resultados.filter(r => r.pos != null && posA.has(r.raceId))
    .map(r => ({ carrera: r.carrera, fecha: r.fecha, pb: r.pos, pa: posA.get(r.raceId) }))
    .sort((x, y) => (y.fecha || '').localeCompare(x.fecha || ''));
  let ga = 0, gb = 0;
  comunes.forEach(c => { if (c.pa < c.pb) ga++; else if (c.pb < c.pa) gb++; });
  const ra = rpRadar(a).ejes, rb = rpRadar(b).ejes;

  const mayor = (x, y) => x > y ? 1 : x < y ? -1 : 0;   // 1 = gana A, -1 = gana B
  const menor = (x, y) => (x == null && y == null) ? 0 : x == null ? -1 : y == null ? 1 : (x < y ? 1 : x > y ? -1 : 0);
  const fila = (lab, va, vb, cmp) =>
    `<tr><td class="rp-cmp-cel${cmp === 1 ? ' rp-cmp-gana' : ''}">${va}</td>` +
    `<th>${lab}</th><td class="rp-cmp-cel${cmp === -1 ? ' rp-cmp-gana' : ''}">${vb}</td></tr>`;
  const tabla =
    fila('Puesto', sa.puesto + 'º', sb.puesto + 'º', menor(sa.puesto, sb.puesto)) +
    fila('Puntos', rpFormatearPuntos(sa.puntos), rpFormatearPuntos(sb.puntos), mayor(sa.puntos, sb.puntos)) +
    fila('🥇 Victorias', sa.victorias, sb.victorias, mayor(sa.victorias, sb.victorias)) +
    fila('🏆 Podios', sa.podios, sb.podios, mayor(sa.podios, sb.podios)) +
    fila('🔟 Top-10', sa.top10, sb.top10, mayor(sa.top10, sb.top10)) +
    fila('🚴 Pruebas', sa.pruebas, sb.pruebas, mayor(sa.pruebas, sb.pruebas)) +
    fila('Mejor puesto', sa.mejor ? sa.mejor + 'º' : '—', sb.mejor ? sb.mejor + 'º' : '—', menor(sa.mejor, sb.mejor));

  const leg = RP_RADAR_EJES.map(([k, emo]) =>
    `<li><b class="rp-cmp-a">${ra[k]}</b><span class="rp-radar-k">${emo} ${k}</span><b class="rp-cmp-b">${rb[k]}</b></li>`).join('');

  const comunesHTML = comunes.slice(0, 8).map(c =>
    `<div class="rp-cmp-carrera"><span class="rp-cmp-cpos${c.pa < c.pb ? ' rp-cmp-gana' : ''}">${c.pa}º</span>` +
    `<span class="rp-cmp-cnom">${rpEscapar(c.carrera)}<small>${rpEscapar(rpFormatearFecha(c.fecha))}</small></span>` +
    `<span class="rp-cmp-cpos${c.pb < c.pa ? ' rp-cmp-gana' : ''}">${c.pb}º</span></div>`).join('') +
    (comunes.length > 8 ? `<p class="rp-radar-nota">…y ${comunes.length - 8} carreras en común más.</p>` : '');

  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera"><h2 id="rp-modal-titulo">⚔️ Duelo</h2></header>' +
    '<div class="rp-cmp-cab">' +
    `<div class="rp-cmp-lado"><span class="rp-cmp-nom rp-cmp-a">${rpEscapar(a.nombre)}</span><span class="rp-cmp-eq">${rpEscapar(a.equipo || '')}</span></div>` +
    '<div class="rp-cmp-vs">VS</div>' +
    `<div class="rp-cmp-lado"><span class="rp-cmp-nom rp-cmp-b">${rpEscapar(b.nombre)}</span><span class="rp-cmp-eq">${rpEscapar(b.equipo || '')}</span></div>` +
    '</div>' +
    '<div class="rp-cmp-h2h">' +
    `<div class="rp-cmp-marcador"><b class="rp-cmp-a">${ga}</b><span>–</span><b class="rp-cmp-b">${gb}</b></div>` +
    (comunes.length
      ? `<p>Cara a cara en <b>${comunes.length}</b> ${comunes.length === 1 ? 'carrera' : 'carreras'} en común` +
        (comunes.length < 5 ? ' <span class="rp-cmp-aviso">(pocas para sacar conclusiones)</span>' : '') + '</p>'
      : '<p>No han coincidido todavía en ninguna carrera.</p>') +
    '</div>' +
    `<table class="rp-cmp-tabla"><tbody>${tabla}</tbody></table>` +
    '<h3 class="rp-radar-tit">📊 Perfil comparado</h3>' +
    '<div class="rp-radar-wrap">' +
    rpRadarSVGmulti([
      { ejes: ra, stroke: 'var(--rp-color-primario)', fill: 'rgba(14,116,144,.26)' },
      { ejes: rb, stroke: '#f5b21a', fill: 'rgba(245,178,26,.22)' }
    ]) +
    `<ul class="rp-radar-leg rp-cmp-leg">${leg}</ul></div>` +
    (comunes.length ? '<h3 class="rp-radar-tit">Carreras en común</h3><div class="rp-cmp-comunes">' + comunesHTML + '</div>' : '') +
    `<button type="button" class="rp-cmp-volver" data-cmp-volver="${rpEscapar(claveA)}">← Volver a la ficha</button>`;
  rpModalMostrar();
  document.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

// ── Evolución de POSICIÓN en el tiempo (Fase C, 2/2) ──
// Recalcula el ranking "a fecha de cada jornada" (el motor acepta hastaFecha) y
// guarda esos snapshots en caché por temporada. Luego saca el puesto del
// corredor en cada jornada aplicando los filtros actuales (misma numeración que
// la tabla).
function rpSnapshotsPosicion() {
  if (rpEstado._snapTemp === rpEstado.temporada && rpEstado._snaps) return rpEstado._snaps;
  const fechas = [...new Set((rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.resultados && c.resultados.length)
    .map(c => c.fecha).filter(Boolean))].sort();
  rpEstado._snaps = fechas.map(f => ({
    fecha: f,
    // hastaFecha es exclusiva; f+'￿' incluye las carreras del propio día f
    ranking: calcularRankingPublico(rpEstado.carreras, { temporada: rpEstado.temporada, hastaFecha: f + '￿' })
  }));
  rpEstado._snapTemp = rpEstado.temporada;
  return rpEstado._snaps;
}

function rpEvolucionPosicion(c) {
  const serie = [];
  for (const s of rpSnapshotsPosicion()) {
    const cat = s.ranking.categorias.find(g => g.key === c.categoria);
    if (!cat) continue;
    const idx = rpPoblacion(cat).findIndex(x => x.clave === c.clave);
    if (idx >= 0) serie.push({ fecha: s.fecha, pos: idx + 1, total: rpPoblacion(cat).length });
  }
  return serie;
}

function rpRenderEvolucionPos(c) {
  const serie = rpEvolucionPosicion(c);
  if (serie.length < 2) return '';
  const W = 600, H = 150, PL = 34, PR = 42, PT = 16, PB = 22;
  const posMax = Math.max(...serie.map(p => p.pos));
  const x = i => PL + i * (W - PL - PR) / (serie.length - 1);
  const y = pos => PT + (pos - 1) / Math.max(1, posMax - 1) * (H - PT - PB);
  const linea = serie.map((p, i) => `${x(i).toFixed(1)},${y(p.pos).toFixed(1)}`).join(' ');
  const marcas = serie.map((p, i) => {
    const cx = x(i).toFixed(1), cy = y(p.pos).toFixed(1);
    const det = `${rpFormatearFecha(p.fecha)} · Puesto ${p.pos}º de ${p.total}`;
    return `<g class="rp-spark-punto"><circle cx="${cx}" cy="${cy}" r="9" fill="transparent"></circle>` +
      `<circle cx="${cx}" cy="${cy}" r="3.5" fill="var(--rp-color-primario)" stroke="var(--rp-color-fondo)" stroke-width="2"></circle>` +
      `<title>${rpEscapar(det)}</title></g>`;
  }).join('');
  const ult = serie[serie.length - 1];
  return '<figure class="rp-spark rp-evopos">' +
    '<figcaption class="rp-spark-titulo">Evolución de posición en el ranking</figcaption>' +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del puesto de ${rpEscapar(c.nombre)} durante la temporada">` +
    `<text x="4" y="${(y(1) + 4).toFixed(1)}" class="rp-evopos-eje">1º</text>` +
    (posMax > 1 ? `<text x="4" y="${(y(posMax) + 4).toFixed(1)}" class="rp-evopos-eje">${posMax}º</text>` : '') +
    `<polyline points="${linea}" fill="none" stroke="var(--rp-color-primario)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>` +
    marcas +
    `<text x="${(W - PR + 6).toFixed(1)}" y="${(y(ult.pos) + 4).toFixed(1)}" class="rp-spark-valor">${ult.pos}º</text>` +
    '</svg>' +
    '<figcaption class="rp-radar-nota">Más arriba = mejor puesto. Puesto entre los corredores con los filtros actuales.</figcaption>' +
    '</figure>';
}

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

/* ============================================================
   COMPARTIR y DESCARGAR RECORRIDO
   ============================================================ */

// URL pública donde vive el ranking (la web de WordPress). Los enlaces que
// se comparten apuntan aquí — no al dominio de Netlify — para que el tráfico
// llegue a mfppcycling.com. embed.js reenvía los parámetros al widget.
const RP_URL_PUBLICA = 'https://mfppcycling.com/ranking/';

function rpEnlaceCorredor(nombre) { return RP_URL_PUBLICA + '?ficha=' + encodeURIComponent(nombre); }
function rpEnlaceCarrera(id) { return RP_URL_PUBLICA + '?carrera=' + encodeURIComponent(id); }

// Botones "📲 WhatsApp" + "🔗 Copiar enlace" para una ficha.
function rpBotonesCompartir(titulo, url) {
  return '<div class="rp-compartir">' +
    `<button type="button" class="rp-compartir-btn rp-compartir-wa" data-share-url="${rpEscapar(url)}" data-share-txt="${rpEscapar(titulo)}">📲 Compartir</button>` +
    `<button type="button" class="rp-compartir-btn rp-compartir-cp" data-share-url="${rpEscapar(url)}">🔗 Copiar enlace</button>` +
    '</div>';
}

// ── Tarjeta del corredor para redes (Instagram/WhatsApp/X) ──
// Se dibuja en un <canvas> 1080×1080 (sin librerías) con el puesto, los puntos
// y la marca. En móvil se comparte con el menú nativo del teléfono; en
// escritorio se descarga. Todos los datos ya son públicos en el ranking.
function rpBotonTarjeta() {
  return '<div class="rp-tarjeta-btns">' +
    '<button type="button" class="rp-ver-btn" title="Ver primero tu tarjeta del ranking en grande, antes de compartirla o descargarla">👁️ Ver mi ranking</button>' +
    '<button type="button" class="rp-tarjeta-btn" title="Compartir o descargar tu tarjeta del ranking (Instagram, WhatsApp, etc.)">📸 Compartir mi ranking</button>' +
    '</div>';
}

function rpRR(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rpDibujarTarjeta(d) {
  return new Promise(resolve => {
    const S = 1080, cx = S / 2;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    const FF = "'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif";
    ctx.textAlign = 'center';
    // Fondo degradado + brillo dorado
    let g = ctx.createRadialGradient(cx, -S * 0.1, 0, cx, -S * 0.1, S * 1.25);
    g.addColorStop(0, '#14889e'); g.addColorStop(.26, '#0e6d86'); g.addColorStop(.62, '#0b3a55'); g.addColorStop(1, '#08243a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    g = ctx.createRadialGradient(cx, S * 0.4, 0, cx, S * 0.4, S * 0.55);
    g.addColorStop(0, 'rgba(245,178,26,.16)'); g.addColorStop(1, 'rgba(245,178,26,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    // Ajusta el tamaño de fuente hasta que el texto quepa en maxW
    const fit = (txt, maxW, size, weight) => {
      let s = size; ctx.font = `${weight} ${s}px ${FF}`;
      while (ctx.measureText(txt).width > maxW && s > 16) { s -= 2; ctx.font = `${weight} ${s}px ${FF}`; }
      return s;
    };
    // Marca
    ctx.fillStyle = '#e8f6fb';
    ctx.font = `800 ${fit('MFPP CYCLING · Ranking', S - 160, 34, 800)}px ${FF}`;
    ctx.fillText('MFPP CYCLING · Ranking', cx, 100);
    // Categoría · comunidad · temporada
    const eyebrow = [d.catLabel, d.region, d.temporada].filter(Boolean).join('  ·  ').toUpperCase();
    ctx.fillStyle = '#f5b21a';
    ctx.font = `800 ${fit(eyebrow, S - 150, 27, 800)}px ${FF}`;
    ctx.fillText(eyebrow, cx, 166);
    // Medalla (podio) o aro con el número
    const pos = d.puesto;
    if (pos === 1 || pos === 2 || pos === 3) {
      ctx.font = `128px ${FF}`;
      ctx.fillText(pos === 1 ? '🥇' : pos === 2 ? '🥈' : '🥉', cx, 340);
    } else if (pos) {
      ctx.beginPath(); ctx.arc(cx, 292, 76, 0, Math.PI * 2);
      ctx.lineWidth = 9; ctx.strokeStyle = '#f5b21a'; ctx.stroke();
      ctx.fillStyle = '#f5b21a';
      ctx.font = `900 ${fit('#' + pos, 118, 66, 900)}px ${FF}`;
      ctx.fillText('#' + pos, cx, 318);
    }
    // SOY Xº
    ctx.fillStyle = '#fff';
    const hero = pos ? ('SOY ' + pos + 'º') : 'EN EL RANKING';
    ctx.font = `900 ${fit(hero, S - 120, 130, 900)}px ${FF}`;
    ctx.fillText(hero, cx, 498);
    // Nombre (si viene "Apellido, Nombre" se le da la vuelta para leerlo natural)
    let nombre = d.nombre || '';
    const mm = nombre.match(/^([^,]+),\s*(.+)$/); if (mm) nombre = (mm[2] + ' ' + mm[1]).trim();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${fit(nombre, S - 130, 60, 800)}px ${FF}`;
    ctx.fillText(nombre, cx, 586);
    // Equipo
    if (d.equipo) {
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.font = `600 ${fit(d.equipo.toUpperCase(), S - 150, 27, 600)}px ${FF}`;
      ctx.fillText(d.equipo.toUpperCase(), cx, 630);
    }
    // Badge de puntos
    if (d.puntos != null) {
      const pts = String(d.puntos), lbl = 'PUNTOS';
      ctx.font = `900 58px ${FF}`; const w1 = ctx.measureText(pts).width;
      ctx.font = `800 30px ${FF}`; const w2 = ctx.measureText(lbl).width;
      const bw = w1 + w2 + 14 + 70, bh = 92, by = 688, bx = cx - bw / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(245,178,26,.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
      ctx.fillStyle = '#f5b21a'; rpRR(ctx, bx, by, bw, bh, bh / 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#0b2a44'; ctx.textAlign = 'left';
      ctx.font = `900 58px ${FF}`; ctx.fillText(pts, bx + 35, by + 61);
      ctx.font = `800 30px ${FF}`; ctx.fillText(lbl, bx + 35 + w1 + 14, by + 59);
      ctx.textAlign = 'center';
    }
    // Estadísticas de la temporada (para presumir con los compañeros)
    if (d.stats) {
      const st = [
        ['🥇', d.stats.victorias, 'VICTORIAS'],
        ['🏆', d.stats.podios, 'PODIOS'],
        ['🔟', d.stats.top10, 'TOP-10'],
        ['🚴', d.stats.pruebas, 'PRUEBAS']
      ];
      // Línea divisoria sutil
      ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - 384, 812); ctx.lineTo(cx + 384, 812); ctx.stroke();
      const gap = 232, x0 = cx - gap * (st.length - 1) / 2;
      st.forEach((s, i) => {
        const x = x0 + gap * i;
        ctx.fillStyle = '#fff'; ctx.font = `900 42px ${FF}`;
        ctx.fillText(s[0] + ' ' + s[1], x, 872);
        ctx.fillStyle = 'rgba(255,255,255,.62)'; ctx.font = `800 20px ${FF}`;
        ctx.fillText(s[2], x, 906);
      });
    }
    // CTA + aviso
    ctx.fillStyle = '#e8f6fb';
    const cta = 'Mira el ranking completo · mfppcycling.com/ranking';
    ctx.font = `800 ${fit(cta, S - 110, 33, 800)}px ${FF}`;
    ctx.fillText(cta, cx, 966);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = `600 21px ${FF}`;
    ctx.fillText('⚠️ Ranking personal, no oficial · elaborado con datos públicos', cx, 1012);
    cv.toBlob(b => resolve(b), 'image/png');
  });
}

// Comparte (menú nativo en móvil) o descarga (escritorio) una imagen ya generada.
async function rpCompartirBlob(blob, d) {
  const file = new File([blob], 'ranking-mfpp' + (d.puesto ? '-' + d.puesto : '') + '.png', { type: 'image/png' });
  const texto = (d.puesto ? `Soy ${d.puesto}º` : 'Estoy') + ` en el Ranking MFPP ${d.temporada} 🏆` +
    (d.puntos != null ? ` — ${d.puntos} pts` : '') + '\nmfppcycling.com/ranking';
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: texto }); } catch (_) { /* cancelado por el usuario */ }
    return 'compartido';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'descargado';
}

async function rpCompartirTarjeta(btn) {
  const d = rpEstado.modalTarjeta;
  if (!d) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Generando…';
  try {
    const blob = await rpDibujarTarjeta(d);
    if (await rpCompartirBlob(blob, d) === 'descargado') btn.textContent = '✅ Descargada';
  } catch (_) { /* error puntual */ }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1900);
}

// Vista previa: muestra la tarjeta en un modal para verla antes de compartir/descargar.
async function rpPreviewTarjeta(btn) {
  const d = rpEstado.modalTarjeta;
  if (!d) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Generando…';
  let blob;
  try { blob = await rpDibujarTarjeta(d); }
  catch (_) { btn.textContent = orig; btn.disabled = false; return; }
  btn.textContent = orig; btn.disabled = false;
  const url = URL.createObjectURL(blob);
  const ov = document.createElement('div');
  ov.className = 'rp-tarjeta-overlay';
  ov.innerHTML =
    '<div class="rp-tarjeta-caja" role="dialog" aria-modal="true" aria-label="Vista previa de tu tarjeta del ranking">' +
    '<button type="button" class="rp-tarjeta-cerrar" aria-label="Cerrar">✕</button>' +
    '<img class="rp-tarjeta-img" alt="Tu tarjeta del Ranking MFPP">' +
    '<button type="button" class="rp-tarjeta-descargar">📲 Compartir / Descargar</button>' +
    '</div>';
  ov.querySelector('.rp-tarjeta-img').src = url;
  document.body.appendChild(ov);
  // Si va embebido en un iframe alto, colocarlo en la zona realmente visible
  if (window.rpColocarVista) window.rpColocarVista();
  function onEsc(e) { if (e.key === 'Escape') cerrar(); }
  function cerrar() { ov.remove(); document.removeEventListener('keydown', onEsc); setTimeout(() => URL.revokeObjectURL(url), 500); }
  document.addEventListener('keydown', onEsc);
  ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('.rp-tarjeta-cerrar')) cerrar(); });
  ov.querySelector('.rp-tarjeta-descargar').addEventListener('click', () => rpCompartirBlob(blob, d));
}

function rpCopiarEnlace(url, btn) {
  const ok = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '✅ ¡Copiado!';
    setTimeout(() => { btn.textContent = original; }, 1600);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ok(); } catch (_) { /* nada */ }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(fallback);
  } else { fallback(); }
}

// ── Recorrido en GPX (para Garmin/Wahoo/Strava…) generado del course.json ──
function rpGenerarGPX(carrera, curso) {
  const trkpts = curso.points.map(p =>
    `<trkpt lat="${Number(p.lat).toFixed(6)}" lon="${Number(p.lon).toFixed(6)}">` +
    (p.ele != null ? `<ele>${Math.round(p.ele)}</ele>` : '') +
    '</trkpt>'
  ).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="MFPP Cycling" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `<metadata><name>${rpEscapar(carrera.nombre)}</name></metadata>\n` +
    `<trk><name>${rpEscapar(carrera.nombre)}</name><trkseg>\n${trkpts}\n</trkseg></trk>\n</gpx>`;
}

function rpDescargarGPX(carrera, curso) {
  rpDescargarArchivo(rpGenerarGPX(carrera, curso), 'application/gpx+xml',
    (carrera.nombre || 'recorrido').replace(/[^\w\-]+/g, '_').slice(0, 60) + '.gpx');
}

// Descarga genérica de un texto como archivo (GPX, ICS…)
function rpDescargarArchivo(texto, tipo, nombre) {
  const blob = new Blob([texto], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Enlace de Google Calendar (se ABRE directamente el calendario con el
// evento listo para guardar, sin descargar ningún archivo).
function rpEnlaceGoogleCal(p) {
  const p2 = n => String(n).padStart(2, '0');
  const base = new Date(p.fecha + 'T00:00:00');
  let dates;
  if (/^\d{1,2}:\d{2}/.test(p.hora || '')) {
    const [h, m] = p.hora.split(':');
    const d = new Date(base); d.setHours(parseInt(h, 10), parseInt(m, 10), 0, 0);
    const e = new Date(d.getTime() + 2 * 3600e3);
    const f = x => '' + x.getFullYear() + p2(x.getMonth() + 1) + p2(x.getDate()) + 'T' + p2(x.getHours()) + p2(x.getMinutes()) + '00';
    dates = f(d) + '/' + f(e);
  } else {
    const e = new Date(base.getTime() + 864e5);
    const f = x => '' + x.getFullYear() + p2(x.getMonth() + 1) + p2(x.getDate());
    dates = f(base) + '/' + f(e);
  }
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: p.nombre || 'Prueba', dates: dates,
    location: p.localidad || '', details: 'Prueba del calendario · MFPP Cycling',
    ctz: 'Europe/Madrid'
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

// ── Modal de ficha del ciclista ──
function rpAbrirModal(clave) {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) return;
  rpSalirDeFichaCarrera();
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
  rpEstado.modalEquipo = null;
  // Estadísticas de la temporada completa (incluye resultados descartados:
  // una victoria es una victoria aunque no cuente para el total).
  const posValidas = c.resultados.map(r => r.pos).filter(p => p >= 1);
  const victorias = posValidas.filter(p => p === 1).length;
  const podios = posValidas.filter(p => p <= 3).length;
  const top10 = posValidas.filter(p => p <= 10).length;
  // Datos para la tarjeta compartible (puesto en el ranking filtrado actual;
  // si no está, su puesto dentro de su categoría)
  let rpPuesto = idx >= 0 ? idx + 1 : null;
  if (rpPuesto === null) {
    const catT = rpEstado.ranking.categorias.find(g => g.key === c.categoria);
    if (catT) { const i = catT.corredores.findIndex(x => x.clave === c.clave); if (i >= 0) rpPuesto = i + 1; }
  }
  rpEstado.modalTarjeta = {
    nombre: c.nombre, puesto: rpPuesto, puntos: rpFormatearPuntos(c.puntosTotales), equipo: c.equipo,
    catLabel: rpEtiquetaCategoria(c.categoria), region: c.region || '', temporada: rpEstado.temporada,
    stats: { victorias, podios, top10, pruebas: c.pruebasTotales }
  };
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(c.nombre)}</h2>` +
    `<p class="rp-ficha-equipo"><button type="button" class="rp-enlace rp-enlace-suave" data-equipo="${rpEscapar(rpNormalizarTexto(c.equipo))}">${rpEscapar(c.equipo)}</button></p>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(rpEtiquetaCategoria(c.categoria))}</span>` +
    (c.subcatPrincipal ? `<span class="rp-chip">${rpEscapar(c.subcatPrincipal)}</span>` : '') +
    (c.region ? `<span class="rp-chip">${rpBanderaCCAA(c.region)} ${rpEscapar(c.region)}</span>` : '') +
    `<span class="rp-chip">Temporada ${rpEscapar(rpEstado.temporada)}</span>` +
    (idx >= 0 ? `<span class="rp-chip">Puesto ${idx + 1}º</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${rpFormatearPuntos(c.puntosTotales)} pts</span>` +
    '</div>' +
    '<div class="rp-ficha-stats">' +
    `<span class="rp-stat">🥇 <b>${victorias}</b> victorias</span>` +
    `<span class="rp-stat">🏆 <b>${podios}</b> podios</span>` +
    `<span class="rp-stat">🔟 <b>${top10}</b> top-10</span>` +
    `<span class="rp-stat">🚴 <b>${c.pruebasTotales}</b> pruebas</span>` +
    '</div>' +
    rpBotonTarjeta() +
    rpBotonesCompartir('Ranking MFPP · ' + c.nombre, rpEnlaceCorredor(c.nombre)) +
    rpBotonComparar() +
    '</header>' +
    rpRenderHighlights(c) +
    rpRenderRadar(c) +
    rpSparkline(c) +
    rpRenderEvolucionPos(c) +
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
/* ============================================================
   RECORRIDO DE LA CARRERA (mapa Leaflet + perfil de altimetría)
   Mismo componente visual que el módulo de recorridos del dashboard
   (colores, marcadores y sincronización perfil↔mapa), adaptado al
   modo lectura de este widget:
   - Los puntos del trazado se descargan del bucket race-tracks
     (Storage) SOLO al abrir la pestaña "Recorrido y perfil".
   - Leaflet y Chart.js se cargan de CDN también bajo demanda: la
     portada y el ranking no cargan ni un byte de más.
   - Solo lecturas: .download() del Storage; jamás upload/remove.
   ============================================================ */

let rpMapaRuta = null;      // instancia Leaflet activa
let rpPerfilRuta = null;    // instancia Chart.js activa
let rpMarcadorRuta = null;  // marcador móvil sincronizado con el perfil
let rpLibsRutaPromesa = null;
const rpCursosCache = new Map(); // raceId → course.json (evita re-descargas)

function rpCargarLibsRuta() {
  if (rpLibsRutaPromesa) return rpLibsRutaPromesa;
  rpLibsRutaPromesa = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    let pendientes = 2;
    const listo = () => { if (--pendientes === 0) resolve(); };
    const fallo = () => {
      rpLibsRutaPromesa = null; // permitir reintento
      reject(new Error('No se pudieron cargar las librerías del mapa'));
    };
    for (const src of [
      'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
      'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js'
    ]) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = listo;
      s.onerror = fallo;
      document.head.appendChild(s);
    }
  });
  return rpLibsRutaPromesa;
}

async function rpDescargarCurso(raceId) {
  if (rpCursosCache.has(raceId)) return rpCursosCache.get(raceId);
  if (!rpDb) throw new Error('Supabase no disponible');
  const { data, error } = await rpDb.storage.from('race-tracks').download(`${raceId}/course.json`);
  if (error || !data) throw new Error('Recorrido no disponible');
  const curso = JSON.parse(await data.text());
  rpCursosCache.set(raceId, curso);
  return curso;
}

function rpLimpiarRuta() {
  if (rpMapaRuta) { try { rpMapaRuta.remove(); } catch (_) { /* ya destruido */ } }
  if (rpPerfilRuta) { try { rpPerfilRuta.destroy(); } catch (_) { /* ya destruido */ } }
  rpMapaRuta = null;
  rpPerfilRuta = null;
  rpMarcadorRuta = null;
}

// Al pasar de la ficha de carrera a cualquier otra ficha (o cerrar):
// destruir mapa/gráfico y devolver el modal a su anchura normal.
function rpSalirDeFichaCarrera() {
  rpLimpiarRuta();
  rpEstado._carreraModal = null;
  const cuadro = document.querySelector('.rp-modal-cuadro');
  if (cuadro) cuadro.classList.remove('rp-cuadro-ancho');
}

// Mapa: trazado azul, salida verde, meta roja (idéntico al dashboard)
function rpDibujarMapaRuta(points) {
  const el = document.getElementById('rp-ruta-mapa');
  if (!el || typeof L === 'undefined') return;
  rpMapaRuta = L.map(el, { preferCanvas: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(rpMapaRuta);
  const latlngs = points.map(p => [p.lat, p.lon]);
  L.polyline(latlngs, { color: '#1f6feb', weight: 4, opacity: 0.85 }).addTo(rpMapaRuta);
  L.circleMarker(latlngs[0], { color: '#15803d', radius: 7, fillOpacity: 1 })
    .addTo(rpMapaRuta).bindTooltip('Salida');
  L.circleMarker(latlngs[latlngs.length - 1], { color: '#b91c1c', radius: 7, fillOpacity: 1 })
    .addTo(rpMapaRuta).bindTooltip('Meta');
  rpMarcadorRuta = L.circleMarker(latlngs[0], {
    color: '#7c3aed', fillColor: '#fff', fillOpacity: 1, radius: 6, weight: 2
  });
  rpMapaRuta.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20] });
}

// Perfil: al recorrerlo (dedo o ratón) el marcador se mueve por el mapa
function rpDibujarPerfilRuta(points) {
  const el = document.getElementById('rp-ruta-perfil');
  if (!el || typeof Chart === 'undefined') return;
  const datos = points.filter(p => p.ele != null)
    .map(p => ({ x: (p.dist || 0) / 1000, y: p.ele, lat: p.lat, lon: p.lon }));
  rpPerfilRuta = new Chart(el, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Altitud (m)',
        data: datos,
        borderColor: '#1f6feb',
        backgroundColor: 'rgba(31,111,235,0.15)',
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // El marcador sigue el dedo/ratón por todo el gráfico, sin exigir
      // tocar la línea exacta (mejor en táctil que el original)
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'km' } },
        y: { title: { display: true, text: 'metros' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `km ${ctx.parsed.x.toFixed(2)} · ${Math.round(ctx.parsed.y)} m`
          }
        }
      },
      onHover: (ev, items) => {
        if (items.length && rpMapaRuta && rpMarcadorRuta) {
          const p = datos[items[0].index];
          if (p && p.lat != null) {
            rpMarcadorRuta.setLatLng([p.lat, p.lon]);
            if (!rpMapaRuta.hasLayer(rpMarcadorRuta)) rpMarcadorRuta.addTo(rpMapaRuta);
          }
        }
      }
    }
  });
}

// Pestañas de la ficha de carrera: Clasificación ↔ Recorrido y perfil
function rpCambiarPestanaCarrera(tab) {
  const cont = document.getElementById('rp-modal-contenido');
  cont.querySelectorAll('[data-rctab]').forEach(b => {
    b.classList.toggle('rp-activa', b.dataset.rctab === tab);
    b.setAttribute('aria-pressed', String(b.dataset.rctab === tab));
  });
  const clasif = document.getElementById('rp-rc-clasificacion');
  const ruta = document.getElementById('rp-rc-ruta');
  if (clasif) clasif.hidden = tab !== 'clasificacion';
  if (ruta) ruta.hidden = tab !== 'ruta';
  if (tab === 'ruta' && rpEstado._carreraModal) rpActivarPestanaRuta(rpEstado._carreraModal);
}

async function rpActivarPestanaRuta(carrera) {
  const cont = document.getElementById('rp-rc-ruta');
  if (!cont) return;
  if (cont.dataset.cargado) {
    // Ya dibujado: solo recalcular el tamaño del mapa al volver a mostrarse
    if (rpMapaRuta) setTimeout(() => rpMapaRuta.invalidateSize(), 60);
    return;
  }
  cont.dataset.cargado = '1';
  cont.innerHTML = '<div class="rp-cargando-caja"><div class="rp-spinner" aria-hidden="true"></div><p class="rp-cargando">Cargando recorrido…</p></div>';
  try {
    const [, curso] = await Promise.all([rpCargarLibsRuta(), rpDescargarCurso(carrera.id)]);
    if (!curso || !Array.isArray(curso.points) || curso.points.length < 2) {
      throw new Error('Recorrido sin puntos');
    }
    const r = carrera.ruta || curso.summary || {};
    const conAltimetria = !!(r.has_altitude !== false && curso.points.some(p => p.ele != null));
    const chips = [
      r.distance_m ? `<span class="rp-chip">📏 ${(r.distance_m / 1000).toFixed(1)} km</span>` : '',
      Number.isFinite(r.desnivel_pos_m) ? `<span class="rp-chip">⛰️ +${Math.round(r.desnivel_pos_m)} m</span>` : '',
      Number.isFinite(r.gradient_max_pct) ? `<span class="rp-chip">📈 máx ${r.gradient_max_pct}%</span>` : '',
      r.terrain_type ? `<span class="rp-chip">${rpEscapar(String(r.terrain_type).charAt(0).toUpperCase() + String(r.terrain_type).slice(1))}</span>` : ''
    ].filter(Boolean).join('');
    // Acciones: descargar el trazado (GPX) y abrir la salida en Google Maps
    const salida = curso.points[0];
    const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' +
      Number(salida.lat).toFixed(6) + ',' + Number(salida.lon).toFixed(6);
    const acciones =
      '<div class="rp-ruta-acciones">' +
      '<button type="button" class="rp-ruta-btn" id="rp-ruta-gpx">⬇️ Descargar recorrido (GPX)</button>' +
      `<a class="rp-ruta-btn" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Ver salida en Google Maps</a>` +
      '</div>';
    cont.innerHTML =
      (chips ? `<div class="rp-ficha-datos rp-ruta-chips">${chips}</div>` : '') +
      acciones +   // arriba, para que se vean sin hacer scroll
      '<div id="rp-ruta-mapa"></div>' +
      (conAltimetria
        ? '<div class="rp-ruta-perfil-wrap"><canvas id="rp-ruta-perfil"></canvas></div>' +
          '<p class="rp-nota">Recorre el perfil con el dedo o el ratón: el punto morado del mapa marca dónde está ese kilómetro.</p>'
        : '<p class="rp-nota">Este recorrido no trae altimetría por punto, así que solo se muestra el mapa.</p>');
    const btnGpx = document.getElementById('rp-ruta-gpx');
    if (btnGpx) btnGpx.addEventListener('click', () => rpDescargarGPX(carrera, curso));
    rpLimpiarRuta();
    setTimeout(() => {
      rpDibujarMapaRuta(curso.points);
      if (conAltimetria) rpDibujarPerfilRuta(curso.points);
    }, 60);
  } catch (e) {
    cont.dataset.cargado = '';
    cont.innerHTML =
      '<p class="rp-nota">No se ha podido cargar el recorrido de esta prueba.</p>' +
      '<button type="button" class="rp-cal-tab" data-rctab="ruta">Reintentar</button>';
  }
}

function rpAbrirModalCarrera(raceId) {
  const carrera = rpCarreraPorId(raceId);
  if (!carrera) return;
  rpEstado.modalClave = null; // desde una carrera las flechas ‹ › no navegan
  rpEstado.modalEquipo = null;
  rpEstado._carreraModal = carrera;
  rpLimpiarRuta();
  // Con recorrido, el modal se ensancha en pantallas grandes: el mapa manda
  document.querySelector('.rp-modal-cuadro').classList.toggle('rp-cuadro-ancho', !!carrera.ruta);
  const ordenados = [...carrera.resultados].sort((a, b) => {
    const pa = parseInt(a.pos, 10), pb = parseInt(b.pos, 10);
    const va = Number.isFinite(pa) && pa > 0, vb = Number.isFinite(pb) && pb > 0;
    if (va && vb) return pa - pb;
    return va ? -1 : (vb ? 1 : 0); // sin posición válida, al final
  });
  const nClasificados = ordenados.filter(r => parseInt(r.pos, 10) > 0).length;
  const coefTxt = carrera.tipo === 'etapa'
    ? 'Tabla de etapa (50…1)'
    : carrera.tipo === 'general'
      ? `Tiempos acumulados · Coef. ×${carrera.participacion.coef.toFixed(2)}`
      : `Coef. ×${(RP_COEFICIENTES[carrera.tipo] ?? 1).toFixed(2)}`;
  // Dorsal y tiempos: solo si la clasificación de esta prueba los trae
  // (pruebas antiguas pueden no tenerlos). El tiempo se muestra al estilo
  // ciclista: absoluto para el ganador, "+diferencia" para el resto y
  // "m.t." (mismo tiempo) cuando la diferencia es cero.
  const hayDorsal = ordenados.some(r => r.bib !== '' && r.bib !== null);
  const hayTiempos = ordenados.some(r => r.tiempo);
  const celdaTiempo = (r, pos) => {
    if (pos === 1) return r.tiempo ? rpEscapar(r.tiempo) : '—';
    if (r.gap === null) return r.tiempo ? rpEscapar(r.tiempo) : '—';
    return r.gap > 0 ? '+' + rpFormatearGap(r.gap) : 'm.t.';
  };
  const filas = ordenados.map(r => {
    const pos = parseInt(r.pos, 10) > 0 ? parseInt(r.pos, 10) : null;
    const pts = rpPuntosResultado(r.pos, carrera.tipo, carrera.participacion.coef);
    const clases = [];
    if (!pos) clases.push('rp-descartado');
    if (pos && pos <= 3) clases.push('rp-podio');
    const clave = rpNormalizarClave(r.nombre);
    // Bandera PERSONAL del corredor (no la de la prueba): comunidad anotada
    // en esta clasificación o, si falta, la conocida por el ranking
    const regionCorredor = carrera.regiones[clave] || rpEstado.regionPorClave.get(clave) || '';
    return `<tr class="${clases.join(' ')}">` +
      `<td class="rp-c"><span class="rp-posicion">${pos ?? '—'}</span></td>` +
      (hayDorsal ? `<td class="rp-c rp-col-dorsal">${rpEscapar(String(r.bib ?? ''))}</td>` : '') +
      // En móvil el equipo baja a sublínea (.rp-equipo-sub) y su columna se
      // oculta: con la bandera del corredor no cabía todo a lo ancho
      `<td><button type="button" class="rp-enlace" data-corredor="${rpEscapar(clave)}">${rpEscapar(r.nombre)}</button>${rpInsigniaRegion(regionCorredor)}` +
      `<span class="rp-equipo-sub">${rpEscapar(r.equipo)}</span></td>` +
      `<td class="rp-col-eqmodal">${rpEscapar(r.equipo)}</td>` +
      `<td class="rp-c rp-col-mat">${rpEscapar(r.cat)}</td>` +
      (hayTiempos ? `<td class="rp-c rp-col-tiempo">${pos ? celdaTiempo(r, pos) : '—'}</td>` : '') +
      `<td class="rp-c rp-pts">${pts.puntos ? rpFormatearPuntos(pts.puntos) : '—'}</td>` +
      `</tr>`;
  }).join('');
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(carrera.nombre)}</h2>` +
    `<p class="rp-ficha-equipo">${rpBanderaCCAA(carrera.ccaa)} ${rpEscapar(rpFormatearFecha(carrera.fecha))}` +
    `${carrera.localidad ? ' · ' + rpEscapar(carrera.localidad) : ''}` +
    `${rpEsFueraCV(carrera.ccaa) && carrera.ccaa ? ' · ' + rpEscapar(carrera.ccaa) : ''}</p>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(RP_ETIQUETAS_TIPO[carrera.tipo] || carrera.tipo)}</span>` +
    `<span class="rp-chip">${rpEscapar(coefTxt)}</span>` +
    (carrera.participacion.nivel
      ? `<span class="rp-chip rp-chip-part">${RP_ETIQUETAS_PARTICIPACION[carrera.participacion.nivel].chip}</span>`
      : '') +
    // Algunos km ya vienen con la unidad escrita ("57,2 km"): no duplicarla
    (carrera.km ? `<span class="rp-chip">${rpEscapar(String(carrera.km).replace(/\s*km\.?\s*$/i, ''))} km</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${nClasificados} clasificados</span>` +
    '</div>' +
    rpBotonesCompartir('Clasificación · ' + carrera.nombre, rpEnlaceCarrera(carrera.id)) +
    '</header>' +
    // Pestañas estilo FirstCycling, solo si la prueba tiene recorrido subido
    (carrera.ruta
      ? '<div class="rp-carrera-tabs" role="tablist" aria-label="Contenido de la prueba">' +
        '<button type="button" data-rctab="clasificacion" class="rp-cal-tab rp-activa" aria-pressed="true">📊 Clasificación</button>' +
        '<button type="button" data-rctab="ruta" class="rp-cal-tab" aria-pressed="false">🗺️ Recorrido y perfil</button>' +
        '</div>'
      : '') +
    '<div id="rp-rc-clasificacion">' +
    '<div class="rp-tabla-historial"><table class="rp-subtabla">' +
    '<thead><tr><th>Pos.</th>' +
    (hayDorsal ? '<th class="rp-col-dorsal" title="Dorsal">Dor.</th>' : '') +
    '<th>Corredor</th><th class="rp-col-eqmodal">Equipo</th><th class="rp-col-mat">Cat.</th>' +
    (hayTiempos ? '<th class="rp-col-tiempo">Tiempo</th>' : '') +
    '<th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    '<p class="rp-nota">' +
    (hayTiempos ? 'Tiempo del ganador y diferencia del resto (m.t. = mismo tiempo). ' : '') +
    'Puntos que otorga cada puesto según el sistema del ranking (bono de +3 por terminar incluido). En verde, el podio; en gris, sin posición válida.</p>' +
    '</div>' +
    (carrera.ruta ? '<div id="rp-rc-ruta" hidden></div>' : '');
  document.getElementById('rp-modal-ant').disabled = true;
  document.getElementById('rp-modal-sig').disabled = true;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

// ── Ficha de equipo (modal) ──
// Plantilla ordenada por puntos (los que suman, destacados), estadísticas del
// equipo completo y navegación ‹ › entre equipos del ranking filtrado.
function rpAbrirModalEquipo(claveEquipo) {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) return;
  rpSalirDeFichaCarrera();
  const equipos = rpCalcularEquipos(rpPoblacion(cat));
  const idx = equipos.findIndex(e => e.clave === claveEquipo);
  let e = idx >= 0 ? equipos[idx] : null;
  let catFicha = rpEstado.categoria;
  if (!e) {
    // El equipo puede quedar fuera del ranking filtrado (otra comunidad,
    // otra categoría…): buscarlo sin filtros, primero en la pestaña activa
    // y luego en el resto. Sin puesto ni navegación en ese caso.
    for (const g of [cat, ...rpEstado.ranking.categorias.filter(x => x !== cat)]) {
      e = rpCalcularEquipos(g.corredores).find(x => x.clave === claveEquipo);
      if (e) { catFicha = g.key; break; }
    }
  }
  if (!e) return;
  rpEstado.modalClave = null;
  rpEstado.modalEquipo = e.clave;
  // Puesto de cada corredor en el ranking FILTRADO actual (mismo orden que la
  // tabla): así la ficha del equipo hereda año + comunidad + categoría +
  // subcategoría. Un corredor fuera de esa vista se marca "—".
  const posGlobal = new Map();
  rpPoblacion(cat).forEach((c, i) => posGlobal.set(c.clave, i + 1));
  const filas = e.corredores.map((c, i) => {
    const badge = rpInsigniaRegion(c.region);
    const puesto = posGlobal.has(c.clave) ? posGlobal.get(c.clave) + 'º' : '—';
    return `<tr class="${i < RP_EQUIPO_TOP_N ? 'rp-podio' : ''}">` +
      `<td class="rp-c">${i + 1}</td>` +
      `<td><button type="button" class="rp-enlace" data-corredor="${rpEscapar(c.clave)}">${rpEscapar(c.nombre)}</button>` +
      `${badge}</td>` +
      `<td class="rp-c rp-rank">${puesto}</td>` +
      `<td class="rp-c rp-col-mat">${c.pruebasContadas}/${c.pruebasTotales}</td>` +
      `<td class="rp-c rp-pts">${rpFormatearPuntos(c.puntosTotales)}</td>` +
      `</tr>`;
  }).join('');
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(e.nombre)}</h2>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(rpEtiquetaCategoria(catFicha))}</span>` +
    `<span class="rp-chip">Temporada ${rpEscapar(rpEstado.temporada)}</span>` +
    (idx >= 0 ? `<span class="rp-chip">Puesto ${idx + 1}º</span>` : '') +
    `<span class="rp-chip rp-chip-puntos">${rpFormatearPuntos(e.puntos)} pts</span>` +
    '</div>' +
    '<div class="rp-ficha-stats">' +
    `<span class="rp-stat">🥇 <b>${e.victorias}</b> victorias</span>` +
    `<span class="rp-stat">🏆 <b>${e.podios}</b> podios</span>` +
    `<span class="rp-stat">🔟 <b>${e.top10}</b> top-10</span>` +
    `<span class="rp-stat">🚴 <b>${e.corredores.length}</b> corredores</span>` +
    '</div></header>' +
    '<div class="rp-tabla-historial"><table class="rp-subtabla">' +
    '<thead><tr><th title="Orden dentro del equipo">#</th><th>Corredor</th><th class="rp-c" title="Puesto en el ranking general con los filtros actuales">Ranking</th><th class="rp-c rp-col-mat">Pruebas</th><th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    `<p class="rp-nota">La columna <b>Ranking</b> es el puesto real de cada corredor en la clasificación general con los filtros activos (${rpEscapar(rpEtiquetaCategoria(catFicha))}${rpEstado.regionDisplay ? ' · ' + rpEscapar(rpEstado.regionDisplay) : ''}); <b>#</b> es su orden dentro del equipo. En verde, los ${RP_EQUIPO_TOP_N} corredores cuyos puntos suman el total del equipo.</p>`;
  const btnAnt = document.getElementById('rp-modal-ant');
  const btnSig = document.getElementById('rp-modal-sig');
  btnAnt.disabled = idx <= 0;
  btnSig.disabled = idx < 0 || idx >= equipos.length - 1;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
}

// Abre la ficha adyacente (dir = -1 anterior, +1 siguiente): corredores o
// equipos según qué ficha esté abierta.
function rpNavegarModal(dir) {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) return;
  if (rpEstado.modalEquipo) {
    const equipos = rpCalcularEquipos(rpPoblacion(cat));
    const idx = equipos.findIndex(e => e.clave === rpEstado.modalEquipo);
    const destino = equipos[idx + dir];
    if (idx >= 0 && destino) rpAbrirModalEquipo(destino.clave);
    return;
  }
  if (!rpEstado.modalClave) return;
  const poblacion = rpPoblacion(cat);
  const idx = poblacion.findIndex(c => c.clave === rpEstado.modalClave);
  const destino = poblacion[idx + dir];
  if (idx >= 0 && destino) rpAbrirModal(destino.clave);
}

// Ventana de Ayuda: guía rápida de qué es y cómo se usa el ranking.
// Reutiliza el modal (X, toque fuera, Escape). Sin flechas de navegación.
function rpAbrirAyuda() {
  rpSalirDeFichaCarrera();
  rpEstado.modalClave = null;
  rpEstado.modalEquipo = null;
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    '<h2 id="rp-modal-titulo">❓ Cómo funciona este ranking</h2>' +
    '<p class="rp-ficha-equipo">Guía rápida para sacarle partido</p>' +
    '</header>' +
    '<div class="rp-ayuda">' +
    '<section><h3>🏆 ¿Qué es esto?</h3>' +
    '<p>Un ranking de rendimiento del ciclismo base (cadetes, juveniles, sub-23…) con los resultados y las clasificaciones de la temporada. Se actualiza cada semana.</p></section>' +
    '<section><h3>🧭 Las dos secciones</h3><ul>' +
    '<li><b>🏁 Últimas carreras:</b> los podios de las pruebas recién disputadas.</li>' +
    '<li><b>🏆 Ranking:</b> la clasificación general por puntos de toda la temporada.</li>' +
    '</ul></section>' +
    '<section><h3>🎚️ Los filtros</h3>' +
    '<p>Arriba puedes elegir <b>temporada</b>, <b>comunidad autónoma</b>, <b>categoría</b> y <b>equipo</b>, o usar el <b>buscador</b> para encontrar directamente un corredor, un equipo o una prueba.</p></section>' +
    '<section><h3>👆 Qué puedes tocar</h3><ul>' +
    '<li>Un <b>nombre</b> → su ficha: historial completo, estadísticas y evolución de puntos.</li>' +
    '<li>Un <b>equipo</b> → su plantilla y el puesto de cada corredor en el ranking.</li>' +
    '<li>Una <b>carrera</b> → su clasificación completa y, si lo tiene, el <b>🗺️ mapa y perfil</b> del recorrido.</li>' +
    '</ul></section>' +
    '<section><h3>🔣 Qué significan los símbolos</h3><ul>' +
    '<li><b>Banderas:</b> la comunidad autónoma (o el país) de cada corredor y de cada prueba.</li>' +
    '<li>🥇🥈 <b>Medallas:</b> victorias y podios conseguidos por el corredor.</li>' +
    '<li>▲▼ <b>Flechas:</b> puestos que sube o baja respecto a la jornada anterior (<b>N</b> = nuevo en el ranking).</li>' +
    '</ul></section>' +
    '<section><h3>🧮 Cómo se puntúa (en corto)</h3>' +
    '<p>Cada puesto otorga puntos; las pruebas con rivales venidos de fuera valen algo más; y solo cuentan los <b>12 mejores resultados</b> de cada corredor. Tienes el detalle completo en <b>“Cómo se calculan los puntos”</b>, al final de la página.</p></section>' +
    '</div>' +
    '<p class="rp-nota">MFPP Cycling · Ranking de rendimiento del ciclismo base.</p>';
  document.getElementById('rp-modal-ant').disabled = true;
  document.getElementById('rp-modal-sig').disabled = true;
  const modal = document.getElementById('rp-modal');
  const yaAbierto = !modal.hidden;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!yaAbierto) document.getElementById('rp-modal-cerrar').focus();
  else modal.querySelector('.rp-modal-cuadro').scrollTop = 0;
  // Marcar la Ayuda como vista: no volver a mostrar el aviso de primera vez
  try { localStorage.setItem('rp-ayuda-vista', '1'); } catch (_) { /* sin almacenamiento */ }
  const hint = document.getElementById('rp-ayuda-hint');
  if (hint) hint.hidden = true;
  document.getElementById('rp-ayuda-btn').classList.remove('rp-ayuda-pulso');
}

function rpCerrarModal() {
  rpEstado.modalClave = null;
  rpEstado.modalEquipo = null;
  rpSalirDeFichaCarrera();
  document.getElementById('rp-modal').hidden = true;
  document.body.style.overflow = '';
}

// Tabla del ranking por equipos (vista "Equipos" de la pestaña activa).
function rpRenderTablaEquipos(cat) {
  const cont = document.querySelector('.rp-tabla-scroll');
  const equipos = rpCalcularEquipos(rpPoblacion(cat));
  const posPrevias = new Map();
  const catPrev = rpEstado.rankingPrevio &&
    rpEstado.rankingPrevio.categorias.find(x => x.key === rpEstado.categoria);
  if (catPrev) rpCalcularEquipos(rpPoblacion(catPrev)).forEach((e, i) => posPrevias.set(e.clave, i + 1));
  const filtro = rpNormalizarTexto(rpEstado.busqueda);
  const filas = [];
  equipos.forEach((e, i) => {
    if (filtro && !rpNormalizarTexto(e.nombre).includes(filtro)) return;
    const previa = posPrevias.get(e.clave);
    let evo;
    if (!previa) evo = '<span class="rp-evo rp-evo-nuevo" title="Nuevo en el ranking">N</span>';
    else if (previa > i + 1) evo = `<span class="rp-evo rp-evo-sube" title="Sube desde el puesto ${previa}">▲${previa - i - 1}</span>`;
    else if (previa < i + 1) evo = `<span class="rp-evo rp-evo-baja" title="Baja desde el puesto ${previa}">▼${i + 1 - previa}</span>`;
    else evo = '<span class="rp-evo rp-evo-igual" title="Mantiene el puesto">=</span>';
    filas.push(
      `<tr class="rp-fila" data-equipo="${rpEscapar(e.clave)}" tabindex="0" aria-label="Ver ficha del equipo ${rpEscapar(e.nombre)}">` +
      `<td class="rp-c rp-rank">${i + 1}</td>` +
      `<td class="rp-c rp-col-evo">${evo}</td>` +
      `<td class="rp-col-nombre"><span class="rp-nombre">${rpEscapar(e.nombre)}</span></td>` +
      `<td class="rp-c">${e.corredores.length}</td>` +
      `<td class="rp-c rp-col-vict">${e.victorias ? '🥇 ' + e.victorias : '—'}</td>` +
      `<td class="rp-c rp-pts">${rpFormatearPuntos(e.puntos)}</td>` +
      `</tr>`
    );
  });
  rpRenderSubtitulo();
  rpGuardarPrefs();
  cont.innerHTML =
    '<table id="rp-tabla"><thead><tr>' +
    '<th class="rp-c">#</th><th class="rp-c rp-col-evo" title="Evolución respecto a la jornada anterior">±</th>' +
    '<th>Equipo</th><th class="rp-c">Corredores</th><th class="rp-c rp-col-vict">Victorias</th>' +
    `<th class="rp-c" title="Suma de los ${RP_EQUIPO_TOP_N} mejores corredores del equipo">Puntos</th>` +
    '</tr></thead>' +
    `<tbody>${filas.join('') || '<tr><td colspan="6" class="rp-vacio">Sin resultados para esa búsqueda.</td></tr>'}</tbody></table>`;
}

// Vista Challenge CV oficial: cabecera, tarjetas de resumen y clasificación
// general acumulada con una columna por prueba (formato del dashboard).
function rpRenderTablaChallenge(cat) {
  const cont = document.querySelector('.rp-tabla-scroll');
  const info = document.getElementById('rp-challenge-info');
  const { pruebas, lista } = rpCalcularChallenge(cat);

  // Cabecera + tarjetas de resumen (sobre la lista filtrada de la pestaña)
  const lider = lista[0];
  info.style.display = '';
  info.innerHTML =
    '<div class="rp-ch-banner">🏆 <div><b>Challenge Comunitat Valenciana</b>' +
    '<span>Clasificación general acumulada · Sistema oficial de puntuación FCCV</span></div></div>' +
    '<div class="rp-ch-tarjetas">' +
    `<div class="rp-ch-tarjeta"><b>${pruebas.length}</b><span>pruebas Challenge</span></div>` +
    `<div class="rp-ch-tarjeta"><b>${lista.length}</b><span>corredores con puntos</span></div>` +
    (lider
      ? `<div class="rp-ch-tarjeta rp-ch-lider"><b>🥇 ${rpEscapar(lider.corredor.nombre)}</b><span>${rpFormatearPuntos(lider.total)} pts · líder actual</span></div>`
      : '') +
    '</div>';

  const filtro = rpNormalizarTexto(rpEstado.busqueda);
  const medalla = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
  const filas = [];
  lista.forEach((x, i) => {
    const c = x.corredor;
    if (filtro &&
        !rpNormalizarTexto(c.nombre).includes(filtro) &&
        !rpNormalizarTexto(c.equipo).includes(filtro)) return;
    const celdasPruebas = pruebas.map(p => {
      const r = x.porCarrera[p.id];
      return `<td class="rp-c rp-ch-pts">${r ? rpFormatearPuntos(r.pts) : '—'}</td>`;
    }).join('');
    filas.push(
      `<tr class="rp-fila${i < 3 ? ' rp-ch-podio' : ''}" data-clave="${rpEscapar(c.clave)}" tabindex="0" aria-label="Ver ficha de ${rpEscapar(c.nombre)}">` +
      `<td class="rp-c rp-rank">${medalla(i)}</td>` +
      `<td class="rp-col-nombre"><span class="rp-nombre">${rpEscapar(c.nombre)}</span>` +
      `${x.desempate ? '<span class="rp-ch-desempate" title="Empate a puntos resuelto por el sistema oficial (más 1ºs, 2ºs… y mejor puesto en la última prueba)">desempate</span>' : ''}` +
      `<span class="rp-ch-sub">${rpEscapar([c.subcats[0], c.equipo].filter(Boolean).join(' · '))}</span></td>` +
      `<td class="rp-c rp-ch-total">${rpFormatearPuntos(x.total)}</td>` +
      celdasPruebas +
      `<td class="rp-c rp-col-extra">${x.conteo[0] ? '🥇 ' + x.conteo[0] : '—'}</td>` +
      `<td class="rp-c rp-col-extra">${(x.conteo[1] + x.conteo[2]) ? '🏆 ' + (x.conteo[1] + x.conteo[2]) : '—'}</td>` +
      `<td class="rp-c rp-col-extra">${x.top10 || '—'}</td>` +
      `<td class="rp-c">${x.disputadas}</td>` +
      `<td class="rp-c">${x.ultimaPos}º</td>` +
      `</tr>`
    );
  });

  rpRenderSubtitulo();
  rpGuardarPrefs();
  const cabecerasPruebas = pruebas.map(p =>
    `<th class="rp-c" title="${rpEscapar(p.nombre)}">${rpEscapar(rpFormatearFecha(p.fecha).slice(0, 5))}` +
    `${p.localidad ? `<span class="rp-ch-loc">${rpEscapar(p.localidad)}</span>` : ''}</th>`
  ).join('');
  cont.innerHTML = pruebas.length
    ? '<table id="rp-tabla" class="rp-tabla-challenge"><thead><tr>' +
      '<th class="rp-c">#</th><th>Ciclista</th><th class="rp-c">Total</th>' +
      cabecerasPruebas +
      '<th class="rp-c rp-col-extra" title="Victorias">🥇</th><th class="rp-c rp-col-extra" title="2º y 3º puestos">🏆</th>' +
      '<th class="rp-c rp-col-extra" title="Puestos entre los 10 primeros">Top 10</th>' +
      '<th class="rp-c" title="Pruebas Challenge disputadas">Pruebas</th>' +
      '<th class="rp-c" title="Puesto en su última prueba Challenge">Última</th>' +
      '</tr></thead>' +
      `<tbody>${filas.join('') || `<tr><td colspan="${8 + pruebas.length}" class="rp-vacio">Sin resultados para esa búsqueda.</td></tr>`}</tbody></table>`
    : '<p class="rp-vacio">No hay pruebas Challenge en la temporada seleccionada.</p>';
}

// ── Mapa de perfiles (scatter Regularidad × Puntos, 4 cuadrantes) — Fase C ──
const RP_CUADRANTES = {
  completo: { label: 'Completo', emo: '🎯', color: '#0e7490', desc: 'regular y con muchos puntos' },
  pistolero: { label: 'Pistolero', emo: '🔫', color: '#d97706', desc: 'irregular, pero puntúa fuerte' },
  regular: { label: 'Regular', emo: '🛡️', color: '#16a34a', desc: 'constante, aún con pocos puntos' },
  desarrollo: { label: 'En desarrollo', emo: '🌱', color: '#64748b', desc: 'empezando a sumar' }
};
function rpCuadranteDe(x, y, medX, medY) {
  if (x >= medX && y >= medY) return 'completo';
  if (x < medX && y >= medY) return 'pistolero';
  if (x >= medX && y < medY) return 'regular';
  return 'desarrollo';
}
function rpRenderPerfiles(poblacion) {
  const raw = poblacion.map(c => {
    const pos = c.resultados.filter(r => r.pos != null).map(r => r.pos);
    let sd = null;
    if (pos.length >= 2) { const m = pos.reduce((a, x) => a + x, 0) / pos.length; sd = Math.sqrt(pos.reduce((a, x) => a + (x - m) * (x - m), 0) / pos.length); }
    return { c, sd, ry: c.puntosTotales };
  });
  if (raw.length < 6) return ''; // pocos corredores → el mapa no aporta
  // Se sitúa a cada corredor por su PERCENTIL dentro de la categoría (no por el
  // valor bruto): reparto uniforme y cuadrantes equilibrados (corte en la
  // mediana = percentil 50). Eje X = Regularidad (consistencia de PUESTOS:
  // menos variación → más regular). Eje Y = Puntos.
  const rX = new Map();
  const conSD = raw.filter(o => o.sd != null).sort((a, b) => b.sd - a.sd); // más irregular primero (SD alta)
  const nX = conSD.length;
  conSD.forEach((o, i) => rX.set(o.c.clave, nX > 1 ? (i / (nX - 1)) * 100 : 50));
  const rY = new Map();
  const ordY = [...raw].sort((a, b) => a.ry - b.ry);
  const nY = ordY.length;
  ordY.forEach((o, i) => rY.set(o.c.clave, nY > 1 ? (i / (nY - 1)) * 100 : 50));
  const datos = raw.map(o => ({ c: o.c, x: rX.has(o.c.clave) ? rX.get(o.c.clave) : 50, y: rY.get(o.c.clave) }));
  const medX = 50, medY = 50;
  const W = 340, H = 300, P = 10;
  const px = x => P + (x / 100) * (W - 2 * P);
  const py = y => P + (1 - y / 100) * (H - 2 * P);
  const mx = +px(medX).toFixed(1), my = +py(medY).toFixed(1);
  const rect = (x, y, w, h, col) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${col}" opacity="0.07"/>`;
  const fondos =
    rect(P, P, mx - P, my - P, RP_CUADRANTES.pistolero.color) +
    rect(mx, P, W - P - mx, my - P, RP_CUADRANTES.completo.color) +
    rect(P, my, mx - P, H - P - my, RP_CUADRANTES.desarrollo.color) +
    rect(mx, my, W - P - mx, H - P - my, RP_CUADRANTES.regular.color);
  const divis =
    `<line x1="${mx}" y1="${P}" x2="${mx}" y2="${H - P}" stroke="rgba(100,116,139,.35)" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<line x1="${P}" y1="${my}" x2="${W - P}" y2="${my}" stroke="rgba(100,116,139,.35)" stroke-width="1" stroke-dasharray="4 4"/>`;
  const lab = (x, y, anchor, q) => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="rp-perf-qlab" fill="${RP_CUADRANTES[q].color}">${RP_CUADRANTES[q].emo} ${RP_CUADRANTES[q].label}</text>`;
  const etiquetas =
    lab(P + 4, P + 15, 'start', 'pistolero') +
    lab(W - P - 4, P + 15, 'end', 'completo') +
    lab(P + 4, H - P - 5, 'start', 'desarrollo') +
    lab(W - P - 4, H - P - 5, 'end', 'regular');
  const pts = datos.map(d => {
    const q = rpCuadranteDe(d.x, d.y, medX, medY);
    const cx = px(d.x).toFixed(1), cy = py(d.y).toFixed(1);
    return `<g class="rp-perf-pt" data-scatter-clave="${rpEscapar(d.c.clave)}" tabindex="0" role="button" aria-label="Ficha de ${rpEscapar(d.c.nombre)}">` +
      `<circle cx="${cx}" cy="${cy}" r="12" fill="transparent"/>` +
      `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${RP_CUADRANTES[q].color}" stroke="#fff" stroke-width="1.5"/>` +
      `<title>${rpEscapar(d.c.nombre)} · ${RP_CUADRANTES[q].label}</title></g>`;
  }).join('');
  const leyenda = '<ul class="rp-perf-leg">' + Object.keys(RP_CUADRANTES).map(k =>
    `<li><span class="rp-perf-dot" style="background:${RP_CUADRANTES[k].color}"></span><b>${RP_CUADRANTES[k].emo} ${RP_CUADRANTES[k].label}</b> — ${RP_CUADRANTES[k].desc}</li>`).join('') + '</ul>';
  return '<details class="rp-perfiles"><summary>🗺️ Mapa de perfiles de la categoría</summary>' +
    '<div class="rp-perf-box"><svg viewBox="0 0 ' + W + ' ' + H + '" class="rp-perf-svg" role="img" aria-label="Mapa de perfiles de corredores">' +
    fondos + divis + etiquetas + pts + '</svg></div>' +
    '<p class="rp-perf-ejes">Horizontal: <b>Regularidad</b> (→ más regular) · Vertical: <b>Puntos</b> (↑ más). Cortes en la <b>mediana</b> de la categoría.</p>' +
    leyenda +
    '<p class="rp-radar-nota">Cada punto es un corredor: tócalo para ver su ficha.</p>' +
    '</details>';
}

// ── Descargar el ranking en PDF (logo + título + tabla) ──
const RP_LOGO_B64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALgAAABECAMAAAAFvQ+XAAABv1BMVEUAAAAAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MAn+MArOmI0vWv3vm24fm54vrJ6PvM6fve8f3q9v7s9/7g8v70+v/0+//8/v/9/v/////////////////////////////////////8/v/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////e8f3u+P7r9v7e8f3Z7/3E5vrD5vqq3fis3fis3fit3vis3fih2veQ1PZryvNZxvJ3zfSY1/dRxPFGwvEPue4Gt+0Btu0jvO8wvu/3/P8Aq+gAqugApeYAn+MAsOsAsesAtewBtu0LuO4ove81v/BQw/FZxvJqyvNwy/R1zfSE0PWN0/aU1faW1veh2vej2vip3Piz4Pnj8/7m9P7u+P7x+f7z+v/F5vvJ6PvK6PvU7fzY7v3////Dvu6vAAAAcnRSTlMAECAwQFBgcICQoLDA0ODw8vjz5+jr5+To5fP++/fy8fDu4N7d2dTQz8zIxMC7sKuqpqCenJmXkpCOi4iBgHd0cG5tZmJgW1hVUExKREA9PDMwLiIgHxEQTHOXmKaMdXmPr7zI4snAoIhZWS90g7/QxMh7W8JjAAAKT0lEQVR42s2aiX/bSBXHn2PHdhzH5r4PWRiMqW2CIWAw8hqyWmSIdqPaa3EfC5T7ajILXdpd2rJlm9Iuad8fzNOMR+PxyIrSZrv9fvqxZ0by6Ddv3nuamQbS8DHGhiVsVExkk8FM9qDojGeg6OEydt+Fi8JFBSgmuEQAHDSwZA86gxAkLVzBnsDFMDCEm5aSc2PQAcJBg1asHE0GcCF0UKEMNTPkScuaGlQPpvIAExjDRWChwk+cB+xrbYYEGxMYmB63HBlPTogrws3hoCPnxsBXPZjiTDdSlnhyfEO46RW+HIxBKHswGavBmsCT4xgPM3NBqM+N3YkBYizbXd93e1pgKDf66F//cu3WPZT8tgBPSt/wCSOkLDk32vDMcNDnqqUllVuMOH4kq28wtrO1mYMnoJMkvL+a8zTL+sk9tFYmSxvsDRZxTRtHJD4Pj0tSKggxqbWve44Rx70V39Psf41xlHBJvfJ4XhOk2lZzjY7uObCa8R1TuHIjJjhVwhW1rQ04NxMZcEq4iijdNfTRmWlpogvvLA/2HhMoz9GpbsI5iR8jPpcHozmrYVkzLQWxR6m+PoWCU8Y5Up6zSq10vlDtST8WX0tt1kBOxoplXdDo6+MLraXxhSs+/YasHzOTevk80hdmtRZ2WzJtv6O7hpMtqQyWb/u+7hrHD1DwiHFM6ZAZKc43AmoWm06bG+PFjVpSGWvJ/xeaaxwtp/Fkall93ZeesijM4vTWCVeCroWrOFpa6vu+79j6xQ/Ewq9du/HWA0z2lHoxD7lCsVLnYZotw7gy4y2E+3GT6+NZuwh//fIPrRCIU0zkTaaxBQuKtaiayV8cqSFYfEvL2sqn1y6sZ6IHgziC85jIvdXQrJTywMlV+Ps0g9E78ctQukUgZ7qnB51pWWvF9U33/yMm8eBVxtkuF4TCQrnGagXgcOX1sz3dijVIvX05kpb5Jtfp6K5v6obfyLqpu1bUct9mnQnluRrL4i6h1BALD+MnI56xixis21NaMtP/Ek1OjxhRghXyrCYK5YX3QCq+0mAJlWMZkH4cgvoywHYkfvIG2nJCWPBBU/Y/uSvkwaDC8ovvLMrHMqlIi/Zs6dduHIKpKxW1/O5E9Gg4io9J7zjlvHnjiHEKYFIWs5Crq1yTwiC2qu4K7ur2APyzViohmOCCt5ggzZibIiQrLKYI64mTii7ckpfMowm1Ukld63ICY/W9avCNYrlcLvHkUogitlxlinpKVlRPldkktqoegmoCAtCw4/GZTNasBZf8WlDlwokMM6OtVDsr6W4mL5m7CASN0PCgJDc6WiM89mcu3MQwuZFUdOH92Frm0UQLFqSvdbXBPmAc03nzUnlOF35mfEqxY124bwZdqK8BifQNtOZGp0ynnot9vBp7fY6ZVMFEe1372ivdXr5kpSeVQdoJj7GmktRUHt+syfcRFYz7YA2txPMoV1rrHEcTNpj4KatvtdnJbVF1W7z1F9R3Yt83MJKKeowVJgTdQMVtjH40YeKu32CqtcpCMa9sFIg8d/504YG0qiZ8oAddalKZZUoqLJH61oaK0W19u7mR7iqT5bVcqNl0jI91NKHQjiYUdO5WKMjNDtsuAKdIGukCxBS2amnB6WjmUpNubt1nK6+jhKMJE8tIKpV8nr8q85ArL2zK1ebiceVzm2WikINibX067GhWlbbTt+7p5539lKQSrr7wa5vlmiyWczKH57nFOfVScSce40Zuh21CMrYWcFp6iNN2tqMJ44Vvnney7VJdy4gL5bk4E9ZItpZ4qjlIxlkgai4v+9olWfVlPUzuwQWTmUO899atW0fChJWV2MxvcnmxwWt8YJmWKk+BiopKIyHmqtQcL8HrRbbKeQ62LppYTYkZlDdJfLxZK9WYItO+8x0lJ6e9ygxqwF/9eVExRlZ/Nw0OsM04myyBDS5NRGTRMHjaEcV8yj/5h6pTOf5ShamoquJ8LlrmxHIzaJ+R4mO2U2ZXj1lUJKigMiGUFmXxlSk0vTZi8xAOcI/KOIRpF7ExAhjhPhC7OIVmlwrtJrU1ELtCzX6TFw+Rfj2MbiN2Yb7XwKijw+gDhtiGRUd1dhevln91H/EOYw8x4q6Uppbk1dUp2VnvKAfYHI0ajTk0mzBvdGHebOyN2ujBHikWeqdI1TnJGmF3tIddbtdG2xvR7fu4O6S76bbhcOiR/t3RLg6peRTd0yDhoqMye3jCfoJ3rt/Gm+z27RO8ffu6kAbKUdhWmWnUU/5Tq9ugbkdc6EGX9A9xPzLYMFJMRHo9si0NcBSNi+5t83mKTHpwQLcfUnlIt8Wt0GzzZthtDnEOoqONY7Lwj/F1xq5fJUUnD7WtsNRbLmfWfSieOI9KDZIPTaGXFHeFlBGpGKI3on9UnnqeBxFtbI8iVQ2Ixuphs93eg13SS4hm+ukQp7KjK2Tp338C377JiKt4Z3lbVlCpkT6ynUxEXr2gHRXnkVtKxQRJJhXzZncX51Sm+uKG+bCJNEHkDU3ci7y53R5RFzwARC/dZjRa2dEP8Tor/unufXybkdXxphSuHJzY3siqezG5w5GwkhQ+GnLvIbpI4rp0W6MtomzKfzD3ppHzegfYHQ73+W1i7NTsDacHGHUQMVIdHV+98ocoMCmd3MbXYiPHex6itnD2LGe1zcbI2+UJhKQRFFreEKNZ59HWbHOHhy41kTPt77cpJvjNntfFQxqL6CWKzSmJ3PVGfIgeTdJ8TvMZd/T5+mu4d+X1kxNG6u+rnbD2ji8Us/g357Apsh/XR8y7yBNaG4n9yL776HHPEdmwKVycivQzmXqmGHEAVOdJkprJr3hoq47K7A6VTv5Oqu4/VHbV1lRVqNJnxlP9A09/0xx606gWIRrn6qp3AIQsymZ5NzH1Dnld/Up1tMPe89PfcZ3HcZ4u8rqimOPKt9fn73eBfOQAuQqLqZXVGlZFJLWV4NmiRMpLsLFV5aorxY1tZrKVgwxu8pSpLJ9IbC7Z/plZxyahXu3Vanm7ypKpPd6ff7zT0NY3lfP8b/jThZJGCpVnKpkYfr6OyrMXlBrqlaM7ybMnexYXfD8qx6n86PhV2gzR97/+/HMIQpiEL4MghDMJnn/O/fJg4gvcvuM4Y9cf+NFTAgCnPx5Ebc4keqjf6QyicjB2J44T+EHwDd9toW1P5AP9mWv3es7YJ8B3J7NZf/zZL/R7tu0MbIyw7M987m8f/vg9vPfv/z7436N//Od9v/7kD755+evffjH8ahA9NQxJFZxNgInY4svCJTpxzaSFmHKVi7Yvyb6/4vR+9BHE93/olVd+hpPL4cyFYMitPHkpyPwXt33zgbHolkVfn8bzYTl9FAilrUGvZbdo3C9R+UWa1d53Zy/QjEwiywb+LLPSVUJ/Qr04A3fc/5LwhXFA9TBwXH/mONSEnRZaYyqh1VqaEQu/eOnSJQv7tmX3B73A7/uXnydPGo/dICDX2v+a40/c8QvfGmCPeh28/J2Fr2dw4QtnBtz3wxe/57qhiDv3ucvhGVZ7fKsCAPwfSbvRC5UvAQsAAAAASUVORK5CYII=';

function rpCargarScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('no carga ' + src));
    document.head.appendChild(s);
  });
}
let rpJsPDFPromesa = null;
function rpCargarJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (rpJsPDFPromesa) return rpJsPDFPromesa;
  rpJsPDFPromesa = rpCargarScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js')
    .then(() => rpCargarScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js'));
  return rpJsPDFPromesa;
}

// Prepara título, columnas y filas según la vista actual (Corredores/Equipos/Challenge)
function rpDatosPDF() {
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) return null;
  const catLabel = rpEtiquetaCategoria(cat.key);
  const region = rpEstado.region
    ? (rpEstado.region === RP_REGION_SIN ? 'Sin comunidad asignada' : (rpEstado.regionDisplay || ''))
    : 'Todas las comunidades';
  const fechas = (rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.resultados && c.resultados.length)
    .map(c => c.fecha).filter(Boolean).sort();
  const rango = fechas.length
    ? `Resultados del ${rpFormatearFecha(fechas[0])} al ${rpFormatearFecha(fechas[fechas.length - 1])}`
    : '';
  let titulo, columnas, filas;
  if (rpEstado.modo === 'challenge') {
    titulo = `Challenge CV Oficial · ${catLabel} ${rpEstado.temporada}`;
    columnas = ['#', 'Ciclista', 'Equipo', 'Puntos'];
    filas = rpCalcularChallenge(cat).lista.map((x, i) => [i + 1, x.corredor.nombre, x.corredor.equipo || '', rpFormatearPuntos(x.total)]);
  } else if (rpEstado.vista === 'equipos') {
    titulo = `Ranking por equipos · ${catLabel} ${rpEstado.temporada}`;
    columnas = ['#', 'Equipo', 'Corredores', 'Victorias', 'Puntos'];
    filas = rpCalcularEquipos(rpPoblacion(cat)).map((e, i) => [i + 1, e.nombre, e.corredores.length, e.victorias || 0, rpFormatearPuntos(e.puntos)]);
  } else {
    titulo = `Ranking ${catLabel} ${rpEstado.temporada}`;
    columnas = ['#', 'Corredor', 'Equipo', 'Cat.', 'Pruebas', 'Puntos'];
    filas = rpPoblacion(cat).map((c, i) => [i + 1, c.nombre, c.equipo || '', c.subcatPrincipal || '', `${c.pruebasContadas}/${c.pruebasTotales}`, rpFormatearPuntos(c.puntosTotales)]);
  }
  return { titulo, subtitulo: (region ? region + ' · ' : '') + 'Temporada ' + rpEstado.temporada, rango, columnas, filas, archivo: `ranking-${cat.key}-${rpEstado.temporada}.pdf` };
}

async function rpDescargarPDF(btn) {
  const d = rpDatosPDF();
  if (!d || !d.filas.length) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Generando…';
  try {
    await rpCargarJsPDF();
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(), bandH = 74;
    // Cabecera: franja azul marino + logo blanco + título
    doc.setFillColor(11, 42, 68); doc.rect(0, 0, W, bandH, 'F');
    try { doc.addImage(RP_LOGO_B64, 'PNG', 40, 22, 130, 130 * 68 / 184); } catch (_) { /* si falla el logo, seguimos */ }
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(d.titulo, W - 40, 38, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(190, 214, 230);
    doc.text(d.subtitulo, W - 40, 55, { align: 'right' });
    // Metadatos
    const y = bandH + 22;
    doc.setTextColor(90, 90, 90); doc.setFontSize(9);
    if (d.rango) doc.text(d.rango, 40, y);
    doc.text('Generado el ' + rpFormatearFecha(new Date().toISOString().slice(0, 10)), W - 40, y, { align: 'right' });
    // Tabla
    doc.autoTable({
      startY: y + 12, head: [d.columnas], body: d.filas,
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 4.5, textColor: [40, 40, 40], lineColor: [230, 230, 230], lineWidth: 0.5 },
      headStyles: { fillColor: [14, 116, 144], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 250, 252] },
      columnStyles: { 0: { halign: 'center', cellWidth: 34 }, [d.columnas.length - 1]: { halign: 'right', fontStyle: 'bold', textColor: [14, 116, 144] } },
      margin: { left: 40, right: 40 },
      didDrawPage: () => {
        const H = doc.internal.pageSize.getHeight();
        doc.setFontSize(8); doc.setTextColor(140, 140, 140);
        doc.text('Ranking personal, no oficial · elaborado por MFPP Cycling · mfppcycling.com/ranking', 40, H - 22);
        doc.text('Página ' + doc.internal.getNumberOfPages(), W - 40, H - 22, { align: 'right' });
      }
    });
    doc.save(d.archivo);
    btn.textContent = '✅ Descargado';
  } catch (_) {
    btn.textContent = '⚠️ Error, reinténtalo';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2200);
}

function rpRenderTabla() {
  const cont = document.querySelector('.rp-tabla-scroll');
  const info = document.getElementById('rp-challenge-info');
  const cat = rpEstado.ranking.categorias.find(c => c.key === rpEstado.categoria);
  if (!cat) { cont.innerHTML = ''; info.style.display = 'none'; return; }
  if (rpEstado.modo === 'challenge') { rpRenderTablaChallenge(cat); return; }
  info.style.display = 'none';
  info.innerHTML = '';
  if (rpEstado.vista === 'equipos') { rpRenderTablaEquipos(cat); return; }

  const filtro = rpNormalizarTexto(rpEstado.busqueda);

  // Posiciones de la jornada anterior (misma población filtrada) para las
  // flechas de evolución.
  const posPrevias = new Map();
  const catPrev = rpEstado.rankingPrevio &&
    rpEstado.rankingPrevio.categorias.find(x => x.key === rpEstado.categoria);
  if (catPrev) rpPoblacion(catPrev).forEach((c, i) => posPrevias.set(c.clave, i + 1));

  const pobl = rpPoblacion(cat);
  const filas = [];
  // Orden por defecto = ranking (por puesto). Con la flecha de la columna
  // "Cat." se reordena agrupando por subcategoría, pero el número (#) sigue
  // siendo el PUESTO REAL del ranking (es solo una ordenación visual).
  const items = pobl.map((c, i) => ({ c, pos: i + 1 }));
  if (rpEstado.ordenCat) {
    const dir = rpEstado.ordenCat; // 1 = ascendente, -1 = descendente
    items.sort((a, b) => {
      const ka = a.c.subcatPrincipal || '', kb = b.c.subcatPrincipal || '';
      // "Genérica" = sin año (CADETE, JUVENIL…) o sin dato → siempre al final,
      // en los dos sentidos. Solo alternan las de año (CAD-1/CAD-2, JUV-1/JUV-2…).
      const ga = !/\d/.test(ka), gb = !/\d/.test(kb);
      if (ga !== gb) return ga ? 1 : -1;
      if (ka !== kb) return dir * ka.localeCompare(kb, 'es');
      return a.pos - b.pos;       // dentro de la misma categoría, orden de ranking
    });
  }
  items.forEach(({ c, pos }) => {
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
    } else if (previa > pos) {
      evo = `<span class="rp-evo rp-evo-sube" title="Sube ${previa - pos} desde el puesto ${previa}">▲${previa - pos}</span>`;
    } else if (previa < pos) {
      evo = `<span class="rp-evo rp-evo-baja" title="Baja ${pos - previa} desde el puesto ${previa}">▼${pos - previa}</span>`;
    } else {
      evo = '<span class="rp-evo rp-evo-igual" title="Mantiene el puesto">=</span>';
    }
    const badge = rpInsigniaRegion(c.region);
    filas.push(
      `<tr class="rp-fila" data-clave="${rpEscapar(c.clave)}" tabindex="0" aria-label="Ver ficha de ${rpEscapar(c.nombre)}">` +
      `<td class="rp-c rp-rank">${pos}</td>` +
      `<td class="rp-c rp-col-evo">${evo}</td>` +
      `<td class="rp-col-nombre"><span class="rp-nombre">${rpEscapar(c.nombre)}</span>` +
      `${badge}` +
      `${medallas ? `<span class="rp-medallas">${medallas}</span>` : ''}</td>` +
      `<td class="rp-c rp-col-cat">${c.subcatPrincipal ? `<span class="rp-badge-cat">${rpEscapar(c.subcatPrincipal)}</span>` : '—'}</td>` +
      // Columna Equipo: en escritorio es una columna normal; en móvil, el
      // CSS la recoloca como 2ª línea a todo el ancho (grid), en una sola línea
      `<td class="rp-col-equipo">${c.equipo ? `<button type="button" class="rp-enlace rp-enlace-suave" data-equipo="${rpEscapar(rpNormalizarTexto(c.equipo))}">${rpEscapar(c.equipo)}</button>` : ''}</td>` +
      `<td class="rp-c rp-col-pruebas">${c.pruebasContadas}/${c.pruebasTotales}</td>` +
      `<td class="rp-c rp-pts">${rpFormatearPuntos(c.puntosTotales)}</td>` +
      `</tr>`
    );
  });

  rpRenderSubtitulo(); // cualquier cambio de filtro pasa por aquí
  rpGuardarPrefs();    // y se recuerda para la próxima visita
  const flechaCat = rpEstado.ordenCat === 1 ? '▲' : rpEstado.ordenCat === -1 ? '▼' : '↕';
  cont.innerHTML =
    '<table id="rp-tabla" class="rp-tabla-corredores"><thead><tr>' +
    '<th class="rp-c">#</th><th class="rp-c rp-col-evo" title="Evolución respecto a la jornada anterior">±</th>' +
    '<th>Corredor</th>' +
    `<th class="rp-c rp-col-cat rp-sort-cat" role="button" tabindex="0" aria-label="Ordenar por categoría" title="Ordenar por categoría (agrupa CAD-1, CAD-2… · vuelve a pulsar para invertir o quitar)">Cat. <span class="rp-sort-ind${rpEstado.ordenCat ? ' rp-sort-on' : ''}">${flechaCat}</span></th>` +
    '<th class="rp-col-equipo">Equipo</th>' +
    '<th class="rp-c rp-col-pruebas" title="Pruebas que puntúan / pruebas disputadas">Pruebas</th><th class="rp-c">Puntos</th>' +
    '</tr></thead>' +
    `<tbody>${filas.join('') || '<tr><td colspan="7" class="rp-vacio">Sin resultados para esa búsqueda.</td></tr>'}</tbody></table>` +
    rpRenderPerfiles(pobl);
}

function rpRenderTodo() {
  rpRenderTemporadas();
  rpRenderPantalla();
  rpRenderModo();
  rpRenderVista();
  rpRenderCalendario(); // próximas pruebas (independiente de los filtros)
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
      equipo: rpEstado.equipo,
      vista: rpEstado.vista,
      modo: rpEstado.modo
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
    if (p.vista === 'corredores' || p.vista === 'equipos') rpEstado.vista = p.vista;
    if (p.modo === 'mfpp' || p.modo === 'challenge') rpEstado.modo = p.modo;
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
  // Corredores puntuados de cualquier categoría: para saber si un inscrito
  // de una startlist tiene ficha que enlazar.
  rpEstado.clavesRanking = new Set(
    rpEstado.ranking.categorias.flatMap(c => c.corredores.map(x => x.clave)));
  // Comunidad conocida de cada corredor (respaldo para la clasificación de
  // una prueba cuando esa prueba no trae la región anotada en notes.regions)
  rpEstado.regionPorClave = new Map();
  for (const cat of rpEstado.ranking.categorias) {
    for (const c of cat.corredores) {
      if (c.region && !rpEstado.regionPorClave.has(c.clave)) {
        rpEstado.regionPorClave.set(c.clave, c.region);
      }
    }
  }
  rpEstado.indiceBusqueda = rpConstruirIndice();
  const cats = rpEstado.ranking.categorias;
  if (!cats.find(c => c.key === rpEstado.categoria)) {
    // Estado inicial por defecto: "Todos los Cadetes". Si un año no hubiera
    // cadetes, cae a la primera categoría con corredores.
    rpEstado.categoria = (cats.find(c => c.key === 'cadete') || cats[0])?.key || null;
  }
  if (!cats.length) rpMostrarVacio(); else rpMostrarEstado('');
}

/* ── Enlaces profundos (?comunidad, ?modo, ?vista, ?pantalla, ?carrera,
   ?ficha) ── `get(clave)` devuelve el valor del parámetro. Se llama con la
   URL propia del widget y, cuando va embebido, con los parámetros que el
   padre (mfppcycling.com) reenvía por postMessage (así los enlaces que se
   comparten abren directamente el corredor o la prueba). */
function rpAplicarDeeplink(get) {
  const comunidad = get('comunidad');
  if (comunidad) {
    rpEstado.region = rpNormalizarTexto(comunidad);
    rpRenderRegiones();
    rpRenderPestanas();
    rpRenderTabla();
  }
  const modoParam = get('modo');
  if (modoParam === 'challenge' || modoParam === 'mfpp') {
    rpEstado.modo = modoParam;
    rpRenderModo();
    rpRenderTabla();
  }
  const vistaParam = get('vista');
  if (vistaParam === 'equipos' || vistaParam === 'corredores') {
    rpEstado.pantalla = 'ranking';
    rpEstado.vista = vistaParam;
    rpRenderPantalla();
    rpRenderVista();
    rpRenderTabla();
  }
  const pantallaParam = get('pantalla');
  if (pantallaParam === 'ranking' || pantallaParam === 'carreras') {
    rpEstado.pantalla = pantallaParam;
    rpRenderPantalla();
    if (pantallaParam === 'ranking') rpRenderTabla();
  }
  const carreraParam = get('carrera');
  if (carreraParam) {
    if (rpCarreraPorId(carreraParam)) rpAbrirModalCarrera(carreraParam);
    else rpAbrirModalPlanificada(carreraParam);
  }
  const ficha = get('ficha');
  if (ficha) {
    const clave = rpNormalizarClave(ficha);
    const cat = rpEstado.ranking.categorias.find(c => c.corredores.some(x => x.clave === clave));
    if (cat) {
      rpEstado.categoria = cat.key;
      rpRenderPestanas();
      rpRenderSubcats();
      rpRenderCalendario();
      rpRenderUltimos();
      rpRenderTabla();
      rpAbrirModal(clave);
    }
  }
}

// Enlace profundo recibido del padre antes de tener datos: se guarda y se
// aplica en cuanto rpIniciar termina de cargar.
let rpDeeplinkPendiente = null;
window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || d.tipo !== 'mfpp-rp-deeplink' || !d.params) return;
  if (rpEstado.ranking) rpAplicarDeeplink(k => d.params[k]);
  else rpDeeplinkPendiente = d.params;
});

async function rpIniciar() {
  rpMostrarCargando();
  try {
    // Dos lecturas en paralelo: clasificaciones (ranking) y calendario
    // (pruebas planificadas con startlist). Si el calendario falla, el
    // ranking sigue funcionando sin él.
    const [rRanking, rCalendario, rAgenda] = await Promise.all([
      rpLeer(
        'races',
        'id, name, date, notes, race_results(pos, bib, name, team, cat, time, gap_seconds, total_seconds)',
        q => q.eq('race_type', 'clasificacion').order('date', { ascending: false })
      ),
      rpLeer(
        'races',
        'id, name, date, notes',
        q => q.eq('race_type', 'planificada').order('date', { ascending: true })
      ).catch(e => ({ data: null, error: e })),
      // Disponibilidad del equipo (voy/no voy): marca qué pruebas del
      // calendario oficial están también en la agenda del equipo.
      rpLeer('race_availability', 'race_id').catch(e => ({ data: null, error: e }))
    ]);
    if (rRanking.error) throw rRanking.error;
    rpEstado.carreras = rpAdaptarCarreras(rRanking.data);
    // Generales de vuelta calculadas por tiempos (2+ etapas detectadas)
    rpEstado.carreras = rpEstado.carreras.concat(rpSintetizarGenerales(rpEstado.carreras));
    // PRE-INSCRIPCIONES: al subir los inscritos de una prueba futura, esta
    // pasa a race_type='clasificacion' aunque aún no se haya corrido (caso
    // Trofeo Torrent). Sigue siendo una PRÓXIMA prueba: se fusiona con las
    // planificadas, sin duplicar (mismo comportamiento que el dashboard).
    const hoyISO = rpHoyISO();
    const preinscripciones = rpAdaptarPlanificadas(
      (rRanking.data || []).filter(r => (r.date || '') >= hoyISO)
    ).map(p => ({ ...p, _pre: true }));
    const plan = rCalendario.error ? [] : rpAdaptarPlanificadas(rCalendario.data);
    const vistosCal = new Set();
    rpEstado.planificadas = [...preinscripciones, ...plan]
      .filter(p => {
        const k = p.fecha + '|' + rpNormalizarTexto(p.nombre);
        if (vistosCal.has(k)) return false;
        vistosCal.add(k);
        return true;
      })
      .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    rpEstado.agendaIds = new Set(((rAgenda && rAgenda.data) || []).map(r => String(r.race_id)));
    if (rCalendario.error) console.warn('[ranking-publico] calendario no disponible:', rCalendario.error);
    rpEstado.temporada = null; // → la más reciente con datos
    // Preferencias guardadas del visitante (la URL manda sobre ellas después).
    rpCargarPrefs();
    if (rpEstado.temporada !== null &&
        !rpEstado.carreras.some(c => c.temporada === rpEstado.temporada)) {
      rpEstado.temporada = null; // la temporada guardada ya no tiene datos
    }
    rpRecalcular();
    rpRenderTodo();
    // Aplicar los parámetros de la propia URL (?comunidad, ?carrera, ?ficha…)
    const paramsURL = new URLSearchParams(location.search);
    rpAplicarDeeplink(k => paramsURL.get(k));
    // Si el padre (mfppcycling.com) mandó un enlace profundo antes de que
    // hubiera datos, aplicarlo ahora; y avisar de que el widget está listo
    // para recibir enlaces que lleguen más tarde.
    if (rpDeeplinkPendiente) { rpAplicarDeeplink(k => rpDeeplinkPendiente[k]); rpDeeplinkPendiente = null; }
    if (window.parent !== window) window.parent.postMessage({ tipo: 'mfpp-rp-listo' }, '*');
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
    rpEstado.subcategoria = ''; // la etiqueta de otra pestaña no aplica aquí
    rpRenderPestanas();
    rpRenderSubcats();
    rpRenderEquipos();
    rpRenderCalendario();  // próximas pruebas de la nueva categoría
    rpRenderUltimos();     // últimos resultados de la nueva categoría
    rpRenderTabla();
  });

  document.getElementById('rp-equipo').addEventListener('change', e => {
    rpEstado.equipo = e.target.value;
    rpRenderTabla();
  });

  document.getElementById('rp-subcat').addEventListener('change', e => {
    // value = "clavePestaña|etiqueta" o '' (todas). Si la etiqueta es de otro
    // bloque, cambiamos de pestaña automáticamente.
    const [catKey, etiqueta] = e.target.value ? e.target.value.split('|') : ['', ''];
    rpEstado.subcategoria = etiqueta || '';
    if (catKey && catKey !== rpEstado.categoria) {
      rpEstado.categoria = catKey;
      rpRenderPestanas();
      rpRenderSubcats();
      rpRenderEquipos();
      rpRenderCalendario();
      rpRenderUltimos();
    }
    rpRenderTabla();
  });

  // Fallito 2: filtros tecleables (comunidad, categoría, equipo)
  rpFiltroBuscable(document.getElementById('rp-region'), 'rp-cb-region');
  rpFiltroBuscable(document.getElementById('rp-subcat'), 'rp-cb-subcat');
  rpFiltroBuscable(document.getElementById('rp-equipo'), 'rp-cb-equipo');

  document.getElementById('rp-region').addEventListener('change', e => {
    rpEstado.region = e.target.value;
    // Nombre para mostrar (títulos/subtítulo); '' = todas → sin etiqueta
    rpEstado.regionDisplay = (e.target.value && e.target.value !== RP_REGION_SIN && e.target.selectedOptions[0])
      ? e.target.selectedOptions[0].textContent
      : '';
    rpRenderPestanas();
    rpRenderUltimos(); // la portada de carreras también respeta la comunidad
    rpRenderTabla();
  });

  let tBusqueda = null;
  const buscador = document.getElementById('rp-buscador');
  buscador.addEventListener('input', e => {
    clearTimeout(tBusqueda);
    tBusqueda = setTimeout(() => {
      rpEstado.busqueda = e.target.value;
      rpRenderTabla();
      rpRenderSugerencias();
    }, 150);
  });
  buscador.addEventListener('focus', () => rpRenderSugerencias());
  buscador.addEventListener('blur', () => setTimeout(rpOcultarSugerencias, 150));
  buscador.addEventListener('keydown', e => {
    if (e.key === 'Escape') { rpOcultarSugerencias(); return; }
    if (e.key === 'Enter') {
      // Enter abre la primera sugerencia visible
      const primera = document.querySelector('#rp-sugerencias .rp-sug');
      if (primera) {
        e.preventDefault();
        rpAbrirSugerencia(primera.dataset.sugTipo, primera.dataset.sugId);
      }
    }
  });
  // mousedown (no click) para ganar al blur del input
  document.getElementById('rp-sugerencias').addEventListener('mousedown', e => {
    const btn = e.target.closest('.rp-sug');
    if (!btn) return;
    e.preventDefault();
    rpAbrirSugerencia(btn.dataset.sugTipo, btn.dataset.sugId);
  });

  // Abrir fichas desde la tabla (clic o teclado): el botón de equipo de una
  // celda tiene prioridad sobre la fila; la fila abre corredor o equipo según
  // la vista activa.
  const alAccionarFila = e => {
    const sortCat = e.target.closest('.rp-sort-cat');
    if (sortCat) {
      const cur = rpEstado.ordenCat || 0;
      rpEstado.ordenCat = cur === 0 ? 1 : cur === 1 ? -1 : 0; // agrupar → invertir → quitar
      rpRenderTabla();
      return;
    }
    const bScatter = e.target.closest('[data-scatter-clave]');
    if (bScatter) { rpAbrirModal(bScatter.dataset.scatterClave); return; }
    const bEquipo = e.target.closest('button[data-equipo]');
    if (bEquipo) { rpAbrirModalEquipo(bEquipo.dataset.equipo); return; }
    const fila = e.target.closest('tr.rp-fila');
    if (!fila) return;
    if (fila.dataset.equipo) rpAbrirModalEquipo(fila.dataset.equipo);
    else rpAbrirModal(fila.dataset.clave);
  };
  document.querySelector('.rp-tabla-scroll').addEventListener('click', alAccionarFila);
  document.querySelector('.rp-tabla-scroll').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    alAccionarFila(e);
  });

  // Conmutador de vista principal: Últimas carreras ↔ Ranking
  document.getElementById('rp-pantalla').addEventListener('click', e => {
    const btn = e.target.closest('button[data-pantalla]');
    if (!btn || btn.dataset.pantalla === rpEstado.pantalla) return;
    rpEstado.pantalla = btn.dataset.pantalla;
    rpRenderPantalla();
    rpRenderPestanas(); // los contadores cambian de significado (pruebas ↔ corredores)
    if (rpEstado.pantalla === 'ranking') rpRenderTabla();
    else rpRenderUltimos();
  });

  // "Ver más carreras" de la portada (los enlaces de las tarjetas van por
  // la delegación general de alClicEnlace)
  document.getElementById('rp-ultimos').addEventListener('click', e => {
    if (e.target.closest('.rp-ver-mas')) {
      rpEstado.ultimosVisibles += 10;
      rpRenderUltimos();
      return;
    }
    const bTipo = e.target.closest('[data-tipofiltro]');
    if (bTipo) {
      rpEstado.filtroTipoCarrera = bTipo.dataset.tipofiltro;
      rpRenderUltimos();
    }
  });

  // Conmutador Corredores / Equipos
  document.getElementById('rp-vista').addEventListener('click', e => {
    const btn = e.target.closest('button[data-vista]');
    if (!btn || btn.dataset.vista === rpEstado.vista) return;
    rpEstado.vista = btn.dataset.vista;
    rpRenderVista();
    rpRenderPestanas(); // los contadores cambian: corredores ↔ equipos únicos
    rpRenderTabla();
  });

  // Descargar el ranking en PDF
  document.getElementById('rp-pdf-btn').addEventListener('click', function () { rpDescargarPDF(this); });

  // Conmutador Ranking MFPP / Challenge CV Oficial
  document.getElementById('rp-modo').addEventListener('click', e => {
    const btn = e.target.closest('button[data-modo]');
    if (!btn || btn.dataset.modo === rpEstado.modo) return;
    rpEstado.modo = btn.dataset.modo;
    rpRenderModo();
    rpRenderPestanas(); // los contadores dependen del modo/vista
    rpRenderTabla();
  });

  // Enlaces cruzados: clic en un corredor o una carrera (dentro del modal o
  // en "Últimos resultados") abre la ficha correspondiente.
  const alClicEnlace = e => {
    const bVer = e.target.closest('.rp-ver-btn');
    if (bVer) { rpPreviewTarjeta(bVer); return; }
    const bTar = e.target.closest('.rp-tarjeta-btn');
    if (bTar) { rpCompartirTarjeta(bTar); return; }
    const bCmp = e.target.closest('.rp-comparar-btn');
    if (bCmp) { rpMostrarSelectorComparar(rpEstado.modalClave); return; }
    const bCmpItem = e.target.closest('.rp-cmp-item');
    if (bCmpItem) { rpAbrirComparador(rpEstado.compararA, bCmpItem.dataset.cmp); return; }
    const bCmpVolver = e.target.closest('.rp-cmp-volver');
    if (bCmpVolver) { rpAbrirModal(bCmpVolver.dataset.cmpVolver); return; }
    const bWA = e.target.closest('.rp-compartir-wa');
    if (bWA) {
      window.open('https://wa.me/?text=' + encodeURIComponent(bWA.dataset.shareTxt + '\n' + bWA.dataset.shareUrl), '_blank', 'noopener');
      return;
    }
    const bCP = e.target.closest('.rp-compartir-cp');
    if (bCP) { rpCopiarEnlace(bCP.dataset.shareUrl, bCP); return; }
    const bTab = e.target.closest('[data-rctab]');
    if (bTab) { rpCambiarPestanaCarrera(bTab.dataset.rctab); return; }
    const bVista = e.target.closest('[data-calvista]');
    if (bVista) { rpEstado.calVista = bVista.dataset.calvista; rpRenderCalendario(); return; }
    const bCorredor = e.target.closest('[data-corredor]');
    if (bCorredor) { rpAbrirModal(bCorredor.dataset.corredor); return; }
    const bCarrera = e.target.closest('[data-carrera]');
    if (bCarrera) { rpAbrirModalCarrera(bCarrera.dataset.carrera); return; }
    const bEquipo = e.target.closest('button[data-equipo]');
    if (bEquipo) { rpAbrirModalEquipo(bEquipo.dataset.equipo); return; }
    const bPlanificada = e.target.closest('[data-planificada]');
    if (bPlanificada) rpAbrirModalPlanificada(bPlanificada.dataset.planificada);
  };
  document.getElementById('rp-modal-contenido').addEventListener('click', alClicEnlace);
  // Filtro del selector de rival (comparador): teclear filtra la lista
  document.getElementById('rp-modal-contenido').addEventListener('input', e => {
    if (!e.target.closest('.rp-cmp-buscar')) return;
    const f = rpNormalizarTexto(e.target.value);
    document.querySelectorAll('.rp-cmp-item').forEach(it => {
      it.style.display = (!f || (it.dataset.norm || '').indexOf(f) >= 0) ? '' : 'none';
    });
  });
  document.getElementById('rp-ultimos').addEventListener('click', alClicEnlace);
  document.getElementById('rp-calendario').addEventListener('click', alClicEnlace);

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

  // Botón de Ayuda + aviso de primera vez (una sola vez por navegador)
  document.getElementById('rp-ayuda-btn').addEventListener('click', rpAbrirAyuda);
  const ayudaHint = document.getElementById('rp-ayuda-hint');
  const ayudaHintX = document.getElementById('rp-ayuda-hint-x');
  try {
    if (!localStorage.getItem('rp-ayuda-vista')) {
      ayudaHint.hidden = false;
      document.getElementById('rp-ayuda-btn').classList.add('rp-ayuda-pulso');
    }
  } catch (_) { /* almacenamiento no disponible */ }
  ayudaHintX.addEventListener('click', () => {
    ayudaHint.hidden = true;
    document.getElementById('rp-ayuda-btn').classList.remove('rp-ayuda-pulso');
    try { localStorage.setItem('rp-ayuda-vista', '1'); } catch (_) { /* sin almacenamiento */ }
  });

  rpIniciar();
});
