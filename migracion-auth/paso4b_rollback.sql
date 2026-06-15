-- ════════════════════════════════════════════════════════════════════════
-- PASO 4b · ROLLBACK — Devuelve las 3 tablas a "anónimo puede TODO"
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['app_permissions','team_sheets','rider_efforts_fccv'] loop
    execute format('drop policy if exists %I on %I', 'anon_read_'||t, t);
    execute format('create policy %I on %I for all to anon using (true) with check (true)', 'anon_all_'||t, t);
  end loop;
end $$;

select tablename, policyname, roles, cmd
from pg_policies
where schemaname='public'
  and tablename in ('app_permissions','team_sheets','rider_efforts_fccv')
order by tablename, policyname;
