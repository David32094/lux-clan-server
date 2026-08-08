-- Gestión segura de líderes y moderación desde la cuenta owner.
-- El navegador nunca recibe service_role y la comprobación real se hace
-- dentro de PostgreSQL usando el usuario autenticado.

create or replace function public.owner_set_member_role(
  p_user_id uuid,
  p_role text
)
returns table (user_id uuid, role text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  requested_role public.clan_role;
  current_role public.clan_role;
begin
  if not public.is_clan_owner() then
    raise exception 'No autorizado';
  end if;

  if p_user_id is null or p_user_id = (select auth.uid()) then
    raise exception 'La cuenta owner no puede cambiar su propio rol';
  end if;

  if p_role not in ('member', 'moderator', 'leader') then
    raise exception 'Rol no permitido';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'La cuenta no existe';
  end if;

  select roles.role
    into current_role
    from public.user_roles as roles
   where roles.user_id = p_user_id;

  if current_role = 'owner'::public.clan_role then
    raise exception 'No se puede modificar otra cuenta owner';
  end if;

  requested_role := p_role::public.clan_role;

  insert into public.user_roles (user_id, role)
  values (p_user_id, requested_role)
  on conflict (user_id) do update
    set role = excluded.role;

  return query
  select roles.user_id, roles.role::text
    from public.user_roles as roles
   where roles.user_id = p_user_id;
end;
$$;

revoke all on function public.owner_set_member_role(uuid, text) from public;
grant execute on function public.owner_set_member_role(uuid, text) to authenticated;

comment on function public.owner_set_member_role(uuid, text) is
  'Permite únicamente al owner asignar member, moderator o leader sin exponer credenciales administrativas.';

notify pgrst, 'reload schema';
