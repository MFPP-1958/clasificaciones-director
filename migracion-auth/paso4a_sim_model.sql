-- ════════════════════════════════════════════════════════════════════════
-- PASO 4a · ASEGURAR sim_model (tabla piloto, bajo riesgo)
-- ════════════════════════════════════════════════════════════════════════
-- Qué hace:   quita la ESCRITURA anónima de sim_model; deja la LECTURA abierta.
--             A partir de aquí, solo el staff AUTENTICADO (enlace mágico) puede
--             escribir en sim_model. Cualquiera (anónimo/PIN) puede LEER.
-- Qué NO hace: no toca el resto de tablas; no afecta a login por PIN (que lee
--             app_users, intacta); no afecta al otro proyecto.
-- Reversión:  paso4a_rollback.sql
-- ════════════════════════════════════════════════════════════════════════

-- RLS ya estaba activado en sim_model; este ALTER es inofensivo si ya lo estaba.
alter table sim_model enable row level security;

-- Sustituir la política "anónimo puede TODO" por "anónimo solo LECTURA".
drop policy if exists anon_all_sim_model on sim_model;
create policy anon_read_sim_model on sim_model
  for select to anon using (true);

-- Las reglas para usuarios AUTENTICADOS ya existen del Paso 1:
--   · auth_read_sim_model       (lectura para cualquier miembro del equipo)
--   · auth_staff_all_sim_model  (lectura/escritura solo staff)
-- No hay que crear nada más.

-- ── VERIFICACIÓN (no modifica nada) ──
-- Debe quedar: anon → SELECT; authenticated → SELECT y ALL.
select policyname, roles, cmd
from pg_policies
where schemaname='public' and tablename='sim_model'
order by policyname;
