const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Inyectar credenciales si están como variables de entorno (opcional)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (supabaseUrl) html = html.replace('%%SUPABASE_URL%%', supabaseUrl);
if (supabaseKey) html = html.replace('%%SUPABASE_KEY%%', supabaseKey);

// ── Cache busting ──
// Calcula un hash corto (8 hex) del contenido de cada asset y lo añade como
// ?v=HASH al final de la URL. Así, cuando despleguemos cambios, los navegadores
// descargarán automáticamente la versión nueva sin necesidad de que el usuario
// haga "hard refresh".
function shortHash(filePath){
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex').slice(0,8);
}
const cssHash = shortHash(path.join(__dirname, 'assets', 'css', 'styles.css'));
const jsHash  = shortHash(path.join(__dirname, 'assets', 'js', 'app.js'));
html = html.replace('assets/css/styles.css"', `assets/css/styles.css?v=${cssHash}"`);
html = html.replace('assets/js/app.js"',     `assets/js/app.js?v=${jsHash}"`);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html, 'utf8');

// ── Copiar carpeta assets/ (CSS/JS/imágenes externos) ──
// Fase 1 del refactor: el CSS se ha sacado a assets/css/styles.css.
function copyDirRecursive(src, dst){
  if(!fs.existsSync(src)) return;
  fs.mkdirSync(dst, {recursive:true});
  for(const entry of fs.readdirSync(src, {withFileTypes:true})){
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if(entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDirRecursive(path.join(__dirname, 'assets'), path.join(__dirname, 'dist', 'assets'));

// ── Publicar el ranking público (widget embebible en mfppcycling.com) ──
// Se copian solo los 3 archivos del widget (nunca ranking/backups/) y se
// aplica el mismo cache busting ?v=HASH que al resto de assets.
const rpDir = path.join(__dirname, 'ranking');
if (fs.existsSync(path.join(rpDir, 'ranking-publico.html'))) {
  const rpDst = path.join(__dirname, 'dist', 'ranking');
  fs.mkdirSync(rpDst, { recursive: true });
  const rpCssHash = shortHash(path.join(rpDir, 'ranking-publico.css'));
  const rpJsHash  = shortHash(path.join(rpDir, 'ranking-publico.js'));
  let rpHtml = fs.readFileSync(path.join(rpDir, 'ranking-publico.html'), 'utf8');
  rpHtml = rpHtml.replace('ranking-publico.css"', `ranking-publico.css?v=${rpCssHash}"`);
  rpHtml = rpHtml.replace('ranking-publico.js"',  `ranking-publico.js?v=${rpJsHash}"`);
  fs.writeFileSync(path.join(rpDst, 'ranking-publico.html'), rpHtml, 'utf8');
  fs.copyFileSync(path.join(rpDir, 'ranking-publico.css'), path.join(rpDst, 'ranking-publico.css'));
  fs.copyFileSync(path.join(rpDir, 'ranking-publico.js'),  path.join(rpDst, 'ranking-publico.js'));
  // Script que ejecuta mfppcycling.com (URL estable, sin ?v=: se sirve
  // con no-cache, así los cambios llegan sin tocar el bloque de WordPress)
  fs.copyFileSync(path.join(rpDir, 'embed.js'), path.join(rpDst, 'embed.js'));
  // Banderas de comunidades autónomas (PNG estáticos, caché larga en _headers)
  copyDirRecursive(path.join(rpDir, 'banderas'), path.join(rpDst, 'banderas'));
  console.log(`✅ Ranking público → dist/ranking/ (css=${rpCssHash}, js=${rpJsHash})`);
}

// Copiar el archivo _headers de Netlify (control de cabeceras HTTP, más
// predecible que netlify.toml para reglas de Cache-Control).
const headersSrc = path.join(__dirname, '_headers');
if(fs.existsSync(headersSrc)){
  fs.copyFileSync(headersSrc, path.join(__dirname, 'dist', '_headers'));
}

console.log(`✅ Build completado → dist/index.html (css=${cssHash}, js=${jsHash})`);
// Build trigger 1779079327
// Trigger deploy after credits refill 1779079759
