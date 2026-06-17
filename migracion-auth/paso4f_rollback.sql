-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK PASO 4f · volver a permitir el login por PIN
-- ════════════════════════════════════════════════════════════════════════
-- Apaga RLS en app_users (vuelve a poder leerse con la clave anon → el PIN
-- vuelve a funcionar). Recuerda también volver a poner _PIN_LOGIN_ENABLED=true
-- en el código si quieres ver de nuevo el campo de PIN en la pantalla de login.
-- ════════════════════════════════════════════════════════════════════════
alter table public.app_users disable row level security;
