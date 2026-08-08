-- Reparación idempotente para instalaciones donde PostgREST conservó un
-- esquema anterior y no exponía la validación de evidencias.
create or replace function public.can_submit_victory(p_evidence_sha256 text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  return not exists (
    select 1 from public.victories where evidence_sha256 = p_evidence_sha256
  ) and (
    select count(*) from public.victories
    where player_id = auth.uid()
      and status = 'pending'
      and created_at > now() - interval '24 hours'
  ) < 8;
end;
$$;

revoke all on function public.can_submit_victory(text) from public;
grant execute on function public.can_submit_victory(text) to authenticated;
notify pgrst, 'reload schema';
