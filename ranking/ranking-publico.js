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
        pos: x.pos, nombre: x.name || '', equipo: x.team || '', cat: x.cat || '',
        // Datos de la clasificación oficial (pueden faltar en pruebas antiguas)
        bib: x.bib ?? '', tiempo: x.time || '',
        gap: Number.isFinite(x.gap_seconds) ? x.gap_seconds : null
      }))
    };
    carrera.tipo = rpTipoCarrera(carrera);
    return carrera;
  }).filter(c => c.temporada !== null);
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

function rpTarjetaCarrera(c, reciente) {
  const lineas = [1, 2, 3].map((p, i) => {
    const r = c.resultados.find(x => parseInt(x.pos, 10) === p);
    if (!r) return '';
    const clave = rpNormalizarClave(r.nombre);
    const nombre = rpEstado.clavesRanking.has(clave)
      ? `<button type="button" class="rp-enlace" data-corredor="${rpEscapar(clave)}">${rpEscapar(r.nombre)}</button>`
      : `<span class="rp-podio-nombre">${rpEscapar(r.nombre)}</span>`;
    return `<li>${RP_MEDALLAS_PODIO[i]} ${nombre}` +
      (r.equipo ? `<span class="rp-podio-equipo"> — ${rpEscapar(r.equipo)}</span>` : '') + '</li>';
  }).join('');
  return `<article class="rp-carrera${reciente ? ' rp-carrera-reciente' : ''}" data-carrera="${rpEscapar(c.id)}">` +
    '<header class="rp-carrera-cab">' +
    `<span class="rp-carrera-fecha">${rpEscapar(rpDiaSemana(c.fecha))} ${rpEscapar(rpFormatearFecha(c.fecha))}</span>` +
    (reciente ? '<span class="rp-chip-reciente">Reciente</span>' : '') +
    `<span class="rp-tipo rp-tipo-${c.tipo}">${rpEscapar(RP_ETIQUETAS_TIPO[c.tipo] || c.tipo)}</span>` +
    '</header>' +
    `<h3 class="rp-carrera-nombre"><button type="button" class="rp-enlace" data-carrera="${rpEscapar(c.id)}">${rpEscapar(c.nombre)}</button></h3>` +
    (c.localidad ? `<p class="rp-carrera-loc">📍 ${rpEscapar(c.localidad)}</p>` : '') +
    (lineas ? `<ul class="rp-podio-lista">${lineas}</ul>` : '') +
    `<button type="button" class="rp-carrera-cta" data-carrera="${rpEscapar(c.id)}">Ver clasificación completa ➔</button>` +
    '</article>';
}

