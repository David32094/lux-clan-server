-- LUX CLAN: importación segura del panel de actividad de Free Fire.
-- Cada captura es una lectura de contadores, no una suma. El ranking usa el
-- máximo observado de la semana y el máximo total para impedir duplicados.

create table if not exists public.game_player_aliases (
  id uuid primary key default gen_random_uuid(),
  alias_key text not null unique check (char_length(alias_key) between 1 and 80),
  game_name text not null check (char_length(game_name) between 1 and 80),
  player_id uuid not null references public.profiles(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.clan_activity_imports (
  id uuid primary key default gen_random_uuid(),
  image_sha256 text not null unique check (image_sha256 ~ '^[0-9a-f]{64}$'),
  image_path text not null,
  captured_on date not null default current_date,
  week_start date not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (image_path like created_by::text || '/%'),
  check (week_start = date_trunc('week', captured_on::timestamp)::date)
);

create table if not exists public.clan_activity_snapshots (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.clan_activity_imports(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  game_name text not null check (char_length(game_name) between 1 and 80),
  glory_week integer not null default 0 check (glory_week between 0 and 100000000),
  glory_total integer not null default 0 check (glory_total between 0 and 100000000),
  plates_week integer not null default 0 check (plates_week between 0 and 100000000),
  plates_total integer not null default 0 check (plates_total between 0 and 100000000),
  row_index smallint not null default 0 check (row_index between 0 and 100),
  created_at timestamptz not null default now(),
  unique (import_id, player_id)
);

create index if not exists aliases_player_idx
  on public.game_player_aliases (player_id, last_seen_at desc);
create index if not exists activity_import_week_idx
  on public.clan_activity_imports (week_start desc, captured_on desc, created_at desc);
create index if not exists activity_snapshot_player_idx
  on public.clan_activity_snapshots (player_id, created_at desc);

alter table public.game_player_aliases enable row level security;
alter table public.clan_activity_imports enable row level security;
alter table public.clan_activity_snapshots enable row level security;

drop policy if exists "leaders manage game aliases" on public.game_player_aliases;
create policy "leaders manage game aliases" on public.game_player_aliases
for all to authenticated
using ((select public.is_clan_leader()))
with check ((select public.is_clan_leader()) and created_by = (select auth.uid()));

drop policy if exists "leaders manage activity imports" on public.clan_activity_imports;
create policy "leaders manage activity imports" on public.clan_activity_imports
for all to authenticated
using ((select public.is_clan_leader()))
with check ((select public.is_clan_leader()) and created_by = (select auth.uid()));

drop policy if exists "leaders manage activity snapshots" on public.clan_activity_snapshots;
create policy "leaders manage activity snapshots" on public.clan_activity_snapshots
for all to authenticated
using ((select public.is_clan_leader()))
with check ((select public.is_clan_leader()));

revoke all on public.game_player_aliases from anon;
revoke all on public.clan_activity_imports from anon;
revoke all on public.clan_activity_snapshots from anon;
grant select, insert, update, delete on public.game_player_aliases to authenticated;
grant select, insert, update, delete on public.clan_activity_imports to authenticated;
grant select, insert, update, delete on public.clan_activity_snapshots to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lux-clan-imports',
  'lux-clan-imports',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "leaders read activity captures" on storage.objects;
create policy "leaders read activity captures" on storage.objects
for select to authenticated
using (bucket_id = 'lux-clan-imports' and (select public.is_clan_leader()));

drop policy if exists "leaders upload own activity captures" on storage.objects;
create policy "leaders upload own activity captures" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'lux-clan-imports'
  and (select public.is_clan_leader())
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "leaders update own activity captures" on storage.objects;
create policy "leaders update own activity captures" on storage.objects
for update to authenticated
using (
  bucket_id = 'lux-clan-imports'
  and (select public.is_clan_leader())
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'lux-clan-imports'
  and (select public.is_clan_leader())
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "leaders delete activity captures" on storage.objects;
create policy "leaders delete activity captures" on storage.objects
for delete to authenticated
using (bucket_id = 'lux-clan-imports' and (select public.is_clan_leader()));

create or replace function public.staff_submit_activity_snapshot(
  p_image_sha256 text,
  p_image_path text,
  p_captured_on date,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_import_id uuid;
  caller_id uuid := auth.uid();
  item record;
  row_count integer;
begin
  if caller_id is null or not public.is_clan_leader() then
    raise exception 'Solo una líder puede importar la actividad';
  end if;
  if p_image_sha256 is null or p_image_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Huella de imagen inválida';
  end if;
  if p_image_path is null or p_image_path not like caller_id::text || '/%' then
    raise exception 'Ruta de imagen inválida';
  end if;
  if p_captured_on is null or p_captured_on < current_date - 3650 or p_captured_on > current_date + 1 then
    raise exception 'Fecha de captura inválida';
  end if;
  if coalesce(jsonb_typeof(p_rows), '') <> 'array' then
    raise exception 'Las filas no son válidas';
  end if;

  row_count := jsonb_array_length(p_rows);
  if row_count < 1 or row_count > 60 then
    raise exception 'La captura debe contener entre 1 y 60 integrantes';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(player_id uuid)
    group by r.player_id
    having count(*) > 1
  ) then
    raise exception 'Un integrante aparece repetido en la misma captura';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(player_id uuid, alias_key text)
    join public.game_player_aliases a on a.alias_key = r.alias_key
    where a.player_id <> r.player_id
  ) then
    raise exception 'Un nombre del juego ya pertenece a otro integrante';
  end if;

  insert into public.clan_activity_imports (
    image_sha256, image_path, captured_on, week_start, created_by
  ) values (
    p_image_sha256,
    p_image_path,
    p_captured_on,
    date_trunc('week', p_captured_on::timestamp)::date,
    caller_id
  )
  returning id into new_import_id;

  for item in
    select * from jsonb_to_recordset(p_rows) as r(
      player_id uuid,
      game_name text,
      alias_key text,
      glory_week integer,
      glory_total integer,
      plates_week integer,
      plates_total integer,
      row_index integer
    )
  loop
    if item.player_id is null or not exists (select 1 from public.profiles where id = item.player_id) then
      raise exception 'Hay un integrante inválido';
    end if;
    if coalesce(char_length(trim(item.game_name)), 0) < 1 or char_length(item.game_name) > 80 then
      raise exception 'Hay un nombre del juego inválido';
    end if;
    if coalesce(char_length(trim(item.alias_key)), 0) < 1 or char_length(item.alias_key) > 80 then
      raise exception 'Hay un alias inválido';
    end if;
    if least(
      coalesce(item.glory_week, 0), coalesce(item.glory_total, 0),
      coalesce(item.plates_week, 0), coalesce(item.plates_total, 0)
    ) < 0 then
      raise exception 'Los valores no pueden ser negativos';
    end if;
    if coalesce(item.glory_total, 0) < coalesce(item.glory_week, 0)
       or coalesce(item.plates_total, 0) < coalesce(item.plates_week, 0) then
      raise exception 'El total no puede ser menor que el valor semanal';
    end if;

    insert into public.game_player_aliases (
      alias_key, game_name, player_id, created_by, last_seen_at
    ) values (
      item.alias_key, trim(item.game_name), item.player_id, caller_id, now()
    )
    on conflict (alias_key) do update set
      game_name = excluded.game_name,
      last_seen_at = now()
    where public.game_player_aliases.player_id = excluded.player_id;

    insert into public.clan_activity_snapshots (
      import_id, player_id, game_name,
      glory_week, glory_total, plates_week, plates_total, row_index
    ) values (
      new_import_id, item.player_id, trim(item.game_name),
      coalesce(item.glory_week, 0), coalesce(item.glory_total, 0),
      coalesce(item.plates_week, 0), coalesce(item.plates_total, 0),
      coalesce(item.row_index, 0)
    );
  end loop;

  return new_import_id;
exception
  when unique_violation then
    raise exception 'Esta captura ya fue importada';
end;
$$;

revoke all on function public.staff_submit_activity_snapshot(text, text, date, jsonb) from public;
grant execute on function public.staff_submit_activity_snapshot(text, text, date, jsonb) to authenticated;

drop function if exists public.get_public_plate_ranking();
create function public.get_public_plate_ranking()
returns table (
  player_id uuid,
  display_name text,
  avatar_path text,
  plate_count bigint,
  plates_week bigint,
  plates_total bigint,
  glory_week bigint,
  glory_total bigint,
  last_captured_on date,
  legacy_image_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with current_week as (
    select date_trunc('week', current_date::timestamp)::date as starts_on
  ), activity as (
    select
      snapshots.player_id,
      max(snapshots.plates_week) filter (where imports.week_start = current_week.starts_on) as plates_week,
      max(snapshots.glory_week) filter (where imports.week_start = current_week.starts_on) as glory_week,
      max(snapshots.plates_total) as plates_total,
      max(snapshots.glory_total) as glory_total,
      max(imports.captured_on) as last_captured_on
    from public.clan_activity_snapshots snapshots
    join public.clan_activity_imports imports on imports.id = snapshots.import_id
    cross join current_week
    group by snapshots.player_id
  ), legacy as (
    select plates.player_id, count(*)::bigint as image_count
    from public.plates
    group by plates.player_id
  )
  select
    profiles.id,
    profiles.display_name,
    profiles.avatar_path,
    coalesce(activity.plates_total, 0)::bigint as plate_count,
    coalesce(activity.plates_week, 0)::bigint,
    coalesce(activity.plates_total, 0)::bigint,
    coalesce(activity.glory_week, 0)::bigint,
    coalesce(activity.glory_total, 0)::bigint,
    activity.last_captured_on,
    coalesce(legacy.image_count, 0)::bigint
  from public.profiles profiles
  left join activity on activity.player_id = profiles.id
  left join legacy on legacy.player_id = profiles.id
  where profiles.is_public
  order by coalesce(activity.plates_week, 0) desc,
           coalesce(activity.plates_total, 0) desc,
           coalesce(activity.glory_week, 0) desc,
           profiles.display_name asc;
$$;

revoke all on function public.get_public_plate_ranking() from public;
grant execute on function public.get_public_plate_ranking() to anon, authenticated;

create or replace function public.get_public_player_plate_history(p_player_id uuid)
returns table (
  week_start date,
  captured_on date,
  plates_week bigint,
  plates_total bigint,
  glory_week bigint,
  glory_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    imports.week_start,
    max(imports.captured_on),
    max(snapshots.plates_week)::bigint,
    max(snapshots.plates_total)::bigint,
    max(snapshots.glory_week)::bigint,
    max(snapshots.glory_total)::bigint
  from public.clan_activity_snapshots snapshots
  join public.clan_activity_imports imports on imports.id = snapshots.import_id
  join public.profiles profiles on profiles.id = snapshots.player_id
  where snapshots.player_id = p_player_id and profiles.is_public
  group by imports.week_start
  order by imports.week_start desc
  limit 16;
$$;

revoke all on function public.get_public_player_plate_history(uuid) from public;
grant execute on function public.get_public_player_plate_history(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
