# LUX CLAN SERVER — documentación técnica integral

Última actualización: 11 de agosto de 2026
Versión funcional documentada: 3.0

Este documento es la fuente de verdad para una persona o una IA que vaya a
modificar el proyecto. Antes de cambiar código, hay que leerlo completo y
preservar las reglas de seguridad, navegación y compatibilidad descritas aquí.

## 1. Objetivo del producto

LUX CLAN SERVER reúne en una sola web las tareas diarias de un clan de Free
Fire:

- registro e inicio de sesión con Google;
- ficha de cada integrante con nombre, edad, país, foto y rol de juego;
- generación del banner oficial a partir de la plantilla del clan;
- evidencias de victorias y partidos completos, siempre moderadas;
- ranking general, por modalidad, periodo y temporada;
- estadísticas de rendimiento individual y recomendaciones de equipo;
- lectura de capturas del panel del juego para gloria y placas;
- temporadas, eventos, disponibilidad y convocatoria de hasta cuatro personas;
- anuncios, notificaciones y solicitudes de ingreso;
- administración de roles, alias, cuentas duplicadas y papelera de 30 días;
- respaldo completo de base de datos e imágenes.

La web es estática y vive en GitHub Pages. Supabase proporciona autenticación,
PostgreSQL, RPC seguras y Storage. El navegador nunca recibe una clave privada.

## 2. Principios que no se deben romper

1. La base de datos decide permisos, duplicados, límites y puntuaciones. El
   JavaScript del navegador solo presenta la interfaz.
2. Una persona no puede modificar su rol, estado de membresía ni estadísticas
   mediante una petición directa.
3. Solo resultados aprobados forman parte del ranking público.
4. Un perfil nuevo no puede continuar hasta tener nombre, edad y país. La foto
   es opcional. No se debe mostrar públicamente como “Jugador”.
5. Owner, líder, moderador e integrante son roles distintos. La opción Cuentas,
   los correos, las fusiones, la restauración y el borrado definitivo pertenecen
   solo al owner.
6. La expulsión normal es reversible durante 30 días. El borrado físico es el
   último paso y solo lo hace el owner.
7. No se guarda una contraseña del usuario. Google OAuth crea y recupera la
   sesión; Supabase mantiene los tokens.
8. Toda imagen subida se valida por tipo y tamaño. Las evidencias usan SHA-256 y
   varios hashes visuales para detectar copias, recortes y recompresiones.
9. Los diseños oficiales se generan desde las plantillas originales; no se debe
   inventar otro banner cuando un administrador pulsa descargar.
10. Cualquier cambio publicable debe pasar `npm test`.

## 3. Arquitectura

### 3.1 Cliente estático

`LUX_CLAN_EDITOR_BY.DAVID.XIT.html` es la única aplicación oficial. Contiene el
editor Canvas y el esqueleto visual. Las funciones grandes están separadas:

- `prototipo-supabase.js`: autenticación, sesión, perfiles, Storage, directorio,
  permisos, moderación antigua, descarga del banner y conexión REST/RPC.
- `lux-platform-v3.js`: membresías, partidos, temporadas, eventos, operaciones,
  anuncios, notificaciones, estadísticas, enlaces públicos y QR.
- `lux-platform-v3.css`: interfaz nueva y adaptación responsive.
- `prototipo-placas-ocr.js`: procesamiento OCR, confianza por campo, comparación
  de nombres, revisión manual y lotes de varias capturas.
- `lux-match-ocr.js`: lectura asistida de capturas finales de partida. Propone
  resultado, marcador, modalidad, nombres, K/D/A y daño, pero nunca aprueba ni
  suma estadísticas por sí solo.
- `prototipo-placas.js`: presentación de placas y estadísticas de actividad.
- `prototipo-clan-hub.js`: pantallas base del hub.
- `prototipo-lider.js` y `prototipo-accesos.js`: compatibilidad del prototipo
  local; en producción sus permisos son sustituidos por Supabase.
- `mobile-touch-fix.js`: separa el desplazamiento vertical de los gestos de
  edición para evitar arrastrar objetos por accidente en móviles.
- `sw.js`: caché PWA. El shell carga primero; las plantillas pesadas se guardan
  en segundo plano después de la primera visita.
- `vendor/qrcode.js`: QR local, sin enviar la URL a un servicio externo.