function rpRenderUltimos() {
  const cont = document.getElementById('rp-ultimos');
  // Al cambiar de temporada o de pestaña, el "Ver más" se reinicia
  const clave = rpEstado.temporada + '|' + rpEstado.categoria;
  if (rpEstado._ultimosClave !== clave) {
    rpEstado._ultimosClave = clave;
    rpEstado.ultimosVisibles = 10;
  }
  const todas = (rpEstado.carreras || [])
    .filter(c => c.temporada === rpEstado.temporada && c.resultados.length &&
                 rpGruposDeCarrera(c).has(rpEstado.categoria))
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  if (!todas.length) {
    cont.innerHTML = '<p class="rp-vacio">Aún no hay carreras disputadas de esta categoría en la temporada seleccionada.</p>';
    return;
  }
  const hace7 = new Date(Date.now() - 7 * 864e5);
  const corteISO = hace7.getFullYear() + '-' +
    String(hace7.getMonth() + 1).padStart(2, '0') + '-' +
    String(hace7.getDate()).padStart(2, '0');
  const visibles = todas.slice(0, rpEstado.ultimosVisibles);
  cont.innerHTML = visibles.map(c => rpTarjetaCarrera(c, c.fecha >= corteISO)).join('') +
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
    return '<div class="rp-ultimo">' +
      `<span class="rp-ultimo-fecha">${rpEscapar(rpDiaSemana(p.fecha))} ${rpEscapar(rpFormatearFecha(p.fecha))}${p.hora ? ' · ' + rpEscapar(p.hora) : ''}</span>` +
      `<button type="button" class="rp-enlace rp-ultimo-nombre" data-planificada="${rpEscapar(p.id)}">${rpEscapar(p.nombre)}</button>` +
      (p.localidad ? `<span class="rp-ultimo-equipo">📍 ${rpEscapar(p.localidad)}</span>` : '') +
      (p.inscritos.length
        ? `<button type="button" class="rp-cal-chip" data-planificada="${rpEscapar(p.id)}">📋 Lista de inscritos (${p.inscritos.length})</button>`
        : '<span class="rp-cal-chip rp-cal-chip-off">Sin inscritos</span>') +
      (clasif ? `<button type="button" class="rp-cal-chip rp-cal-chip-ok" data-carrera="${rpEscapar(clasif.id)}">🏆 Clasificación disponible</button>` : '') +
      '</div>';
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

function rpRenderPestanas() {
  const nav = document.getElementById('rp-pestanas');
  // El contador refleja el filtro de comunidad (la subcategoría no, porque
  // sus etiquetas son propias de cada pestaña). En la vista Equipos cuenta
  // EQUIPOS ÚNICOS con presencia en la categoría, no corredores.
  const cuenta = cat => {
    const visibles = cat.corredores.filter(c => {
      if (rpEstado.region === RP_REGION_SIN) return !c.region;
      return !rpEstado.region || rpNormalizarTexto(c.region) === rpEstado.region;
    });
    if (rpEstado.vista === 'equipos' && rpEstado.modo !== 'challenge') {
      return new Set(visibles.map(c => rpNormalizarTexto(c.equipo)).filter(Boolean)).size;
    }
    return visibles.length;
  };
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
  rpEstado.modalEquipo = null;
  // Estadísticas de la temporada completa (incluye resultados descartados:
  // una victoria es una victoria aunque no cuente para el total).
  const posValidas = c.resultados.map(r => r.pos).filter(p => p >= 1);
  const victorias = posValidas.filter(p => p === 1).length;
  const podios = posValidas.filter(p => p <= 3).length;
  const top10 = posValidas.filter(p => p <= 10).length;
  document.getElementById('rp-modal-contenido').innerHTML =
    '<header class="rp-ficha-cabecera">' +
    `<h2 id="rp-modal-titulo">${rpEscapar(c.nombre)}</h2>` +
    `<p class="rp-ficha-equipo"><button type="button" class="rp-enlace rp-enlace-suave" data-equipo="${rpEscapar(rpNormalizarTexto(c.equipo))}">${rpEscapar(c.equipo)}</button></p>` +
    '<div class="rp-ficha-datos">' +
    `<span class="rp-chip">${rpEscapar(rpEtiquetaCategoria(c.categoria))}</span>` +
    (c.subcatPrincipal ? `<span class="rp-chip">${rpEscapar(c.subcatPrincipal)}</span>` : '') +
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
    rpRenderHighlights(c) +
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
  rpEstado.modalClave = null; // desde una carrera las flechas ‹ › no navegan
  rpEstado.modalEquipo = null;
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
    const pts = rpPuntosResultado(r.pos, carrera.tipo);
    const clases = [];
    if (!pos) clases.push('rp-descartado');
    if (pos && pos <= 3) clases.push('rp-podio');
    return `<tr class="${clases.join(' ')}">` +
      `<td class="rp-c"><span class="rp-posicion">${pos ?? '—'}</span></td>` +
      (hayDorsal ? `<td class="rp-c rp-col-dorsal">${rpEscapar(String(r.bib ?? ''))}</td>` : '') +
      `<td><button type="button" class="rp-enlace" data-corredor="${rpEscapar(rpNormalizarClave(r.nombre))}">${rpEscapar(r.nombre)}</button></td>` +
      `<td>${rpEscapar(r.equipo)}</td>` +
      `<td class="rp-c rp-col-mat">${rpEscapar(r.cat)}</td>` +
      (hayTiempos ? `<td class="rp-c rp-col-tiempo">${pos ? celdaTiempo(r, pos) : '—'}</td>` : '') +
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
    '<thead><tr><th>Pos.</th>' +
    (hayDorsal ? '<th class="rp-col-dorsal" title="Dorsal">Dor.</th>' : '') +
    '<th>Corredor</th><th>Equipo</th><th class="rp-col-mat">Cat.</th>' +
    (hayTiempos ? '<th class="rp-col-tiempo">Tiempo</th>' : '') +
    '<th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    '<p class="rp-nota">' +
    (hayTiempos ? 'Tiempo del ganador y diferencia del resto (m.t. = mismo tiempo). ' : '') +
    'Puntos que otorga cada puesto según el sistema del ranking (bono de +3 por terminar incluido). En verde, el podio; en gris, sin posición válida.</p>';
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
  const filas = e.corredores.map((c, i) => {
    const badge = rpBadgeRegion(c.region);
    return `<tr class="${i < RP_EQUIPO_TOP_N ? 'rp-podio' : ''}">` +
      `<td class="rp-c">${i + 1}</td>` +
      `<td><button type="button" class="rp-enlace" data-corredor="${rpEscapar(c.clave)}">${rpEscapar(c.nombre)}</button>` +
      `${badge ? `<span class="rp-badge-region" title="${rpEscapar(c.region)}">${rpEscapar(badge)}</span>` : ''}</td>` +
      `<td class="rp-c">${c.pruebasContadas}/${c.pruebasTotales}</td>` +
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
    '<thead><tr><th>#</th><th>Corredor</th><th>Pruebas</th><th>Puntos</th></tr></thead>' +
    `<tbody>${filas}</tbody></table></div>` +
    `<p class="rp-nota">En verde, los ${RP_EQUIPO_TOP_N} corredores cuyos puntos suman el total del equipo. Las estadísticas cuentan toda la plantilla.</p>`;
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

function rpCerrarModal() {
  rpEstado.modalClave = null;
  rpEstado.modalEquipo = null;
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
      `<td class="rp-c rp-col-cat">${c.subcatPrincipal ? `<span class="rp-badge-cat">${rpEscapar(c.subcatPrincipal)}</span>` : '—'}</td>` +
      `<td class="rp-col-equipo">${c.equipo ? `<button type="button" class="rp-enlace rp-enlace-suave" data-equipo="${rpEscapar(rpNormalizarTexto(c.equipo))}">${rpEscapar(c.equipo)}</button>` : ''}</td>` +
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
    '<th>Corredor</th><th class="rp-c rp-col-cat" title="Categoría del corredor">Cat.</th><th class="rp-col-equipo">Equipo</th>' +
    '<th class="rp-c" title="Pruebas que puntúan / pruebas disputadas">Pruebas</th><th class="rp-c">Puntos</th>' +
    '</tr></thead>' +
    `<tbody>${filas.join('') || '<tr><td colspan="7" class="rp-vacio">Sin resultados para esa búsqueda.</td></tr>'}</tbody></table>`;
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
  rpEstado.indiceBusqueda = rpConstruirIndice();
  const cats = rpEstado.ranking.categorias;
  if (!cats.find(c => c.key === rpEstado.categoria)) {
    // Estado inicial por defecto: "Todos los Cadetes". Si un año no hubiera
    // cadetes, cae a la primera categoría con corredores.
    rpEstado.categoria = (cats.find(c => c.key === 'cadete') || cats[0])?.key || null;
  }
  if (!cats.length) rpMostrarVacio(); else rpMostrarEstado('');
}

async function rpIniciar() {
  rpMostrarCargando();
  try {
    // Dos lecturas en paralelo: clasificaciones (ranking) y calendario
    // (pruebas planificadas con startlist). Si el calendario falla, el
    // ranking sigue funcionando sin él.
    const [rRanking, rCalendario, rAgenda] = await Promise.all([
      rpLeer(
        'races',
        'id, name, date, notes, race_results(pos, bib, name, team, cat, time, gap_seconds)',
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
    // Modo inicial por URL: ?modo=challenge (o mfpp).
    const modoParam = new URLSearchParams(location.search).get('modo');
    if (modoParam === 'challenge' || modoParam === 'mfpp') {
      rpEstado.modo = modoParam;
      rpRenderModo();
      rpRenderTabla();
    }
    // Vista inicial por URL: ?vista=equipos (o corredores).
    const vistaParam = new URLSearchParams(location.search).get('vista');
    if (vistaParam === 'equipos' || vistaParam === 'corredores') {
      // Pedir una vista del ranking implica entrar directamente al ranking
      rpEstado.pantalla = 'ranking';
      rpEstado.vista = vistaParam;
      rpRenderPantalla();
      rpRenderVista();
      rpRenderTabla();
    }
    // Enlace directo a la vista principal: ?pantalla=ranking|carreras
    const pantallaParam = new URLSearchParams(location.search).get('pantalla');
    if (pantallaParam === 'ranking' || pantallaParam === 'carreras') {
      rpEstado.pantalla = pantallaParam;
      rpRenderPantalla();
      if (pantallaParam === 'ranking') rpRenderTabla();
    }
    // Enlace directo a una prueba: ?carrera=<id> (disputada o del calendario).
    const carreraParam = new URLSearchParams(location.search).get('carrera');
    if (carreraParam) {
      if (rpCarreraPorId(carreraParam)) rpAbrirModalCarrera(carreraParam);
      else rpAbrirModalPlanificada(carreraParam);
    }
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
        rpRenderCalendario();
        rpRenderUltimos();
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

  document.getElementById('rp-region').addEventListener('change', e => {
    rpEstado.region = e.target.value;
    rpRenderPestanas();
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
    if (rpEstado.pantalla === 'ranking') rpRenderTabla();
    else rpRenderUltimos();
  });

  // "Ver más carreras" de la portada (los enlaces de las tarjetas van por
  // la delegación general de alClicEnlace)
  document.getElementById('rp-ultimos').addEventListener('click', e => {
    if (e.target.closest('.rp-ver-mas')) {
      rpEstado.ultimosVisibles += 10;
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

  rpIniciar();
});
