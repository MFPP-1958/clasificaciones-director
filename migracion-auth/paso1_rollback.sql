-- ════════════════════════════════════════════════════════════════════════
-- PASO 1 · ROLLBACK — Borra TODO lo creado por paso1_politicas_paralelas.sql
-- Deja la base de datos exactamente como estaba antes del Paso 1.
-- (No toca las políticas anon_* originales ni el estado de RLS.)
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'races','race_results','team_rankings','team_sheets',
    'rider_efforts_fccv','sim_model','app_permissions'
  ]
  loop
    execute format('drop policy if exists %I on %I', 'auth_read_'||t, t);
    execute format('drop policy if exists %I on %I', 'auth_staff_all_'||t, t);
  end loop;
end $$;

drop policy if exists auth_self_read_app_users on app_users;
drop policy if exists auth_staff_all_app_users on app_users;

drop function if exists public.current_app_role();

-- Verificación: no debe quedar ninguna política auth_*
select tablename, policyname from pg_policies
where schemaname='public' and policyname like 'auth\_%' escape '\';
