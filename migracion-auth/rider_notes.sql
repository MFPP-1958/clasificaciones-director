-- ════════════════════════════════════════════════════════════════════════
-- Tabla rider_notes · notas PRIVADAS del director por corredor (#3)
-- ════════════════════════════════════════════════════════════════════════
-- Una nota + valoración (estrellas) por corredor. SOLO el staff
-- (SUPERADMIN/ADMIN/DIRECTOR) puede leerlas y escribirlas: son privadas, los
-- ciclistas/familias NO las ven (no hay política para anon ni para el resto).
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.rider_notes (
  rider_key  text primary key,   -- nombre normalizado del corredor (identidad estable)
  note       text default '',
  rating     int,                -- 1..5 estrellas (o NULL)
  updated_at timestamptz default now(),
  updated_by text
);

alter table public.rider_notes enable row level security;

drop policy if exists rider_notes_staff_all on public.rider_notes;
create policy rider_notes_staff_all on public.rider_notes
  for all to authenticated
  using      (public.current_app_role() in ('SUPERADMIN','ADMIN','DIRECTOR'))
  with check (public.current_app_role() in ('SUPERADMIN','ADMIN','DIRECTOR'));

-- ── VERIFICACIÓN ──
select c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='rider_notes';

select policyname, roles, cmd from pg_policies
where schemaname='public' and tablename='rider_notes' order by policyname;
