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

console.log('✅ Build completado → dist/index.html');
// Build trigger 1779079327
// Trigger deploy after credits refill 1779079759
