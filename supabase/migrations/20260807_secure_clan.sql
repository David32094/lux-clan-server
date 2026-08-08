-- LUX CLAN: esquema de producción con Supabase Auth, Storage y RLS.
-- Ejecutar completo en el SQL Editor de un proyecto NUEVO de Supabase.
-- No incluye ni necesita service_role keys.

create extension if not exists pgcrypto;

do $$ begin
  create type public.clan_role as enum ('owner', 'leader', 'moderator', 'member');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.victory_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Jugador' check (char_length(display_name) between 2 and 24),
  age smallint check (age between 13 and 99),
  country_code text check (country_code is null or char_length(country_code) between 2 and 3),
  country_name text check (country_name is null or char_length(country_name) <= 60),
  avatar_path text,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Los roles se guardan separados del perfil para que un jugador no pueda
-- convertirse en líder editando una columna desde el navegador.
create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.clan_role not null default 'member',
  assigned_at timestamptz not null default now()
);

create table if not exists public.victories (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('4v4', 'Duelo', 'Otro')),
  evidence_path text not null check (evidence_path like player_id::text || '/%'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  status public.victory_status not null default 'pending',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 300),
  created_at timestamptz not null default now(),
  unique (evidence_sha256)
);

create table if not exists public.plates (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Placa del clan' check (char_length(title) between 1 and 42),
  image_path text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists victories_player_status_idx on public.victories (player_id, status, created_at desc);
create index if not exists victories_status_mode_idx on public.victories (status, mode);
create index if not exists plates_player_created_idx on public.plates (player_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();

-- Crea el perfil y el rol mínimo desde Auth. Ningún dato de metadatos se usa
-- para otorgar permisos; el rol siempre empieza como member.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(left(new.raw_user_meta_data ->> 'display_name', 24), ''), 'Jugador'))
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'member')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists auth_user_created_profile on auth.users;
create trigger auth_user_created_profile
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_clan_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('owner', 'leader', 'moderator')
  );
$$;

create or replace function public.is_clan_leader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('owner', 'leader')
  );
$$;

revoke all on function public.is_clan_staff() from public;
revoke all on function public.is_clan_leader() from public;
grant execute on function public.is_clan_staff() to authenticated;
grant execute on function public.is_clan_leader() to authenticated;

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.victories enable row level security;
alter table public.plates enable row level security;

-- La tabla completa de perfiles no es pública: contiene edad y rutas internas.
-- La clasificación abierta se entrega mediante una función limitada más abajo.
drop policy if exists "public profiles are visible" on public.profiles;
drop policy if exists "members and staff read profiles" on public.profiles;
create policy "members and staff read profiles" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or (select public.is_clan_staff()));

drop policy if exists "members update only their profile" on public.profiles;
create policy "members update only their profile" on public.profiles
for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "staff can update profiles" on public.profiles;
create policy "staff can update profiles" on public.profiles
for update to authenticated
using ((select public.is_clan_staff()))
with check ((select public.is_clan_staff()));

drop policy if exists "members read their role" on public.user_roles;
create policy "members read their role" on public.user_roles
for select to authenticated
using (user_id = (select auth.uid()) or (select public.is_clan_staff()));

-- No existen políticas de INSERT, UPDATE ni DELETE para user_roles: las
-- promociones se hacen únicamente desde el SQL Editor por el propietario.

drop policy if exists "members read their evidence" on public.victories;
create policy "members read their evidence" on public.victories
for select to authenticated
using (player_id = (select auth.uid()) or (select public.is_clan_staff()));

drop policy if exists "members submit pending victories" on public.victories;
create policy "members submit pending victories" on public.victories
for insert to authenticated
with check (
  player_id = (select auth.uid())
  and status = 'pending'
  and reviewed_by is null
  and reviewed_at is null
  and rejection_reason is null
);

drop policy if exists "members remove their pending victories" on public.victories;
create policy "members remove their pending victories" on public.victories
for delete to authenticated
using (player_id = (select auth.uid()) and status = 'pending');

drop policy if exists "staff review victories" on public.victories;
create policy "staff review victories" on public.victories
for update to authenticated
using ((select public.is_clan_staff()))
with check ((select public.is_clan_staff()));

drop policy if exists "public plates are visible" on public.plates;
drop policy if exists "members and staff read plates" on public.plates;
create policy "members and staff read plates" on public.plates
for select to authenticated
using (player_id = (select auth.uid()) or (select public.is_clan_staff()));

drop policy if exists "leaders manage plates" on public.plates;
create policy "leaders manage plates" on public.plates
for all to authenticated
using ((select public.is_clan_leader()))
with check ((select public.is_clan_leader()) and created_by = (select auth.uid()));

