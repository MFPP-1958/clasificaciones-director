-- ════════════════════════════════════════════════════════════════════════
-- PASO 4a · ROLLBACK — Devuelve sim_model a como estaba (anónimo puede TODO)
-- ════════════════════════════════════════════════════════════════════════
drop policy if exists anon_read_sim_model on sim_model;
create policy anon_all_sim_model on sim_model
  for all to anon using (true) with check (true);

-- Verificación: anon debe volver a aparecer con cmd ALL
select policyname, roles, cmd
from pg_policies
where schemaname='public' and tablename='sim_model'
order by policyname;
