-- FLUXO: una sola fuente de verdad para Cuentas, Integrantes y rankings.
-- Las cuentas expulsadas se ocultan de inmediato y permanecen 30 dias en
-- la papelera del owner antes de permitir el borrado fisico.

create or replace function public.enforce_profile_visibility()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.is_public := new.onboarding_complete
    and new.membership_status in ('active','trial','reserve')
    and new.removed_at is null
    and new.merged_into is null;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_visibility on public.profiles;
create trigger profiles_enforce_visibility
before insert or update of onboarding_complete,membership_status,removed_at,merged_into,is_public
on public.profiles
for each row execute procedure public.enforce_profile_visibility();

-- Corrige fichas historicas que quedaron publicas despues de una expulsion,
-- fusion o registro incompleto.
update public.profiles
set is_public = onboarding_complete
  and membership_status in ('active','trial','reserve')
  and removed_at is null
  and merged_into is null
where is_public is distinct from (
  onboarding_complete
  and membership_status in ('active','trial','reserve')
  and removed_at is null
  and merged_into is null
);

create or replace function public.is_active_clan_member(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    join auth.users u on u.id=p.id
    where p.id=p_user_id
      and p.onboarding_complete
      and p.is_public
      and p.membership_status in ('active','trial','reserve')
      and p.removed_at is null
      and p.merged_into is null
  );
$$;

revoke all on function public.is_active_clan_member(uuid) from public;
grant execute on function public.is_active_clan_member(uuid) to authenticated;

