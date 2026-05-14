const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL y SUPABASE_KEY son obligatorias.');
  process.exit(1);
}

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
html = html.replace('%%SUPABASE_URL%%', supabaseUrl);
html = html.replace('%%SUPABASE_KEY%%', supabaseKey);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html, 'utf8');

console.log('✅ Build completado → dist/index.html');
