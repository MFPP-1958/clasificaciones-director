-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK PASO 4e · volver a dejar races y app_permissions SIN RLS
-- ════════════════════════════════════════════════════════════════════════
-- Desactiva RLS (vuelve al comportamiento anterior: cualquiera puede leer y
-- escribir con la clave anon). Las políticas de authenticated quedan creadas
-- pero "dormidas". Usar solo si algo se rompe tras el 4e.
-- ════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['races','app_permissions'] loop
    execute format('drop policy if exists %I on %I', 'anon_read_'||t, t);
    execute format('alter table %I disable row level security', t);
  end loop;
end $$;
