# Backend seguro de LUX CLAN

Supabase guarda cuentas, perfiles, roles, victorias, placas y archivos. Ejecuta
los SQL de `migrations/` en orden de nombre; las migraciones posteriores
reemplazan funciones creadas por las anteriores.

La configuración de producción se genera en GitHub Actions a partir de
`SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY`. El archivo versionado de la raíz es
solo un placeholder local. Nunca uses `service_role`, secretos OAuth ni claves
`sb_secret_...` en el navegador.

La seguridad real depende de RLS y de las comprobaciones internas de las RPC:

- cada cuenta nueva empieza como `member`;
- solo `owner` gestiona roles y ve correos;
- staff revisa capturas;
- una victoria solo suma cuando está `approved`;
- las evidencias aprobadas de perfiles públicos son visibles en sus perfiles;
- pendientes y rechazadas permanecen protegidas.

La documentación completa del esquema, buckets, RPC, roles, migraciones y
pruebas está en [../GUIA_TECNICA_PARA_IA.md](../GUIA_TECNICA_PARA_IA.md).
