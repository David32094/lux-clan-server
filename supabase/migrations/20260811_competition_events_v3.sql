-- LUX CLAN PLATFORM V3
-- Partidos con participantes, estadisticas reales, temporadas, convocatorias,
-- disponibilidad, equipos recomendados y perfiles compartibles.

do $$ begin
  create type public.clan_match_status as enum ('pending','approved','rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.clan_match_result as enum ('win','loss','draw');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.event_response_status as enum ('available','maybe','unavailable');
exception when duplicate_object then null;
end $$;

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  starts_on date not null,
  ends_on date,
  is_current boolean not null default false,
  is_archived boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

create unique index if not exists seasons_one_current_idx on public.seasons(is_current) where is_current;
create index if not exists seasons_dates_idx on public.seasons(starts_on desc, ends_on desc);

insert into public.seasons(name,starts_on,is_current)
select 'Temporada inicial', current_date, true
where not exists(select 1 from public.seasons);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  season_id uuid references public.seasons(id),
  mode text not null check (mode in ('1v1','2v2','3v3','4v4','Otro')),
  played_at timestamptz not null default now(),
  opponent text check (opponent is null or char_length(opponent) <= 80),
  result public.clan_match_result not null,
  score_for smallint check (score_for between 0 and 999),
  score_against smallint check (score_against between 0 and 999),
  evidence_path text,
  evidence_sha256 text,
  evidence_dhash text,
  duplicate_risk boolean not null default false,
  duplicate_source text,
  notes text check (notes is null or char_length(notes) <= 600),
  status public.clan_match_status not null default 'pending',
  submitted_by uuid not null references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (evidence_path is null or evidence_path like submitted_by::text || '/%'),
  check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  check (evidence_dhash is null or evidence_dhash ~ '^[0-9a-f]{16}$')
);

create unique index if not exists matches_evidence_sha_uidx on public.matches(evidence_sha256) where evidence_sha256 is not null;
create index if not exists matches_status_played_idx on public.matches(status,played_at desc);
create index if not exists matches_season_idx on public.matches(season_id,status,played_at desc);

create table if not exists public.match_participants (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id),
  team_role text check (team_role is null or team_role in ('IGL','Rusher','Soporte','Francotirador','Flexible','Suplente')),
  kills smallint not null default 0 check (kills between 0 and 999),
  deaths smallint not null default 0 check (deaths between 0 and 999),
  assists smallint not null default 0 check (assists between 0 and 999),
  damage integer not null default 0 check (damage between 0 and 10000000),
  is_mvp boolean not null default false,
  created_at timestamptz not null default now(),
  unique(match_id,player_id)
);

create index if not exists match_participants_player_idx on public.match_participants(player_id,match_id);