`LUX_CLAN_EDITOR.html` redirige a la aplicación oficial y existe únicamente para
enlaces antiguos. No debe contener lógica duplicada.

### 3.2 Plantillas y recursos

- `INTEGRANTES/base.png`: plantilla oficial del banner de integrante.
- `ENFRETAMIENTOS/base.png`: plantilla oficial de enfrentamientos.
- `ENFRETAMIENTOS/overlay - copia.png`: overlay del rival.
- `ICONOS/lux-icon-512.png`: icono usado por la PWA y el manifest.

Las tres plantillas ya no están codificadas en Base64 dentro del HTML. Se cargan
al abrir el editor y se almacenan con el service worker. Este cambio redujo el
HTML de unos 5,24 MB a unos 130 KB. No volver a incrustarlas.

### 3.3 Backend

Supabase tiene cuatro responsabilidades:

- Auth: identidad Google y renovación de sesiones.
- PostgreSQL: perfiles, roles, resultados, membresías, eventos y auditoría.
- RPC: toda mutación sensible o cálculo que no debe confiar en el navegador.
- Storage: avatares públicos; evidencias, banners, placas e importaciones con
  políticas específicas.

Las migraciones se aplican cronológicamente. La lista y el procedimiento están
en `supabase/README.md`.

## 4. Navegación simplificada

### 4.1 Visitante

La portada explica el producto y ofrece iniciar con Google. Un visitante puede
consultar los datos públicos aprobados y abrir un perfil mediante un enlace con
`?player=<slug>`; nunca recibe correo, edad privada, evidencia pendiente ni
controles administrativos.

### 4.2 Integrante

La barra principal mantiene cinco destinos claros:

1. Inicio: resumen, anuncios, próximos eventos y accesos principales.
2. Mi perfil: editar datos, ver estadísticas y descargar el banner.
3. Partidas: subir una evidencia individual o un partido con participantes.
4. Ranking: clasificación y perfiles públicos de otros integrantes.
5. Integrantes: directorio del clan.

Desde Mi perfil se ven nombre, edad, país, foto, roles de juego, modalidades,
K/D, asistencias, daño y evidencias aprobadas. Una captura ampliable admite zoom.

### 4.3 Moderador

Puede revisar evidencias y solicitudes asignadas, pero no puede:

- ver la lista privada de cuentas y correos;
- cambiar roles;
- expulsar líderes;
- fusionar cuentas;
- restaurar respaldos ni borrar definitivamente.

### 4.4 Líder

Además de moderar, puede administrar integrantes ordinarios, temporadas,
eventos, convocatorias, placas, alias y anuncios. Puede descargar cualquier
banner oficial generado con los datos actuales del perfil.

### 4.5 Owner

Tiene las opciones anteriores y la sección Cuentas. Puede nombrar líderes y
moderadores, fusionar duplicados, restaurar la papelera, purgar después de 30
días, crear invitaciones y gestionar respaldos. La cuenta owner no puede ser
degradada desde la propia interfaz.

## 5. Registro, sesión y membresía

### 5.1 Google OAuth

El botón usa `signInWithOAuth` con `prompt=select_account`. El callback se
procesa incluso si scripts antiguos cambian el hash: el fragmento OAuth se
copia temporalmente a `sessionStorage` antes de arrancar la aplicación.

La sesión se guarda en tres niveles para resistir cierres de pestaña y
restricciones móviles:

- `localStorage`;
- `sessionStorage`;
- IndexedDB.

Al iniciar, se valida el usuario con Supabase. Online y al volver a una pestaña
visible se intenta renovar el token. Si la renovación falla de verdad, se limpia
la sesión; un error temporal de red no debe provocar un bucle de login.

### 5.2 Onboarding obligatorio

Después de Google se presenta un formulario único con:

- nombre visible: obligatorio, entre 2 y 24 caracteres;
- edad: obligatoria, dentro del rango definido en SQL;
- país: obligatorio, guardado como código y nombre normalizados;
- foto: opcional;
- rol principal/secundario y disponibilidad: opcionales.

El borrador no debe ser reemplazado por una recarga asíncrona. La variable
`profileDraftDirty` evita que el servidor borre lo que la persona está
escribiendo. La RPC `complete_my_onboarding` valida y guarda en una transacción.

### 5.3 Estados de membresía

