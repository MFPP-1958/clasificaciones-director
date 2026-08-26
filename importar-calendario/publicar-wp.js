// Publica el bloque del Calendario (backups-web/calendario-federativo.html) en
// la página 5646 de WordPress, envuelto en un bloque wp:html. Hace copia del
// contenido actual antes de sobreescribir. Credenciales desde el .env.
//
// Uso:  node importar-calendario/publicar-wp.js
const fs = require('fs');
const path = require('path');

const ENV = '/Users/manuelfrancisperezperez/Desktop/Redes Sociales/.env';
function envVal(k){
  const line = fs.readFileSync(ENV,'utf8').split('\n').find(l=>l.startsWith(k+'='));
  return line ? line.slice(k.length+1).trim() : '';
}
const WP_URL = envVal('WP_URL').replace(/\/+$/,'');
const WP_USER = envVal('WP_USER');
const WP_PASS = envVal('WP_APP_PASSWORD');
const PAGE_ID = 5646;
if(!WP_URL || !WP_USER || !WP_PASS){ console.error('Faltan credenciales WP en el .env'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(WP_USER+':'+WP_PASS).toString('base64');

const widget = fs.readFileSync(path.join(__dirname,'..','backups-web','calendario-federativo.html'),'utf8');
const content = '<!-- wp:html -->\n' + widget + '\n<!-- /wp:html -->';

(async ()=>{
  // 1) Copia de seguridad del contenido actual (context=edit para el crudo)
  const g = await fetch(`${WP_URL}/wp-json/wp/v2/pages/${PAGE_ID}?context=edit`, { headers:{ Authorization:AUTH } });
  if(!g.ok){ console.error('No pude leer la página:', g.status, await g.text()); process.exit(1); }
  const cur = await g.json();
  const bakDir = process.env.BAK_DIR || '/tmp';
  const bak = path.join(bakDir, `wp_5646_backup_${Date.now()}.html`);
  fs.writeFileSync(bak, (cur.content && cur.content.raw) || '', 'utf8');
  console.log('Copia de seguridad del contenido previo →', bak, `(${((cur.content&&cur.content.raw)||'').length} chars)`);

  // 2) Publicar
  const p = await fetch(`${WP_URL}/wp-json/wp/v2/pages/${PAGE_ID}`, {
    method:'POST',
    headers:{ Authorization:AUTH, 'Content-Type':'application/json' },
    body: JSON.stringify({ content })
  });
  if(!p.ok){ console.error('Error al publicar:', p.status, await p.text()); process.exit(1); }
  const res = await p.json();
  console.log('✅ Publicado. Página', res.id, '· modificada', res.modified);
})();
