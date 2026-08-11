-- LUX CLAN PLATFORM V3
-- Rankings por periodo, avisos internos a moderadores y resumen comparativo.

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (char_length(kind) between 2 and 40),
  title text not null check (char_length(title) between 2 and 100),
  body text not null check (char_length(body) between 2 and 600),
  payload jsonb not null default '{}'::jsonb,
  delivered_at timestamptz,
  attempts smallint not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.notification_outbox enable row level security;
drop policy if exists "staff reads notification outbox" on public.notification_outbox;
create policy "staff reads notification outbox" on public.notification_outbox
for select to authenticated using(public.is_clan_staff());
revoke all on public.notification_outbox from anon;
grant select on public.notification_outbox to authenticated;

create or replace function public.notify_clan_staff(
  p_kind text,
  p_title text,
  p_body text,
  p_action_url text default null,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications(user_id,kind,title,body,action_url)
  select r.user_id,left(p_kind,40),left(p_title,100),left(p_body,600),left(p_action_url,300)
  from public.user_roles r
  join public.profiles p on p.id=r.user_id
  where r.role in ('owner','leader','moderator') and p.merged_into is null;

  insert into public.notification_outbox(kind,title,body,payload)
  values(left(p_kind,40),left(p_title,100),left(p_body,600),coalesce(p_payload,'{}'::jsonb));
end;
$$;

revoke all on function public.notify_clan_staff(text,text,text,text,jsonb) from public;

create or replace function public.notify_pending_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare member_name text;
begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status) then
    select display_name into member_name from public.profiles where id=new.user_id;
    perform public.notify_clan_staff(
      'membership','Nueva solicitud de ingreso',
      coalesce(member_name,'Un jugador')||' completó su perfil y espera aprobación.',
      '#solicitudes',jsonb_build_object('user_id',new.user_id,'request_id',new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists membership_requests_notify_staff on public.membership_requests;
create trigger membership_requests_notify_staff
after insert or update of status on public.membership_requests
for each row execute procedure public.notify_pending_membership();

create or replace function public.notify_pending_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare member_name text; evidence_kind text;
begin
  if tg_table_name='victories' then
    select display_name into member_name from public.profiles where id=new.player_id;
    evidence_kind:='victoria';
    perform public.notify_clan_staff(
      'victory','Victoria pendiente',coalesce(member_name,'Un integrante')||' envió una captura para revisar.',
      '#victorias',jsonb_build_object('victory_id',new.id,'duplicate_risk',new.duplicate_risk)
    );
  else
    select display_name into member_name from public.profiles where id=new.submitted_by;
    evidence_kind:='partido';
    perform public.notify_clan_staff(
      'match','Partido pendiente',coalesce(member_name,'Un integrante')||' registró un partido de equipo.',
      '#partidos',jsonb_build_object('match_id',new.id,'duplicate_risk',new.duplicate_risk)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists victories_notify_staff on public.victories;
create trigger victories_notify_staff after insert on public.victories
for each row when (new.status='pending') execute procedure public.notify_pending_evidence();
drop trigger if exists matches_notify_staff on public.matches;
create trigger matches_notify_staff after insert on public.matches
for each row when (new.status='pending') execute procedure public.notify_pending_evidence();

create or replace function public.notify_new_announcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active then
    insert into public.notifications(user_id,kind,title,body,action_url)
    select p.id,'announcement',left(new.title,100),left(new.body,600),'#avisos'
    from public.profiles p
    where p.membership_status in ('active','trial','reserve') and p.merged_into is null and p.id<>new.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists announcements_notify_members on public.announcements;
create trigger announcements_notify_members after insert on public.announcements
for each row execute procedure public.notify_new_announcement();

-- Misma forma que get_public_ranking, filtrada por semana, mes o temporada.
create or replace function public.get_period_ranking(
  p_period text default 'all',
  p_season_id uuid default null
)
returns table(
  player_id uuid,display_name text,country_code text,avatar_path text,public_slug text,
  primary_game_role text,secondary_game_role text,experience_level text,
  victories_1v1 bigint,victories_2v2 bigint,victories_3v3 bigint,victories_4v4 bigint,
  victories_other bigint,victories_total bigint,matches_played bigint,losses bigint,draws bigint,
  win_rate numeric,kills bigint,deaths bigint,assists bigint,damage bigint,kd numeric,
  recent_matches bigint,current_streak bigint,performance_score numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  period_start timestamptz;
  period_end timestamptz:=now()+interval '1 second';
  selected_season uuid:=p_season_id;
begin
  if p_period not in ('all','week','month','current','season') then raise exception 'Periodo invalido'; end if;
  if p_period='week' then period_start:=date_trunc('week',now()); end if;
  if p_period='month' then period_start:=date_trunc('month',now()); end if;
  if p_period='current' then
    select s.id,s.starts_on::timestamptz,(coalesce(s.ends_on,current_date)+1)::timestamptz
      into selected_season,period_start,period_end from public.seasons s where s.is_current limit 1;
  elsif p_period='season' then
    select s.starts_on::timestamptz,(coalesce(s.ends_on,current_date)+1)::timestamptz
      into period_start,period_end from public.seasons s where s.id=selected_season;
    if period_start is null then raise exception 'Temporada no encontrada'; end if;
  end if;

  return query
  with legacy as (
    select v.player_id,
      count(*) filter(where v.mode='1v1')::bigint v1,count(*) filter(where v.mode='2v2')::bigint v2,
      count(*) filter(where v.mode='3v3')::bigint v3,count(*) filter(where v.mode='4v4')::bigint v4,
      count(*) filter(where v.mode='Otro')::bigint vo,count(*)::bigint wins
    from public.victories v
    where v.status='approved' and (p_period='all' or (v.created_at>=period_start and v.created_at<period_end))
    group by v.player_id
  ), eligible_matches as (
    select m.* from public.matches m
    where m.status='approved' and (
      p_period='all'
      or (p_period in ('week','month') and m.played_at>=period_start and m.played_at<period_end)
      or (p_period in ('current','season') and (m.season_id=selected_season or (m.season_id is null and m.played_at>=period_start and m.played_at<period_end)))
    )
  ), played as (
    select mp.player_id,count(*)::bigint total,
      count(*) filter(where m.result='win')::bigint wins,count(*) filter(where m.result='loss')::bigint losses,
      count(*) filter(where m.result='draw')::bigint draws,
      count(*) filter(where m.result='win' and m.mode='1v1')::bigint v1,
      count(*) filter(where m.result='win' and m.mode='2v2')::bigint v2,
      count(*) filter(where m.result='win' and m.mode='3v3')::bigint v3,
      count(*) filter(where m.result='win' and m.mode='4v4')::bigint v4,
      count(*) filter(where m.result='win' and m.mode='Otro')::bigint vo,
      coalesce(sum(mp.kills),0)::bigint kills,coalesce(sum(mp.deaths),0)::bigint deaths,
      coalesce(sum(mp.assists),0)::bigint assists,coalesce(sum(mp.damage),0)::bigint damage,
      count(*) filter(where m.played_at>now()-interval '30 days')::bigint recent
    from public.match_participants mp join eligible_matches m on m.id=mp.match_id group by mp.player_id
  ), streaks as (
    select p.id player_id,count(m.id)::bigint streak
    from public.profiles p
    left join public.match_participants mp on mp.player_id=p.id
    left join eligible_matches m on m.id=mp.match_id and m.result='win'
      and m.played_at>coalesce((select max(m2.played_at) from public.match_participants mp2
        join eligible_matches m2 on m2.id=mp2.match_id where mp2.player_id=p.id and m2.result<>'win'),'-infinity'::timestamptz)
    group by p.id
  )
  select p.id,p.display_name,p.country_code,p.avatar_path,p.public_slug,
    p.primary_game_role,p.secondary_game_role,p.experience_level,
    (coalesce(l.v1,0)+coalesce(g.v1,0))::bigint,(coalesce(l.v2,0)+coalesce(g.v2,0))::bigint,
    (coalesce(l.v3,0)+coalesce(g.v3,0))::bigint,(coalesce(l.v4,0)+coalesce(g.v4,0))::bigint,
    (coalesce(l.vo,0)+coalesce(g.vo,0))::bigint,(coalesce(l.wins,0)+coalesce(g.wins,0))::bigint,
    (coalesce(l.wins,0)+coalesce(g.total,0))::bigint,coalesce(g.losses,0),coalesce(g.draws,0),
    round(case when coalesce(l.wins,0)+coalesce(g.total,0)>0 then
      (coalesce(l.wins,0)+coalesce(g.wins,0))::numeric*100/(coalesce(l.wins,0)+coalesce(g.total,0)) else 0 end,1),
    coalesce(g.kills,0),coalesce(g.deaths,0),coalesce(g.assists,0),coalesce(g.damage,0),
    round(case when coalesce(g.deaths,0)>0 then g.kills::numeric/g.deaths else coalesce(g.kills,0)::numeric end,2),
    coalesce(g.recent,0),coalesce(s.streak,0),
    round((coalesce(l.wins,0)+coalesce(g.wins,0))*100+coalesce(g.kills,0)*2+coalesce(g.assists,0)+coalesce(g.damage,0)/1000.0-coalesce(g.losses,0)*20,2)
  from public.profiles p left join legacy l on l.player_id=p.id left join played g on g.player_id=p.id left join streaks s on s.player_id=p.id
  where p.is_public and p.onboarding_complete and p.membership_status in ('active','trial','reserve') and p.merged_into is null
  order by 26 desc,14 desc,p.display_name;
end;
$$;

revoke all on function public.get_period_ranking(text,uuid) from public;
grant execute on function public.get_period_ranking(text,uuid) to anon,authenticated;

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
    'active_this_week',(select count(distinct player_id) from (
      select player_id from public.victories where created_at>=date_trunc('week',now())
      union all select mp.player_id from public.match_participants mp join public.matches m on m.id=mp.match_id where m.played_at>=date_trunc('week',now())
      union all select s.player_id from public.clan_activity_snapshots s where s.created_at>=date_trunc('week',now())
    ) activity),
    'pending_members',(select count(*) from public.profiles where onboarding_complete and membership_status='pending' and merged_into is null),
    'incomplete_profiles',(select count(*) from public.profiles where not onboarding_complete and merged_into is null),
    'inactive_30_days',(select count(*) from public.profiles p where p.membership_status in ('active','trial','reserve') and p.merged_into is null and
      greatest(p.updated_at,coalesce((select max(v.created_at) from public.victories v where v.player_id=p.id),p.created_at),
        coalesce((select max(m.played_at) from public.match_participants mp join public.matches m on m.id=mp.match_id where mp.player_id=p.id),p.created_at))<now()-interval '30 days'),
    'joined_this_week',(select count(*) from public.profiles where joined_at>=date_trunc('week',now()) and merged_into is null),
    'joined_previous_week',(select count(*) from public.profiles where joined_at>=date_trunc('week',now())-interval '7 days' and joined_at<date_trunc('week',now()) and merged_into is null),
    'pending_victories',(select count(*) from public.victories where status='pending'),
    'risky_victories',(select count(*) from public.victories where status='pending' and duplicate_risk),
    'pending_matches',(select count(*) from public.matches where status='pending'),
    'risky_matches',(select count(*) from public.matches where status='pending' and duplicate_risk),
    'open_events',(select count(*) from public.clan_events where status='open' and scheduled_at>now()),
    'next_event',(select jsonb_build_object('id',id,'title',title,'scheduled_at',scheduled_at,'mode',mode) from public.clan_events where status='open' and scheduled_at>now() order by scheduled_at limit 1),
    'trash_members',(select count(*) from public.profiles where removed_at is not null and merged_into is null),
    'last_plate_import',(select max(captured_on) from public.clan_activity_imports),
    'unread_notifications',(select count(*) from public.notifications where user_id=auth.uid() and read_at is null)
  );
end;
$$;

revoke all on function public.get_admin_dashboard_summary() from public;
grant execute on function public.get_admin_dashboard_summary() to authenticated;

-- Varias huellas de la misma imagen (completa y recortes interiores) hacen
-- que una recompresión o un recorte pequeño no pueda contarse como evidencia nueva.
alter table public.victories add column if not exists evidence_visual_hashes text[];
alter table public.matches add column if not exists evidence_visual_hashes text[];
update public.victories set evidence_visual_hashes=array[evidence_dhash]
where evidence_visual_hashes is null and evidence_dhash is not null;
update public.matches set evidence_visual_hashes=array[evidence_dhash]
where evidence_visual_hashes is null and evidence_dhash is not null;
alter table public.victories drop constraint if exists victories_visual_hashes_check;
alter table public.victories add constraint victories_visual_hashes_check
  check (evidence_visual_hashes is null or cardinality(evidence_visual_hashes) between 1 and 4);
alter table public.matches drop constraint if exists matches_visual_hashes_check;
alter table public.matches add constraint matches_visual_hashes_check
  check (evidence_visual_hashes is null or cardinality(evidence_visual_hashes) between 1 and 4);

create or replace function public.visual_hash_distance(p_left text[],p_right text[])
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare left_hash text;right_hash text;distance integer;best integer:=64;
begin
  if p_left is null or p_right is null then return 64; end if;
  foreach left_hash in array p_left loop
    foreach right_hash in array p_right loop
      distance:=public.hex_hamming_distance(left_hash,right_hash);
      if distance<best then best:=distance; end if;
    end loop;
  end loop;
  return best;
end;
$$;

drop function if exists public.submit_victory_secure(text,text,text,text,timestamptz);
drop function if exists public.submit_victory_secure(text,text,text,text,text[],timestamptz);
create function public.submit_victory_secure(
  p_mode text,p_evidence_path text,p_evidence_sha256 text,p_evidence_dhash text default null,
  p_visual_hashes text[] default null,p_client_captured_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare result uuid;similar_id uuid;similar_source text;similar_distance integer:=64;hashes text[];
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then raise exception 'Tu perfil debe estar completo y aprobado'; end if;
  if p_mode not in ('1v1','2v2','3v3','4v4','Otro') then raise exception 'Modo invalido'; end if;
  if p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/%' then raise exception 'Ruta invalida'; end if;
  if p_evidence_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Huella SHA-256 invalida'; end if;
  hashes:=coalesce(p_visual_hashes,array[p_evidence_dhash]);
  if cardinality(hashes) not between 1 and 4 or exists(select 1 from unnest(hashes) h where h !~ '^[0-9a-f]{16}$') then raise exception 'Huellas visuales invalidas'; end if;
  if exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256)
     or exists(select 1 from public.matches where evidence_sha256=p_evidence_sha256) then raise exception 'Esta captura ya fue enviada'; end if;
  if (select count(*) from (
    select created_at from public.victories where player_id=auth.uid() and created_at>now()-interval '24 hours'
    union all select created_at from public.matches where submitted_by=auth.uid() and created_at>now()-interval '24 hours'
  ) submissions)>=6 then raise exception 'Limite diario alcanzado: maximo 6 evidencias'; end if;
  if (select count(*) from (
    select id from public.victories where player_id=auth.uid() and status='pending'
    union all select id from public.matches where submitted_by=auth.uid() and status='pending'
  ) pending)>=4 then raise exception 'Tienes 4 evidencias pendientes; espera la revision'; end if;

  select source,id,distance into similar_source,similar_id,similar_distance from (
    select 'victory'::text source,v.id,public.visual_hash_distance(v.evidence_visual_hashes,hashes) distance from public.victories v where v.evidence_visual_hashes is not null
    union all select 'match'::text,m.id,public.visual_hash_distance(m.evidence_visual_hashes,hashes) from public.matches m where m.evidence_visual_hashes is not null
  ) candidates order by distance limit 1;
  if similar_distance<=5 then raise exception 'La imagen es igual, recompuesta o recortada de una evidencia anterior'; end if;

  insert into public.victories(player_id,mode,evidence_path,evidence_sha256,evidence_dhash,evidence_visual_hashes,
    duplicate_risk,duplicate_of,client_captured_at,status)
  values(auth.uid(),p_mode,p_evidence_path,p_evidence_sha256,hashes[1],hashes,
    coalesce(similar_distance<=10,false),case when similar_distance<=10 and similar_source='victory' then similar_id else null end,p_client_captured_at,'pending')
  returning id into result;
  perform public.write_audit('victory_submitted','victory',result::text,auth.uid(),jsonb_build_object('mode',p_mode,'duplicate_risk',similar_distance<=10,'visual_distance',similar_distance));
  return result;
exception when unique_violation then raise exception 'Esta captura ya fue enviada';
end;
$$;

revoke all on function public.submit_victory_secure(text,text,text,text,text[],timestamptz) from public;
grant execute on function public.submit_victory_secure(text,text,text,text,text[],timestamptz) to authenticated;

create or replace function public.can_submit_victory(p_evidence_sha256 text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.is_active_clan_member(auth.uid())
    and p_evidence_sha256 ~ '^[0-9a-f]{64}$'
    and not exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256)
    and not exists(select 1 from public.matches where evidence_sha256=p_evidence_sha256)
    and (select count(*) from (
      select created_at from public.victories where player_id=auth.uid() and created_at>now()-interval '24 hours'
      union all select created_at from public.matches where submitted_by=auth.uid() and created_at>now()-interval '24 hours'
    ) submissions)<6
    and (select count(*) from (
      select id from public.victories where player_id=auth.uid() and status='pending'
      union all select id from public.matches where submitted_by=auth.uid() and status='pending'
    ) pending)<4;
$$;

drop function if exists public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,jsonb,text,uuid);
drop function if exists public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,text[],jsonb,text,uuid);
create function public.submit_match_secure(
  p_mode text,p_played_at timestamptz,p_opponent text,p_result text,p_score_for integer,p_score_against integer,
  p_evidence_path text,p_evidence_sha256 text,p_evidence_dhash text,p_visual_hashes text[],p_participants jsonb,
  p_notes text default null,p_season_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_match uuid;chosen_season uuid;item record;participant_count integer;similar_distance integer:=64;similar_source text;hashes text[];
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then raise exception 'Tu cuenta no esta activa'; end if;
  if p_mode not in ('1v1','2v2','3v3','4v4','Otro') or p_result not in ('win','loss','draw') then raise exception 'Modo o resultado invalido'; end if;
  if p_played_at is null or p_played_at>now()+interval '1 hour' or p_played_at<now()-interval '2 years' then raise exception 'Fecha invalida'; end if;
  if p_score_for not between 0 and 999 or p_score_against not between 0 and 999 then raise exception 'Marcador invalido'; end if;
  if p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/%' or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Evidencia invalida'; end if;
  hashes:=coalesce(p_visual_hashes,array[p_evidence_dhash]);
  if cardinality(hashes) not between 1 and 4 or exists(select 1 from unnest(hashes) h where h !~ '^[0-9a-f]{16}$') then raise exception 'Huellas visuales invalidas'; end if;
  if jsonb_typeof(p_participants)<>'array' then raise exception 'Participantes invalidos'; end if;
  participant_count:=jsonb_array_length(p_participants);
  if participant_count not between 1 and 4 then raise exception 'Selecciona entre 1 y 4 integrantes'; end if;
  if not public.is_clan_staff() and not exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) where r.player_id=auth.uid()) then raise exception 'Debes incluirte como participante'; end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) group by r.player_id having count(*)>1) then raise exception 'Hay participantes repetidos'; end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) where not public.is_active_clan_member(r.player_id)) then raise exception 'Hay un integrante no activo'; end if;
  if exists(select 1 from public.matches where evidence_sha256=p_evidence_sha256) or exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256) then raise exception 'Esta captura ya fue enviada'; end if;
  if (select count(*) from (
    select created_at from public.victories where player_id=auth.uid() and created_at>now()-interval '24 hours'
    union all select created_at from public.matches where submitted_by=auth.uid() and created_at>now()-interval '24 hours'
  ) submissions)>=6 then raise exception 'Limite diario alcanzado'; end if;
  if (select count(*) from (
    select id from public.victories where player_id=auth.uid() and status='pending'
    union all select id from public.matches where submitted_by=auth.uid() and status='pending'
  ) pending)>=4 then raise exception 'Tienes demasiadas evidencias pendientes'; end if;

  select source,distance into similar_source,similar_distance from (
    select 'victory:'||v.id::text source,public.visual_hash_distance(v.evidence_visual_hashes,hashes) distance from public.victories v where v.evidence_visual_hashes is not null
    union all select 'match:'||m.id::text,public.visual_hash_distance(m.evidence_visual_hashes,hashes) from public.matches m where m.evidence_visual_hashes is not null
  ) candidates order by distance limit 1;
  if similar_distance<=5 then raise exception 'La imagen es igual, recompuesta o recortada de otra evidencia'; end if;
  chosen_season:=p_season_id;
  if chosen_season is null then select id into chosen_season from public.seasons where is_current limit 1; end if;
  insert into public.matches(season_id,mode,played_at,opponent,result,score_for,score_against,evidence_path,evidence_sha256,
    evidence_dhash,evidence_visual_hashes,duplicate_risk,duplicate_source,notes,submitted_by)
  values(chosen_season,p_mode,p_played_at,nullif(left(trim(p_opponent),80),''),p_result::public.clan_match_result,
    p_score_for,p_score_against,p_evidence_path,p_evidence_sha256,hashes[1],hashes,coalesce(similar_distance<=10,false),
    case when similar_distance<=10 then similar_source else null end,nullif(left(trim(p_notes),600),''),auth.uid()) returning id into new_match;
  for item in select * from jsonb_to_recordset(p_participants) as r(player_id uuid,team_role text,kills integer,deaths integer,assists integer,damage integer,is_mvp boolean) loop
    if coalesce(item.kills,0) not between 0 and 999 or coalesce(item.deaths,0) not between 0 and 999 or coalesce(item.assists,0) not between 0 and 999 or coalesce(item.damage,0) not between 0 and 10000000 then raise exception 'Estadisticas invalidas'; end if;
    insert into public.match_participants(match_id,player_id,team_role,kills,deaths,assists,damage,is_mvp)
    values(new_match,item.player_id,item.team_role,coalesce(item.kills,0),coalesce(item.deaths,0),coalesce(item.assists,0),coalesce(item.damage,0),coalesce(item.is_mvp,false));
  end loop;
  perform public.write_audit('match_submitted','match',new_match::text,auth.uid(),jsonb_build_object('mode',p_mode,'participants',participant_count,'risk',similar_distance<=10,'visual_distance',similar_distance));
  return new_match;
