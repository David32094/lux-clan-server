-- Acceso administrable al clan.
-- open: cualquier cuenta de Google queda activa al completar su ficha.
-- approval: cualquiera puede registrarse, pero espera la aprobación del equipo.
-- invite_only: solo un enlace temporal puede activar a una cuenta nueva.

create table if not exists public.clan_access_settings (
  singleton boolean primary key default true check (singleton),
  access_mode text not null default 'open' check (access_mode in ('open','approval','invite_only')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.clan_access_settings(singleton,access_mode)
values (true,'open')
on conflict(singleton) do nothing;

update public.profiles
set membership_status='active',is_public=true,
    approved_by=coalesce(approved_by,(select user_id from public.user_roles where role='owner' limit 1)),
    approved_at=coalesce(approved_at,now()),joined_at=coalesce(joined_at,now()),
    status_reason='Acceso general abierto',updated_at=now()
where onboarding_complete and membership_status='pending' and merged_into is null
  and (select access_mode from public.clan_access_settings where singleton)='open';

update public.membership_requests
set status='approved',reviewed_by=coalesce(reviewed_by,(select user_id from public.user_roles where role='owner' limit 1)),
    reviewed_at=coalesce(reviewed_at,now()),decision_reason='Acceso general abierto',updated_at=now()
where status='pending'
  and (select access_mode from public.clan_access_settings where singleton)='open';

alter table public.clan_access_settings enable row level security;

drop policy if exists "everyone reads clan access mode" on public.clan_access_settings;
create policy "everyone reads clan access mode" on public.clan_access_settings
for select to anon,authenticated using (true);

create or replace function public.get_clan_access_settings()
returns table(access_mode text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.access_mode,s.updated_at
  from public.clan_access_settings s
  where s.singleton
  limit 1;
$$;

revoke all on function public.get_clan_access_settings() from public;
grant execute on function public.get_clan_access_settings() to anon,authenticated;

create or replace function public.owner_set_clan_access_mode(p_mode text)
returns public.clan_access_settings
language plpgsql
security definer
set search_path = public
as $$
declare result public.clan_access_settings;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede cambiar el acceso'; end if;
  if p_mode not in ('open','approval','invite_only') then raise exception 'Modo de acceso no permitido'; end if;

  insert into public.clan_access_settings(singleton,access_mode,updated_by,updated_at)
  values(true,p_mode,auth.uid(),now())
  on conflict(singleton) do update set
    access_mode=excluded.access_mode,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  returning * into result;

  -- Abrir el registro también libera las fichas completas que ya estaban
  -- esperando. Restringirlo nunca expulsa a quienes ya pertenecen al clan.
  if p_mode='open' then
    update public.profiles
    set membership_status='active',is_public=true,approved_by=auth.uid(),approved_at=coalesce(approved_at,now()),
        joined_at=coalesce(joined_at,now()),status_reason='Acceso general abierto',updated_at=now()
    where onboarding_complete and membership_status='pending' and merged_into is null;

    update public.membership_requests
    set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),decision_reason='Acceso general abierto',updated_at=now()
    where status='pending';
  end if;

  perform public.write_audit('access_mode_changed','settings','clan-access',null,jsonb_build_object('mode',p_mode));
  return result;
end;
$$;

revoke all on function public.owner_set_clan_access_mode(text) from public;
grant execute on function public.owner_set_clan_access_mode(text) to authenticated;

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
  current_status public.clan_membership_status;
  selected_mode text := 'approval';
  approved_now boolean := false;
begin
  if auth.uid() is null then raise exception 'Inicia sesion primero'; end if;
  if char_length(trim(coalesce(p_display_name,''))) not between 2 and 24 or trim(p_display_name)='Jugador' then
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

  select membership_status into current_status from public.profiles where id=auth.uid() and merged_into is null;
  select access_mode into selected_mode from public.clan_access_settings where singleton;
  selected_mode := coalesce(selected_mode,'approval');
  approved_now := current_status in ('active','trial','reserve') or selected_mode='open' or public.is_clan_staff();

  update public.profiles
  set display_name=trim(p_display_name),age=p_age,country_code=lower(trim(p_country_code)),country_name=trim(p_country_name),
      avatar_path=coalesce(p_avatar_path,avatar_path),primary_game_role=p_primary_game_role,
      secondary_game_role=p_secondary_game_role,experience_level=p_experience_level,onboarding_complete=true,
      membership_status=case when approved_now then
        case when current_status in ('trial','reserve') then current_status else 'active'::public.clan_membership_status end
        else 'pending'::public.clan_membership_status end,
      is_public=approved_now,
      approved_at=case when approved_now then coalesce(approved_at,now()) else approved_at end,
      joined_at=case when approved_now then coalesce(joined_at,now()) else joined_at end,
      status_reason=case when selected_mode='open' and approved_now then 'Acceso general abierto' else status_reason end,
      public_slug=public.make_profile_slug(trim(p_display_name),id),updated_at=now()
  where id=auth.uid() and merged_into is null
  returning * into result;

  if result.id is null then raise exception 'No se encontro el perfil'; end if;

  insert into public.membership_requests(user_id,status,message,reviewed_at,decision_reason)
  values(auth.uid(),case when approved_now then 'approved'::public.membership_request_status else 'pending'::public.membership_request_status end,
    nullif(left(trim(p_message),500),''),case when approved_now then now() else null end,
    case when selected_mode='open' then 'Acceso general abierto' else null end)
  on conflict(user_id) do update set
    status=case when approved_now or public.membership_requests.status='approved' then 'approved'::public.membership_request_status else 'pending'::public.membership_request_status end,
    message=excluded.message,reviewed_at=case when approved_now then now() else public.membership_requests.reviewed_at end,
    decision_reason=case when selected_mode='open' then 'Acceso general abierto' else public.membership_requests.decision_reason end,
    updated_at=now();

  perform public.write_audit('onboarding_completed','profile',result.id::text,result.id,jsonb_build_object('access_mode',selected_mode,'activated',approved_now));
  return result;
end;
$$;

revoke all on function public.complete_my_onboarding(text,integer,text,text,text,text,text,text,text) from public;
grant execute on function public.complete_my_onboarding(text,integer,text,text,text,text,text,text,text) to authenticated;

revoke all on public.clan_access_settings from anon,authenticated;
grant select on public.clan_access_settings to anon,authenticated;

notify pgrst, 'reload schema';
