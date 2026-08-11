-- LUX CLAN PLATFORM V3
-- Registro controlado, estados de miembro, invitaciones, auditoria, papelera,
-- notificaciones y alta atomica de victorias con proteccion anti duplicados.

create extension if not exists pgcrypto;

do $$ begin
  create type public.clan_membership_status as enum (
    'pending', 'active', 'trial', 'reserve', 'inactive', 'expelled', 'alumni'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.membership_request_status as enum (
    'pending', 'approved', 'rejected', 'cancelled'
  );
exception when duplicate_object then null;
end $$;

alter table public.profiles
  add column if not exists onboarding_complete boolean not null default false,
  add column if not exists membership_status public.clan_membership_status not null default 'pending',
  add column if not exists public_slug text,
  add column if not exists primary_game_role text,
  add column if not exists secondary_game_role text,
  add column if not exists availability_note text,
  add column if not exists experience_level text,
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists joined_at timestamptz,
  add column if not exists status_reason text,
  add column if not exists removed_at timestamptz,
  add column if not exists purge_after timestamptz,
  add column if not exists merged_into uuid references public.profiles(id);

alter table public.profiles drop constraint if exists profiles_primary_game_role_check;
alter table public.profiles add constraint profiles_primary_game_role_check
  check (primary_game_role is null or primary_game_role in ('IGL','Rusher','Soporte','Francotirador','Flexible','Suplente'));
alter table public.profiles drop constraint if exists profiles_secondary_game_role_check;
alter table public.profiles add constraint profiles_secondary_game_role_check
  check (secondary_game_role is null or secondary_game_role in ('IGL','Rusher','Soporte','Francotirador','Flexible','Suplente'));
alter table public.profiles drop constraint if exists profiles_experience_level_check;
alter table public.profiles add constraint profiles_experience_level_check
  check (experience_level is null or experience_level in ('Nuevo','Intermedio','Competitivo','Veterano'));
alter table public.profiles drop constraint if exists profiles_public_slug_check;
alter table public.profiles add constraint profiles_public_slug_check
  check (public_slug is null or public_slug ~ '^[a-z0-9][a-z0-9-]{2,59}$');
alter table public.profiles drop constraint if exists profiles_availability_note_check;
alter table public.profiles add constraint profiles_availability_note_check
  check (availability_note is null or char_length(availability_note) <= 180);
alter table public.profiles drop constraint if exists profiles_status_reason_check;
alter table public.profiles add constraint profiles_status_reason_check
  check (status_reason is null or char_length(status_reason) <= 300);

create unique index if not exists profiles_public_slug_uidx
  on public.profiles (public_slug) where public_slug is not null;
create index if not exists profiles_membership_idx
  on public.profiles (membership_status, onboarding_complete, is_public);
create index if not exists profiles_purge_idx
  on public.profiles (purge_after) where removed_at is not null;

create or replace function public.make_profile_slug(p_name text, p_id uuid)
returns text
language sql
immutable
set search_path = public
as $$
  select left(
    trim(both '-' from regexp_replace(
      lower(translate(coalesce(nullif(trim(p_name), ''), 'jugador'),
        'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')),
      '[^a-z0-9]+', '-', 'g'
    )), 46
  ) || '-' || left(replace(p_id::text, '-', ''), 8);
$$;

-- Los perfiles existentes que ya estaban completos se conservan activos.
update public.profiles
set onboarding_complete = true,
    membership_status = 'active',
    joined_at = coalesce(joined_at, created_at),
    approved_at = coalesce(approved_at, created_at),
    public_slug = coalesce(public_slug, public.make_profile_slug(display_name, id))
where display_name <> 'Jugador'
  and age is not null
  and country_code is not null
  and merged_into is null;

update public.profiles
set onboarding_complete = false,
    membership_status = 'pending',
    is_public = false,
    public_slug = coalesce(public_slug, public.make_profile_slug(display_name, id))
where display_name = 'Jugador' or age is null or country_code is null;

update public.profiles p
set onboarding_complete = true,
    membership_status = 'active',
    is_public = true,
    joined_at = coalesce(p.joined_at, p.created_at),
    approved_at = coalesce(p.approved_at, p.created_at),
    public_slug = coalesce(p.public_slug, public.make_profile_slug(p.display_name, p.id))
from public.user_roles r
where r.user_id = p.id and r.role in ('owner','leader','moderator');

alter table public.profiles alter column is_public set default false;

create table if not exists public.membership_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  status public.membership_request_status not null default 'pending',
  message text check (message is null or char_length(message) <= 500),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clan_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  label text not null default 'Invitacion LUX CLAN' check (char_length(label) between 2 and 80),
  created_by uuid not null references public.profiles(id),
  expires_at timestamptz not null,
  max_uses smallint not null default 1 check (max_uses between 1 and 100),
  uses smallint not null default 0 check (uses between 0 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (char_length(action) between 3 and 80),
  target_type text not null check (char_length(target_type) between 2 and 50),
  target_id text,
  target_user_id uuid references public.profiles(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  kind text not null default 'info' check (char_length(kind) between 2 and 40),
  title text not null check (char_length(title) between 2 and 100),
  body text not null check (char_length(body) between 2 and 600),
  action_url text check (action_url is null or char_length(action_url) <= 300),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 100),
  body text not null check (char_length(body) between 2 and 2000),
  created_by uuid not null references public.profiles(id),
  is_pinned boolean not null default false,
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists membership_requests_status_idx on public.membership_requests (status, created_at);
create index if not exists clan_invites_active_idx on public.clan_invites (is_active, expires_at);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_target_user_idx on public.audit_log (target_user_id, created_at desc);
create index if not exists notifications_user_idx on public.notifications (user_id, read_at, created_at desc);
create index if not exists announcements_active_idx on public.announcements (is_active, is_pinned desc, created_at desc);

drop trigger if exists membership_requests_updated_at on public.membership_requests;
create trigger membership_requests_updated_at before update on public.membership_requests
for each row execute procedure public.set_updated_at();
drop trigger if exists announcements_updated_at on public.announcements;
create trigger announcements_updated_at before update on public.announcements
for each row execute procedure public.set_updated_at();

create or replace function public.write_audit(
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_target_user_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log(actor_id, action, target_type, target_id, target_user_id, details)
  values (auth.uid(), left(p_action,80), left(p_target_type,50), p_target_id, p_target_user_id, coalesce(p_details,'{}'::jsonb));
end;
$$;

revoke all on function public.write_audit(text,text,text,uuid,jsonb) from public;

create or replace function public.is_active_clan_member(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = p_user_id
      and onboarding_complete
      and membership_status in ('active','trial','reserve')
      and merged_into is null
  );
$$;

revoke all on function public.is_active_clan_member(uuid) from public;
grant execute on function public.is_active_clan_member(uuid) to authenticated;

-- Una cuenta de Google crea solo una ficha privada y pendiente. No entra al
-- directorio ni al ranking hasta completar los datos y ser aprobada.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, display_name, onboarding_complete, membership_status, is_public, public_slug
  ) values (
    new.id, 'Jugador', false, 'pending', false, public.make_profile_slug('jugador', new.id)
  ) on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'member')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create or replace function public.protect_profile_security_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'postgres' and auth.uid() = old.id and not public.is_clan_staff() then
    if new.onboarding_complete is distinct from old.onboarding_complete
       or new.membership_status is distinct from old.membership_status
       or new.is_public is distinct from old.is_public
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at
       or new.joined_at is distinct from old.joined_at
       or new.status_reason is distinct from old.status_reason
       or new.removed_at is distinct from old.removed_at
       or new.purge_after is distinct from old.purge_after
       or new.merged_into is distinct from old.merged_into
       or new.public_slug is distinct from old.public_slug then
      raise exception 'No puedes cambiar el estado ni los permisos de tu cuenta';
    end if;
  end if;

  if new.onboarding_complete and (
    new.display_name = 'Jugador' or char_length(trim(new.display_name)) < 2
    or new.age is null or new.country_code is null or new.country_name is null
  ) then
    raise exception 'Nombre, edad y pais son obligatorios';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_security_fields on public.profiles;
create trigger profiles_protect_security_fields before update on public.profiles
for each row execute procedure public.protect_profile_security_fields();

create or replace function public.complete_my_onboarding(
  p_display_name text,
  p_age integer,
  p_country_code text,
  p_country_name text,
  p_avatar_path text default null,
  p_message text default null,
  p_primary_game_role text default null,
  p_secondary_game_role text default null,
  p_experience_level text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.profiles;
begin
  if auth.uid() is null then raise exception 'Inicia sesion primero'; end if;
  if char_length(trim(coalesce(p_display_name,''))) not between 2 and 24 or trim(p_display_name) = 'Jugador' then
    raise exception 'Escribe un nombre de 2 a 24 caracteres';
  end if;
  if p_age not between 13 and 99 then raise exception 'La edad debe estar entre 13 y 99'; end if;
  if char_length(trim(coalesce(p_country_code,''))) not between 2 and 3
     or char_length(trim(coalesce(p_country_name,''))) not between 2 and 60 then
    raise exception 'Selecciona un pais valido';
  end if;
  if p_avatar_path is not null and p_avatar_path not like auth.uid()::text || '/%' then
    raise exception 'Ruta de foto invalida';
  end if;

  update public.profiles
  set display_name = trim(p_display_name),
      age = p_age,
      country_code = lower(trim(p_country_code)),
      country_name = trim(p_country_name),
      avatar_path = coalesce(p_avatar_path, avatar_path),
      primary_game_role = p_primary_game_role,
      secondary_game_role = p_secondary_game_role,
      experience_level = p_experience_level,
      onboarding_complete = true,
      public_slug = public.make_profile_slug(trim(p_display_name), id),
      updated_at = now()
  where id = auth.uid() and merged_into is null
  returning * into result;

  if result.id is null then raise exception 'No se encontro el perfil'; end if;

  insert into public.membership_requests(user_id, status, message)
  values (auth.uid(), 'pending', nullif(left(trim(p_message),500),''))
  on conflict (user_id) do update
    set status = case
          when public.membership_requests.status = 'approved'
            then 'approved'::public.membership_request_status
          else 'pending'::public.membership_request_status
        end,
        message = excluded.message,
        updated_at = now();

  perform public.write_audit('onboarding_completed','profile',result.id::text,result.id,'{}'::jsonb);
  return result;
end;
$$;

revoke all on function public.complete_my_onboarding(text,integer,text,text,text,text,text,text,text) from public;
grant execute on function public.complete_my_onboarding(text,integer,text,text,text,text,text,text,text) to authenticated;

create or replace function public.staff_review_membership(
  p_user_id uuid,
  p_status text,
  p_reason text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role public.clan_role;
  target_role public.clan_role;
  requested public.clan_membership_status;
  result public.profiles;
begin
  select role into caller_role from public.user_roles where user_id = auth.uid();
  select role into target_role from public.user_roles where user_id = p_user_id;
  if caller_role not in ('owner','leader','moderator') then raise exception 'No autorizado'; end if;
  if p_user_id = auth.uid() then raise exception 'No puedes modificar tu propio estado'; end if;
  if caller_role <> 'owner' and target_role <> 'member' then raise exception 'Solo el owner gestiona cuentas del equipo'; end if;
  if p_status not in ('active','trial','reserve','inactive','expelled','alumni') then raise exception 'Estado no permitido'; end if;
  requested := p_status::public.clan_membership_status;

  if requested in ('active','trial','reserve') and not exists (
    select 1 from public.profiles where id=p_user_id and onboarding_complete
  ) then raise exception 'El integrante debe completar nombre, edad y pais'; end if;

  update public.profiles
  set membership_status = requested,
      is_public = requested in ('active','trial','reserve'),
      approved_by = case when requested in ('active','trial','reserve') then auth.uid() else approved_by end,
      approved_at = case when requested in ('active','trial','reserve') then now() else approved_at end,
      joined_at = case when requested in ('active','trial','reserve') then coalesce(joined_at,now()) else joined_at end,
      status_reason = nullif(left(trim(p_reason),300),''),
      removed_at = case when requested in ('expelled','alumni') then now() else null end,
      purge_after = case when requested in ('expelled','alumni') then now()+interval '30 days' else null end,
      updated_at = now()
  where id = p_user_id and merged_into is null
  returning * into result;
  if result.id is null then raise exception 'La cuenta no existe'; end if;

  insert into public.membership_requests(user_id,status,reviewed_by,reviewed_at,decision_reason)
  values (p_user_id,
    case when requested in ('active','trial','reserve') then 'approved'::public.membership_request_status else 'rejected'::public.membership_request_status end,
    auth.uid(),now(),nullif(left(trim(p_reason),300),''))
  on conflict(user_id) do update set
    status=excluded.status,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,
    decision_reason=excluded.decision_reason,updated_at=now();

  insert into public.notifications(user_id,kind,title,body,action_url)
  values (p_user_id,'membership','Estado de tu cuenta actualizado',
    case when requested in ('active','trial','reserve') then 'Ya puedes participar en LUX CLAN.' else 'Tu estado ahora es '||requested::text||'.' end,
    '#integrantes');
  perform public.write_audit('membership_'||requested::text,'profile',p_user_id::text,p_user_id,jsonb_build_object('reason',p_reason));
  return result;
end;
$$;

revoke all on function public.staff_review_membership(uuid,text,text) from public;
grant execute on function public.staff_review_membership(uuid,text,text) to authenticated;

create or replace function public.owner_create_invite(
  p_label text default 'Invitacion LUX CLAN',
  p_hours integer default 72,
  p_max_uses integer default 1
)
returns table(invite_id uuid, invite_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text := encode(gen_random_bytes(18),'hex');
  created public.clan_invites;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede crear invitaciones'; end if;
  if p_hours not between 1 and 720 or p_max_uses not between 1 and 100 then raise exception 'Limites de invitacion invalidos'; end if;
  insert into public.clan_invites(token_hash,label,created_by,expires_at,max_uses)
  values (digest(raw_token,'sha256'),left(coalesce(nullif(trim(p_label),''),'Invitacion LUX CLAN'),80),auth.uid(),now()+make_interval(hours=>p_hours),p_max_uses)
  returning * into created;
  perform public.write_audit('invite_created','invite',created.id::text,null,jsonb_build_object('max_uses',p_max_uses,'hours',p_hours));
  return query select created.id, raw_token, created.expires_at;
end;
$$;

revoke all on function public.owner_create_invite(text,integer,integer) from public;
grant execute on function public.owner_create_invite(text,integer,integer) to authenticated;

create or replace function public.redeem_clan_invite(p_token text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  invite public.clan_invites;
  result public.profiles;
begin
  if auth.uid() is null then raise exception 'Inicia sesion primero'; end if;
  if not public.is_active_clan_member(auth.uid()) and not exists (
    select 1 from public.profiles where id=auth.uid() and onboarding_complete
  ) then raise exception 'Completa tu perfil antes de usar la invitacion'; end if;

  select * into invite from public.clan_invites
  where token_hash=digest(trim(p_token),'sha256') and is_active and expires_at>now() and uses<max_uses
  for update;
  if invite.id is null then raise exception 'La invitacion no existe, vencio o ya fue usada'; end if;

  update public.clan_invites
  set uses=uses+1,is_active=(uses+1<max_uses)
  where id=invite.id;

  update public.profiles
  set membership_status='active',is_public=true,approved_by=invite.created_by,
      approved_at=now(),joined_at=coalesce(joined_at,now()),status_reason='Invitacion verificada',
      removed_at=null,purge_after=null,updated_at=now()
  where id=auth.uid() and onboarding_complete and merged_into is null
  returning * into result;

  insert into public.membership_requests(user_id,status,reviewed_by,reviewed_at,decision_reason)
  values(auth.uid(),'approved',invite.created_by,now(),'Invitacion verificada')
  on conflict(user_id) do update set status='approved',reviewed_by=excluded.reviewed_by,
    reviewed_at=excluded.reviewed_at,decision_reason=excluded.decision_reason,updated_at=now();
  perform public.write_audit('invite_redeemed','invite',invite.id::text,auth.uid(),'{}'::jsonb);
  return result;
end;
$$;

revoke all on function public.redeem_clan_invite(text) from public;
grant execute on function public.redeem_clan_invite(text) to authenticated;

create or replace function public.staff_soft_delete_member(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare caller_role public.clan_role; target_role public.clan_role;
begin
  select role into caller_role from public.user_roles where user_id=auth.uid();
  select role into target_role from public.user_roles where user_id=p_user_id;
  if p_user_id=auth.uid() then raise exception 'No puedes expulsarte a ti mismo'; end if;
  if caller_role not in ('owner','leader') then raise exception 'No autorizado'; end if;
  if caller_role<>'owner' and target_role<>'member' then raise exception 'Una lider solo puede expulsar integrantes'; end if;
  if target_role='owner' then raise exception 'No se puede eliminar al owner'; end if;
  perform public.staff_review_membership(p_user_id,'expelled',coalesce(nullif(trim(p_reason),''),'Expulsado del clan'));
end;
$$;

revoke all on function public.staff_soft_delete_member(uuid,text) from public;
grant execute on function public.staff_soft_delete_member(uuid,text) to authenticated;

-- Compatibilidad: el boton antiguo ya no destruye; mueve a papelera 30 dias.
create or replace function public.staff_delete_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.staff_soft_delete_member(p_user_id,'Expulsado desde el panel');
end;
$$;

revoke all on function public.staff_delete_member(uuid) from public;
grant execute on function public.staff_delete_member(uuid) to authenticated;

create or replace function public.owner_restore_member(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare result public.profiles;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede restaurar cuentas'; end if;
  update public.profiles set membership_status='active',is_public=onboarding_complete,
    removed_at=null,purge_after=null,status_reason='Restaurado por el owner',updated_at=now()
  where id=p_user_id and merged_into is null returning * into result;
  if result.id is null then raise exception 'La cuenta no existe'; end if;
  perform public.write_audit('member_restored','profile',p_user_id::text,p_user_id,'{}'::jsonb);
  return result;
end;
$$;

revoke all on function public.owner_restore_member(uuid) from public;
grant execute on function public.owner_restore_member(uuid) to authenticated;

-- El borrado fisico solo se habilita al owner cuando pasaron los 30 dias.
create or replace function public.owner_purge_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare target_role public.clan_role;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede vaciar la papelera'; end if;
  select role into target_role from public.user_roles where user_id=p_user_id;
  if target_role='owner' or p_user_id=auth.uid() then raise exception 'Cuenta protegida'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id and purge_after<=now()) then
    raise exception 'La cuenta aun puede restaurarse o no esta en la papelera';
  end if;
  perform public.write_audit('member_purged','profile',p_user_id::text,p_user_id,'{}'::jsonb);
  delete from auth.users where id=p_user_id;
end;
$$;

revoke all on function public.owner_purge_member(uuid) from public;
grant execute on function public.owner_purge_member(uuid) to authenticated;

-- Proteccion de victorias: la insercion directa queda cerrada. El servidor
-- comprueba estado, limites, SHA-256 y una huella visual dHash de 64 bits.
alter table public.victories
  add column if not exists evidence_dhash text,
  add column if not exists duplicate_risk boolean not null default false,
  add column if not exists duplicate_of uuid references public.victories(id),
  add column if not exists client_captured_at timestamptz;

alter table public.victories drop constraint if exists victories_evidence_dhash_check;
alter table public.victories add constraint victories_evidence_dhash_check
  check (evidence_dhash is null or evidence_dhash ~ '^[0-9a-f]{16}$');
create index if not exists victories_dhash_idx on public.victories(evidence_dhash) where evidence_dhash is not null;

create or replace function public.hex_hamming_distance(p_left text, p_right text)
returns integer
language plpgsql
immutable
strict
set search_path = public
as $$
declare left_bytes bytea; right_bytes bytea; total integer:=0; i integer; bits text;
begin
  if p_left !~ '^[0-9a-f]{16}$' or p_right !~ '^[0-9a-f]{16}$' then return 64; end if;
  left_bytes:=decode(p_left,'hex'); right_bytes:=decode(p_right,'hex');
  for i in 0..7 loop
    bits:=((get_byte(left_bytes,i) # get_byte(right_bytes,i))::bit(8))::text;
    total:=total+char_length(replace(bits,'0',''));
  end loop;
  return total;
end;
$$;

drop policy if exists "members submit pending victories" on public.victories;

create or replace function public.submit_victory_secure(
  p_mode text,
  p_evidence_path text,
  p_evidence_sha256 text,
  p_evidence_dhash text default null,
  p_client_captured_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare result uuid; similar_id uuid; similar_distance integer:=64;
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then
    raise exception 'Tu perfil debe estar completo y aprobado';
  end if;
  if p_mode not in ('1v1','2v2','3v3','4v4','Otro') then raise exception 'Modo invalido'; end if;
  if p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/%' then raise exception 'Ruta invalida'; end if;
  if p_evidence_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Huella SHA-256 invalida'; end if;
  if p_evidence_dhash is not null and p_evidence_dhash !~ '^[0-9a-f]{16}$' then raise exception 'Huella visual invalida'; end if;
  if exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256) then raise exception 'Esta captura ya fue enviada'; end if;
  if (select count(*) from public.victories where player_id=auth.uid() and created_at>now()-interval '24 hours')>=6 then
    raise exception 'Limite diario alcanzado: maximo 6 capturas';
  end if;
  if (select count(*) from public.victories where player_id=auth.uid() and status='pending')>=4 then
    raise exception 'Tienes 4 capturas pendientes; espera la revision';
  end if;

  if p_evidence_dhash is not null then
    select id, public.hex_hamming_distance(evidence_dhash,p_evidence_dhash)
      into similar_id,similar_distance
    from public.victories
    where evidence_dhash is not null and created_at>now()-interval '2 years'
    order by public.hex_hamming_distance(evidence_dhash,p_evidence_dhash),created_at desc
    limit 1;
    if similar_distance<=3 then raise exception 'La imagen es igual o casi igual a una captura ya enviada'; end if;
  end if;

  insert into public.victories(player_id,mode,evidence_path,evidence_sha256,evidence_dhash,
    duplicate_risk,duplicate_of,client_captured_at,status)
  values(auth.uid(),p_mode,p_evidence_path,p_evidence_sha256,p_evidence_dhash,
    coalesce(similar_distance<=8,false),case when similar_distance<=8 then similar_id else null end,
    p_client_captured_at,'pending') returning id into result;
  perform public.write_audit('victory_submitted','victory',result::text,auth.uid(),jsonb_build_object('mode',p_mode,'duplicate_risk',similar_distance<=8));
  return result;
exception when unique_violation then
  raise exception 'Esta captura ya fue enviada';
end;
$$;

revoke all on function public.submit_victory_secure(text,text,text,text,timestamptz) from public;
grant execute on function public.submit_victory_secure(text,text,text,text,timestamptz) to authenticated;

create or replace function public.can_submit_victory(p_evidence_sha256 text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and public.is_active_clan_member(auth.uid())
    and p_evidence_sha256 ~ '^[0-9a-f]{64}$'
    and not exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256)
    and (select count(*) from public.victories where player_id=auth.uid() and created_at>now()-interval '24 hours')<6
    and (select count(*) from public.victories where player_id=auth.uid() and status='pending')<4;
$$;

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
declare target_user uuid; risk boolean;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Estado invalido'; end if;
  update public.victories set status=p_status,reviewed_by=auth.uid(),reviewed_at=now(),
    rejection_reason=case when p_status='rejected' then nullif(left(trim(p_reason),300),'') else null end
  where id=p_victory_id and status='pending'
  returning player_id,duplicate_risk into target_user,risk;
  if target_user is null then raise exception 'La victoria no existe o ya fue revisada'; end if;
  insert into public.notifications(user_id,kind,title,body,action_url)
  values(target_user,'victory',case when p_status='approved' then 'Victoria aprobada' else 'Victoria rechazada' end,
    case when p_status='approved' then 'La captura ya suma a tus estadisticas.' else coalesce(nullif(trim(p_reason),''),'La captura no fue aceptada.') end,
    '#integrantes');
  perform public.write_audit('victory_'||p_status::text,'victory',p_victory_id::text,target_user,jsonb_build_object('reason',p_reason,'duplicate_risk',risk));
end;
$$;

alter table public.membership_requests enable row level security;
alter table public.clan_invites enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;
alter table public.announcements enable row level security;

drop policy if exists "members read own membership request" on public.membership_requests;
create policy "members read own membership request" on public.membership_requests
for select to authenticated using(user_id=auth.uid() or public.is_clan_staff());

drop policy if exists "owner manages invites" on public.clan_invites;
create policy "owner manages invites" on public.clan_invites
for all to authenticated using(public.is_clan_owner()) with check(public.is_clan_owner() and created_by=auth.uid());

drop policy if exists "staff reads audit" on public.audit_log;
create policy "staff reads audit" on public.audit_log
for select to authenticated using(public.is_clan_staff());

drop policy if exists "members read own notifications" on public.notifications;
create policy "members read own notifications" on public.notifications
for select to authenticated using(user_id=auth.uid() or user_id is null);
drop policy if exists "members mark own notifications read" on public.notifications;
create policy "members mark own notifications read" on public.notifications
for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());

drop policy if exists "members read active announcements" on public.announcements;
create policy "members read active announcements" on public.announcements
for select to authenticated using(is_active and (expires_at is null or expires_at>now()));
drop policy if exists "staff manages announcements" on public.announcements;
create policy "staff manages announcements" on public.announcements
for all to authenticated using(public.is_clan_staff()) with check(public.is_clan_staff() and created_by=auth.uid());

-- Solo miembros aceptados pueden guardar nuevos archivos de evidencia.
drop policy if exists "member uploads own evidence" on storage.objects;
create policy "member uploads own evidence" on storage.objects
for insert to authenticated with check(
  bucket_id='lux-evidence'
  and (storage.foldername(name))[1]=auth.uid()::text
  and public.is_active_clan_member(auth.uid())
);

revoke all on public.membership_requests,public.clan_invites,public.audit_log,public.notifications,public.announcements from anon;
grant select on public.membership_requests,public.clan_invites,public.audit_log,public.notifications,public.announcements to authenticated;
grant update on public.notifications to authenticated;
grant insert,update,delete on public.announcements to authenticated;

notify pgrst, 'reload schema';
