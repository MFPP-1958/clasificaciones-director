-- ════════════════════════════════════════════════════════════════════════
-- PASO 4e · ASEGURAR races (+ app_permissions)
-- ════════════════════════════════════════════════════════════════════════
-- REQUISITO: ejecutar ANTES el paso 4d (tabla race_availability) y desplegar
-- el código que ya escribe la disponibilidad en esa tabla. Si no, marcar
-- disponibilidad dejará de funcionar (races pasa a ser solo-staff en escritura).
--
-- Igual que en 4a/4b/4c: encendemos RLS, dejamos LECTURA anónima (la app sigue
-- mostrando el calendario y las pruebas sin login) y la ESCRITURA queda solo
-- para el STAFF autenticado (las políticas de authenticated ya existen del Paso 1).
--
-- Tras esto: crear/editar/borrar pruebas y guardar notas requiere ENLACE MÁGICO.
-- Reversión: paso4e_rollback.sql
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text; pol record;
begin
  foreach t in array array['races','app_permissions'] loop
    execute format('alter table %I enable row level security', t);
    -- quitar políticas anónimas previas (las recreamos limpias como solo-lectura)
    for pol in select policyname from pg_policies
               where schemaname='public' and tablename=t and 'anon'=any(roles) loop
      execute format('drop policy if exists %I on %I', pol.policyname, t);
    end loop;
    -- anónimo: SOLO lectura
    execute format('create policy %I on %I for select to anon using (true)', 'anon_read_'||t, t);
    -- authenticated (lectura a todos los activos / escritura solo staff) ya existen del Paso 1
  end loop;
end $$;

-- ── VERIFICACIÓN ──
-- Por tabla: anon→SELECT, authenticated→SELECT y ALL, rls_activado=true.
select c.relname as tabla, c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('races','app_permissions');

select tablename, policyname, roles, cmd
from pg_policies
where schemaname='public' and tablename in ('races','app_permissions')
order by tablename, policyname;
