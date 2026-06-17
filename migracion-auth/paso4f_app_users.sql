-- ════════════════════════════════════════════════════════════════════════
-- PASO 4f · ASEGURAR app_users  (esto MATA el login por PIN)
-- ════════════════════════════════════════════════════════════════════════
-- REQUISITOS antes de ejecutar:
--   • Haber comprobado que ENTRAS por enlace mágico en una ventana de incógnito.
--   • Tu correo con rol staff (SUPERADMIN/ADMIN/DIRECTOR) y active=true.
--
-- Qué hace: enciende RLS en app_users y quita cualquier lectura anónima. El PIN
-- leía la tabla por 'anon' → deja de funcionar. El enlace mágico lee TU propia
-- fila gracias a la política auth_self_read_app_users (creada en el Paso 1).
--
-- Reversión: paso4f_rollback.sql
-- ════════════════════════════════════════════════════════════════════════
do $$
declare n int; pol record;
begin
  -- Salvaguarda: no encender RLS si faltan las políticas del Paso 1 (si no,
  -- nadie podría leer su fila y NADIE podría entrar).
  select count(*) into n from pg_policies
   where schemaname='public' and tablename='app_users'
     and policyname in ('auth_self_read_app_users','auth_staff_all_app_users');
  if n < 2 then
    raise exception 'Faltan políticas del Paso 1 en app_users (% de 2). Ejecuta antes el paso1_politicas_paralelas.', n;
  end if;

  -- Quitar CUALQUIER política anónima (el PIN leía por anon: debe morir).
  for pol in select policyname from pg_policies
             where schemaname='public' and tablename='app_users' and 'anon'=any(roles) loop
    execute format('drop policy if exists %I on public.app_users', pol.policyname);
  end loop;

  -- Encender RLS.
  execute 'alter table public.app_users enable row level security';
end $$;

-- ── VERIFICACIÓN ──
-- rls_activado debe ser true; y NO debe quedar ninguna política con rol {anon}.
select c.relrowsecurity as rls_activado
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='app_users';

select policyname, roles, cmd from pg_policies
where schemaname='public' and tablename='app_users'
order by policyname;
