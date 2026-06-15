-- ════════════════════════════════════════════════════════════════════════
-- PASO 4c · ROLLBACK — Devuelve race_results y team_rankings a abierto (RLS OFF)
-- ════════════════════════════════════════════════════════════════════════
-- Vuelven a como estaban (RLS desactivado = acceso total). Se quitan las
-- políticas anon_read_* añadidas (al estar el RLS off, no se evalúan, pero las
-- limpiamos para no dejar restos).
do $$
declare t text;
begin
  foreach t in array array['race_results','team_rankings'] loop
    execute format('drop policy if exists %I on %I', 'anon_read_'||t, t);
    execute format('alter table %I disable row level security', t);
  end loop;
end $$;

select c.relname as tabla, c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('race_results','team_rankings');
