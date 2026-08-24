// ─────────────────────────────────────────────────────────────────────────
// Sube el calendario raspado (importar-calendario/salida.json) a Supabase
// `pruebas_federativas`. Dos modos:
//   --diff   (por defecto): SOLO LECTURA. Compara con lo que hay en vivo y
//            enseña añadidas / desaparecidas / nuevas incidencias. No escribe.
//   --apply  : hace BACKUP de la tabla, BORRA las futuras (fecha>=hoy) y mete
//            las raspadas. Necesita la clave de ESCRITURA en la variable de
//            entorno SUPABASE_SERVICE_KEY (no se guarda en git). Las pruebas
//            PASADAS (fecha<hoy) NO se tocan (quedan como histórico).
//
// Uso:
//   NODE_PATH=$(pwd)/node_modules node importar-calendario/upload.js --diff
//   SUPABASE_SERVICE_KEY=... node importar-calendario/upload.js --apply
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const SUPA = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const ANON = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';
const TABLE = 'pruebas_federativas';
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

// Normaliza quitando acentos Y puntuación (comillas, guiones…) → así casan
// "LXXXI Gran Premio «fiestas…»" y "LXXXI GRAN PREMIO FIESTAS…".
const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
// Clave por federación + fecha + primeras palabras del nombre (el formato viejo
// a veces concatena el nombre con info extra; comparar por prefijo reduce
// falsos "desaparecidos").
const primeras = (s, n=5) => norm(s).split(' ').filter(Boolean).slice(0, n).join(' ');
const clave = r => `${norm(r.federacion)}|${r.fecha}|${primeras(r.prueba)}`;

async function leerTabla(){
  // paginado (Supabase corta a 1000)
  const out = [];
  for(let off = 0; ; off += 1000){
    const url = `${SUPA}/rest/v1/${TABLE}?select=*&order=fecha.asc&limit=1000&offset=${off}`;
    const res = await fetch(url, { headers: { apikey: ANON, Authorization: 'Bearer '+ANON } });
    if(!res.ok) throw new Error('lectura Supabase '+res.status+' '+await res.text());
    const chunk = await res.json();
    out.push(...chunk);
    if(chunk.length < 1000) break;
  }
  return out;
}

function calcularDiff(scrape, actual, fedFilter){
  let futActual = actual.filter(r => r.fecha && r.fecha >= HOY);
  if(fedFilter) futActual = futActual.filter(r => r.federacion === fedFilter);
  const mapAct = new Map(futActual.map(r => [clave(r), r]));
  const mapNew = new Map(scrape.map(r => [clave(r), r]));
  const anadidas = scrape.filter(r => !mapAct.has(clave(r)));
  const desaparecidas = futActual.filter(r => !mapNew.has(clave(r)));
  const incidencias = [];   // estaban activas y ahora anulada/aplazada
  for(const [k, r] of mapNew){
    const a = mapAct.get(k);
    if(a && a.estado === 'activa' && r.estado !== 'activa') incidencias.push({ ...r, antes: a.estado });
  }
  return { futActual, anadidas, desaparecidas, incidencias };
}

function pintaLista(titulo, arr, n=25){
  console.log(`\n${titulo} (${arr.length})`);
  arr.slice(0, n).forEach(r => console.log(`  · ${r.fecha} · ${r.federacion} · ${r.prueba}${r.estado&&r.estado!=='activa'?' ['+r.estado+']':''}`));
  if(arr.length > n) console.log(`  … y ${arr.length - n} más`);
}

