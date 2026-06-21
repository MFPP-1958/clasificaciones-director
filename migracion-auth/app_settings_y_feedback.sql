-- ════════════════════════════════════════════════════════════════════════
-- AJUSTES GLOBALES (feature flags) + estado 'Descartado' en beta_feedback
-- ════════════════════════════════════════════════════════════════════════
-- 100% ADITIVO. Reutiliza public.current_app_role().

-- 1) Tabla clave/valor para ajustes globales de la app
create table if not exists public.app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- Semilla: recepción de feedback ACTIVA por defecto
insert into public.app_settings (key, value) values ('feedback_activo', 'true')
  on conflict (key) do nothing;

alter table public.app_settings enable row level security;
grant select on public.app_settings to authenticated;
grant insert, update on public.app_settings to authenticated;

-- Lectura: cualquier usuario autenticado (necesita leer el flag al arrancar).
drop policy if exists as_select_auth on public.app_settings;
create policy as_select_auth on public.app_settings
  for select to authenticated using (true);

-- Escritura: SOLO superadmin (encender/apagar el interruptor).
drop policy if exists as_insert_superadmin on public.app_settings;
create policy as_insert_superadmin on public.app_settings
  for insert to authenticated with check (public.current_app_role() = 'SUPERADMIN');

drop policy if exists as_update_superadmin on public.app_settings;
create policy as_update_superadmin on public.app_settings
  for update to authenticated
  using (public.current_app_role() = 'SUPERADMIN')
  with check (public.current_app_role() = 'SUPERADMIN');

-- 2) Ampliar estados de beta_feedback con 'Descartado'
alter table public.beta_feedback drop constraint if exists beta_feedback_estado_check;
alter table public.beta_feedback
  add constraint beta_feedback_estado_check
  check (estado in ('Pendiente','Resuelto','Descartado'));
