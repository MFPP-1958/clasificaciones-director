-- ════════════════════════════════════════════════════════════════════════
-- FIX · Políticas del bucket de Storage 'race-tracks' (recorridos .fit/.gpx)
-- ════════════════════════════════════════════════════════════════════════
-- El error "Subida original falló: new row violates row-level security policy"
-- es de Supabase STORAGE (no de las tablas que aseguramos). El bucket no tenía
-- una política que permitiera SUBIR. Aquí: el usuario AUTENTICADO (enlace mágico)
-- puede subir/leer/borrar recorridos; cualquiera puede LEER (para mostrar el
-- curso sin login). Scoped SOLO al bucket 'race-tracks' → no afecta a otros.
-- ════════════════════════════════════════════════════════════════════════

-- (RLS en storage.objects ya viene activado por defecto en Supabase.)

drop policy if exists "race_tracks_auth_all"   on storage.objects;
drop policy if exists "race_tracks_anon_read"  on storage.objects;

-- Escritura/lectura/borrado para usuarios AUTENTICADOS en este bucket
create policy "race_tracks_auth_all" on storage.objects
  for all to authenticated
  using      (bucket_id = 'race-tracks')
  with check (bucket_id = 'race-tracks');

-- Lectura anónima (para que la app muestre el recorrido aunque no haya login)
create policy "race_tracks_anon_read" on storage.objects
  for select to anon
  using (bucket_id = 'race-tracks');

-- ── Verificación: deben aparecer las dos políticas del bucket ──
select policyname, roles, cmd
from pg_policies
where schemaname='storage' and tablename='objects'
  and policyname like 'race_tracks_%'
order by policyname;