create table if not exists public.clan_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 100),
  description text check (description is null or char_length(description) <= 1200),
  mode text not null default '4v4' check (mode in ('1v1','2v2','3v3','4v4','Entrenamiento','Otro')),
  scheduled_at timestamptz not null,
  response_deadline timestamptz,
  slots smallint not null default 4 check (slots between 1 and 20),
  status text not null default 'open' check (status in ('draft','open','closed','completed','cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (response_deadline is null or response_deadline <= scheduled_at)
);

create table if not exists public.event_responses (
  event_id uuid not null references public.clan_events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  response public.event_response_status not null,
  preferred_role text check (preferred_role is null or preferred_role in ('IGL','Rusher','Soporte','Francotirador','Flexible','Suplente')),
  note text check (note is null or char_length(note) <= 250),
  responded_at timestamptz not null default now(),
  primary key(event_id,user_id)
);

create table if not exists public.event_roster (
  event_id uuid not null references public.clan_events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  assigned_role text check (assigned_role is null or assigned_role in ('IGL','Rusher','Soporte','Francotirador','Flexible','Suplente')),
  is_substitute boolean not null default false,
  selected_by uuid not null references public.profiles(id),
  selected_at timestamptz not null default now(),
  primary key(event_id,user_id)
);

create index if not exists clan_events_schedule_idx on public.clan_events(status,scheduled_at);
create index if not exists event_responses_event_idx on public.event_responses(event_id,response,responded_at);

drop trigger if exists matches_updated_at on public.matches;
create trigger matches_updated_at before update on public.matches
for each row execute procedure public.set_updated_at();
drop trigger if exists clan_events_updated_at on public.clan_events;
create trigger clan_events_updated_at before update on public.clan_events
for each row execute procedure public.set_updated_at();

create or replace function public.submit_match_secure(
  p_mode text,
  p_played_at timestamptz,
  p_opponent text,
  p_result text,
  p_score_for integer,
  p_score_against integer,
  p_evidence_path text,
  p_evidence_sha256 text,
  p_evidence_dhash text,
  p_participants jsonb,
  p_notes text default null,
  p_season_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_match uuid;
  chosen_season uuid;
  item record;
  participant_count integer;
  similar_distance integer:=64;
  similar_source text;
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then raise exception 'Tu cuenta no esta activa'; end if;
  if p_mode not in ('1v1','2v2','3v3','4v4','Otro') then raise exception 'Modo invalido'; end if;
  if p_result not in ('win','loss','draw') then raise exception 'Resultado invalido'; end if;
  if p_played_at is null or p_played_at>now()+interval '1 hour' or p_played_at<now()-interval '2 years' then raise exception 'Fecha invalida'; end if;
  if p_score_for not between 0 and 999 or p_score_against not between 0 and 999 then raise exception 'Marcador invalido'; end if;
  if p_evidence_path is null or p_evidence_path not like auth.uid()::text||'/%' then raise exception 'Ruta de evidencia invalida'; end if;
  if p_evidence_sha256 !~ '^[0-9a-f]{64}$' or p_evidence_dhash !~ '^[0-9a-f]{16}$' then raise exception 'Huella de evidencia invalida'; end if;
  if jsonb_typeof(p_participants)<>'array' then raise exception 'Participantes invalidos'; end if;
  participant_count:=jsonb_array_length(p_participants);
  if participant_count not between 1 and 4 then raise exception 'Selecciona entre 1 y 4 integrantes del clan'; end if;
  if not public.is_clan_staff() and not exists(
    select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) where r.player_id=auth.uid()
  ) then raise exception 'Debes incluirte como participante'; end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) group by r.player_id having count(*)>1) then
    raise exception 'Hay participantes repetidos';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid)
    where not public.is_active_clan_member(r.player_id)) then raise exception 'Hay un integrante no activo'; end if;
  if exists(select 1 from public.matches where evidence_sha256=p_evidence_sha256)
     or exists(select 1 from public.victories where evidence_sha256=p_evidence_sha256) then raise exception 'Esta captura ya fue enviada'; end if;
  if (select count(*) from public.matches where submitted_by=auth.uid() and created_at>now()-interval '24 hours')>=6 then raise exception 'Limite diario alcanzado'; end if;
  if (select count(*) from public.matches where submitted_by=auth.uid() and status='pending')>=4 then raise exception 'Tienes demasiados partidos pendientes'; end if;

  select source,distance into similar_source,similar_distance from (
    select 'victory:'||id::text source,public.hex_hamming_distance(evidence_dhash,p_evidence_dhash) distance
      from public.victories where evidence_dhash is not null
    union all
    select 'match:'||id::text,public.hex_hamming_distance(evidence_dhash,p_evidence_dhash)
      from public.matches where evidence_dhash is not null
  ) candidates order by distance limit 1;
  if similar_distance<=3 then raise exception 'La imagen es igual o casi igual a otra evidencia'; end if;

  chosen_season:=p_season_id;
  if chosen_season is null then select id into chosen_season from public.seasons where is_current limit 1; end if;

  insert into public.matches(season_id,mode,played_at,opponent,result,score_for,score_against,
    evidence_path,evidence_sha256,evidence_dhash,duplicate_risk,duplicate_source,notes,submitted_by)
  values(chosen_season,p_mode,p_played_at,nullif(left(trim(p_opponent),80),''),p_result::public.clan_match_result,
    p_score_for,p_score_against,p_evidence_path,p_evidence_sha256,p_evidence_dhash,
    coalesce(similar_distance<=8,false),case when similar_distance<=8 then similar_source else null end,
    nullif(left(trim(p_notes),600),''),auth.uid()) returning id into new_match;

  for item in select * from jsonb_to_recordset(p_participants) as r(
    player_id uuid, team_role text, kills integer, deaths integer, assists integer, damage integer, is_mvp boolean
  ) loop
    if coalesce(item.kills,0) not between 0 and 999 or coalesce(item.deaths,0) not between 0 and 999
       or coalesce(item.assists,0) not between 0 and 999 or coalesce(item.damage,0) not between 0 and 10000000 then
      raise exception 'Estadisticas de participante invalidas';
    end if;
    insert into public.match_participants(match_id,player_id,team_role,kills,deaths,assists,damage,is_mvp)
    values(new_match,item.player_id,item.team_role,coalesce(item.kills,0),coalesce(item.deaths,0),
      coalesce(item.assists,0),coalesce(item.damage,0),coalesce(item.is_mvp,false));
  end loop;
  perform public.write_audit('match_submitted','match',new_match::text,auth.uid(),jsonb_build_object('mode',p_mode,'participants',participant_count,'risk',similar_distance<=8));
  return new_match;
