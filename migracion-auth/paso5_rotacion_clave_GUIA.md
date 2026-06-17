# PASO 5 · Guía de rotación de la clave publishable (anon)

## Contexto honesto (léelo antes)
- La clave **publishable** (`sb_publishable_…`) está **pensada para ser pública**: va en el
  navegador. Quien abra la web la ve. **Eso es normal.**
- Lo que protege los datos es el **RLS + Supabase Auth** (ya completados en el paso 4),
  **no** el secreto de esta clave.
- **No hay ninguna clave `service_role`/secreta filtrada** en el código ni en git
  (comprobado). Esa es la única que sería grave; y está a salvo.
- Conclusión: **rotar esta clave aporta poco** en seguridad ahora mismo. Es higiene
  opcional. Hazlo solo si quieres, sin prisa.

## Qué hace exactamente rotar la publishable
- **NO** cierra las sesiones de los usuarios (eso solo lo haría rotar el *JWT secret*,
  que NO tocamos).
- **SÍ** deja de funcionar cualquier app/web que siga usando la clave vieja una vez la
  revoques. Por eso: primero se crea la nueva, se actualiza TODO, y al final se revoca la
  vieja.

## Datos del proyecto
- Proyecto Supabase: `neeamkhbtoqsdxvsaogd`
- Clave actual en la app: `sb_publishable_R7anMfu6xfwlr7Ew3kMUbg_N1mqNRJb`
- Dónde está en el código: `assets/js/app.js` (1 vez) → se reconstruye en `dist/` al hacer `node build.js`.

## Antes de empezar: ¿qué OTRAS apps usan esta clave?
Haz una lista. Si solo la usa esta app (Dashboard Director), perfecto. Si hay otra web/app
tuya conectada al MISMO proyecto Supabase, tendrás que actualizarla también con la clave
nueva, o dejará de conectar al revocar la vieja.

## Procedimiento (con red de seguridad)
1. **Copia de seguridad** del código (lo hacemos juntos antes).
2. En Supabase: **Settings → API Keys** → sección *Publishable keys*.
3. **Crear una nueva** publishable key (queda conviviendo con la actual; las dos válidas).
4. **Actualizar la clave en el código**: sustituir la cadena `sb_publishable_…` por la
   nueva en `assets/js/app.js`.
5. `node -c assets/js/app.js` → `node build.js` → commit → push → esperar a que Netlify
   publique el nuevo hash.
6. **Probar la web** con la clave nueva: que carga datos, que entras por enlace mágico,
   que guardas algo. Probar también cualquier OTRA app que actualizaras.
7. Solo cuando TODO funcione con la clave nueva: **revocar la clave vieja** en Supabase.
8. Verificación final: recargar la web y confirmar que sigue conectando (ya solo con la
   nueva).

## Plan de rescate
- Si tras revocar algo deja de conectar: vuelve a **crear/activar** una clave publishable
  en Supabase, ponla en el código, `build.js`, push. Mientras no revoques la vieja, puedes
  volver a ella en cualquier momento.

## Recomendación
Dado que el RLS ya está completo y no hay secretos filtrados, **es razonable posponer o
incluso saltarse** esta rotación. Si la haces, sigue el orden de arriba (crear → actualizar
todo → revocar al final) para no cortar el servicio.