exception when unique_violation then raise exception 'Esta captura o un participante esta repetido';
end;
$$;

revoke all on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,text[],jsonb,text,uuid) from public;
grant execute on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,text[],jsonb,text,uuid) to authenticated;

create or replace function public.staff_set_season_state(p_season_id uuid,p_action text,p_ends_on date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_clan_leader() then raise exception 'No autorizado'; end if;
  if p_action='activate' then
    update public.seasons set is_current=false where is_current;
    update public.seasons set is_current=true,is_archived=false where id=p_season_id;
  elsif p_action='archive' then
    update public.seasons set is_current=false,is_archived=true,ends_on=coalesce(p_ends_on,ends_on,current_date) where id=p_season_id;
  else raise exception 'Accion invalida'; end if;
  if not found then raise exception 'Temporada no encontrada'; end if;
  perform public.write_audit('season_'||p_action,'season',p_season_id::text,null,jsonb_build_object('ends_on',p_ends_on));
end;
$$;

revoke all on function public.staff_set_season_state(uuid,text,date) from public;
grant execute on function public.staff_set_season_state(uuid,text,date) to authenticated;

create or replace function public.staff_save_recommended_team(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare event_slots integer;selected_count integer:=0;candidate record;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  select slots into event_slots from public.clan_events where id=p_event_id;
  if event_slots is null then raise exception 'Convocatoria no encontrada'; end if;
  delete from public.event_roster where event_id=p_event_id;
  for candidate in select * from public.recommend_event_team(p_event_id) limit event_slots+2 loop
    selected_count:=selected_count+1;
    insert into public.event_roster(event_id,user_id,assigned_role,is_substitute,selected_by)
    values(p_event_id,candidate.player_id,coalesce(candidate.preferred_role,candidate.primary_game_role,'Flexible'),selected_count>event_slots,auth.uid());
    insert into public.notifications(user_id,kind,title,body,action_url)
    values(candidate.player_id,'event','Convocatoria del equipo',case when selected_count>event_slots then 'Fuiste seleccionado como suplente.' else 'Fuiste seleccionado para el equipo titular.' end,'#convocatorias');
  end loop;
  perform public.write_audit('event_roster_saved','event',p_event_id::text,null,jsonb_build_object('players',selected_count));
  return selected_count;
end;
$$;

revoke all on function public.staff_save_recommended_team(uuid) from public;
grant execute on function public.staff_save_recommended_team(uuid) to authenticated;

notify pgrst, 'reload schema';