-- Solo líderes pueden cambiar el estado. El ranking usa exclusivamente
-- victorias aprobadas, así que nadie puede inflar su propia clasificación.
create or replace function public.review_victory(
  p_victory_id uuid,
  p_status public.victory_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_clan_staff() then
    raise exception 'No autorizado';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'Estado de revisión no válido';
  end if;

  update public.victories
  set status = p_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = case when p_status = 'rejected' then nullif(left(p_reason, 300), '') else null end
  where id = p_victory_id
    and status = 'pending';

  if not found then
    raise exception 'La victoria no existe o ya fue revisada';
  end if;
end;
$$;

revoke all on function public.review_victory(uuid, public.victory_status, text) from public;
grant execute on function public.review_victory(uuid, public.victory_status, text) to authenticated;

-- El ranking devuelve únicamente datos pensados para ser públicos: nunca la
-- ruta de la captura, la edad, el correo ni datos de inicio de sesión.
create or replace function public.get_public_ranking()
returns table (
  player_id uuid,
  display_name text,
  country_code text,
  avatar_path text,
  victories_4v4 bigint,
  victories_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.display_name,
         p.country_code,
         p.avatar_path,
         count(v.id) filter (where v.mode = '4v4') as victories_4v4,
         count(v.id) as victories_total
  from public.profiles p
  left join public.victories v on v.player_id = p.id and v.status = 'approved'
  where p.is_public
  group by p.id, p.display_name, p.country_code, p.avatar_path
  order by victories_4v4 desc, victories_total desc, p.display_name asc;
$$;

create or replace function public.get_public_plate_ranking()
returns table (
  player_id uuid,
  display_name text,
  plate_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name, count(pl.id) as plate_count
  from public.profiles p
  left join public.plates pl on pl.player_id = p.id
  where p.is_public
  group by p.id, p.display_name
  order by plate_count desc, p.display_name asc;
$$;

revoke all on function public.get_public_ranking() from public;
revoke all on function public.get_public_plate_ranking() from public;
grant execute on function public.get_public_ranking() to anon, authenticated;
grant execute on function public.get_public_plate_ranking() to anon, authenticated;

create or replace function public.get_public_player_plates(p_player_id uuid)
returns table (
  title text,
  image_path text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select pl.title, pl.image_path, pl.created_at
  from public.plates pl
  join public.profiles p on p.id = pl.player_id
  where pl.player_id = p_player_id
    and p.is_public
  order by pl.created_at desc;
$$;

revoke all on function public.get_public_player_plates(uuid) from public;
grant execute on function public.get_public_player_plates(uuid) to anon, authenticated;

-- Buckets: avatares y placas son públicos; capturas de victoria permanecen
-- privadas para el jugador y el equipo de líderes.
insert into storage.buckets (id, name, public)
values ('lux-avatars', 'lux-avatars', true),
       ('lux-evidence', 'lux-evidence', false),
       ('lux-plates', 'lux-plates', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "public avatar read" on storage.objects;
create policy "public avatar read" on storage.objects
for select to anon, authenticated using (bucket_id = 'lux-avatars');

drop policy if exists "member manages own avatar" on storage.objects;
create policy "member manages own avatar" on storage.objects
for all to authenticated
using (bucket_id = 'lux-avatars' and (storage.foldername(name))[1] = (select auth.uid()::text))
with check (bucket_id = 'lux-avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "member reads own evidence" on storage.objects;
create policy "member reads own evidence" on storage.objects
for select to authenticated
using (
  bucket_id = 'lux-evidence'
  and ((storage.foldername(name))[1] = (select auth.uid()::text) or (select public.is_clan_staff()))
);

drop policy if exists "member uploads own evidence" on storage.objects;
create policy "member uploads own evidence" on storage.objects
for insert to authenticated
with check (bucket_id = 'lux-evidence' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "member deletes own pending evidence" on storage.objects;
drop policy if exists "staff deletes evidence" on storage.objects;
create policy "staff deletes evidence" on storage.objects
for delete to authenticated
using (bucket_id = 'lux-evidence' and (select public.is_clan_staff()));

drop policy if exists "public plate read" on storage.objects;
create policy "public plate read" on storage.objects
for select to anon, authenticated using (bucket_id = 'lux-plates');

drop policy if exists "leaders manage plate images" on storage.objects;
create policy "leaders manage plate images" on storage.objects
for all to authenticated
using (bucket_id = 'lux-plates' and (select public.is_clan_leader()))
with check (bucket_id = 'lux-plates' and (select public.is_clan_leader()));

-- Tras crear las cuentas en Auth, promociona a las líderes una vez:
-- update public.user_roles set role = 'owner' where user_id = '<UUID_DE_DAVID>';
-- update public.user_roles set role = 'leader' where user_id = '<UUID_LIDER_2>';
-- update public.user_roles set role = 'moderator' where user_id = '<UUID_LIDER_3>';
