/* ============================================================
   MOTOR DE CÁLCULO DEL RANKING (versión Node, sin DOM)
   ------------------------------------------------------------
   RÉPLICA EXACTA del motor de ranking/ranking-publico.js (mismas
   constantes y misma lógica) para poder calcular el ranking en el
   build y generar páginas SEO con los puestos y puntos idénticos a
   los del ranking interactivo.
   ⚠️ Si se cambia el cálculo en ranking-publico.js, hay que reflejarlo
   aquí (y viceversa). Un test compara ambos para detectar desajustes.
   ============================================================ */
'use strict';

const RP_PUNTOS_BASE = {
  1: 100, 2: 80, 3: 65, 4: 55, 5: 48, 6: 42, 7: 36, 8: 32, 9: 28, 10: 24,
  11: 21, 12: 18, 13: 15, 14: 13, 15: 11, 16: 9, 17: 7, 18: 5, 19: 3, 20: 1
};
const RP_PUNTOS_ETAPA = {
  1: 50, 2: 40, 3: 33, 4: 28, 5: 24, 6: 21, 7: 18, 8: 16, 9: 14, 10: 12,
  11: 11, 12: 9, 13: 8, 14: 7, 15: 6, 16: 5, 17: 4, 18: 3, 19: 2, 20: 1
};
const RP_BONO_FINALIZAR = 3;
// Plus FIJO por ganar/subir al podio de la general de una vuelta (además de
// los 100/80/65… × coef). Debe coincidir con ranking-publico.js.
const RP_BONO_GENERAL = { 1: 30, 2: 20, 3: 10 };
const RP_MAX_RESULTADOS_CONTADOS = 12;
const RP_COEFICIENTES = { ordinaria: 1.00, challenge: 1.30, fuera_cv: 1.35 };
const RP_PAISES = new Set([
  'belgica', 'portugal', 'paises bajos', 'francia', 'italia', 'alemania',
  'reino unido', 'suiza', 'andorra'
]);
const RP_COEF_PARTICIPACION = { internacional: 1.20, nacional: 1.10 };
const RP_RE_ETAPA = /etapa/i;
const RP_CCAA_CV = new Set([
  '', 'comunitat valenciana', 'comunidad valenciana', 'c valenciana', 'cv',
  'valencia', 'pais valenciano', 'pais valencia'
]);
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
function rpNormalizarTexto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function rpGrupoCategoria(cat) {
  const s = String(cat || '');
  if (/^\s*f[-\s.]?(cad|jun|juv|elit|sub|mast|inf|alev)/i.test(s) || /femen|f[eé]mina|mujer|dones/i.test(s)) {
    return 'fem';
  }
  for (const g of RP_GRUPOS_CATEGORIA) { if (g.re.test(s)) return g.key; }
  return null;
}
function rpEsFueraCV(ccaa) { return !RP_CCAA_CV.has(rpNormalizarTexto(ccaa)); }

function rpNivelParticipacion(carrera) {
  const total = carrera.resultados.length;
  if (!total) return { nivel: null, coef: 1 };
  let fuera = 0, extranjeros = 0;
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
function rpTipoCarrera(carrera) {
  if (RP_RE_ETAPA.test(carrera.nombre || '')) return 'etapa';
  if (carrera.challengeCV === true) return 'challenge';
  if (rpEsFueraCV(carrera.ccaa)) return 'fuera_cv';
  return 'ordinaria';
}
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
    const bonoPodio = RP_BONO_GENERAL[p] || 0;   // plus por ganar/podio de la vuelta
    const puntos = Math.round((base * coefPart + bonoPodio) * 100) / 100;
    return { base, coef: coefPart, bono: bonoPodio, puntos };
  }
  const base = RP_PUNTOS_BASE[p] || 0;
  const coef = tipo === 'ordinaria' ? coefPart : (RP_COEFICIENTES[tipo] ?? 1);
  const puntos = Math.round((base * coef + RP_BONO_FINALIZAR) * 100) / 100;
  return { base, coef, bono: RP_BONO_FINALIZAR, puntos };
}
function rpTemporada(fechaISO) {
  const a = parseInt(String(fechaISO || '').slice(0, 4), 10);
  return Number.isFinite(a) ? a : null;
}
function rpFormatearGap(segundos) {
  const t = Math.round(segundos);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}
function rpFormatearPuntos(n) {
  return Math.ceil(Math.round(n * 100) / 100).toLocaleString('es-ES');
}

