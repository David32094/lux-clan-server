-- LUX CLAN PLATFORM V3
-- Operaciones: alias, lotes de placas, fusion de duplicados, respaldo,
-- papelera visible, resumen administrativo y notificaciones internas.

alter table public.game_player_aliases
  add column if not exists is_active boolean not null default true,
  add column if not exists notes text,
  add column if not exists match_confidence numeric(5,2);

alter table public.game_player_aliases drop constraint if exists game_player_aliases_notes_check;
alter table public.game_player_aliases add constraint game_player_aliases_notes_check
  check (notes is null or char_length(notes) <= 300);
alter table public.game_player_aliases drop constraint if exists game_player_aliases_match_confidence_check;
alter table public.game_player_aliases add constraint game_player_aliases_match_confidence_check
  check (match_confidence is null or match_confidence between 0 and 100);

alter table public.clan_activity_imports
  add column if not exists batch_id uuid,
  add column if not exists source_index smallint not null default 0;

alter table public.clan_activity_snapshots
  add column if not exists name_confidence numeric(5,2),
  add column if not exists glory_week_confidence numeric(5,2),
  add column if not exists glory_total_confidence numeric(5,2),
  add column if not exists plates_week_confidence numeric(5,2),
  add column if not exists plates_total_confidence numeric(5,2),
  add column if not exists needs_review boolean not null default false;

