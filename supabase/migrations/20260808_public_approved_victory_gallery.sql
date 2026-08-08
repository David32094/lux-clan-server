-- Public competitive profiles: approved evidence is visible to everyone.
-- Pending and rejected evidence remains protected by the existing RLS policies.

drop function if exists public.get_public_ranking();

create function public.get_public_ranking()
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
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = 'Otro')::bigint,
    count(victories.id) filter (where victories.status = 'approved')::bigint
  from public.profiles
  left join public.victories on victories.player_id = profiles.id
  where profiles.is_public
  group by profiles.id, profiles.display_name, profiles.age, profiles.country_code, profiles.avatar_path
  order by
    count(victories.id) filter (where victories.status = 'approved' and victories.mode = '4v4') desc,
    count(victories.id) filter (where victories.status = 'approved') desc,
    profiles.display_name;
$$;

revoke all on function public.get_public_ranking() from public;
grant execute on function public.get_public_ranking() to anon, authenticated;

drop function if exists public.get_public_player_victories(uuid);

create function public.get_public_player_victories(p_player_id uuid)
returns table (
  victory_id uuid,
  mode text,
  evidence_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select victories.id, victories.mode, victories.evidence_path, victories.created_at
  from public.victories
  join public.profiles on profiles.id = victories.player_id
  where victories.player_id = p_player_id
    and victories.status = 'approved'
    and profiles.is_public
  order by victories.created_at desc;
$$;

revoke all on function public.get_public_player_victories(uuid) from public;
grant execute on function public.get_public_player_victories(uuid) to anon, authenticated;

create or replace function public.is_public_approved_evidence(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.victories
    join public.profiles on profiles.id = victories.player_id
    where victories.evidence_path = p_path
      and victories.status = 'approved'
      and profiles.is_public
  );
$$;

revoke all on function public.is_public_approved_evidence(text) from public;
grant execute on function public.is_public_approved_evidence(text) to anon, authenticated;

drop policy if exists "approved evidence is public" on storage.objects;
create policy "approved evidence is public" on storage.objects
for select to anon, authenticated
using (
  bucket_id = 'lux-evidence'
  and public.is_public_approved_evidence(name)
);

notify pgrst, 'reload schema';