function rpAdaptarCarreras(filas) {
  return (filas || []).map(r => {
    let extra = {};
    try { extra = JSON.parse(r.notes || '{}') || {}; } catch (_) { extra = {}; }
    const regiones = {};
    const rawRegs = extra.regions || {};
    for (const k in rawRegs) {
      const v = String(rawRegs[k] || '').trim();
      if (v) regiones[rpNormalizarClave(k)] = v;
    }
    const carrera = {
      id: r.id, nombre: r.name || '', fecha: r.date || '', temporada: rpTemporada(r.date),
      challengeCV: extra.challengeCV === true, ccaa: extra.ccaa || '',
      localidad: extra.localidad || '', km: extra.km || '', regiones,
      ruta: (extra.route && typeof extra.route === 'object') ? extra.route : null,
      resultados: (r.race_results || []).map(x => ({
        pos: x.pos, nombre: x.name || '', equipo: x.team || '', cat: x.cat || '',
        bib: x.bib ?? '', tiempo: x.time || '',
        gap: Number.isFinite(x.gap_seconds) ? x.gap_seconds : null,
        segundosTotales: Number.isFinite(x.total_seconds) ? x.total_seconds : null
      }))
    };
    // General OFICIAL de una vuelta subida a mano (casilla en Carga y Resumen):
    // se trata/etiqueta como 'general' y hace que la calculada por tiempos se
    // descarte sola. Debe ir sincronizado con ranking-publico.js.
    carrera.generalOficial = extra.generalOficial === true;
    carrera.tipo = carrera.generalOficial ? 'general' : rpTipoCarrera(carrera);
    carrera.participacion = (carrera.generalOficial && rpEsFueraCV(carrera.ccaa))
      ? { nivel: null, coef: RP_COEFICIENTES.fuera_cv }
      : rpNivelParticipacion(carrera);
    return carrera;
  }).filter(c => c.temporada !== null);
}

function rpSintetizarGenerales(carreras) {
  const grupos = new Map();
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
    if ((new Date(ultima.fecha) - new Date(primera.fecha)) / 864e5 > 10) continue;
    const hayOficial = carreras.some(o => o.tipo !== 'etapa' &&
      o.temporada === primera.temporada && rpNormalizarTexto(o.nombre).includes(claveVuelta));
    if (hayOficial) continue;
    if (!etapas.every(e => e.c.resultados.some(r => Number.isFinite(r.segundosTotales)))) continue;
    const acum = new Map();
    etapas.forEach(({ c }, i) => {
      for (const r of c.resultados) {
        const pos = parseInt(r.pos, 10);
        if (!Number.isFinite(pos) || pos <= 0 || !Number.isFinite(r.segundosTotales)) continue;
        const clave = rpNormalizarClave(r.nombre);
        if (!clave) continue;
        if (i === 0) acum.set(clave, { seg: r.segundosTotales, n: 1, r });
        else { const a = acum.get(clave); if (a && a.n === i) { a.seg += r.segundosTotales; a.n++; a.r = r; } }
      }
    });
    const gc = [...acum.values()].filter(a => a.n === etapas.length).sort((x, y) => x.seg - y.seg);
    if (gc.length < 2) continue;
    const lider = gc[0].seg;
    const regiones = Object.assign({}, ...etapas.map(e => e.c.regiones));
    const carrera = {
      id: 'general-' + ultima.id, nombre: 'General — ' + etapas[etapas.length - 1].display,
      fecha: ultima.fecha, temporada: ultima.temporada, challengeCV: false,
      ccaa: ultima.ccaa || '', localidad: '', km: '', regiones, ruta: null, esGeneral: true,
      resultados: gc.map((a, i) => ({
        pos: i + 1, nombre: a.r.nombre, equipo: a.r.equipo, cat: a.r.cat, bib: '',
        tiempo: i === 0 ? rpFormatearGap(a.seg) : '', gap: Math.round((a.seg - lider) * 100) / 100,
        segundosTotales: a.seg
      }))
    };
    carrera.tipo = 'general';
    carrera.participacion = rpEsFueraCV(carrera.ccaa)
      ? { nivel: null, coef: RP_COEFICIENTES.fuera_cv }
      : rpNivelParticipacion(carrera);
    generales.push(carrera);
  }
  return generales;
}

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