create table if not exists public.backup_restores (
  id uuid primary key default gen_random_uuid(),
  restored_by uuid not null references public.profiles(id),
  backup_version text not null,
  dry_run boolean not null,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.backup_restores enable row level security;
create policy "owner reads backup restores" on public.backup_restores
for select to authenticated using(public.is_clan_owner());
revoke all on public.backup_restores from anon;
grant select on public.backup_restores to authenticated;

drop policy if exists "owner restores clan storage" on storage.objects;
create policy "owner restores clan storage" on storage.objects
for all to authenticated
using(bucket_id in ('lux-avatars','lux-evidence','lux-banners','lux-plates','lux-clan-imports') and public.is_clan_owner())
with check(bucket_id in ('lux-avatars','lux-evidence','lux-banners','lux-plates','lux-clan-imports') and public.is_clan_owner());

create or replace function public.staff_set_game_alias(
  p_player_id uuid,p_game_name text,p_notes text default null,p_confidence numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare normalized_alias text; result uuid;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  if not exists(select 1 from public.profiles where id=p_player_id and merged_into is null) then raise exception 'Integrante invalido'; end if;
  normalized_alias:=upper(regexp_replace(translate(trim(p_game_name),'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN'),'[^A-Za-z0-9]+','','g'));
  if char_length(normalized_alias) not between 1 and 80 then raise exception 'Nombre de juego invalido'; end if;
  if exists(select 1 from public.game_player_aliases where alias_key=normalized_alias and player_id<>p_player_id and is_active) then
    raise exception 'Este nombre del juego ya pertenece a otro integrante';
  end if;
  insert into public.game_player_aliases(alias_key,game_name,player_id,created_by,last_seen_at,is_active,notes,match_confidence)
  values(normalized_alias,trim(p_game_name),p_player_id,auth.uid(),now(),true,nullif(left(trim(p_notes),300),''),p_confidence)
  on conflict(alias_key) do update set game_name=excluded.game_name,player_id=excluded.player_id,last_seen_at=now(),
    is_active=true,notes=excluded.notes,match_confidence=excluded.match_confidence
  returning id into result;
  perform public.write_audit('alias_saved','alias',result::text,p_player_id,jsonb_build_object('game_name',p_game_name));
  return result;
end;
$$;

revoke all on function public.staff_set_game_alias(uuid,text,text,numeric) from public;
grant execute on function public.staff_set_game_alias(uuid,text,text,numeric) to authenticated;

create or replace function public.staff_disable_game_alias(p_alias_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare target uuid;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  update public.game_player_aliases set is_active=false,last_seen_at=now() where id=p_alias_id returning player_id into target;
  if target is null then raise exception 'Alias no encontrado'; end if;
  perform public.write_audit('alias_disabled','alias',p_alias_id::text,target,'{}'::jsonb);
end;
$$;

revoke all on function public.staff_disable_game_alias(uuid) from public;
grant execute on function public.staff_disable_game_alias(uuid) to authenticated;

create or replace function public.staff_list_alias_conflicts()
returns table(alias_id uuid,game_name text,alias_key text,player_id uuid,display_name text,last_seen_at timestamptz,match_confidence numeric,is_active boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  return query select a.id,a.game_name,a.alias_key,a.player_id,p.display_name,a.last_seen_at,a.match_confidence,a.is_active
  from public.game_player_aliases a join public.profiles p on p.id=a.player_id
  order by a.is_active desc,a.last_seen_at desc,a.game_name;
end;
$$;

revoke all on function public.staff_list_alias_conflicts() from public;
grant execute on function public.staff_list_alias_conflicts() to authenticated;

create or replace function public.staff_submit_activity_batch(p_captures jsonb)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  batch uuid:=gen_random_uuid();
  capture record;
  new_import uuid;
  results uuid[]:='{}';
  capture_count integer;
begin
  if not public.is_clan_leader() then raise exception 'Solo una lider puede importar placas'; end if;
  if jsonb_typeof(p_captures)<>'array' then raise exception 'Lote invalido'; end if;
  capture_count:=jsonb_array_length(p_captures);
  if capture_count not between 1 and 12 then raise exception 'Selecciona entre 1 y 12 capturas'; end if;
  for capture in select * from jsonb_to_recordset(p_captures) as x(
    image_sha256 text,image_path text,captured_on date,rows jsonb,source_index integer
  ) loop
    new_import:=public.staff_submit_activity_snapshot(capture.image_sha256,capture.image_path,capture.captured_on,capture.rows);
    update public.clan_activity_imports set batch_id=batch,source_index=coalesce(capture.source_index,0) where id=new_import;
    update public.clan_activity_snapshots s set
      name_confidence=q.name_confidence,
      glory_week_confidence=q.glory_week_confidence,
      glory_total_confidence=q.glory_total_confidence,
      plates_week_confidence=q.plates_week_confidence,
      plates_total_confidence=q.plates_total_confidence,
      needs_review=coalesce(q.name_confidence,0)<70 or least(coalesce(q.glory_week_confidence,0),coalesce(q.glory_total_confidence,0),coalesce(q.plates_week_confidence,0),coalesce(q.plates_total_confidence,0))<65
    from jsonb_to_recordset(capture.rows) q(
      row_index integer,name_confidence numeric,glory_week_confidence numeric,glory_total_confidence numeric,
      plates_week_confidence numeric,plates_total_confidence numeric
    ) where s.import_id=new_import and s.row_index=q.row_index;
    results:=array_append(results,new_import);
  end loop;
  perform public.write_audit('activity_batch_imported','activity_batch',batch::text,null,jsonb_build_object('captures',capture_count));
  return results;
end;
$$;

revoke all on function public.staff_submit_activity_batch(jsonb) from public;
grant execute on function public.staff_submit_activity_batch(jsonb) to authenticated;

-- Fusion segura de dos fichas. Las identidades Auth no se unen desde el
-- navegador: los datos pasan a la cuenta destino y la ficha origen queda
-- marcada como fusionada para impedir que vuelva a aparecer.
create or replace function public.owner_merge_member_profiles(p_source_id uuid,p_target_id uuid,p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare part record;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede fusionar cuentas'; end if;
  if p_source_id is null or p_target_id is null or p_source_id=p_target_id then raise exception 'Selecciona dos cuentas diferentes'; end if;
  if p_source_id=auth.uid() then raise exception 'No se puede fusionar la cuenta owner de origen'; end if;
  if not exists(select 1 from public.profiles where id=p_source_id and merged_into is null)
     or not exists(select 1 from public.profiles where id=p_target_id and merged_into is null) then raise exception 'Una de las cuentas no existe o ya fue fusionada'; end if;
  if exists(select 1 from public.user_roles where user_id=p_source_id and role='owner') then raise exception 'La cuenta owner esta protegida'; end if;

  update public.profiles t set
    avatar_path=coalesce(t.avatar_path,s.avatar_path),banner_path=coalesce(t.banner_path,s.banner_path),
    primary_game_role=coalesce(t.primary_game_role,s.primary_game_role),secondary_game_role=coalesce(t.secondary_game_role,s.secondary_game_role),
    experience_level=coalesce(t.experience_level,s.experience_level),updated_at=now()
  from public.profiles s where t.id=p_target_id and s.id=p_source_id;

  update public.victories set player_id=p_target_id where player_id=p_source_id;
  update public.plates set player_id=p_target_id where player_id=p_source_id;
  update public.game_player_aliases set player_id=p_target_id where player_id=p_source_id;

  for part in select * from public.match_participants where player_id=p_source_id loop
    if exists(select 1 from public.match_participants where match_id=part.match_id and player_id=p_target_id) then
      update public.match_participants set kills=kills+part.kills,deaths=deaths+part.deaths,assists=assists+part.assists,
        damage=damage+part.damage,is_mvp=is_mvp or part.is_mvp
      where match_id=part.match_id and player_id=p_target_id;
      delete from public.match_participants where id=part.id;
    else
      update public.match_participants set player_id=p_target_id where id=part.id;
    end if;
  end loop;

  delete from public.clan_activity_snapshots s using public.clan_activity_snapshots t
    where s.player_id=p_source_id and t.player_id=p_target_id and s.import_id=t.import_id;
  update public.clan_activity_snapshots set player_id=p_target_id where player_id=p_source_id;
  delete from public.event_responses s using public.event_responses t
    where s.user_id=p_source_id and t.user_id=p_target_id and s.event_id=t.event_id;
  update public.event_responses set user_id=p_target_id where user_id=p_source_id;
  delete from public.event_roster s using public.event_roster t
    where s.user_id=p_source_id and t.user_id=p_target_id and s.event_id=t.event_id;
  update public.event_roster set user_id=p_target_id where user_id=p_source_id;
  update public.notifications set user_id=p_target_id where user_id=p_source_id;

  update public.profiles set membership_status='alumni',is_public=false,merged_into=p_target_id,
    removed_at=now(),purge_after=null,status_reason=coalesce(nullif(left(trim(p_reason),300),''),'Cuenta fusionada'),updated_at=now()
  where id=p_source_id;
  update public.user_roles set role='member' where user_id=p_source_id;
  perform public.write_audit('profiles_merged','profile',p_source_id::text,p_target_id,
    jsonb_build_object('source',p_source_id,'target',p_target_id,'reason',p_reason));
end;
$$;

revoke all on function public.owner_merge_member_profiles(uuid,uuid,text) from public;
grant execute on function public.owner_merge_member_profiles(uuid,uuid,text) to authenticated;

drop function if exists public.owner_list_clan_users();
create function public.owner_list_clan_users()
returns table(
  user_id uuid,email text,display_name text,role text,providers text,created_at timestamptz,last_sign_in_at timestamptz,
  onboarding_complete boolean,membership_status text,removed_at timestamptz,purge_after timestamptz,merged_into uuid
)
language plpgsql
stable
security definer
set search_path = public,auth
as $$
begin
  if not public.is_clan_owner() then raise exception 'No autorizado'; end if;
  return query select u.id,u.email::text,coalesce(p.display_name,'Jugador')::text,coalesce(r.role::text,'member')::text,
    coalesce(string_agg(distinct i.provider::text,', ' order by i.provider::text),'')::text,u.created_at,u.last_sign_in_at,
    coalesce(p.onboarding_complete,false),coalesce(p.membership_status::text,'pending'),p.removed_at,p.purge_after,p.merged_into
  from auth.users u left join public.profiles p on p.id=u.id left join public.user_roles r on r.user_id=u.id
  left join auth.identities i on i.user_id=u.id
  group by u.id,u.email,p.display_name,r.role,u.created_at,u.last_sign_in_at,p.onboarding_complete,p.membership_status,p.removed_at,p.purge_after,p.merged_into
  order by (p.removed_at is not null),u.created_at;
end;
$$;

revoke all on function public.owner_list_clan_users() from public;
grant execute on function public.owner_list_clan_users() to authenticated;

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
    'active_members',(select count(*) from public.profiles where membership_status in ('active','trial','reserve') and merged_into is null),
    'pending_members',(select count(*) from public.profiles where onboarding_complete and membership_status='pending' and merged_into is null),
    'incomplete_profiles',(select count(*) from public.profiles where not onboarding_complete and merged_into is null),
    'pending_victories',(select count(*) from public.victories where status='pending'),
    'risky_victories',(select count(*) from public.victories where status='pending' and duplicate_risk),
    'pending_matches',(select count(*) from public.matches where status='pending'),
    'open_events',(select count(*) from public.clan_events where status='open' and scheduled_at>now()),
    'trash_members',(select count(*) from public.profiles where removed_at is not null and merged_into is null),
    'last_plate_import',(select max(captured_on) from public.clan_activity_imports),
    'unread_notifications',(select count(*) from public.notifications where user_id=auth.uid() and read_at is null)
  );
end;
$$;

revoke all on function public.get_admin_dashboard_summary() from public;
grant execute on function public.get_admin_dashboard_summary() to authenticated;

create or replace function public.mark_my_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  update public.notifications set read_at=coalesce(read_at,now())
  where user_id=auth.uid() and (p_ids is null or id=any(p_ids));
  get diagnostics affected=row_count;
  return affected;
end;
$$;

revoke all on function public.mark_my_notifications_read(uuid[]) from public;
grant execute on function public.mark_my_notifications_read(uuid[]) to authenticated;

-- El JSON contiene todos los registros y un manifiesto de archivos. El cliente
-- descarga tambien cada objeto para producir un respaldo autocontenido.
create or replace function public.owner_export_platform_backup()
returns jsonb
language plpgsql
stable
security definer
set search_path = public,auth,storage
as $$
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede crear respaldos completos'; end if;
  return jsonb_build_object(
    'schema_version','lux-clan-v3','generated_at',now(),'generated_by',auth.uid(),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'created_at',u.created_at,'last_sign_in_at',u.last_sign_in_at)),'[]'::jsonb) from auth.users u),
    'profiles',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.profiles x),
    'roles',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.user_roles x),
    'invites',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.clan_invites x),
    'membership_requests',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.membership_requests x),
    'victories',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.victories x),
    'matches',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.matches x),
    'match_participants',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.match_participants x),
    'plates',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.plates x),
    'aliases',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.game_player_aliases x),
    'activity_imports',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.clan_activity_imports x),
    'activity_snapshots',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.clan_activity_snapshots x),
    'seasons',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.seasons x),
    'events',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.clan_events x),
    'event_responses',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.event_responses x),
    'event_roster',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.event_roster x),
    'announcements',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.announcements x),
    'notifications',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.notifications x),
    'audit_log',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from public.audit_log x),
    'storage_manifest',(select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'name',o.name,'size',o.metadata->>'size','mimetype',o.metadata->>'mimetype','updated_at',o.updated_at)),'[]'::jsonb)
      from storage.objects o where o.bucket_id in ('lux-avatars','lux-evidence','lux-banners','lux-plates','lux-clan-imports'))
  );
