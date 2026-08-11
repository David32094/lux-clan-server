-- LUX CLAN: flujo captura -> OCR -> confirmacion -> aprobacion.
-- No consulta ni modifica el cliente de Free Fire y nunca recibe credenciales del juego.

alter table public.match_participants
  add column if not exists game_name text,
  add column if not exists stats_confirmed boolean not null default false;

alter table public.match_participants drop constraint if exists match_participants_game_name_check;
alter table public.match_participants add constraint match_participants_game_name_check
  check (game_name is null or char_length(game_name) between 1 and 80);

create or replace function public.get_active_game_aliases()
returns table(alias_key text,game_name text,player_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_clan_member(auth.uid()) then
    raise exception 'Acceso solo para integrantes activos';
  end if;
  return query
    select a.alias_key,a.game_name,a.player_id
    from public.game_player_aliases a
    join public.profiles p on p.id=a.player_id
    where a.is_active and p.membership_status in ('active','trial','reserve') and p.merged_into is null
    order by a.last_seen_at desc;
end;
$$;

revoke all on function public.get_active_game_aliases() from public;
grant execute on function public.get_active_game_aliases() to authenticated;

create or replace function public.submit_match_secure(
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
  for item in select * from jsonb_to_recordset(p_participants) as r(
    player_id uuid,game_name text,team_role text,kills integer,deaths integer,assists integer,damage integer,is_mvp boolean,stats_confirmed boolean
  ) loop
    if coalesce(item.kills,0) not between 0 and 999 or coalesce(item.deaths,0) not between 0 and 999 or coalesce(item.assists,0) not between 0 and 999 or coalesce(item.damage,0) not between 0 and 10000000 then raise exception 'Estadisticas invalidas'; end if;
    if item.game_name is not null and char_length(trim(item.game_name)) not between 1 and 80 then raise exception 'Nombre de Free Fire invalido'; end if;
    insert into public.match_participants(match_id,player_id,game_name,team_role,kills,deaths,assists,damage,is_mvp,stats_confirmed)
    values(new_match,item.player_id,nullif(left(trim(item.game_name),80),''),item.team_role,coalesce(item.kills,0),coalesce(item.deaths,0),
      coalesce(item.assists,0),coalesce(item.damage,0),coalesce(item.is_mvp,false),coalesce(item.stats_confirmed,false));
  end loop;
  perform public.write_audit('match_submitted','match',new_match::text,auth.uid(),jsonb_build_object('mode',p_mode,'participants',participant_count,'risk',similar_distance<=10,'visual_distance',similar_distance));
  return new_match;
exception when unique_violation then raise exception 'Esta captura o un participante esta repetido';
end;
$$;

revoke all on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,text[],jsonb,text,uuid) from public;
grant execute on function public.submit_match_secure(text,timestamptz,text,text,integer,integer,text,text,text,text[],jsonb,text,uuid) to authenticated;

create or replace function public.staff_update_pending_match(
  p_match_id uuid,p_mode text,p_result text,p_score_for integer,p_score_against integer,p_opponent text,p_participants jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare item record;participant_count integer;submitter uuid;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  if p_mode not in ('1v1','2v2','3v3','4v4','Otro') or p_result not in ('win','loss','draw') then raise exception 'Modo o resultado invalido'; end if;
  if p_score_for not between 0 and 999 or p_score_against not between 0 and 999 then raise exception 'Marcador invalido'; end if;
  if jsonb_typeof(p_participants)<>'array' then raise exception 'Participantes invalidos'; end if;
  participant_count:=jsonb_array_length(p_participants);
  if participant_count not between 1 and 4 then raise exception 'Selecciona entre 1 y 4 integrantes'; end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) group by r.player_id having count(*)>1) then raise exception 'Hay participantes repetidos'; end if;
  if exists(select 1 from jsonb_to_recordset(p_participants) r(player_id uuid) where not public.is_active_clan_member(r.player_id)) then raise exception 'Hay un integrante no activo'; end if;
  update public.matches set mode=p_mode,result=p_result::public.clan_match_result,score_for=p_score_for,score_against=p_score_against,
    opponent=nullif(left(trim(p_opponent),80),'')
  where id=p_match_id and status='pending' returning submitted_by into submitter;
  if submitter is null then raise exception 'El partido no existe o ya fue revisado'; end if;
  delete from public.match_participants where match_id=p_match_id;
  for item in select * from jsonb_to_recordset(p_participants) as r(
    player_id uuid,game_name text,team_role text,kills integer,deaths integer,assists integer,damage integer,is_mvp boolean,stats_confirmed boolean
  ) loop
    if coalesce(item.kills,0) not between 0 and 999 or coalesce(item.deaths,0) not between 0 and 999 or coalesce(item.assists,0) not between 0 and 999 or coalesce(item.damage,0) not between 0 and 10000000 then raise exception 'Estadisticas invalidas'; end if;
    insert into public.match_participants(match_id,player_id,game_name,team_role,kills,deaths,assists,damage,is_mvp,stats_confirmed)
    values(p_match_id,item.player_id,nullif(left(trim(item.game_name),80),''),item.team_role,coalesce(item.kills,0),coalesce(item.deaths,0),
      coalesce(item.assists,0),coalesce(item.damage,0),coalesce(item.is_mvp,false),coalesce(item.stats_confirmed,true));
  end loop;
  perform public.write_audit('match_corrected','match',p_match_id::text,submitter,jsonb_build_object('participants',participant_count,'mode',p_mode));