exception when unique_violation then raise exception 'Esta captura o un participante esta repetido';
end;
$$;

revoke all on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,jsonb,text,uuid) from public;
grant execute on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,jsonb,text,uuid) to authenticated;

create or replace function public.review_match(p_match_id uuid,p_status text,p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare submitter uuid;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Estado invalido'; end if;
  update public.matches set status=p_status::public.clan_match_status,reviewed_by=auth.uid(),reviewed_at=now(),
    rejection_reason=case when p_status='rejected' then nullif(left(trim(p_reason),300),'') else null end
  where id=p_match_id and status='pending' returning submitted_by into submitter;
  if submitter is null then raise exception 'El partido no existe o ya fue revisado'; end if;
  insert into public.notifications(user_id,kind,title,body,action_url)
  select distinct participants.player_id,'match',
    case when p_status='approved' then 'Partido aprobado' else 'Partido rechazado' end,
    case when p_status='approved' then 'Las estadisticas del partido ya fueron aplicadas.' else coalesce(nullif(trim(p_reason),''),'La evidencia no fue aceptada.') end,
    '#ranking'
  from public.match_participants participants where participants.match_id=p_match_id;
  perform public.write_audit('match_'||p_status,'match',p_match_id::text,submitter,jsonb_build_object('reason',p_reason));
end;
$$;

revoke all on function public.review_match(uuid,text,text) from public;
grant execute on function public.review_match(uuid,text,text) to authenticated;

create or replace function public.staff_create_season(p_name text,p_starts_on date,p_ends_on date default null,p_make_current boolean default true)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare result uuid;
begin
  if not public.is_clan_leader() then raise exception 'No autorizado'; end if;
  if char_length(trim(coalesce(p_name,''))) not between 2 and 80 then raise exception 'Nombre invalido'; end if;
  if p_ends_on is not null and p_ends_on<p_starts_on then raise exception 'Fechas invalidas'; end if;
  if p_make_current then update public.seasons set is_current=false where is_current; end if;
  insert into public.seasons(name,starts_on,ends_on,is_current,created_by)
  values(trim(p_name),p_starts_on,p_ends_on,p_make_current,auth.uid()) returning id into result;
  perform public.write_audit('season_created','season',result::text,null,jsonb_build_object('name',p_name));
  return result;
end;
$$;

revoke all on function public.staff_create_season(text,date,date,boolean) from public;
grant execute on function public.staff_create_season(text,date,date,boolean) to authenticated;

create or replace function public.respond_to_event(p_event_id uuid,p_response text,p_preferred_role text default null,p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_clan_member(auth.uid()) then raise exception 'Tu cuenta no esta activa'; end if;
  if p_response not in ('available','maybe','unavailable') then raise exception 'Respuesta invalida'; end if;
  if not exists(select 1 from public.clan_events where id=p_event_id and status='open' and scheduled_at>now()) then raise exception 'La convocatoria no esta abierta'; end if;
  insert into public.event_responses(event_id,user_id,response,preferred_role,note,responded_at)
  values(p_event_id,auth.uid(),p_response::public.event_response_status,p_preferred_role,nullif(left(trim(p_note),250),''),now())
  on conflict(event_id,user_id) do update set response=excluded.response,preferred_role=excluded.preferred_role,
    note=excluded.note,responded_at=now();
  perform public.write_audit('event_response','event',p_event_id::text,auth.uid(),jsonb_build_object('response',p_response));
end;
$$;

revoke all on function public.respond_to_event(uuid,text,text,text) from public;
grant execute on function public.respond_to_event(uuid,text,text,text) to authenticated;

create or replace function public.recommend_event_team(p_event_id uuid)
returns table(
  player_id uuid,display_name text,avatar_path text,primary_game_role text,preferred_role text,
  matches_played bigint,wins bigint,win_rate numeric,kills bigint,assists bigint,damage bigint,recommendation_score numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  return query
  with totals as (
    select mp.player_id,count(*)::bigint played,
      count(*) filter(where m.result='win')::bigint wins,
      sum(mp.kills)::bigint kills,sum(mp.assists)::bigint assists,sum(mp.damage)::bigint damage
    from public.match_participants mp join public.matches m on m.id=mp.match_id and m.status='approved'
    group by mp.player_id
  )
  select p.id,p.display_name,p.avatar_path,p.primary_game_role,r.preferred_role,
    coalesce(t.played,0),coalesce(t.wins,0),
    round(case when coalesce(t.played,0)>0 then t.wins::numeric*100/t.played else 0 end,1),
    coalesce(t.kills,0),coalesce(t.assists,0),coalesce(t.damage,0),
    round(coalesce(t.wins,0)*100+coalesce(t.kills,0)*2+coalesce(t.assists,0)+coalesce(t.damage,0)/1000.0,2)
  from public.event_responses r join public.profiles p on p.id=r.user_id
  left join totals t on t.player_id=p.id
  where r.event_id=p_event_id and r.response='available' and public.is_active_clan_member(p.id)
  order by 13 desc,p.display_name;
end;
$$;

revoke all on function public.recommend_event_team(uuid) from public;
grant execute on function public.recommend_event_team(uuid) to authenticated;

-- Ranking general: combina las victorias antiguas con los partidos nuevos.
drop function if exists public.get_public_ranking();
create function public.get_public_ranking()
returns table(
  player_id uuid,display_name text,country_code text,avatar_path text,public_slug text,
  primary_game_role text,secondary_game_role text,experience_level text,
  victories_1v1 bigint,victories_2v2 bigint,victories_3v3 bigint,victories_4v4 bigint,
  victories_other bigint,victories_total bigint,matches_played bigint,losses bigint,draws bigint,
  win_rate numeric,kills bigint,deaths bigint,assists bigint,damage bigint,kd numeric,
  recent_matches bigint,current_streak bigint,performance_score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with legacy as (
    select v.player_id,
      count(*) filter(where v.mode='1v1')::bigint v1,
      count(*) filter(where v.mode='2v2')::bigint v2,
      count(*) filter(where v.mode='3v3')::bigint v3,
      count(*) filter(where v.mode='4v4')::bigint v4,
      count(*) filter(where v.mode='Otro')::bigint vo,
      count(*)::bigint wins
    from public.victories v where v.status='approved' group by v.player_id
  ), played as (
    select mp.player_id,
      count(*)::bigint total,
      count(*) filter(where m.result='win')::bigint wins,
      count(*) filter(where m.result='loss')::bigint losses,
      count(*) filter(where m.result='draw')::bigint draws,
      count(*) filter(where m.result='win' and m.mode='1v1')::bigint v1,
      count(*) filter(where m.result='win' and m.mode='2v2')::bigint v2,
      count(*) filter(where m.result='win' and m.mode='3v3')::bigint v3,
      count(*) filter(where m.result='win' and m.mode='4v4')::bigint v4,
      count(*) filter(where m.result='win' and m.mode='Otro')::bigint vo,
      sum(mp.kills)::bigint kills,sum(mp.deaths)::bigint deaths,sum(mp.assists)::bigint assists,sum(mp.damage)::bigint damage,
      count(*) filter(where m.played_at>now()-interval '30 days')::bigint recent
    from public.match_participants mp join public.matches m on m.id=mp.match_id and m.status='approved'
    group by mp.player_id
  ), streaks as (
    select p.id player_id,count(m.id)::bigint streak
    from public.profiles p
    left join public.match_participants mp on mp.player_id=p.id
    left join public.matches m on m.id=mp.match_id and m.status='approved' and m.result='win'
      and m.played_at>coalesce((select max(m2.played_at) from public.match_participants mp2 join public.matches m2 on m2.id=mp2.match_id
        where mp2.player_id=p.id and m2.status='approved' and m2.result<>'win'),'-infinity'::timestamptz)
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
$$;

revoke all on function public.get_public_ranking() from public;
grant execute on function public.get_public_ranking() to anon,authenticated;

drop function if exists public.get_authenticated_clan_directory();
create function public.get_authenticated_clan_directory()
returns table(
  player_id uuid,display_name text,age smallint,country_code text,avatar_path text,public_slug text,
  primary_game_role text,secondary_game_role text,experience_level text,
  victories_1v1 bigint,victories_2v2 bigint,victories_3v3 bigint,victories_4v4 bigint,
  victories_other bigint,victories_total bigint,matches_played bigint,losses bigint,win_rate numeric,
  kills bigint,deaths bigint,assists bigint,damage bigint,kd numeric,recent_matches bigint,current_streak bigint,performance_score numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then raise exception 'Acceso solo para integrantes activos'; end if;
  return query select p.id,p.display_name,p.age,p.country_code,p.avatar_path,p.public_slug,
    p.primary_game_role,p.secondary_game_role,p.experience_level,
    r.victories_1v1,r.victories_2v2,r.victories_3v3,r.victories_4v4,r.victories_other,r.victories_total,
    r.matches_played,r.losses,r.win_rate,r.kills,r.deaths,r.assists,r.damage,r.kd,r.recent_matches,r.current_streak,r.performance_score
  from public.profiles p join public.get_public_ranking() r on r.player_id=p.id;
end;
$$;

revoke all on function public.get_authenticated_clan_directory() from public;
grant execute on function public.get_authenticated_clan_directory() to authenticated;

drop function if exists public.get_clan_directory();
create function public.get_clan_directory()
returns table(
  player_id uuid,display_name text,age smallint,country_code text,avatar_path text,public_slug text,
  primary_game_role text,secondary_game_role text,experience_level text,
  victories_1v1 bigint,victories_2v2 bigint,victories_3v3 bigint,victories_4v4 bigint,
  victories_other bigint,victories_total bigint,matches_played bigint,losses bigint,win_rate numeric,
  kills bigint,deaths bigint,assists bigint,damage bigint,kd numeric,recent_matches bigint,current_streak bigint,performance_score numeric
)
language sql
stable
security definer
set search_path = public
as $$ select * from public.get_authenticated_clan_directory(); $$;

revoke all on function public.get_clan_directory() from public;
grant execute on function public.get_clan_directory() to authenticated;

drop function if exists public.get_public_player_victories(uuid);
create function public.get_public_player_victories(p_player_id uuid)
returns table(id uuid,mode text,evidence_path text,created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select v.id,v.mode,v.evidence_path,v.created_at
  from public.victories v join public.profiles p on p.id=v.player_id
  where v.player_id=p_player_id and v.status='approved' and p.is_public
    and p.membership_status in ('active','trial','reserve')
  union all
  select m.id,m.mode,m.evidence_path,m.played_at
  from public.matches m join public.match_participants mp on mp.match_id=m.id
  join public.profiles p on p.id=mp.player_id
  where mp.player_id=p_player_id and m.status='approved' and m.evidence_path is not null and p.is_public
    and p.membership_status in ('active','trial','reserve')
  order by created_at desc limit 24;
$$;

revoke all on function public.get_public_player_victories(uuid) from public;
grant execute on function public.get_public_player_victories(uuid) to anon,authenticated;

create or replace function public.get_public_player_by_slug(p_slug text)
returns table(
  player_id uuid,display_name text,country_code text,avatar_path text,public_slug text,
  primary_game_role text,secondary_game_role text,experience_level text,
  victories_1v1 bigint,victories_2v2 bigint,victories_3v3 bigint,victories_4v4 bigint,
  victories_other bigint,victories_total bigint,matches_played bigint,losses bigint,draws bigint,
  win_rate numeric,kills bigint,deaths bigint,assists bigint,damage bigint,kd numeric,
  recent_matches bigint,current_streak bigint,performance_score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select r.* from public.get_public_ranking() r where r.public_slug=p_slug limit 1;
$$;

-- Amplia la regla de Storage para evidencias de partidos aprobados.
create or replace function public.is_public_approved_evidence(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.victories v join public.profiles p on p.id=v.player_id
    where v.evidence_path=p_path and v.status='approved' and p.is_public and p.membership_status in ('active','trial','reserve')
  ) or exists(
    select 1 from public.matches m join public.match_participants mp on mp.match_id=m.id
    join public.profiles p on p.id=mp.player_id
    where m.evidence_path=p_path and m.status='approved' and p.is_public and p.membership_status in ('active','trial','reserve')
  );
$$;

alter table public.seasons enable row level security;
alter table public.matches enable row level security;
alter table public.match_participants enable row level security;
alter table public.clan_events enable row level security;
alter table public.event_responses enable row level security;
alter table public.event_roster enable row level security;

create policy "seasons are visible" on public.seasons for select to anon,authenticated using(true);
create policy "leaders manage seasons" on public.seasons for all to authenticated using(public.is_clan_leader()) with check(public.is_clan_leader());
create policy "approved matches are visible" on public.matches for select to anon,authenticated
  using(status='approved' or submitted_by=auth.uid() or public.is_clan_staff());
create policy "staff updates matches" on public.matches for update to authenticated using(public.is_clan_staff()) with check(public.is_clan_staff());
create policy "approved participants are visible" on public.match_participants for select to anon,authenticated
  using(player_id=auth.uid() or exists(select 1 from public.matches m where m.id=match_id and (m.status='approved' or m.submitted_by=auth.uid() or public.is_clan_staff())));
create policy "members read open events" on public.clan_events for select to authenticated using(public.is_active_clan_member(auth.uid()) or public.is_clan_staff());
create policy "staff manages events" on public.clan_events for all to authenticated using(public.is_clan_staff()) with check(public.is_clan_staff() and created_by=auth.uid());
create policy "members read event responses" on public.event_responses for select to authenticated using(user_id=auth.uid() or public.is_clan_staff());
create policy "members manage own event response" on public.event_responses for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid() and public.is_active_clan_member(auth.uid()));
create policy "staff manages event roster" on public.event_roster for all to authenticated using(public.is_clan_staff()) with check(public.is_clan_staff() and selected_by=auth.uid());
create policy "members read event roster" on public.event_roster for select to authenticated using(public.is_active_clan_member(auth.uid()));

revoke all on public.matches,public.match_participants,public.clan_events,public.event_responses,public.event_roster from anon;
grant select on public.matches,public.match_participants to anon,authenticated;
grant select on public.seasons to anon,authenticated;
grant select,insert,update,delete on public.clan_events,public.event_responses,public.event_roster to authenticated;

notify pgrst, 'reload schema';
