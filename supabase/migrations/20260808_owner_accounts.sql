-- Control privado de cuentas para la propietaria del clan.
-- La función usa SECURITY DEFINER para poder leer auth.users sin exponer
-- service_role ni datos de Auth directamente en el navegador.

create or replace function public.is_clan_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = (select auth.uid())
      and role = 'owner'::public.clan_role
  );
$$;

revoke all on function public.is_clan_owner() from public;
grant execute on function public.is_clan_owner() to authenticated;

create or replace function public.owner_list_clan_users()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  providers text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_clan_owner() then
    raise exception 'No autorizado';
  end if;

  return query
  select
    users.id,
    users.email::text,
    coalesce(profiles.display_name, 'Jugador')::text,
    coalesce(roles.role::text, 'member')::text,
    coalesce(string_agg(distinct identities.provider::text, ', ' order by identities.provider::text), '')::text,
    users.created_at,
    users.last_sign_in_at
  from auth.users as users
  left join public.profiles as profiles on profiles.id = users.id
  left join public.user_roles as roles on roles.user_id = users.id
  left join auth.identities as identities on identities.user_id = users.id
  group by users.id, users.email, profiles.display_name, roles.role, users.created_at, users.last_sign_in_at
  order by users.created_at asc;
end;
$$;

revoke all on function public.owner_list_clan_users() from public;
grant execute on function public.owner_list_clan_users() to authenticated;

comment on function public.owner_list_clan_users() is
  'Lista privada de cuentas Auth, disponible únicamente para el rol owner.';

notify pgrst, 'reload schema';