Los estados son `pending`, `active`, `trial`, `reserve`, `inactive`, `expelled`
y `alumni`. Solo `active`, `trial` y `reserve` aparecen normalmente en el
directorio y pueden participar. Una solicitud o invitación no concede permisos
administrativos.

Las invitaciones guardan únicamente un hash del token, caducan y tienen límite
de usos. Las solicitudes son aceptadas o rechazadas por personal autorizado y
cada decisión entra en auditoría.

## 6. Perfiles y banners

El avatar de un perfil se obtiene siempre desde `avatar_path`; cualquier tarjeta
de ranking, integrante, MVP o modal debe usar el mismo helper de avatar. Si no
hay imagen, se muestran iniciales, nunca una imagen rota.

El banner oficial se produce en Canvas con la plantilla de integrante, los
datos actuales del perfil y su avatar. No depende de que la persona haya pulsado
“guardar banner” antes. El país se centra midiendo el ancho real de la bandera y
del texto; no se debe usar una cantidad fija por letra. Esto evita que Venezuela
u otros nombres largos se monten sobre la bandera.

El banner guardado en Storage es una comodidad. La fuente real sigue siendo la
configuración oficial más el perfil actual.

## 7. Victorias y partidos

### 7.1 Evidencia individual compatible

El flujo anterior permite `1v1`, `2v2`, `3v3`, `4v4` y `Otro`. La RPC segura
recibe SHA-256, varios hashes visuales y fecha aproximada. El resultado queda
`pending` y no puntúa hasta aprobación.

### 7.2 Partido completo

Una sola captura puede registrar hasta cuatro integrantes. Para reducir el
trabajo manual, la pantalla inicial solo exige modalidad y captura. El botón de
lectura automática intenta preparar resultado, marcador, nombres, bajas,
muertes, asistencias y daño. El jugador abre «Revisar o corregir datos» solo si
lo necesita; rival, notas y estadísticas detalladas son opcionales.

Los nombres detectados se comparan primero con perfiles y alias históricos. Un
nombre dudoso no se asigna solo: aparece «¿qué integrante es?» y puede ignorarse
si pertenece al equipo rival. La captura original es siempre la evidencia; el
texto OCR es únicamente un borrador.

El administrador puede ampliar la imagen, corregir la ficha, aprobar, rechazar
o seleccionar varias fichas sin riesgo para aprobarlas juntas. Las capturas con
riesgo de similitud no se seleccionan automáticamente en un lote. Al aprobar,
las estadísticas de todas las personas vinculadas se actualizan mediante
consultas y los nombres de juego confirmados se guardan como alias. Un conflicto
de alias nunca reasigna una cuenta de forma automática.

### 7.3 Integración con Free Fire

No existe en el proyecto una conexión oficial de Garena que exponga plantillas
de clan, integrantes y resultados privados. No añadir servicios comunitarios
que pidan JWT, tokens, contraseña o una sesión de Free Fire. Aunque una API no
oficial prometa esos datos, puede cambiar o dejar de funcionar sin aviso.

La integración admitida es captura → OCR local en el navegador → corrección
humana → RPC segura → moderación. Nunca modificar, interceptar ni automatizar el
cliente del juego.

### 7.4 Antifraude

Las defensas son acumulativas:

- índice único del SHA-256 exacto;
- varios dHash calculados sobre la imagen completa y recortes;
- distancia Hamming para detectar recompresión o recortes parecidos;
- comparación contra evidencias individuales y partidos;
- máximo combinado de seis envíos en 24 horas;
- máximo combinado de cuatro evidencias pendientes;
- fecha del cliente limitada a un margen razonable;
- moderación humana obligatoria.

No confiar en una validación hecha solo en JavaScript: una petición manual
seguiría siendo posible. Los límites definitivos viven en SQL.

## 8. Estadísticas, ranking y equipo recomendado

El ranking combina victorias individuales antiguas y partidos aprobados. Mide:

- victorias por modalidad y totales;
- partidos, derrotas, empates y porcentaje de victoria;
- bajas, muertes, asistencias, daño y K/D;
- actividad reciente, racha actual y puntuación de rendimiento.

Puede consultarse en total, semana, mes o temporada. Una temporada archivada
conserva su clasificación histórica. El equipo recomendado usa rendimiento,
actividad, disponibilidad y roles, pero la líder toma la decisión final y puede
guardar titulares y suplentes.

## 9. Eventos y disponibilidad