end;
$$;

revoke all on function public.staff_update_pending_match(uuid,text,text,integer,integer,text,jsonb) from public;
grant execute on function public.staff_update_pending_match(uuid,text,text,integer,integer,text,jsonb) to authenticated;

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

  if p_status='approved' then
    insert into public.game_player_aliases(alias_key,game_name,player_id,created_by,last_seen_at,is_active,notes,match_confidence)
    select upper(regexp_replace(translate(trim(mp.game_name),'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN'),'[^A-Za-z0-9]+','','g')),
      trim(mp.game_name),mp.player_id,auth.uid(),now(),true,'Confirmado al aprobar una captura',100
    from public.match_participants mp
    where mp.match_id=p_match_id and nullif(trim(mp.game_name),'') is not null
      and char_length(upper(regexp_replace(translate(trim(mp.game_name),'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN'),'[^A-Za-z0-9]+','','g'))) between 1 and 80
    on conflict(alias_key) do update set game_name=excluded.game_name,last_seen_at=now(),is_active=true,match_confidence=greatest(public.game_player_aliases.match_confidence,excluded.match_confidence)
      where public.game_player_aliases.player_id=excluded.player_id;
  end if;

  insert into public.notifications(user_id,kind,title,body,action_url)
  select distinct participants.player_id,'match',case when p_status='approved' then 'Partido aprobado' else 'Partido rechazado' end,
    case when p_status='approved' then 'Las estadisticas del partido ya fueron aplicadas.' else coalesce(nullif(trim(p_reason),''),'La evidencia no fue aceptada.') end,'#ranking'
  from public.match_participants participants where participants.match_id=p_match_id;
  perform public.write_audit('match_'||p_status,'match',p_match_id::text,submitter,jsonb_build_object('reason',p_reason));
end;
$$;

revoke all on function public.review_match(uuid,text,text) from public;
grant execute on function public.review_match(uuid,text,text) to authenticated;

create or replace function public.staff_bulk_review_matches(p_match_ids uuid[],p_status text,p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare match_id uuid;reviewed integer:=0;
begin
  if not public.is_clan_staff() then raise exception 'No autorizado'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Estado invalido'; end if;
  if cardinality(p_match_ids) not between 1 and 40 then raise exception 'Seleccion invalida'; end if;
  foreach match_id in array p_match_ids loop
    perform public.review_match(match_id,p_status,p_reason);
    reviewed:=reviewed+1;
  end loop;
  return reviewed;
end;
$$;

revoke all on function public.staff_bulk_review_matches(uuid[],text,text) from public;
grant execute on function public.staff_bulk_review_matches(uuid[],text,text) to authenticated;

notify pgrst, 'reload schema';
