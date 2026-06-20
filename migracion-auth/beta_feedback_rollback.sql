-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK · BETA FEEDBACK — elimina la tabla y sus políticas
-- ════════════════════════════════════════════════════════════════════════
-- ⚠️ Borra TODOS los reportes guardados. Úsalo solo si quieres deshacerlo.
drop policy if exists bf_insert_authenticated on public.beta_feedback;
drop policy if exists bf_select_superadmin    on public.beta_feedback;
drop policy if exists bf_update_superadmin     on public.beta_feedback;
drop index  if exists public.beta_feedback_estado_fecha_idx;
drop table  if exists public.beta_feedback;
