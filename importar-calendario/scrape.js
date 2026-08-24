// ─────────────────────────────────────────────────────────────────────────
// Scraper del calendario federativo (sistema "smartweb" de 16 federaciones +
// Cataluña aparte). Lee la web renderizada con Chrome (playwright-core),
// bloqueando el redirect-a-Error con retardo (anti-scrape). Devuelve filas
// normalizadas al formato de la tabla Supabase `pruebas_federativas`.
//
// NO sube nada: solo raspa y normaliza. La subida va en upload.js.
// Uso:  NODE_PATH=$(pwd)/node_modules node importar-calendario/scrape.js [fed]
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const { chromium } = require('playwright-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// URLs de calendario (temporada en curso, desde hoy hacia delante) por federación.
const FEDS = {
  'Andalucía':          'https://andaluciaciclismo.com/es/smartweb/seccion/calendario/andalucia/2026',
  'Aragón':             'https://aragonciclismo.com/index.php/es/smartweb/seccion/calendario/aragon/2026',
  'Asturias':           'https://ciclismoasturiano.es/es/smartweb/seccion/calendario/asturias/2026',
  'Baleares':           'https://webfcib.es/es/smartweb/seccion/calendario/baleares/2026',
  'Canarias':           'https://ciclismocanario.es/index.php/es/smartweb/seccion/calendario/canarias/2026',
  'Cantabria':          'https://fcciclismo.com/index.php/es/smartweb/seccion/calendario/cantabria/2026',
  'Castilla-La Mancha': 'https://yosoyciclista.com/index.php/es/smartweb/seccion/calendario/castillalamancha/2026',
  'Castilla y León':    'https://fedciclismocyl.com/es/smartweb/seccion/calendario/castillaleon/2026',
  'Madrid':             'https://fmciclismo.com/es/smartweb/seccion/calendario/madrid/2026',
  'C. Valenciana':      'https://fccv.es/index.php/es/smartweb/seccion/calendario/valenciana/2026',
  'Euskadi':            'https://fvascicli.eus/index.php/es/smartweb/seccion/calendario/euskadi/2026',
  'Extremadura':        'https://ciclismoextremadura.es/es/smartweb/seccion/calendario/extremadura/2026',
  'Galicia':            'https://fgalegaciclismo.es/es/smartweb/seccion/calendario/galicia/2026',
  'La Rioja':           'https://yosoyciclista.com/index.php/es/smartweb/seccion/calendario/larioja/2026',
  'Murcia':             'https://yosoyciclista.com/index.php/es/smartweb/seccion/calendario/murcia/2026',
  'Navarra':            'https://fnciclismo.es/es/smartweb/seccion/calendario/navarra/2026'
  // Cataluña: web distinta (ciclisme.cat), se maneja aparte más adelante.
};

// ── Normalización de datos ────────────────────────────────────────────────
const _norm = s => String(s||'').replace(/\s+/g,' ').trim();

// Timestamp Unix (seg) → fecha ISO YYYY-MM-DD en horario de España.
function tsToISO(ts){
  const n = parseInt(ts, 10);
  if(!Number.isFinite(n) || n <= 0) return '';
  return new Date(n*1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
}

// "DD/MM/YYYY" → "YYYY-MM-DD" (Cataluña no trae timestamp oculto)
function ddmmyyyyToISO(s){
  const m = String(s||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m) return '';
  return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

// Categorías del texto de la web → set canónico {escuelas,cadete,junior,sub23,elite,master}
function parseCategorias(txt){
  const t = ' ' + String(txt||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'') + ' ';
  const out = [];
  // incluye variantes en catalán (cadet, elit, promocio, master)
  if(/escuela|escola|alevin|infantil|principiante|promesa|promocio|benjamin|prebenjamin|iniciacion/.test(t)) out.push('escuelas');
  if(/cadet/.test(t)) out.push('cadete');
  if(/junior|juvenil/.test(t)) out.push('junior');
  if(/sub[\s-]?23/.test(t)) out.push('sub23');
  if(/elit|open|absolut/.test(t)) out.push('elite');
  if(/master|veteran|m30|m40|m50/.test(t)) out.push('master');
  return [...new Set(out)];
}
// Sexo M/F/MF a partir del texto de categorías. hasF = hay marca femenina;
// hasM = hay alguna categoría SIN esa marca (o no hay ninguna marca fem).
function parseSexo(txt){
  const t = String(txt||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const hasF = /fem|femenin|mujer/.test(t);
  const tokens = t.split(/[,\/;]/);
  const hasM = tokens.some(tok => /cadete|junior|juvenil|sub|elite|master|open|escuela|alevin|infantil|absolut|veteran/.test(tok) && !/fem|femenin|mujer/.test(tok)) || !hasF;
  if(hasF && hasM) return 'MF';
  if(hasF) return 'F';
  return 'M';
}
// Modalidad del texto de la web → una de las 8 canónicas de la tabla.
function normModalidad(m){
  const t = String(m||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  if(/ciclo\s*-?\s*cros{1,2}|cyclocross/.test(t)) return 'Ciclocross';   // "ciclocròs" catalán (1 s)
  if(/pump\s*track/.test(t)) return 'BMX';
  if(/\bbmx\b/.test(t)) return 'BMX';
  if(/gravel/.test(t)) return 'Gravel';
  if(/\bpista\b|velodrom|track/.test(t)) return 'Pista';
  if(/\btrial\b/.test(t)) return 'Trial';
  if(/btt|mtb|mountain|xco|xcm|xco|enduro|descenso|\bdh\b|maraton/.test(t)) return 'BTT';
  if(/ciclismo para todos|cicloturis|cicloturista|\bmarcha|ciclodep|para todos/.test(t)) return 'Cicloturismo';
  // Carretera y sus variantes/jergas por federación (Galicia "Estrada", escuelas,
  // criteriums, circuitos urbanos, tecnificación, categorías sueltas, etc.)
  if(/carretera|ruta|road|estrada|escuela|circuito urbano|criterium|criteri|promocion|tecnificacion|colectivos|intersociales|judex|feminas|paralimpic|adaptad/.test(t)) return 'Carretera';
  return 'Carretera';   // por defecto: la mayoría de lo no reconocido es ruta
}
// Estado: activa / aplazada / anulada, detectado en el texto/clase de la fila.
function parseEstado(rowText, rowClass){
  const t = (String(rowText||'') + ' ' + String(rowClass||'')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  if(/anulad|suspendid|cancelad/.test(t)) return 'anulada';
  if(/aplazad|pospuesto|pospuesta/.test(t)) return 'aplazada';
  return 'activa';
}
// "LOCALIDAD (PROVINCIA)" → { localidad, provincia }
function parseLugar(txt){
  const s = _norm(txt);
  const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if(m) return { localidad: _norm(m[1]), provincia: _norm(m[2]) };
  return { localidad: s, provincia: '' };
}

// ── Raspado de una federación smartweb ────────────────────────────────────
async function scrapeSmartweb(browser, fed, url){
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    locale: 'es-ES'
  });
  const page = await ctx.newPage();
  await page.route('**/show_error_frontend/**', r => r.abort());   // matar el redirect anti-scrape
  const rows = [];
  try{
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(()=>{});
    const raw = await page.evaluate(() => {
      // elegir la tabla que tenga cabecera FECHA/PRUEBA
      const tables = [...document.querySelectorAll('table')];
      const tbl = tables.find(t => /FECHA/i.test(t.innerText) && /PRUEBA/i.test(t.innerText)) || tables[0];
      if(!tbl) return [];
      return [...tbl.querySelectorAll('tbody tr')].map(tr => {
        const tds = [...tr.querySelectorAll('td')];
        const cell = i => tds[i] ? tds[i].innerText.replace(/\s+/g,' ').trim() : '';
        // timestamp oculto en la 1ª celda (fecha exacta)
        const hidden = tds[0] ? tds[0].querySelector('div[style*="display:none"]') : null;
        const ts = hidden ? hidden.textContent.trim() : '';
        // Enlace "MÁS" → ficha de la prueba (tiene TODAS las categorías, sin recortar)
        const mas = tr.querySelector('a[href*="prueba"]');
        return {
          ts,
          fechaTxt: cell(0), modalidad: cell(1), categorias: cell(2),
          clase: cell(3), prueba: cell(4), lugar: cell(5),
          club: cell(6), observaciones: cell(7),
          masUrl: mas ? mas.href : '',
          rowText: tr.innerText.replace(/\s+/g,' ').trim(), rowClass: tr.className || ''
        };
      });
    });
    for(const r of raw){
      const prueba = _norm(r.prueba);
      if(!prueba) continue;                       // filas vacías / de control
      const { localidad, provincia } = parseLugar(r.lugar);
      rows.push({
        federacion: fed,
        prueba,
        fecha: tsToISO(r.ts) || '',
        localidad, provincia,
        modalidad: normModalidad(r.modalidad) || 'Carretera',
        categorias: parseCategorias(r.categorias).join(','),
        sexo: parseSexo(r.categorias),
        club: _norm(r.club),              // organizador / club (celda 6 de la tabla)
        clase: _norm(r.clase),            // clase/nivel de la prueba (celda 3): "6.2", "10.4"…
        hora: '',                          // (se rellena en enrichCategorias desde la ficha, si está)
        observaciones: _norm(r.observaciones),
        estado: parseEstado(r.rowText, r.rowClass),
        _rawCat: r.categorias || '',      // texto de la tabla (puede venir recortado con "…")
        _masUrl: r.masUrl || ''           // ficha para sacar TODAS las categorías
      });
    }
  } catch(e){
    console.error(`  ⚠️  ${fed}: ${e.message}`);
  } finally {
    await ctx.close();
  }
  return rows;
}

// ── Raspado de Cataluña (ciclisme.cat, web distinta) ──────────────────────
// El calendario "tot" (todas las modalidades) está paginado (10 filas/página)
// y arranca en el día de hoy. Recorremos páginas hasta que no haya filas.
async function scrapeCataluna(browser){
  const ctx = await browser.newContext({ locale: 'ca-ES' });
  const page = await ctx.newPage();
  const rows = [];
  const vistos = new Set();
  try{
    for(let p = 0; p <= 40; p++){   // ¡empezar en 0! la página base (?page=0) trae las más próximas
      const url = `https://www.ciclisme.cat/calendari/tot?page=${p}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(600);
      const raw = await page.evaluate(() => {
        const tbl = document.querySelector('table'); if(!tbl) return [];
        return [...tbl.querySelectorAll('tbody tr')].map(tr => {
          const tds = [...tr.querySelectorAll('td')];
          const lines = i => tds[i] ? tds[i].innerText.split('\n').map(s=>s.trim()).filter(Boolean) : [];
          return { data: lines(0)[0]||'', cursa: lines(1), lloc: lines(2), moda: lines(3) };
        });
      });
      if(!raw.length) break;
      let nuevos = 0;
      for(const r of raw){
        const prueba = _norm(r.cursa[0]||'');
        const fecha = ddmmyyyyToISO(r.data);
        if(!prueba || !fecha) continue;
        const clave = fecha + '|' + prueba.toLowerCase();
        if(vistos.has(clave)) continue;      // fin de paginación (se repite)
        vistos.add(clave); nuevos++;
        const especialitat = r.moda[1] || '';
        rows.push({
          federacion: 'Cataluña',
          prueba,
          fecha,
          localidad: _norm(r.lloc[0]||''),
          provincia: _norm(r.lloc[1]||''),
          modalidad: normModalidad(r.moda[0]||'') || 'Carretera',
          categorias: parseCategorias(especialitat).join(','),
          sexo: parseSexo(especialitat),
          club: '', clase: '', hora: '',                        // ciclisme.cat no da estos campos
          observaciones: _norm(r.cursa.slice(1).join(' · ')),   // Copa/Campionat en 2ª línea
          estado: parseEstado(r.cursa.join(' '), '')
        });
      }
      if(nuevos === 0) break;   // página repetida → hemos llegado al final
    }
  } catch(e){
    console.error(`  ⚠️  Cataluña: ${e.message}`);
  } finally { await ctx.close(); }
  return rows;
}

// ── Enriquecer categorías recortadas ──────────────────────────────────────
// Las webs recortan la columna Categorías ("Elite, Elite Fem., Junior…").
// Para las recortadas, abrimos su ficha (enlace "MÁS", HTML servido, sin JS)
// y sacamos TODAS las categorías. Así el filtro por categoría es fiable.
function _estaRecortada(txt){ return /(\.\.\.|…)\s*$/.test(String(txt||'')); }
// Abre la ficha (HTML servido, sin JS) y saca las categorías COMPLETAS y la
// HORA de salida. Devuelve { cats, hora }.
async function _fetchFicha(url){
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
    signal: AbortSignal.timeout(20000)
  });
  if(!res.ok) return { cats: '', hora: '' };
  const html = await res.text();
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const mc = text.match(/Categor[ií]as?\s*:?\s*(.+?)\s*(?:Lugar\b|Fecha\b|Hora\b|Organizador\b|INFORMACI[OÓ]N DE LA INSCRIP)/i);
  // "Hora Salida: 10:30" (a veces "Hora de salida"). Evitamos la hora de recogida de dorsales.
  const mh = text.match(/Hora\s*(?:de\s*)?Salida\s*:?\s*(\d{1,2}[:.]\d{2})/i);
  return { cats: mc ? mc[1].trim() : '', hora: mh ? mh[1].replace('.', ':') : '' };
}
async function enrichCategorias(rows){
  // Abrimos la ficha de TODA prueba con enlace "MÁS": completa categorías
  // recortadas Y captura la hora de salida.
  const targets = rows.filter(r => r._masUrl);
  if(!targets.length) return;
  console.error(`  Abriendo ficha de ${targets.length} pruebas (categorías completas + hora)…`);
  let i = 0, done = 0, changed = 0, conHora = 0;
  async function worker(){
    while(i < targets.length){
      const r = targets[i++];
      try{
        const fic = await _fetchFicha(r._masUrl);
        if(_estaRecortada(r._rawCat) && fic.cats){
          const cats = parseCategorias(fic.cats);
          if(cats.length){
            const before = r.categorias;
            r.categorias = cats.join(',');
            r.sexo = parseSexo(fic.cats);
            if(r.categorias !== before) changed++;
          }
        }
        if(fic.hora){ r.hora = fic.hora; conHora++; }
      }catch(e){ /* si falla, se queda con lo que había */ }
      done++;
      if(done % 50 === 0) console.error(`    …${done}/${targets.length}`);
    }
  }
  const N = Math.min(8, targets.length);
  await Promise.all(Array.from({ length: N }, worker));
  console.error(`  ✓ fichas abiertas · ${changed} categorías ampliadas · ${conHora} con hora`);
}

async function main(){
  const only = process.argv[2];   // opcional: nombre de una federación
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const all = [];
  const targets = only ? (FEDS[only] ? { [only]: FEDS[only] } : {}) : FEDS;
  for(const [fed, url] of Object.entries(targets)){
    if(!url){ console.error(`  ✗ ${fed}: sin URL`); continue; }
    const rows = await scrapeSmartweb(browser, fed, url);
    console.error(`  ${rows.length ? '✓' : '✗'} ${fed.padEnd(20)} ${rows.length} pruebas`);
    all.push(...rows);
  }
  // Cataluña (salvo que se pida una federación concreta que no sea Cataluña)
  if(!only || only === 'Cataluña'){
    const cat = await scrapeCataluna(browser);
    console.error(`  ${cat.length ? '✓' : '✗'} ${'Cataluña'.padEnd(20)} ${cat.length} pruebas`);
    all.push(...cat);
  }
  await browser.close();
  // Solo futuras: descartar sin fecha o anteriores a hoy (por si alguna web cuela pasadas)
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const fut = all.filter(r => r.fecha && r.fecha >= hoy);
  // Completar las categorías recortadas (solo sobre las futuras, para no abrir de más)
  await enrichCategorias(fut);
  // Guardar el enlace "MÁS" como fuente (enlace directo a la prueba) y limpiar temporales
  fut.forEach(r => { r.fuente = r._masUrl || ''; delete r._rawCat; delete r._masUrl; });
  console.error(`\n  TOTAL: ${fut.length} pruebas futuras (descartadas ${all.length - fut.length} sin fecha/pasadas)`);
  process.stdout.write(JSON.stringify(fut, null, 2));
}

if(require.main === module) main();
module.exports = { scrapeSmartweb, FEDS, parseCategorias, parseSexo, parseEstado, tsToISO };
