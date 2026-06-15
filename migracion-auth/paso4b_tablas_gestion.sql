-- ════════════════════════════════════════════════════════════════════════
-- PASO 4b · ASEGURAR tablas de gestión (escritura poco frecuente)
--   app_permissions · team_sheets · rider_efforts_fccv
-- ════════════════════════════════════════════════════════════════════════
-- Qué hace:   quita la ESCRITURA anónima; deja la LECTURA abierta. La escritura
--             pasa a ser solo del staff AUTENTICADO (enlace mágico).
-- Robusto:    elimina CUALQUIER política del rol anónimo en esas tablas (sea
--             cual sea su nombre) y crea una de solo lectura.
-- Reversión:  paso4b_rollback.sql
-- IMPORTANTE: para gestionar láminas / permisos / FCCV tras esto, entra por
--             ENLACE MÁGICO (por PIN eres anónimo y no podrás escribir).
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text; pol record;
begin
  foreach t in array array['app_permissions','team_sheets','rider_efforts_fccv'] loop
    execute format('alter table %I enable row level security', t);
    -- borrar todas las políticas del rol anónimo en esta tabla
    for pol in select policyname from pg_policies
               where schemaname='public' and tablename=t and 'anon'=any(roles) loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
    -- anónimo: solo lectura
    execute format('create policy %I on %I for select to anon using (true)', 'anon_read_'||t, t);
  end loop;
end $$;

-- ── VERIFICACIÓN ── debe quedar, por tabla: anon→SELECT, authenticated→SELECT y ALL.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname='public'
  and tablename in ('app_permissions','team_sheets','rider_efforts_fccv')
order by tablename, policyname;
