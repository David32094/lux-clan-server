# FLUXO

Plataforma web del clan FLUXO: cuentas con Google, perfiles, banners oficiales,
ranking, evidencias de partidas, placas, temporadas, convocatorias y panel de
administración. Funciona como PWA en iPhone, Android y escritorio.

## Enlaces y archivos principales

- Producción: <https://david32094.github.io/lux-clan-server/>
- Aplicación oficial: `LUX_CLAN_EDITOR_BY.DAVID.XIT.html`
- Manual técnico completo: [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md)
- Backend y migraciones: [supabase/README.md](supabase/README.md)

`LUX_CLAN_EDITOR.html` es solo una redirección por compatibilidad. No se debe
añadir funcionalidad nueva allí.

## Desarrollo local

Requiere Node.js 24 o compatible.

```text
npm ci
npm run build
npm test
```

También se puede abrir el entorno manual con `ABRIR-EDITOR.bat`. El servidor de
pruebas usa la carpeta generada `.site`, que contiene únicamente los archivos
necesarios para producción.

## Publicación

Cada cambio enviado a `main` ejecuta sintaxis, seguridad, pruebas unitarias y
pruebas de navegador en escritorio, iPhone y Android. GitHub Pages solo publica
si todo pasa. La configuración pública de Supabase se inyecta desde variables y
secretos del repositorio; ninguna clave privada puede formar parte del sitio.

No subir `.env`, claves `service_role`, contraseñas, respaldos de producción,
informes de pruebas ni capturas privadas.