-- Una expulsion tambien funciona con cuentas antiguas o incompletas. Antes
-- esta operacion dependia de que la ficha ya estuviera bien creada.
create or replace function public.staff_soft_delete_member(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_role public.clan_role;
  target_role public.clan_role;
begin
  select role into caller_role from public.user_roles where user_id=auth.uid();
  select role into target_role from public.user_roles where user_id=p_user_id;

  if p_user_id=auth.uid() then raise exception 'No puedes expulsarte a ti mismo'; end if;
  if caller_role not in ('owner','leader') then raise exception 'No autorizado'; end if;
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'La cuenta no existe'; end if;
  if target_role='owner' then raise exception 'No se puede eliminar al owner'; end if;
  if caller_role<>'owner' and coalesce(target_role,'member')<>'member' then
    raise exception 'Una lider solo puede expulsar integrantes';
  end if;

  insert into public.profiles(id,display_name,is_public,onboarding_complete,membership_status)
  values(p_user_id,'Jugador',false,false,'pending')
  on conflict(id) do nothing;
  insert into public.user_roles(user_id,role)
  values(p_user_id,'member')
  on conflict(user_id) do nothing;

  update public.profiles
  set membership_status='expelled',
      is_public=false,
      status_reason=coalesce(nullif(left(trim(p_reason),300),''),'Expulsado del clan'),
      removed_at=now(),
      purge_after=now()+interval '30 days',
      updated_at=now()
  where id=p_user_id and merged_into is null;

  if not found then raise exception 'La cuenta ya fue fusionada o eliminada'; end if;

  -- Si el owner expulsa a una antigua lider/moderadora, sus permisos se
  -- revocan en la misma transaccion.
  update public.user_roles set role='member',assigned_at=now()
  where user_id=p_user_id and role<>'owner';

  insert into public.membership_requests(user_id,status,reviewed_by,reviewed_at,decision_reason)
  values(p_user_id,'rejected',auth.uid(),now(),coalesce(nullif(left(trim(p_reason),300),''),'Expulsado del clan'))
  on conflict(user_id) do update set status='rejected',reviewed_by=excluded.reviewed_by,
    reviewed_at=excluded.reviewed_at,decision_reason=excluded.decision_reason,updated_at=now();

  insert into public.notifications(user_id,kind,title,body,action_url)
  values(p_user_id,'membership','Cuenta retirada de FLUXO',
    'Tu perfil ya no aparece en el directorio ni en las clasificaciones.','#integrantes');

  perform public.write_audit('membership_expelled','profile',p_user_id::text,p_user_id,
    jsonb_build_object('reason',p_reason,'recoverable_until',now()+interval '30 days'));
end;
$$;

revoke all on function public.staff_soft_delete_member(uuid,text) from public;
grant execute on function public.staff_soft_delete_member(uuid,text) to authenticated;

-- Cuentas reales y operativas: incluye perfiles incompletos y pendientes,
-- pero nunca mezcla la papelera con la lista principal.
drop function if exists public.owner_list_clan_users();
create function public.owner_list_clan_users()
returns table(
  user_id uuid,email text,display_name text,role text,providers text,created_at timestamptz,last_sign_in_at timestamptz,
  onboarding_complete boolean,membership_status text,removed_at timestamptz,purge_after timestamptz,merged_into uuid,
  avatar_path text
)
language plpgsql
stable
security definer
set search_path = public,auth
as $$
begin
  if not public.is_clan_owner() then raise exception 'No autorizado'; end if;
  return query
  select u.id,u.email::text,coalesce(p.display_name,'Jugador')::text,coalesce(r.role::text,'member')::text,
    coalesce(string_agg(distinct i.provider::text,', ' order by i.provider::text),'')::text,
    u.created_at,u.last_sign_in_at,coalesce(p.onboarding_complete,false),
    coalesce(p.membership_status::text,'pending'),p.removed_at,p.purge_after,p.merged_into,p.avatar_path
  from auth.users u
  left join public.profiles p on p.id=u.id
  left join public.user_roles r on r.user_id=u.id
  left join auth.identities i on i.user_id=u.id
  where (p.id is null or (p.removed_at is null and p.merged_into is null))
  group by u.id,u.email,p.display_name,r.role,u.created_at,u.last_sign_in_at,
    p.onboarding_complete,p.membership_status,p.removed_at,p.purge_after,p.merged_into,p.avatar_path
  order by u.created_at;
end;
$$;

revoke all on function public.owner_list_clan_users() from public;
grant execute on function public.owner_list_clan_users() to authenticated;

create or replace function public.owner_list_removed_users()
returns table(
  user_id uuid,email text,display_name text,role text,providers text,created_at timestamptz,last_sign_in_at timestamptz,
  onboarding_complete boolean,membership_status text,removed_at timestamptz,purge_after timestamptz,merged_into uuid,
  avatar_path text
)
language plpgsql
stable
security definer
set search_path = public,auth
as $$
begin
  if not public.is_clan_owner() then raise exception 'No autorizado'; end if;
  return query
  select u.id,u.email::text,p.display_name::text,coalesce(r.role::text,'member')::text,
    coalesce(string_agg(distinct i.provider::text,', ' order by i.provider::text),'')::text,
    u.created_at,u.last_sign_in_at,p.onboarding_complete,p.membership_status::text,
    p.removed_at,p.purge_after,p.merged_into,p.avatar_path
  from auth.users u
  join public.profiles p on p.id=u.id
  left join public.user_roles r on r.user_id=u.id
  left join auth.identities i on i.user_id=u.id
  where p.removed_at is not null and p.merged_into is null
  group by u.id,u.email,p.display_name,r.role,u.created_at,u.last_sign_in_at,
    p.onboarding_complete,p.membership_status,p.removed_at,p.purge_after,p.merged_into,p.avatar_path
  order by p.removed_at desc;
end;
$$;

revoke all on function public.owner_list_removed_users() from public;
grant execute on function public.owner_list_removed_users() to authenticated;

-- Los numeros del panel solo cuentan integrantes que siguen dentro del clan.
create or replace function public.get_admin_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  return jsonb_build_object(
    'active_members',(select count(*) from public.profiles where onboarding_complete and is_public
      and membership_status in ('active','trial','reserve') and removed_at is null and merged_into is null),
    'active_this_week',(select count(distinct activity.player_id) from (
      select v.player_id from public.victories v join public.profiles p on p.id=v.player_id
        where v.created_at>=date_trunc('week',now()) and p.is_public and p.removed_at is null and p.merged_into is null
      union all
      select mp.player_id from public.match_participants mp join public.matches m on m.id=mp.match_id
        join public.profiles p on p.id=mp.player_id
        where m.played_at>=date_trunc('week',now()) and p.is_public and p.removed_at is null and p.merged_into is null
      union all
      select s.player_id from public.clan_activity_snapshots s join public.profiles p on p.id=s.player_id
        where s.created_at>=date_trunc('week',now()) and p.is_public and p.removed_at is null and p.merged_into is null
    ) activity),
    'pending_members',(select count(*) from public.profiles where onboarding_complete and membership_status='pending'
      and removed_at is null and merged_into is null),
    'incomplete_profiles',(select count(*) from public.profiles where not onboarding_complete
      and removed_at is null and merged_into is null),
    'inactive_30_days',(select count(*) from public.profiles p where p.membership_status in ('active','trial','reserve')
      and p.is_public and p.removed_at is null and p.merged_into is null and
      greatest(p.updated_at,coalesce((select max(v.created_at) from public.victories v where v.player_id=p.id),p.created_at),
        coalesce((select max(m.played_at) from public.match_participants mp join public.matches m on m.id=mp.match_id where mp.player_id=p.id),p.created_at))<now()-interval '30 days'),
    'joined_this_week',(select count(*) from public.profiles where joined_at>=date_trunc('week',now())
      and removed_at is null and merged_into is null),
    'joined_previous_week',(select count(*) from public.profiles where joined_at>=date_trunc('week',now())-interval '7 days'
      and joined_at<date_trunc('week',now()) and removed_at is null and merged_into is null),
    'pending_victories',(select count(*) from public.victories v join public.profiles p on p.id=v.player_id
      where v.status='pending' and p.is_public and p.removed_at is null and p.merged_into is null),
    'risky_victories',(select count(*) from public.victories v join public.profiles p on p.id=v.player_id
      where v.status='pending' and v.duplicate_risk and p.is_public and p.removed_at is null and p.merged_into is null),
    'pending_matches',(select count(distinct m.id) from public.matches m join public.match_participants mp on mp.match_id=m.id
      join public.profiles p on p.id=mp.player_id where m.status='pending' and p.is_public and p.removed_at is null and p.merged_into is null),
    'risky_matches',(select count(distinct m.id) from public.matches m join public.match_participants mp on mp.match_id=m.id
      join public.profiles p on p.id=mp.player_id where m.status='pending' and m.duplicate_risk and p.is_public and p.removed_at is null and p.merged_into is null),
    'open_events',(select count(*) from public.clan_events where status='open' and scheduled_at>now()),
    'next_event',(select jsonb_build_object('id',id,'title',title,'scheduled_at',scheduled_at,'mode',mode)
      from public.clan_events where status='open' and scheduled_at>now() order by scheduled_at limit 1),
    'trash_members',(select count(*) from public.profiles where removed_at is not null and merged_into is null),
    'last_plate_import',(select max(captured_on) from public.clan_activity_imports),
    'unread_notifications',(select count(*) from public.notifications where user_id=auth.uid() and read_at is null)
  );
end;
$$;

revoke all on function public.get_admin_dashboard_summary() from public;
grant execute on function public.get_admin_dashboard_summary() to authenticated;

notify pgrst, 'reload schema';
