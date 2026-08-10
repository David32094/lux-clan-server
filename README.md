# LUX CLAN SERVER

Centro del clan y editor de banners para iPhone, Android y escritorio. La web
usa GitHub Pages como frontend y Supabase para autenticación, perfiles, roles,
victorias, capturas, placas y almacenamiento.

## Documentación completa

Antes de modificar el proyecto, lee [GUIA_TECNICA_PARA_IA.md](GUIA_TECNICA_PARA_IA.md).
Incluye arquitectura, archivos, navegación por rol, esquema de Supabase,
seguridad, editor Canvas, PWA/offline, despliegue, pruebas y reglas para no
romper datos existentes.

## Uso local

Ejecuta `ABRIR-EDITOR.bat`. Abre un servidor local en el puerto `8091` y carga
`LUX_CLAN_EDITOR_BY.DAVID.XIT.html`. El BAT termina cualquier proceso que ya use
ese puerto; si necesitas conservarlo, inicia manualmente `python -m http.server`
en otro puerto.

## Producción

`.github/workflows/deploy-pages.yml` valida los scripts, genera la configuración
pública de Supabase desde variables/secretos de GitHub y publica `main` en
GitHub Pages.

Nunca subas `.env`, contraseñas, secretos OAuth, claves `sb_secret_...` ni una
`service_role key`. La publishable key sí llega al navegador y debe estar
protegida por RLS, no tratarse como una credencial administrativa.