El personal crea entrenamientos, guerras o partidas con modalidad, fecha,
fecha límite y cupos. Cada integrante responde disponible, quizás o no
disponible, y puede indicar el rol que prefiere. La convocatoria guardada
mantiene quién seleccionó a cada persona y cuándo.

## 10. Placas, gloria y OCR

Una captura del panel de actividad es un estado acumulado, no una cantidad que
se suma. Se guardan gloria semanal/total y placas semanales/totales. El ranking
usa el máximo observado por periodo; volver a subir la misma captura no infla
los números.

El OCR:

- acepta varias imágenes en un lote;
- calcula SHA-256 por archivo;
- recorta filas y columnas de métricas;
- relee números de baja confianza con procesamiento específico;
- normaliza nombres estilizados y genera variantes;
- compara distancia de edición y similitud con alias conocidos;
- muestra candidatos y confianza por nombre y por número;
- resalta campos de baja confianza y exige revisión manual;
- permite asignar un nombre desconocido a un integrante y guardar el alias.

Nunca asignar automáticamente cuando la confianza es baja. Es preferible pedir
a la líder “¿quién es esta persona?” con el recorte de la fila.

## 11. Archivos, privacidad y acceso público

Buckets principales:

- `lux-avatars`: avatares públicos de perfiles públicos;
- `lux-evidence`: evidencias privadas mientras están pendientes; las aprobadas
  de perfiles públicos se pueden visualizar mediante la política comprobada;
- `lux-banners`: banners personales, escribibles por su dueño y legibles por
  personal autorizado;
- `lux-plates`: imágenes de placas;
- `lux-clan-imports`: capturas originales del panel, privadas para el personal.

Las URLs privadas son firmadas por poco tiempo. No guardar una URL firmada como
si fuera permanente. El correo solo aparece en la RPC exclusiva del owner.

## 12. Administración, auditoría y notificaciones

Cada acción sensible llama `write_audit`: revisar membresías/evidencias,
cambiar estados, expulsar/restaurar/purgar, fusionar cuentas, modificar alias,
restaurar respaldos y gestionar temporadas. El historial es de solo lectura
para el personal.

Las notificaciones internas se entregan al usuario. `notification_outbox`
registra eventos que pueden conectarse a correo o WhatsApp mediante una Edge
Function; la web no incluye credenciales de proveedores. Esto permite añadir un
canal externo sin debilitar GitHub Pages.

## 13. Cuentas duplicadas y papelera

El owner puede fusionar un perfil origen en uno destino. Se reasignan resultados,
participantes, placas, alias, actividad y eventos; se conservan las evidencias y
se deja una relación `merged_into` auditable. Antes de confirmar, la interfaz
muestra ambos perfiles.

Expulsar oculta la ficha y establece `purge_after` 30 días después. Restaurar
revierte el proceso. El borrado definitivo requiere owner y que el plazo haya
vencido; no debe añadirse un atajo de borrado inmediato.

## 14. Respaldo y restauración

`owner_export_platform_backup` produce la información estructurada: perfiles,
roles, solicitudes, victorias, partidos, participantes, placas, alias,
importaciones, temporadas, eventos, convocatorias, anuncios, auditoría y un
manifiesto de Storage. El cliente descarga además cada archivo y lo codifica en
el JSON final.

La restauración ocurre en tres fases:

1. validar versión, estructura, cuentas existentes y cantidad de archivos;
2. restaurar los objetos de Storage;
3. ejecutar la RPC que recompone relaciones y registra la operación.

Supabase Auth no permite recrear identidades con una clave pública. Si una
cuenta ya no existe en Auth se informa como faltante y sus datos no se enlazan
hasta recrearla de forma autorizada. Nunca colocar `service_role` en el cliente
para evitar esta restricción.

## 15. PWA, offline y rendimiento

El manifest permite instalar la web desde Safari o Chrome. La primera apertura
necesita HTTPS e internet. Después, el service worker conserva el shell y las
plantillas del editor. Los datos compartidos de Supabase necesitan red; se debe
mostrar el error de conexión sin borrar una sesión válida.

La compilación `scripts/build-site.mjs` crea `.site` con una lista blanca. No se
publican scripts auxiliares, respaldos, pruebas, fuentes del repositorio ni
imágenes sin uso. El editor pesado solo se abre cuando se solicita. Las nuevas
imágenes decorativas deben convertirse a WebP/AVIF y cargarse con `loading=lazy`;
las plantillas Canvas pueden conservar PNG si la transparencia o calidad lo
requiere.

