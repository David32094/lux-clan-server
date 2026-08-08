# LUX CLAN SERVER

Editor de banners y centro del clan, diseñado para móviles Android y iPhone.

## Uso local

Ejecuta `ABRIR-EDITOR.bat` y abre la dirección que aparece en pantalla. Para
probarlo desde otro dispositivo conectado a la misma red, utiliza la IP local
del equipo en vez de `localhost`.

## Publicación

El repositorio incluye `.github/workflows/deploy-pages.yml`: al subir la rama
`main`, GitHub Actions valida los scripts y publica el sitio con GitHub Pages.

## Datos reales y seguridad

GitHub Pages solo sirve los archivos. Las cuentas, victorias, capturas y placas
reales deben conectarse a Supabase siguiendo [supabase/README.md](supabase/README.md).
La versión local mantiene sus datos exclusivamente en el navegador y debe usarse
solo como demo hasta terminar esa conexión.

Nunca subas `.env`, `supabase-client-config.js`, contraseñas ni una
`service_role key` a GitHub.
