-- ════════════════════════════════════════════════════════════════════════
-- PASO 4c · ASEGURAR los RESULTADOS: race_results + team_rankings
-- ════════════════════════════════════════════════════════════════════════
-- Estas 2 tablas tenían el RLS APAGADO. Al encenderlo empezarían a exigir
-- políticas; por eso AÑADIMOS lectura anónima (para que la app siga leyendo
-- con o sin login) y dejamos la ESCRITURA solo al staff AUTENTICADO.
--
-- NOTA: NO tocamos 'races' (la escriben también los ciclistas al apuntarse en
-- Disponibilidad; se asegurará cuando saquemos la disponibilidad a su propia
-- tabla). NO tocamos 'app_users' (haría caer el login por PIN).
--
-- Tras esto: GUARDAR clasificaciones requiere entrar por ENLACE MÁGICO.
-- Reversión: paso4c_rollback.sql
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text; pol record;
begin
  foreach t in array array['race_results','team_rankings'] loop
    execute format('alter table %I enable row level security', t);
    -- por si hubiera alguna política anónima previa, la quitamos
    for pol in select policyname from pg_policies
               where schemaname='public' and tablename=t and 'anon'=any(roles) loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
    -- anónimo: SOLO lectura (la app sigue mostrando datos sin login)
    execute format('create policy %I on %I for select to anon using (true)', 'anon_read_'||t, t);
    -- las políticas de authenticated (lectura todos / escritura staff) ya existen del Paso 1
  end loop;
end $$;

-- ── VERIFICACIÓN ──
-- Por tabla debe haber: anon→SELECT, authenticated→SELECT y ALL. Y rls_activado=true.
select c.relname as tabla, c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('race_results','team_rankings');

select tablename, policyname, roles, cmd
from pg_policies
where schemaname='public' and tablename in ('race_results','team_rankings')
order by tablename, policyname;
