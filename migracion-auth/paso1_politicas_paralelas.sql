-- ════════════════════════════════════════════════════════════════════════
-- PASO 1 · MIGRACIÓN AUTH — Políticas RLS EN PARALELO (100% ADITIVO)
-- ════════════════════════════════════════════════════════════════════════
-- Qué hace:   crea la función de rol y políticas para usuarios AUTENTICADOS.
-- Qué NO hace: no borra políticas anon, no activa/desactiva RLS, no cambia
--              ningún comportamiento actual de la app. Es preparación.
-- Reversión:  paso1_rollback.sql (borra todo lo que crea este script).
-- ════════════════════════════════════════════════════════════════════════

-- 1) Función helper: devuelve el rol del usuario autenticado leyendo app_users
--    por su email. SECURITY DEFINER => no entra en recursión con las políticas
--    de app_users. STABLE => cacheable dentro de la consulta.
create or replace function public.current_app_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from app_users
  where lower(email) = lower(coalesce(auth.jwt()->>'email',''))
    and active
  limit 1;
$$;

-- (revocar ejecución a anon: solo usuarios autenticados la necesitan)
revoke execute on function public.current_app_role() from anon;
grant  execute on function public.current_app_role() to authenticated;

-- 2) Políticas para usuarios AUTENTICADOS en las tablas de datos deportivos.
--    Lectura: cualquier usuario autenticado y activo del equipo.
--    Escritura: solo staff (SUPERADMIN / ADMIN / DIRECTOR).
--    NOTA: se crean aunque alguna tabla tenga RLS desactivado hoy; quedarán
--    "dormidas" hasta que el Paso 4 active RLS tabla a tabla.
do $$
declare t text;
begin
  foreach t in array array[
    'races','race_results','team_rankings','team_sheets',
    'rider_efforts_fccv','sim_model','app_permissions'
  ]
  loop
    execute format('drop policy if exists %I on %I', 'auth_read_'||t, t);
    execute format(
      'create policy %I on %I for select to authenticated
         using (public.current_app_role() is not null)',
      'auth_read_'||t, t);

    execute format('drop policy if exists %I on %I', 'auth_staff_all_'||t, t);
    execute format(
      'create policy %I on %I for all to authenticated
         using (public.current_app_role() in (''SUPERADMIN'',''ADMIN'',''DIRECTOR''))
         with check (public.current_app_role() in (''SUPERADMIN'',''ADMIN'',''DIRECTOR''))',
      'auth_staff_all_'||t, t);
  end loop;
end $$;

-- 3) app_users: cada usuario autenticado puede leer SU propia fila (para saber
--    su rol/nombre); el staff puede gestionarlo todo. Sin recursión gracias al
--    SECURITY DEFINER de la función.
drop policy if exists auth_self_read_app_users on app_users;
create policy auth_self_read_app_users on app_users
  for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt()->>'email','')));

drop policy if exists auth_staff_all_app_users on app_users;
create policy auth_staff_all_app_users on app_users
  for all to authenticated
  using (public.current_app_role() in ('SUPERADMIN','ADMIN','DIRECTOR'))
  with check (public.current_app_role() in ('SUPERADMIN','ADMIN','DIRECTOR'));

-- 4) DIAGNÓSTICO (no modifica nada): mapa real de RLS y políticas por tabla.
--    Pega el resultado de estas dos consultas en el chat para el checkpoint.
select c.relname as tabla,
       c.relrowsecurity as rls_activado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('races','race_results','team_rankings','team_sheets',
                    'rider_efforts_fccv','sim_model','app_users','app_permissions')
order by 1;

select tablename as tabla, policyname as politica, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
