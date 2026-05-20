const fs = require('fs');
const path = require('path');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Inyectar credenciales si están como variables de entorno (opcional)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (supabaseUrl) html = html.replace('%%SUPABASE_URL%%', supabaseUrl);
if (supabaseKey) html = html.replace('%%SUPABASE_KEY%%', supabaseKey);

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

console.log('✅ Build completado → dist/index.html (+ dist/assets/)');
// Build trigger 1779079327
// Trigger deploy after credits refill 1779079759
