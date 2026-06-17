# Guía · Configurar SMTP con Gmail en Supabase (para enviar enlaces mágicos)

## ¿Por qué hace falta?
El correo que trae Supabase de fábrica está **muy limitado** (unos pocos emails por hora) y
es solo para pruebas. Para mandar enlaces de acceso a ~27 personas (familias + staff)
necesitas un SMTP propio. Usamos **Gmail**.

> Nota honesta: Gmail funciona bien para volúmenes pequeños como el tuyo. Para algo más
> serio o con mejor entregabilidad existen servicios gratuitos pensados para apps (Resend,
> Brevo, SendGrid). Pero para 27 personas, Gmail vale.

---

## PARTE A · En tu cuenta de Google (crear una "contraseña de aplicación")
Gmail no deja usar tu contraseña normal en apps externas; hay que generar una **contraseña
de aplicación**. Requiere tener activada la **verificación en 2 pasos**.

1. Entra en tu cuenta Google: https://myaccount.google.com/security
2. Activa la **Verificación en 2 pasos** si no la tienes (sin esto no aparece la opción).
3. Ve a **Contraseñas de aplicaciones**: https://myaccount.google.com/apppasswords
4. Crea una nueva (nombre p. ej. "Supabase Dashboard"). Google te dará una clave de
   **16 letras** (tipo `abcd efgh ijkl mnop`).
5. **Cópiala y guárdala** — la necesitarás en la Parte B. (Se escribe SIN espacios.)

⚠️ Esa contraseña de aplicación da acceso al envío de tu Gmail: trátala como una clave.

---

## PARTE B · En Supabase (activar el SMTP propio)
1. Entra en el proyecto **del Dashboard** (`neeamkhbtoqsdxvsaogd`), no en Cycling-Team-DB.
2. Menú **Authentication** → **Emails** (o **Project Settings → Authentication → SMTP**).
3. Activa **Enable Custom SMTP** y rellena:
   - **Sender email**: tu Gmail (ej. `mfppmfpp@gmail.com`)
   - **Sender name**: `Dashboard Director TBG-WIXUM` (lo que verán como remitente)
   - **Host**: `smtp.gmail.com`
   - **Port**: `587`
   - **Username**: tu Gmail completo (`mfppmfpp@gmail.com`)
   - **Password**: la contraseña de aplicación de 16 letras (sin espacios)
4. **Guardar** (Save).

---

## PARTE C · Subir el límite de envío de Auth
Supabase limita por defecto cuántos emails de Auth manda por hora (suele ser bajo).
1. **Authentication** → **Rate Limits**.
2. Sube el límite de **emails por hora** lo suficiente para el alta inicial (p. ej. 30–50).
3. Guardar.

---

## PARTE D · Probar
1. Abre la app en **incógnito**, pide un enlace a un correo tuyo de prueba.
2. Comprueba que llega (mira también **spam**) y que el remitente es tu Gmail / el nombre
   que pusiste (ya no el de Supabase por defecto).
3. Pulsa el enlace y confirma que entras.

---

## Al dar de alta a las familias (cuando llegue el momento)
- Da el alta **espaciada** (no 27 de golpe) para no disparar el antispam de Gmail.
- Avisa a las familias de que **miren spam** la primera vez y marquen "No es spam".
- Recuerda: cada familia debe estar en `app_users` (active=true) o el enlace no la dejará
  entrar (la app valida el correo contra esa tabla).

## Límites y avisos honestos
- Gmail gratuito: ~500 envíos/día (de sobra para ti).
- El remitente real será tu dirección de Gmail (Gmail reescribe el "From").
- Si algún día Gmail se queda corto o da problemas de entregabilidad, migrar a Resend/Brevo
  es sencillo (solo cambian Host/Port/Usuario/Contraseña en la Parte B).
