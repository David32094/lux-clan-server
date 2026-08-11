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

## Importación del panel de actividad

`migrations/20260810_clan_activity_snapshots.sql` agrega el flujo de capturas
del listado de Free Fire. Cada archivo se identifica con SHA-256 y se guarda en
el bucket privado `lux-clan-imports`. Solo las cuentas `owner` o `leader` pueden
leerlo o registrar una importación.

Los cuatro valores guardados por integrante son gloria semanal/total y placas
semanales/totales. Una captura es un estado de los contadores, no una cantidad
para sumar: el ranking usa el máximo observado por semana y el máximo total.
Esto evita inflar resultados al subir de nuevo la misma captura, una versión
recomprimida o varias capturas solapadas del listado.

`game_player_aliases` relaciona el nombre estilizado del juego con el UUID del
perfil web. El OCR se ejecuta en el dispositivo de la líder y solo propone los
datos; las filas desconocidas deben asignarse manualmente antes de guardarse.
