-- La clasificación de placas usa la misma foto pública de perfil que el
-- ranking de victorias. No expone correos, edades ni rutas privadas.
-- PostgreSQL no permite cambiar las columnas OUT con CREATE OR REPLACE.
-- Esta función no tiene dependencias internas, así que se sustituye completa.
drop function if exists public.get_public_plate_ranking();

create function public.get_public_plate_ranking()
returns table (
  player_id uuid,
  display_name text,
  avatar_path text,
  plate_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name, p.avatar_path, count(pl.id) as plate_count
  from public.profiles p
  left join public.plates pl on pl.player_id = p.id
  where p.is_public
  group by p.id, p.display_name, p.avatar_path
  order by plate_count desc, p.display_name asc;
$$;

revoke all on function public.get_public_plate_ranking() from public;
grant execute on function public.get_public_plate_ranking() to anon, authenticated;
notify pgrst, 'reload schema';