function calcularRankingPublico(carreras, { temporada, hastaFecha } = {}) {
  const temporadasDisponibles = [...new Set(carreras.map(c => c.temporada))].sort((x, y) => y - x);
  const anyo = temporada != null ? temporada : (temporadasDisponibles[0] != null ? temporadasDisponibles[0] : null);
  const delAnyo = carreras.filter(c => c.temporada === anyo && (!hastaFecha || c.fecha < hastaFecha));
  const porCorredor = new Map();
  for (const carrera of delAnyo) {
    for (const res of carrera.resultados) {
      const clave = rpNormalizarClave(res.nombre);
      if (!clave) continue;
      if (!porCorredor.has(clave)) porCorredor.set(clave, []);
      const pts = rpPuntosResultado(res.pos, carrera.tipo, carrera.participacion.coef);
      porCorredor.get(clave).push({
        raceId: carrera.id, carrera: carrera.nombre, fecha: carrera.fecha,
        pos: (Number.isFinite(parseInt(res.pos, 10)) && parseInt(res.pos, 10) > 0) ? parseInt(res.pos, 10) : null,
        tipo: carrera.tipo, base: pts.base, coef: pts.coef, bono: pts.bono, puntos: pts.puntos,
        contado: false, motivoNoContado: null,
        _nombre: res.nombre, _equipo: res.equipo, _cat: res.cat, _region: carrera.regiones[clave] || ''
      });
    }
  }
  const corredores = [];
  for (const [clave, resultados] of porCorredor) {
    resultados.sort((x, y) => (y.fecha || '').localeCompare(x.fecha || ''));
    const puntuables = resultados.filter(r => r.puntos > 0).sort((x, y) => y.puntos - x.puntos);
    puntuables.forEach((r, i) => {
      if (i < RP_MAX_RESULTADOS_CONTADOS) r.contado = true;
      else r.motivoNoContado = 'fuera_top12';
    });
    resultados.forEach(r => { if (!r.contado && !r.motivoNoContado) r.motivoNoContado = r.puntos > 0 ? 'fuera_top12' : 'sin_posicion'; });
    const contados = resultados.filter(r => r.contado);
    const puntosTotales = Math.round(contados.reduce((s, r) => s + r.puntos, 0) * 100) / 100;
    if (puntosTotales === 0) continue;
    const votos = new Map();
    for (const r of resultados) { const g = rpGrupoCategoria(r._cat); if (g) votos.set(g, (votos.get(g) || 0) + 1); }
    let categoria = 'otros';
    if (votos.size) {
      const max = Math.max(...votos.values());
      const empatados = [...votos.entries()].filter(([, n]) => n === max).map(([g]) => g);
      categoria = empatados.length === 1 ? empatados[0]
        : (resultados.map(r => rpGrupoCategoria(r._cat)).find(g => empatados.includes(g)) || empatados[0]);
    }
    const votosReg = new Map();
    for (const r of resultados) {
      if (!r._region) continue;
      const k = rpNormalizarTexto(r._region);
      const e = votosReg.get(k) || { n: 0, display: r._region };
      e.n++; votosReg.set(k, e);
    }
    let region = '';
    if (votosReg.size) {
      const maxReg = Math.max(...[...votosReg.values()].map(e => e.n));
      const empatadosReg = [...votosReg.entries()].filter(([, e]) => e.n === maxReg);
      if (empatadosReg.length === 1) region = empatadosReg[0][1].display;
      else {
        const claves = new Set(empatadosReg.map(([k]) => k));
        const rec = resultados.find(r => r._region && claves.has(rpNormalizarTexto(r._region)));
        region = rec ? votosReg.get(rpNormalizarTexto(rec._region)).display : empatadosReg[0][1].display;
      }
    }
    const conteoPuestos = new Array(20).fill(0);
    for (const r of contados) { if (r.pos >= 1 && r.pos <= 20) conteoPuestos[r.pos - 1]++; }
    const masReciente = resultados[0];
    const subcats = [...new Set(resultados.map(r => String(r._cat || '').trim().toUpperCase()).filter(Boolean))];
    const votosSub = new Map();
    for (const r of resultados) { const s = String(r._cat || '').trim().toUpperCase(); if (s) votosSub.set(s, (votosSub.get(s) || 0) + 1); }
    let subcatPrincipal = '';
    if (votosSub.size) {
      const maxSub = Math.max(...votosSub.values());
      subcatPrincipal = resultados.map(r => String(r._cat || '').trim().toUpperCase()).find(s => s && votosSub.get(s) === maxSub) || '';
    }
    corredores.push({
      clave, nombre: masReciente._nombre, equipo: masReciente._equipo, categoria, subcats, subcatPrincipal,
      region, puntosTotales, pruebasContadas: contados.length, pruebasTotales: resultados.length, conteoPuestos,
      resultados: resultados.map(({ _nombre, _equipo, _cat, _region, ...r }) => r)
    });
  }
  const categorias = [];
  for (const g of [...RP_GRUPOS_CATEGORIA, RP_GRUPO_OTROS]) {
    const lista = corredores.filter(c => c.categoria === g.key).sort(rpCompararCorredores);
    if (lista.length) categorias.push({ key: g.key, label: g.label, corredores: lista });
  }
  return { temporada: anyo, temporadasDisponibles, categorias };
}

// API pública del módulo: recibe las filas crudas de Supabase (races +
// race_results) y devuelve el ranking igual que el widget (adaptar →
// concatenar generales → calcular).
function calcularRanking(filas) {
  let carreras = rpAdaptarCarreras(filas);
  carreras = carreras.concat(rpSintetizarGenerales(carreras));
  return calcularRankingPublico(carreras, {});
}

module.exports = {
  calcularRanking,
  rpFormatearPuntos, rpNormalizarTexto, rpEsFueraCV, rpNormalizarClave,
  rpRepararMojibake, RP_GRUPOS_CATEGORIA, RP_GRUPO_OTROS
};