async function main(){
  const modo = process.argv.includes('--apply') ? 'apply' : 'diff';
  // --fed "C. Valenciana": actualizar SOLO esa federación (no toca las demás)
  const fedIdx = process.argv.indexOf('--fed');
  const fedFilter = (fedIdx>=0 && process.argv[fedIdx+1]) ? process.argv[fedIdx+1] : null;

  let scrape = JSON.parse(fs.readFileSync(path.join(__dirname, 'salida.json'), 'utf8'));
  if(fedFilter){ scrape = scrape.filter(r => r.federacion === fedFilter); }
  console.log(`Raspadas: ${scrape.length} pruebas futuras (desde ${HOY})${fedFilter?` · SOLO ${fedFilter}`:''}.`);
  console.log('Leyendo la tabla actual de Supabase…');
  const actual = await leerTabla();
  console.log(`Tabla actual: ${actual.length} filas (${actual.filter(r=>r.fecha>=HOY).length} futuras).`);

  const { anadidas, desaparecidas, incidencias } = calcularDiff(scrape, actual, fedFilter);
  console.log('\n════════════════  CAMBIOS respecto a lo que hay en vivo  ════════════════');
  pintaLista('🟢 NUEVAS (no estaban)', anadidas);
  pintaLista('🔴 DESAPARECIDAS (estaban y ya no)', desaparecidas);
  pintaLista('🟠 NUEVAS INCIDENCIAS (activa → anulada/aplazada)', incidencias);
  console.log(`\nResumen: +${anadidas.length} nuevas · -${desaparecidas.length} desaparecidas · ${incidencias.length} incidencias`);

  if(modo === 'diff'){
    console.log('\n(Modo lectura. Para aplicar: SUPABASE_SERVICE_KEY=… node importar-calendario/upload.js --apply)');
    return;
  }

  // ── modo apply ──
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if(!KEY){ console.error('\n❌ Falta SUPABASE_SERVICE_KEY (clave de escritura). Abortado.'); process.exit(1); }

  // 1) BACKUP de toda la tabla
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const backupFile = path.join(backupDir, `pruebas_federativas-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(actual, null, 2));
  console.log(`\n💾 Backup de ${actual.length} filas → ${path.relative(process.cwd(), backupFile)}`);

  const h = { apikey: KEY, Authorization: 'Bearer '+KEY, 'Content-Type': 'application/json' };

  // 2) BORRAR las futuras (fecha >= hoy); las pasadas se conservan.
  //    Con --fed, SOLO las de esa federación (las demás no se tocan).
  let delUrl = `${SUPA}/rest/v1/${TABLE}?fecha=gte.${HOY}`;
  if(fedFilter) delUrl += `&federacion=eq.${encodeURIComponent(fedFilter)}`;
  console.log(`🗑️  Borrando futuras (fecha >= ${HOY})${fedFilter?` de ${fedFilter}`:''}…`);
  const del = await fetch(delUrl, { method: 'DELETE', headers: h });
  if(!del.ok){ console.error('❌ DELETE falló:', del.status, await del.text()); process.exit(1); }

  // 3) INSERTAR las raspadas (en lotes de 500) con actualizado = ahora
  const ahora = new Date().toISOString();
  // Deduplicar por la clave ÚNICA de la tabla (federacion, prueba, fecha):
  // el raspado puede traer la misma prueba repetida y violaría la constraint.
  const vistas = new Set();
  const filas = [];
  let dup = 0;
  for(const r of scrape){
    const k = r.federacion + '|' + r.prueba + '|' + r.fecha;
    if(vistas.has(k)){ dup++; continue; }
    vistas.add(k);
    filas.push({
      federacion: r.federacion, prueba: r.prueba, fecha: r.fecha,
      localidad: r.localidad, provincia: r.provincia, modalidad: r.modalidad,
      categorias: r.categorias, sexo: r.sexo, observaciones: r.observaciones,
      estado: r.estado, fuente: r.fuente || '',
      club: r.club || '', clase: r.clase || '', hora: r.hora || '',
      actualizado: ahora
    });
  }
  if(dup) console.log(`  (descartados ${dup} duplicados internos por federación+prueba+fecha)`);
  for(let i = 0; i < filas.length; i += 500){
    const lote = filas.slice(i, i+500);
    const ins = await fetch(`${SUPA}/rest/v1/${TABLE}`, { method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(lote) });
    if(!ins.ok){ console.error(`❌ INSERT lote ${i} falló:`, ins.status, await ins.text()); process.exit(1); }
    console.log(`  ✓ insertadas ${Math.min(i+500, filas.length)}/${filas.length}`);
  }
  console.log('\n✅ Calendario actualizado. La web lo reflejará en el próximo acceso.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
