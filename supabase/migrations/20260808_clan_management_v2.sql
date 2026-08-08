-- LUX CLAN: banners reales del editor, estadísticas por modo y expulsión segura.

alter table public.profiles
  add column if not exists banner_path text;

drop policy if exists "members update only their profile" on public.profiles;
create policy "members update only their profile" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (
  id = (select auth.uid())
  and (avatar_path is null or avatar_path like (select auth.uid()::text || '/%'))
  and (banner_path is null or banner_path like (select auth.uid()::text || '/%'))
);

-- Los registros antiguos llamados "Duelo" pasan a la categoría clara 1v1.
update public.victories set mode = '1v1' where mode = 'Duelo';

alter table public.victories drop constraint if exists victories_mode_check;
alter table public.victories
  add constraint victories_mode_check
  check (mode in ('1v1', '2v2', '3v3', '4v4', 'Otro'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lux-banners', 'lux-banners', false, 10485760, array['image/png'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "member manages own banner" on storage.objects;
create policy "member manages own banner" on storage.objects
for all to authenticated
using (
  bucket_id = 'lux-banners'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'lux-banners'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "staff reads banners" on storage.objects;
create policy "staff reads banners" on storage.objects
for select to authenticated
using (bucket_id = 'lux-banners' and (select public.is_clan_staff()));

drop policy if exists "leaders delete clan media" on storage.objects;
create policy "leaders delete clan media" on storage.objects
for delete to authenticated
using (
  bucket_id in ('lux-avatars', 'lux-evidence', 'lux-banners', 'lux-plates')
  and (select public.is_clan_leader())
);

-- Entrega únicamente roles a líderes y moderación; nunca correos ni datos Auth.
create or replace function public.staff_list_member_roles()
returns table (user_id uuid, role text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_clan_staff() then
    raise exception 'No autorizado';
  end if;

  return query
  select roles.user_id, roles.role::text
  from public.user_roles as roles;
end;
$$;

revoke all on function public.staff_list_member_roles() from public;
grant execute on function public.staff_list_member_roles() to authenticated;

-- Antes de borrar la cuenta, el cliente elimina estos objetos usando Storage
-- y las políticas anteriores. Así no quedan imágenes huérfanas.
create or replace function public.staff_member_assets(p_user_id uuid)
returns table (bucket_id text, object_name text)
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  caller_role public.clan_role;
  target_role public.clan_role;
begin
  select role into caller_role from public.user_roles where user_id = auth.uid();
  select role into target_role from public.user_roles where user_id = p_user_id;

  if auth.uid() is null or p_user_id = auth.uid() then
    raise exception 'No puedes eliminar tu propia cuenta';
  end if;
  if target_role is null then
    raise exception 'La cuenta no existe';
  end if;
  if caller_role = 'leader' and target_role <> 'member' then
    raise exception 'Una líder solo puede expulsar integrantes';
  end if;
  if caller_role <> 'owner' and caller_role <> 'leader' then
    raise exception 'No autorizado';
  end if;

  return query
  select objects.bucket_id::text, objects.name::text
  from storage.objects as objects
  where
    (objects.bucket_id in ('lux-avatars', 'lux-evidence', 'lux-banners')
      and (storage.foldername(objects.name))[1] = p_user_id::text)
    or
    (objects.bucket_id = 'lux-plates' and objects.name in (
      select plates.image_path from public.plates where plates.player_id = p_user_id
    ));
end;
$$;

revoke all on function public.staff_member_assets(uuid) from public;
grant execute on function public.staff_member_assets(uuid) to authenticated;

create or replace function public.staff_delete_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_role public.clan_role;
  target_role public.clan_role;
begin
  select role into caller_role from public.user_roles where user_id = auth.uid();
  select role into target_role from public.user_roles where user_id = p_user_id;

  if auth.uid() is null or p_user_id = auth.uid() then
    raise exception 'No puedes eliminar tu propia cuenta';
  end if;
  if caller_role = 'leader' and target_role <> 'member' then
    raise exception 'Una líder solo puede expulsar integrantes';
  end if;
  if caller_role <> 'owner' and caller_role <> 'leader' then
    raise exception 'No autorizado';
  end if;
  if target_role is null then
    raise exception 'La cuenta no existe';
  end if;

  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'No se pudo eliminar la cuenta';
  end if;
end;
$$;

revoke all on function public.staff_delete_member(uuid) from public;
grant execute on function public.staff_delete_member(uuid) to authenticated;

-- Cambian las columnas de salida, por eso se sustituye la función completa.
drop function if exists public.get_public_ranking();
create function public.get_public_ranking()
returns table (
  player_id uuid,
  display_name text,
  country_code text,
  avatar_path text,
  victories_1v1 bigint,
  victories_2v2 bigint,
  victories_3v3 bigint,
  victories_4v4 bigint,
  victories_other bigint,
  victories_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    profiles.id,
    profiles.display_name,
    profiles.country_code,
    profiles.avatar_path,
    count(victories.id) filter (where victories.mode = '1v1') as victories_1v1,
    count(victories.id) filter (where victories.mode = '2v2') as victories_2v2,
    count(victories.id) filter (where victories.mode = '3v3') as victories_3v3,
    count(victories.id) filter (where victories.mode = '4v4') as victories_4v4,
    count(victories.id) filter (where victories.mode = 'Otro') as victories_other,
    count(victories.id) as victories_total
  from public.profiles as profiles
  left join public.victories as victories
    on victories.player_id = profiles.id and victories.status = 'approved'
  where profiles.is_public
  group by profiles.id, profiles.display_name, profiles.country_code, profiles.avatar_path
  order by victories_4v4 desc, victories_3v3 desc, victories_2v2 desc,
           victories_1v1 desc, victories_total desc, profiles.display_name asc;
$$;

revoke all on function public.get_public_ranking() from public;
grant execute on function public.get_public_ranking() to anon, authenticated;

notify pgrst, 'reload schema';