## 16. Pruebas

Comandos obligatorios:

```text
npm run check
npm run test:unit
npm run build
npm run test:e2e
```

`tests/unit/platform.test.mjs` comprueba tamaño, redirección antigua, seguridad,
funciones de plataforma, OCR y ausencia de claves privadas.

`tests/e2e/platform.spec.mjs` intercepta Supabase con respuestas controladas y
prueba en tres proyectos Chromium con dimensiones y entrada equivalentes a PC,
iPhone 13 y Pixel 7:

- apertura real del proveedor Google y selector de cuenta;
- persistencia de la sesión tras recargar;
- bloqueo por onboarding incompleto;
- separación de permisos owner;
- envío de resultados mediante RPC segura;
- carga de placas y plantillas externas del banner;
- ausencia de desbordamiento horizontal móvil.

Antes de publicar una nueva función sensible se debe añadir al menos una prueba
del resultado normal y una de permiso/entrada inválida.

## 17. Construcción y despliegue

La acción `.github/workflows/deploy-pages.yml` hace lo siguiente en `main`:

1. instala dependencias con `npm ci`;
2. busca claves privadas;
3. valida sintaxis y ejecuta pruebas unitarias;
4. construye `.site`;
5. instala Chromium y ejecuta las 21 pruebas de navegador;
6. solo si todo pasa, crea la configuración pública desde GitHub Secrets;
7. vuelve a construir y publica únicamente `.site`.

Variables requeridas en GitHub:

- variable `SUPABASE_URL`;
- secret `SUPABASE_PUBLISHABLE_KEY`.

La publishable key es pública por diseño; la seguridad depende de RLS y RPC.
Una `service_role` sí es secreta y está prohibida en el repositorio.

## 18. Cómo modificar sin romper

1. Revisar `git status` y no sobrescribir trabajo no relacionado.
2. Buscar primero el comportamiento existente con `rg`.
3. Mantener una sola fuente de verdad: no duplicar navegación ni editor.
4. Para permisos o estadísticas, escribir primero SQL/RLS/RPC y después UI.
5. Hacer migraciones idempotentes cuando sea posible (`if not exists`,
   `create or replace`, políticas eliminadas antes de recrearlas).
6. No cambiar firmas RPC sin actualizar el cliente, pruebas y documentación.
7. No interpolar HTML sin `esc()`; no insertar texto del usuario con
   `innerHTML` sin escapar.
8. Revocar ejecución pública de RPC privadas y concederla solo a
   `authenticated`.
9. Probar sesión anónima, integrante, moderador, líder y owner.
10. Ejecutar la suite completa antes de commit y verificar GitHub Pages después.

## 19. Lista de comprobación funcional

- Google regresa a la URL exacta de GitHub Pages y conserva la sesión.
- Un perfil incompleto siempre abre onboarding y conserva lo escrito.
- Un integrante ve otros perfiles, ranking, edad y capturas aprobadas.
- Un resultado pendiente no suma.
- Una copia exacta o visualmente similar es rechazada/señalada por el servidor.
- Un líder no ve correos ni operaciones exclusivas del owner.
- El owner puede cambiar roles sin modificar su propio rol.
- El banner descargado coincide con la plantilla oficial y el perfil actual.
- Venezuela y países largos no se superponen con su bandera.
- El OCR no guarda una asignación dudosa sin revisión.
- La papelera restaura antes de 30 días y solo purga después.
- El respaldo valida antes de escribir y cuenta archivos faltantes.
- La web no desplaza horizontalmente en iPhone ni Android.
- Tras la primera carga, las plantillas pueden abrirse sin conexión.

## 20. Limitaciones deliberadas

- GitHub Pages no ejecuta código de servidor; toda seguridad real está en
  Supabase.
- La restauración no puede recrear usuarios de Auth desde el navegador.
- El OCR ayuda, pero la líder confirma nombres poco legibles.
- El equipo recomendado orienta; no reemplaza el criterio humano.
- Correo o WhatsApp automáticos requieren una Edge Function o proveedor externo
  que procese `notification_outbox` con secretos guardados fuera del cliente.

Si una propuesta contradice estas limitaciones, debe rediseñarse en el backend,
no resolverse escondiendo controles en CSS o confiando en el navegador.
