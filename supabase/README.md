# Backend seguro de LUX CLAN

Este directorio contiene la base para pasar de la demo local a una web real.
La web puede estar publicada en GitHub Pages, pero las cuentas, imágenes y
resultados se guardan en Supabase.

1. Crear un proyecto de Supabase y ejecutar la migración de `migrations/` en
   el SQL Editor.
2. Crear el archivo `supabase-client-config.js` a partir de
   `client-config.example.js`, con la URL y la **publishable key** del proyecto.
3. Añadir ese archivo a `.gitignore`; nunca subir claves privadas ni la
   `service_role key`.
4. Cuando David y las otras líderes hayan creado su cuenta, asignarles su rol
   desde el SQL Editor usando sus UUID de `auth.users`.

La migración aplica Row Level Security: un integrante solo puede modificar su
perfil y sus capturas pendientes; las victorias solo cuentan después de que una
líder las aprueba. El ranking público no expone capturas ni edades.
