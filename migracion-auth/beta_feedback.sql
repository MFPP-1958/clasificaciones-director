-- ════════════════════════════════════════════════════════════════════════
-- BETA FEEDBACK · tabla de reportes de los Beta Testers (100% ADITIVO)
-- ════════════════════════════════════════════════════════════════════════
-- Qué hace:   crea la tabla public.beta_feedback y sus políticas RLS.
-- Seguridad:  · INSERT  → cualquier usuario AUTENTICADO (beta_tester, director,
--                          ciclista…) puede enviar un reporte.
--             · SELECT  → SOLO el SUPERADMIN puede leer la tabla.
--             · UPDATE  → SOLO el SUPERADMIN (cambiar estado a 'Resuelto', etc.).
--             · DELETE  → nadie (no se crea política de borrado).
-- Reutiliza:  public.current_app_role()  (creada en paso1_politicas_paralelas.sql)
--             que devuelve el rol del usuario autenticado leyendo app_users.
-- Reversión:  beta_feedback_rollback.sql
-- ════════════════════════════════════════════════════════════════════════

-- 1) Tabla
create table if not exists public.beta_feedback (
  id                uuid primary key default gen_random_uuid(),
  fecha             timestamptz not null default now(),
  id_usuario        text,                 -- email del usuario (auth)
  rol_usuario       text,                 -- rol en el momento del reporte
  seccion_actual    text,                 -- pantalla activa (Simulador, Calendario…)
  tipo_reporte      text not null check (tipo_reporte in ('Fallo','Sugerencia','Mejora de Interfaz')),
  descripcion_texto text not null,
  estado            text not null default 'Pendiente' check (estado in ('Pendiente','Resuelto'))
);

-- 2) Activar RLS
alter table public.beta_feedback enable row level security;

-- 3) Permisos de tabla (RLS sigue mandando por encima de estos grants)
grant insert, select, update on public.beta_feedback to authenticated;

-- 4) Políticas RLS
-- 4a) INSERT: cualquier usuario AUTENTICADO puede crear un reporte.
drop policy if exists bf_insert_authenticated on public.beta_feedback;
create policy bf_insert_authenticated on public.beta_feedback
  for insert to authenticated
  with check (true);

-- 4b) SELECT: SOLO superadmin puede leer toda la tabla. Nadie más.
drop policy if exists bf_select_superadmin on public.beta_feedback;
create policy bf_select_superadmin on public.beta_feedback
  for select to authenticated
  using (public.current_app_role() = 'SUPERADMIN');

-- 4c) UPDATE: SOLO superadmin (marcar como 'Resuelto', editar, etc.).
drop policy if exists bf_update_superadmin on public.beta_feedback;
create policy bf_update_superadmin on public.beta_feedback
  for update to authenticated
  using (public.current_app_role() = 'SUPERADMIN')
  with check (public.current_app_role() = 'SUPERADMIN');

-- (Sin política de DELETE → ningún rol puede borrar reportes.)

-- 5) Índice para ordenar/filtrar rápido por estado y fecha (panel del superadmin)
create index if not exists beta_feedback_estado_fecha_idx
  on public.beta_feedback (estado, fecha desc);
