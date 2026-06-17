-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK PASO 4d · eliminar la tabla race_availability
-- ════════════════════════════════════════════════════════════════════════
-- OJO: solo revertir si NO se ha llegado a usar (perderías las confirmaciones
-- guardadas en la tabla nueva). La disponibilidad antigua sigue intacta en
-- races.notes, así que volver atrás es seguro mientras nadie haya guardado
-- disponibilidad NUEVA tras el refactor.
-- ════════════════════════════════════════════════════════════════════════

do $$
begin
  begin
    execute 'alter publication supabase_realtime drop table public.race_availability';
  exception when others then null;
  end;
end $$;

drop policy if exists avail_anon_read  on public.race_availability;
drop policy if exists avail_auth_read  on public.race_availability;
drop policy if exists avail_auth_write on public.race_availability;

drop table if exists public.race_availability;