end;
$$;

revoke all on function public.owner_export_platform_backup() from public;
grant execute on function public.owner_export_platform_backup() to authenticated;

-- Valida un respaldo antes de restaurar. La restauracion de Auth no se puede
-- hacer con una clave publica; las cuentas deben existir y se informa cuantas
-- coinciden. El cliente restaura primero los archivos y luego los metadatos.
create or replace function public.owner_validate_platform_backup(p_backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public,auth
as $$
declare result jsonb;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede validar respaldos'; end if;
  if jsonb_typeof(p_backup)<>'object' or p_backup->>'schema_version'<>'lux-clan-v3' then raise exception 'Archivo de respaldo incompatible'; end if;
  result:=jsonb_build_object(
    'version',p_backup->>'schema_version',
    'profiles_in_backup',jsonb_array_length(coalesce(p_backup->'profiles','[]'::jsonb)),
    'existing_accounts',(select count(*) from jsonb_to_recordset(coalesce(p_backup->'profiles','[]'::jsonb)) r(id uuid) join auth.users u on u.id=r.id),
    'missing_accounts',(select count(*) from jsonb_to_recordset(coalesce(p_backup->'profiles','[]'::jsonb)) r(id uuid) left join auth.users u on u.id=r.id where u.id is null),
    'files',jsonb_array_length(coalesce(p_backup->'storage_manifest','[]'::jsonb))
  );
  insert into public.backup_restores(restored_by,backup_version,dry_run,summary) values(auth.uid(),'lux-clan-v3',true,result);
  perform public.write_audit('backup_validated','backup',null,null,result);
  return result;
end;
$$;

revoke all on function public.owner_validate_platform_backup(jsonb) from public;
grant execute on function public.owner_validate_platform_backup(jsonb) to authenticated;

create or replace function public.owner_restore_platform_backup(p_backup jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public,auth
as $$
declare
  item jsonb;
  restored_profiles integer:=0;
  restored_rows integer:=0;
  result jsonb;
  requested_role text;
begin
  if not public.is_clan_owner() then raise exception 'Solo el owner puede restaurar respaldos'; end if;
  perform public.owner_validate_platform_backup(p_backup);

  -- Perfiles: solo cuentas Auth que ya existen. Nunca se crean identidades ni
  -- contrasenas desde un archivo JSON.
  for item in select value from jsonb_array_elements(coalesce(p_backup->'profiles','[]'::jsonb)) loop
    if exists(select 1 from auth.users where id=(item->>'id')::uuid) then
      update public.profiles set
        display_name=left(coalesce(nullif(item->>'display_name',''),'Jugador'),24),
        age=nullif(item->>'age','')::smallint,
        country_code=nullif(item->>'country_code',''),country_name=nullif(item->>'country_name',''),
        avatar_path=nullif(item->>'avatar_path',''),banner_path=nullif(item->>'banner_path',''),
        onboarding_complete=coalesce((item->>'onboarding_complete')::boolean,false),
        membership_status=coalesce(nullif(item->>'membership_status',''),'pending')::public.clan_membership_status,
        is_public=coalesce((item->>'is_public')::boolean,false),
        public_slug=coalesce(nullif(item->>'public_slug',''),public.make_profile_slug(item->>'display_name',(item->>'id')::uuid)),
        primary_game_role=nullif(item->>'primary_game_role',''),secondary_game_role=nullif(item->>'secondary_game_role',''),
        availability_note=nullif(item->>'availability_note',''),experience_level=nullif(item->>'experience_level',''),
        status_reason=nullif(item->>'status_reason',''),removed_at=nullif(item->>'removed_at','')::timestamptz,
        purge_after=nullif(item->>'purge_after','')::timestamptz,updated_at=now()
      where id=(item->>'id')::uuid;
      restored_profiles:=restored_profiles+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'roles','[]'::jsonb)) loop
    requested_role:=item->>'role';
    if requested_role in ('member','moderator','leader')
       and exists(select 1 from auth.users where id=(item->>'user_id')::uuid)
       and not exists(select 1 from public.user_roles where user_id=(item->>'user_id')::uuid and role='owner') then
      insert into public.user_roles(user_id,role,assigned_at)
      values((item->>'user_id')::uuid,requested_role::public.clan_role,coalesce(nullif(item->>'assigned_at','')::timestamptz,now()))
      on conflict(user_id) do update set role=excluded.role,assigned_at=excluded.assigned_at;
    end if;
  end loop;

  -- Conserva relaciones de cuentas fusionadas después de que todos los
  -- perfiles disponibles hayan sido recuperados.
  for item in select value from jsonb_array_elements(coalesce(p_backup->'profiles','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'id')::uuid)
       and exists(select 1 from public.profiles where id=nullif(item->>'merged_into','')::uuid) then
      update public.profiles set merged_into=nullif(item->>'merged_into','')::uuid where id=(item->>'id')::uuid;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'invites','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then
      insert into public.clan_invites(id,token_hash,label,created_by,expires_at,max_uses,uses,is_active,created_at)
      values((item->>'id')::uuid,(item->>'token_hash')::bytea,item->>'label',(item->>'created_by')::uuid,
        (item->>'expires_at')::timestamptz,coalesce((item->>'max_uses')::smallint,1),coalesce((item->>'uses')::smallint,0),
        coalesce((item->>'is_active')::boolean,false),coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set label=excluded.label,expires_at=excluded.expires_at,max_uses=excluded.max_uses,
        uses=excluded.uses,is_active=excluded.is_active;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'seasons','[]'::jsonb)) loop
    insert into public.seasons(id,name,starts_on,ends_on,is_current,is_archived,created_by,created_at)
    values((item->>'id')::uuid,item->>'name',(item->>'starts_on')::date,nullif(item->>'ends_on','')::date,
      false,coalesce((item->>'is_archived')::boolean,false),
      case when exists(select 1 from public.profiles where id=nullif(item->>'created_by','')::uuid) then nullif(item->>'created_by','')::uuid else auth.uid() end,
      coalesce(nullif(item->>'created_at','')::timestamptz,now()))
    on conflict(id) do update set name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,is_archived=excluded.is_archived;
  end loop;

  -- Solo la ultima temporada marcada queda actual.
  update public.seasons set is_current=false where is_current;
  update public.seasons set is_current=true where id=(
    select (x.value->>'id')::uuid from jsonb_array_elements(coalesce(p_backup->'seasons','[]'::jsonb)) x(value)
    where coalesce((x.value->>'is_current')::boolean,false) order by x.value->>'starts_on' desc limit 1
  );

  for item in select value from jsonb_array_elements(coalesce(p_backup->'victories','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'player_id')::uuid) then
      insert into public.victories(id,player_id,mode,evidence_path,evidence_sha256,evidence_dhash,status,
        reviewed_by,reviewed_at,rejection_reason,duplicate_risk,duplicate_of,client_captured_at,created_at)
      values((item->>'id')::uuid,(item->>'player_id')::uuid,item->>'mode',item->>'evidence_path',item->>'evidence_sha256',
        nullif(item->>'evidence_dhash',''),coalesce(nullif(item->>'status',''),'pending')::public.victory_status,
        case when exists(select 1 from public.profiles where id=nullif(item->>'reviewed_by','')::uuid) then nullif(item->>'reviewed_by','')::uuid else null end,
        nullif(item->>'reviewed_at','')::timestamptz,nullif(item->>'rejection_reason',''),
        coalesce((item->>'duplicate_risk')::boolean,false),null,nullif(item->>'client_captured_at','')::timestamptz,
        coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set player_id=excluded.player_id,mode=excluded.mode,evidence_path=excluded.evidence_path,
        evidence_sha256=excluded.evidence_sha256,evidence_dhash=excluded.evidence_dhash,status=excluded.status,
        reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,rejection_reason=excluded.rejection_reason,
        duplicate_risk=excluded.duplicate_risk,client_captured_at=excluded.client_captured_at;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'matches','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'submitted_by')::uuid) then
      insert into public.matches(id,season_id,mode,played_at,opponent,result,score_for,score_against,evidence_path,
        evidence_sha256,evidence_dhash,duplicate_risk,duplicate_source,notes,status,submitted_by,reviewed_by,reviewed_at,rejection_reason,created_at)
      values((item->>'id')::uuid,
        case when exists(select 1 from public.seasons where id=nullif(item->>'season_id','')::uuid) then nullif(item->>'season_id','')::uuid else null end,
        item->>'mode',(item->>'played_at')::timestamptz,nullif(item->>'opponent',''),(item->>'result')::public.clan_match_result,
        nullif(item->>'score_for','')::smallint,nullif(item->>'score_against','')::smallint,nullif(item->>'evidence_path',''),
        nullif(item->>'evidence_sha256',''),nullif(item->>'evidence_dhash',''),coalesce((item->>'duplicate_risk')::boolean,false),
        nullif(item->>'duplicate_source',''),nullif(item->>'notes',''),coalesce(nullif(item->>'status',''),'pending')::public.clan_match_status,
        (item->>'submitted_by')::uuid,
        case when exists(select 1 from public.profiles where id=nullif(item->>'reviewed_by','')::uuid) then nullif(item->>'reviewed_by','')::uuid else null end,
        nullif(item->>'reviewed_at','')::timestamptz,nullif(item->>'rejection_reason',''),coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set season_id=excluded.season_id,mode=excluded.mode,played_at=excluded.played_at,
        opponent=excluded.opponent,result=excluded.result,score_for=excluded.score_for,score_against=excluded.score_against,
        evidence_path=excluded.evidence_path,evidence_sha256=excluded.evidence_sha256,evidence_dhash=excluded.evidence_dhash,
        status=excluded.status,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,rejection_reason=excluded.rejection_reason;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'match_participants','[]'::jsonb)) loop
    if exists(select 1 from public.matches where id=(item->>'match_id')::uuid)
       and exists(select 1 from public.profiles where id=(item->>'player_id')::uuid) then
      insert into public.match_participants(id,match_id,player_id,team_role,kills,deaths,assists,damage,is_mvp,created_at)
      values((item->>'id')::uuid,(item->>'match_id')::uuid,(item->>'player_id')::uuid,nullif(item->>'team_role',''),
        coalesce((item->>'kills')::smallint,0),coalesce((item->>'deaths')::smallint,0),coalesce((item->>'assists')::smallint,0),
        coalesce((item->>'damage')::integer,0),coalesce((item->>'is_mvp')::boolean,false),coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(match_id,player_id) do update set team_role=excluded.team_role,kills=excluded.kills,deaths=excluded.deaths,
        assists=excluded.assists,damage=excluded.damage,is_mvp=excluded.is_mvp;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'plates','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'player_id')::uuid) then
      insert into public.plates(id,player_id,title,image_path,created_by,created_at)
      values((item->>'id')::uuid,(item->>'player_id')::uuid,item->>'title',item->>'image_path',
        case when exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then (item->>'created_by')::uuid else auth.uid() end,
        coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set player_id=excluded.player_id,title=excluded.title,image_path=excluded.image_path;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'aliases','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'player_id')::uuid) then
      insert into public.game_player_aliases(id,alias_key,game_name,player_id,created_by,created_at,last_seen_at,is_active,notes,match_confidence)
      values((item->>'id')::uuid,item->>'alias_key',item->>'game_name',(item->>'player_id')::uuid,
        case when exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then (item->>'created_by')::uuid else auth.uid() end,
        coalesce(nullif(item->>'created_at','')::timestamptz,now()),coalesce(nullif(item->>'last_seen_at','')::timestamptz,now()),
        coalesce((item->>'is_active')::boolean,true),nullif(item->>'notes',''),nullif(item->>'match_confidence','')::numeric)
      on conflict(alias_key) do update set game_name=excluded.game_name,player_id=excluded.player_id,last_seen_at=excluded.last_seen_at,
        is_active=excluded.is_active,notes=excluded.notes,match_confidence=excluded.match_confidence;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'activity_imports','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then
      insert into public.clan_activity_imports(id,image_sha256,image_path,captured_on,week_start,created_by,created_at,batch_id,source_index)
      values((item->>'id')::uuid,item->>'image_sha256',item->>'image_path',(item->>'captured_on')::date,(item->>'week_start')::date,
        (item->>'created_by')::uuid,coalesce(nullif(item->>'created_at','')::timestamptz,now()),nullif(item->>'batch_id','')::uuid,
        coalesce((item->>'source_index')::smallint,0))
      on conflict(id) do update set image_sha256=excluded.image_sha256,image_path=excluded.image_path,captured_on=excluded.captured_on,
        week_start=excluded.week_start,batch_id=excluded.batch_id,source_index=excluded.source_index;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'activity_snapshots','[]'::jsonb)) loop
    if exists(select 1 from public.clan_activity_imports where id=(item->>'import_id')::uuid)
       and exists(select 1 from public.profiles where id=(item->>'player_id')::uuid) then
      insert into public.clan_activity_snapshots(id,import_id,player_id,game_name,glory_week,glory_total,plates_week,plates_total,row_index,
        created_at,name_confidence,glory_week_confidence,glory_total_confidence,plates_week_confidence,plates_total_confidence,needs_review)
      values((item->>'id')::uuid,(item->>'import_id')::uuid,(item->>'player_id')::uuid,item->>'game_name',
        coalesce((item->>'glory_week')::integer,0),coalesce((item->>'glory_total')::integer,0),
        coalesce((item->>'plates_week')::integer,0),coalesce((item->>'plates_total')::integer,0),
        coalesce((item->>'row_index')::smallint,0),coalesce(nullif(item->>'created_at','')::timestamptz,now()),
        nullif(item->>'name_confidence','')::numeric,nullif(item->>'glory_week_confidence','')::numeric,
        nullif(item->>'glory_total_confidence','')::numeric,nullif(item->>'plates_week_confidence','')::numeric,
        nullif(item->>'plates_total_confidence','')::numeric,coalesce((item->>'needs_review')::boolean,false))
      on conflict(import_id,player_id) do update set game_name=excluded.game_name,glory_week=excluded.glory_week,
        glory_total=excluded.glory_total,plates_week=excluded.plates_week,plates_total=excluded.plates_total,
        row_index=excluded.row_index,name_confidence=excluded.name_confidence,glory_week_confidence=excluded.glory_week_confidence,
        glory_total_confidence=excluded.glory_total_confidence,plates_week_confidence=excluded.plates_week_confidence,
        plates_total_confidence=excluded.plates_total_confidence,needs_review=excluded.needs_review;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'events','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then
      insert into public.clan_events(id,title,description,mode,scheduled_at,response_deadline,slots,status,created_by,created_at)
      values((item->>'id')::uuid,item->>'title',nullif(item->>'description',''),item->>'mode',(item->>'scheduled_at')::timestamptz,
        nullif(item->>'response_deadline','')::timestamptz,coalesce((item->>'slots')::smallint,4),item->>'status',
        (item->>'created_by')::uuid,coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set title=excluded.title,description=excluded.description,mode=excluded.mode,
        scheduled_at=excluded.scheduled_at,response_deadline=excluded.response_deadline,slots=excluded.slots,status=excluded.status;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'event_responses','[]'::jsonb)) loop
    if exists(select 1 from public.clan_events where id=(item->>'event_id')::uuid)
       and exists(select 1 from public.profiles where id=(item->>'user_id')::uuid) then
      insert into public.event_responses(event_id,user_id,response,preferred_role,note,responded_at)
      values((item->>'event_id')::uuid,(item->>'user_id')::uuid,(item->>'response')::public.event_response_status,
        nullif(item->>'preferred_role',''),nullif(item->>'note',''),coalesce(nullif(item->>'responded_at','')::timestamptz,now()))
      on conflict(event_id,user_id) do update set response=excluded.response,preferred_role=excluded.preferred_role,
        note=excluded.note,responded_at=excluded.responded_at;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'event_roster','[]'::jsonb)) loop
    if exists(select 1 from public.clan_events where id=(item->>'event_id')::uuid)
       and exists(select 1 from public.profiles where id=(item->>'user_id')::uuid) then
      insert into public.event_roster(event_id,user_id,assigned_role,is_substitute,selected_by,selected_at)
      values((item->>'event_id')::uuid,(item->>'user_id')::uuid,nullif(item->>'assigned_role',''),
        coalesce((item->>'is_substitute')::boolean,false),
        case when exists(select 1 from public.profiles where id=(item->>'selected_by')::uuid) then (item->>'selected_by')::uuid else auth.uid() end,
        coalesce(nullif(item->>'selected_at','')::timestamptz,now()))
      on conflict(event_id,user_id) do update set assigned_role=excluded.assigned_role,is_substitute=excluded.is_substitute,
        selected_by=excluded.selected_by,selected_at=excluded.selected_at;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'membership_requests','[]'::jsonb)) loop
    if exists(select 1 from public.profiles where id=(item->>'user_id')::uuid) then
      insert into public.membership_requests(id,user_id,status,message,reviewed_by,reviewed_at,decision_reason,created_at)
      values((item->>'id')::uuid,(item->>'user_id')::uuid,(item->>'status')::public.membership_request_status,
        nullif(item->>'message',''),case when exists(select 1 from public.profiles where id=nullif(item->>'reviewed_by','')::uuid) then nullif(item->>'reviewed_by','')::uuid else null end,
        nullif(item->>'reviewed_at','')::timestamptz,nullif(item->>'decision_reason',''),coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(user_id) do update set status=excluded.status,message=excluded.message,reviewed_by=excluded.reviewed_by,
        reviewed_at=excluded.reviewed_at,decision_reason=excluded.decision_reason;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'announcements','[]'::jsonb)) loop
    insert into public.announcements(id,title,body,created_by,is_pinned,is_active,expires_at,created_at)
    values((item->>'id')::uuid,item->>'title',item->>'body',
      case when exists(select 1 from public.profiles where id=(item->>'created_by')::uuid) then (item->>'created_by')::uuid else auth.uid() end,
      coalesce((item->>'is_pinned')::boolean,false),coalesce((item->>'is_active')::boolean,true),
      nullif(item->>'expires_at','')::timestamptz,coalesce(nullif(item->>'created_at','')::timestamptz,now()))
    on conflict(id) do update set title=excluded.title,body=excluded.body,is_pinned=excluded.is_pinned,is_active=excluded.is_active,expires_at=excluded.expires_at;
    restored_rows:=restored_rows+1;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_backup->'notifications','[]'::jsonb)) loop
    if item->>'user_id' is null or exists(select 1 from public.profiles where id=(item->>'user_id')::uuid) then
      insert into public.notifications(id,user_id,kind,title,body,action_url,read_at,created_at)
      values((item->>'id')::uuid,nullif(item->>'user_id','')::uuid,item->>'kind',item->>'title',item->>'body',
        nullif(item->>'action_url',''),nullif(item->>'read_at','')::timestamptz,
        coalesce(nullif(item->>'created_at','')::timestamptz,now()))
      on conflict(id) do update set user_id=excluded.user_id,kind=excluded.kind,title=excluded.title,body=excluded.body,
        action_url=excluded.action_url,read_at=excluded.read_at;
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  -- Los identificadores identity de auditoría no se reutilizan. Se conserva el
  -- contenido y la fecha original, se marca el origen y se evita duplicar una
  -- misma entrada al restaurar dos veces el mismo archivo.
  for item in select value from jsonb_array_elements(coalesce(p_backup->'audit_log','[]'::jsonb)) loop
    if char_length(coalesce(item->>'action','')) between 3 and 80
       and char_length(coalesce(item->>'target_type','')) between 2 and 50
       and not exists(
         select 1 from public.audit_log a
         where a.action=item->>'action' and a.target_type=item->>'target_type'
           and a.target_id is not distinct from nullif(item->>'target_id','')
           and a.created_at=coalesce(nullif(item->>'created_at','')::timestamptz,now())
       ) then
      insert into public.audit_log(actor_id,action,target_type,target_id,target_user_id,details,created_at)
      values(
        case when exists(select 1 from public.profiles where id=nullif(item->>'actor_id','')::uuid) then nullif(item->>'actor_id','')::uuid else null end,
        item->>'action',item->>'target_type',nullif(item->>'target_id',''),
        case when exists(select 1 from public.profiles where id=nullif(item->>'target_user_id','')::uuid) then nullif(item->>'target_user_id','')::uuid else null end,
        coalesce(item->'details','{}'::jsonb) || jsonb_build_object('_restored_backup',true),
        coalesce(nullif(item->>'created_at','')::timestamptz,now())
      );
      restored_rows:=restored_rows+1;
    end if;
  end loop;

  result:=jsonb_build_object('profiles',restored_profiles,'records',restored_rows,
    'missing_accounts',(select count(*) from jsonb_to_recordset(coalesce(p_backup->'profiles','[]'::jsonb)) r(id uuid) left join auth.users u on u.id=r.id where u.id is null),
    'files_expected',jsonb_array_length(coalesce(p_backup->'storage_manifest','[]'::jsonb)));
  insert into public.backup_restores(restored_by,backup_version,dry_run,summary) values(auth.uid(),'lux-clan-v3',false,result);
  perform public.write_audit('backup_restored','backup',null,null,result);
  return result;
end;
$$;

revoke all on function public.owner_restore_platform_backup(jsonb) from public;
grant execute on function public.owner_restore_platform_backup(jsonb) to authenticated;

notify pgrst, 'reload schema';
