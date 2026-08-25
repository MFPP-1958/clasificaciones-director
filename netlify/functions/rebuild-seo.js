// Función de servidor de Netlify: dispara un rebuild (regenera las páginas SEO
// del ranking y del calendario) SOLO si quien la llama tiene sesión iniciada
// en el panel (token de Supabase válido).
//
// Por qué existe: el repo es PÚBLICO, así que la URL secreta del "build hook"
// NO puede ir en el navegador (app.js) ni en el código. Vive como variable de
// entorno en Netlify (NETLIFY_BUILD_HOOK) y solo se usa aquí, en el servidor.
//
// Configuración necesaria (una sola vez, en Netlify → Site configuration →
// Environment variables):  NETLIFY_BUILD_HOOK = https://api.netlify.com/build_hooks/xxxx

const SUPABASE_URL = 'https://neeamkhbtoqsdxvsaogd.supabase.co';
const SUPABASE_ANON = 'sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb';

exports.handler = async (event) => {
  // Solo POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const HOOK = process.env.NETLIFY_BUILD_HOOK;
  if (!HOOK) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Falta NETLIFY_BUILD_HOOK en las variables de entorno de Netlify.' }) };
  }

  // 1) Verificar la sesión: el panel manda su access_token de Supabase.
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Inicia sesión en el panel antes de publicar.' }) };
  }
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` }
    });
    if (!u.ok) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Sesión no válida o caducada. Vuelve a iniciar sesión.' }) };
    }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'No se pudo verificar la sesión.' }) };
  }

  // 2) Disparar el build.
  try {
    const r = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Netlify rechazó el build (' + r.status + ').' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'No se pudo contactar con Netlify.' }) };
  }
};
