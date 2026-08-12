# Backend Supabase de FLUXO

La web usa Supabase Auth, PostgreSQL, Row Level Security, funciones RPC y
Storage. GitHub Pages solo entrega el cliente estático.

## Orden de migraciones

En un proyecto nuevo se deben ejecutar todos los archivos de `migrations/` en
orden alfabético. En el proyecto existente, ejecutar únicamente los posteriores
a la última versión aplicada. Para la versión 3 el orden específico es:

1. `20260811_membership_security_v3.sql`
2. `20260811_competition_events_v3.sql`
3. `20260811_operations_backup_v3.sql`
4. `20260811_seasons_notifications_v3.sql`
5. `20260811_zz_fix_profile_role_persistence.sql`

No cambiar el orden: competición depende de la membresía; operaciones depende
de competición; periodos y notificaciones amplían las funciones anteriores.

Cada ejecución debe terminar sin error y se debe recargar el esquema de
PostgREST. Las migraciones ya incluyen `notify pgrst, 'reload schema'` cuando
corresponde.

## Configuración de Auth

Activar Google como proveedor. Autorizar:

- URL del sitio: `https://david32094.github.io/lux-clan-server/`
- Redirect URL: `https://david32094.github.io/lux-clan-server/LUX_CLAN_EDITOR_BY.DAVID.XIT.html`
- URL local de pruebas si se va a usar OAuth local.

El correo del owner se vincula una vez a `auth.users`; su rol vive en
`public.user_roles`. No conceder owner basándose únicamente en texto enviado por
el cliente.

## Seguridad

- RLS está activado en las tablas expuestas.
- Los integrantes modifican solo sus datos permitidos y sus propios envíos.
- Roles, membresía, revisiones, fusiones, respaldos y límites usan RPC
  `security definer` con validaciones internas.
- Las evidencias pendientes son privadas; solo las aprobadas de perfiles
  públicos se muestran.
- El panel de cuentas y correos llama una RPC exclusiva del owner.
- Las claves `service_role` y contraseñas nunca se colocan en JavaScript, GitHub
  Pages ni archivos de respaldo compartidos.

## Storage

Las migraciones crean/configuran `lux-avatars`, `lux-evidence`, `lux-banners`,
`lux-plates` y `lux-clan-imports`. Revisar políticas después de cualquier cambio
de bucket. El respaldo completo descarga objetos desde el navegador autorizado;
la restauración valida el JSON y luego vuelve a subir los archivos.

## Importación de actividad y OCR

`game_player_aliases` relaciona nombres estilizados del juego con perfiles. Las
capturas guardan gloria semanal/total y placas semanales/totales como estados.
El servidor usa máximos por periodo y hash por imagen para impedir que una
captura repetida incremente los totales.

El OCR corre en el dispositivo y solo propone. Campos con confianza baja y
nombres sin alias deben confirmarse antes de llamar la RPC de lote.

## Recuperación

El respaldo incluye datos, auditoría, roles, alias, relaciones y un manifiesto
de objetos. Auth no se restaura con la publishable key: las identidades deben
existir previamente. No resolver esto exponiendo `service_role`; usar el panel
de Supabase o un proceso administrativo seguro si alguna cuenta debe recrearse.
