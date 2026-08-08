-- Safe clan directory for authenticated members.
-- Exposes age for member profiles without exposing email, evidence or admin data.

drop function if exists public.get_clan_directory();

create function public.get_clan_directory()
returns table (
  player_id uuid,
  display_name text,
  age smallint,
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
    profiles.age,
    profiles.country_code,
    profiles.avatar_path,
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '1v1')::bigint,
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '2v2')::bigint,
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '3v3')::bigint,
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '4v4')::bigint,
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = 'other')::bigint,
    count(victories.id) filter (where victories.status = 'approved')::bigint
  from public.profiles
  left join public.victories on victories.player_id = profiles.id
  where auth.uid() is not null
    and profiles.is_public
  group by profiles.id, profiles.display_name, profiles.age, profiles.country_code, profiles.avatar_path
  order by
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '4v4') desc,
    count(victories.id) filter (where victories.status = 'approved') desc,
    profiles.display_name;
$$;

revoke all on function public.get_clan_directory() from public;
grant execute on function public.get_clan_directory() to authenticated;

notify pgrst, 'reload schema';
