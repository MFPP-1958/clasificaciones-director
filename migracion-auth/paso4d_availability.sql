-- ════════════════════════════════════════════════════════════════════════
-- PASO 4d · DISPONIBILIDAD en su propia tabla (race_availability)
-- ════════════════════════════════════════════════════════════════════════
-- Hoy la disponibilidad (Sí voy / No voy / pendiente) se guarda dentro de
-- races.notes, y eso obliga a dar ESCRITURA sobre races a quien la marque.
-- La sacamos a su propia tabla para poder:
--   • Bloquear races a solo-staff (paso 4e) sin romper la disponibilidad.
--   • Permitir que CUALQUIER usuario autenticado (familias incluidas) marque
--     disponibilidad, pero NO pueda tocar clasificaciones ni nada más.
--
-- Una fila por carrera con un JSON {confirmed, declined, roster}. La app lee
-- de aquí y, si no hay fila, cae de vuelta a races.notes (no hace falta migrar).
--
-- Reversión: paso4d_rollback.sql
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.race_availability (
  race_id    uuid primary key references public.races(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.race_availability enable row level security;

-- Lectura anónima (para que el póster / la pantalla muestre confirmados sin login)
drop policy if exists avail_anon_read on public.race_availability;
create policy avail_anon_read on public.race_availability
  for select to anon using (true);

-- Lectura para usuarios autenticados y activos del equipo
drop policy if exists avail_auth_read on public.race_availability;
create policy avail_auth_read on public.race_availability
  for select to authenticated
  using (public.current_app_role() is not null);

-- Escritura (insert/update/delete) para CUALQUIER usuario autenticado y activo
-- (familias y ciclistas incluidos, no solo staff): así marcan su disponibilidad
-- sin poder tocar el resto de tablas.
drop policy if exists avail_auth_write on public.race_availability;
create policy avail_auth_write on public.race_availability
  for all to authenticated
  using      (public.current_app_role() is not null)
  with check (public.current_app_role() is not null);

-- Realtime: para que al confirmar desde un móvil se refresque en el resto
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.race_availability';
  exception when duplicate_object then null; when others then null;
  end;
end $$;

-- ── VERIFICACIÓN ──
select c.relname as tabla, c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='race_availability';

select tablename, policyname, roles, cmd
from pg_policies
where schemaname='public' and tablename='race_availability'
order by policyname;
