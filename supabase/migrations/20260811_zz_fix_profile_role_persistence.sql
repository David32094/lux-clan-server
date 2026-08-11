-- Corrige el guardado de la ficha competitiva en instalaciones V3 existentes.
-- El CASE del upsert devolvia text, pero membership_requests.status es enum;
-- PostgreSQL cancelaba toda la transaccion y los roles nunca se persistian.

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

notify pgrst, 'reload schema';
