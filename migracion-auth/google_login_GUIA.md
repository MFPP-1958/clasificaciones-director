# Guía · Activar "Entrar con Google" (Supabase OAuth)

El código ya tiene el botón (oculto tras el interruptor `_GOOGLE_LOGIN_ENABLED`).
Falta configurar el proveedor Google. Cuando esté, se enciende el interruptor.

Proyecto Supabase: `neeamkhbtoqsdxvsaogd`
URL de redirección (callback) que usaremos:
`https://neeamkhbtoqsdxvsaogd.supabase.co/auth/v1/callback`

---

## PARTE A · Google Cloud Console (crear credenciales)
1. Entra en https://console.cloud.google.com (con tu cuenta Google).
2. Arriba, crea o elige un **proyecto** (ej. "TBG Dashboard").
3. Menú ☰ → **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Externo** → Crear.
   - Nombre de la app: `Dashboard Director TBG-WIXUM`.
   - Correo de asistencia: tu Gmail.
   - **Dominios autorizados**: añade `supabase.co`.
   - Datos de contacto: tu Gmail. Guardar y continuar (puedes saltar "Scopes").
   - **IMPORTANTE**: al final, **PUBLICA** la app (botón "Publicar aplicación" /
     "Volver a producción"). Si la dejas en "Pruebas", solo entrarían correos de
     prueba. Con permisos básicos (email/perfil) **no hace falta verificación**.
4. Menú ☰ → **APIs y servicios → Credenciales** → **Crear credenciales** →
   **ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - Nombre: `Supabase`.
   - **URIs de redirección autorizados** → Añadir URI:
     `https://neeamkhbtoqsdxvsaogd.supabase.co/auth/v1/callback`
   - Crear.
5. Google te muestra **ID de cliente** y **Secreto de cliente**. Cópialos.
   - El **Secreto** es sensible: solo se pega en Supabase (Parte B). No lo
     compartas por chat.

---

## PARTE B · Supabase (habilitar Google)
1. Proyecto del Dashboard → **Authentication → Providers** (o Sign In/Providers).
2. Busca **Google** → **Enable**.
3. Pega el **Client ID** y el **Client Secret** de la Parte A.
4. (Comprueba que el "Callback URL" que muestra Supabase coincide con el que
   pusiste en Google: `…/auth/v1/callback`.)
5. **Save**.

---

## PARTE C · Encender el botón (lo hago yo)
Cuando me digas que el proveedor Google está habilitado en Supabase, pongo
`_GOOGLE_LOGIN_ENABLED = true`, despliego, y probamos en incógnito.

## Prueba
- En incógnito, abre la app → pulsa **Entrar con Google** → elige tu cuenta →
  debe entrarte (si tu correo está en `app_users`).
- Si tu correo NO está autorizado, te sacará con aviso (exclusividad intacta).

## Si algo falla
- El enlace mágico sigue funcionando siempre → nadie se queda fuera.
- Apagar: `_GOOGLE_LOGIN_ENABLED = false` (oculta el botón) y/o deshabilitar
  el proveedor en Supabase.
