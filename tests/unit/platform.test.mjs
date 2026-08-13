import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('la entrada es ligera y las plantillas no siguen incrustadas', async () => {
  const html = await read('LUX_CLAN_EDITOR_BY.DAVID.XIT.html');
  const info = await stat(new URL('../../LUX_CLAN_EDITOR_BY.DAVID.XIT.html', import.meta.url));
  assert.ok(info.size < 250_000, `HTML demasiado pesado: ${info.size}`);
  assert.match(html, /\.\/INTEGRANTES\/fluxo-integrantes\.png/);
  assert.match(html, /\.\/ENFRETAMIENTOS\/fluxo-enfrentamientos\.jpg/);
  assert.match(html, /\.\/ENFRETAMIENTOS\/fluxo-result-overlay\.png/);
  assert.match(html, /cl-nombre-integ[^>]+value="#ade102"/);
  assert.match(html, /field === 'nombre' && \/\\d\/\.test/);
  assert.match(html, /flag\s*:\s*\{\s*x:390,\s*y:1496,\s*w:84,\s*h:56/);
  assert.doesNotMatch(html, /const\s+INTEG_TEMPLATE\s*=\s*["'][^"']*base\.png/);
  assert.ok(!/const\s+INTEG_TEMPLATE\s*=\s*["']data:image/.test(html));
});

test('el editor anterior solo redirige a la versión oficial', async () => {
  const html = await read('LUX_CLAN_EDITOR.html');
  assert.match(html, /LUX_CLAN_EDITOR_BY\.DAVID\.XIT\.html/);
  assert.ok(html.length < 2_000);
});

test('el registro, los roles y el antifraude se resuelven en Supabase', async () => {
  const membership = await read('supabase/migrations/20260811_membership_security_v3.sql');
  const security = await read('supabase/migrations/20260811_seasons_notifications_v3.sql');
  assert.match(membership, /complete_my_onboarding/i);
  assert.match(membership, /membership_status/i);
  assert.match(membership, /enable row level security/i);
  assert.match(security, /evidence_visual_hashes/i);
  assert.match(security, /visual_hash_distance/i);
  assert.match(security, /submit_victory_secure/i);
  assert.match(security, /interval '24 hours'/i);
});

test('la plataforma incluye partidos, temporadas, convocatorias y operaciones', async () => {
  const sql = `${await read('supabase/migrations/20260811_competition_events_v3.sql')}\n${await read('supabase/migrations/20260811_operations_backup_v3.sql')}\n${await read('supabase/migrations/20260811_seasons_notifications_v3.sql')}`;
  for (const feature of ['public.matches','public.match_participants','public.seasons','public.clan_events','public.game_player_aliases','owner_export_platform_backup','owner_restore_platform_backup','owner_merge_member_profiles','audit_log','notifications']) {
    assert.match(sql, new RegExp(feature, 'i'), `Falta ${feature}`);
  }
});

test('el OCR conserva confianza por campo y admite varias capturas', async () => {
  const ocr = await read('prototipo-placas-ocr.js');
  assert.match(ocr, /files:\[\]/);
  assert.match(ocr, /confidence/i);
  assert.match(ocr, /lux-confidence-low/i);
  assert.match(ocr, /gloryWeekConfidence/i);
});

test('las partidas ocultan el OCR al integrante y dejan la correccion a la lider', async () => {
  const [ocr,platform,sql] = await Promise.all([
    read('lux-match-ocr.js'),
    read('lux-platform-v3.js'),
    read('supabase/migrations/20260811_zzz_capture_ocr_workflow.sql')
  ]);
  assert.match(ocr, /parseResult/);
  assert.match(ocr, /scoreFor/);
  assert.match(ocr, /lineStats/);
  assert.match(platform, /Envía la captura y listo/);
  assert.match(platform, /REVISIÓN VISUAL/);
  assert.match(platform, /¿QUÉ INTEGRANTE ES\?/);
  assert.match(platform, /APROBAR SELECCIONADAS/);
  assert.match(sql, /get_active_game_aliases/i);
  assert.match(sql, /staff_update_pending_match/i);
  assert.match(sql, /staff_bulk_review_matches/i);
  assert.match(sql, /stats_confirmed/i);
});

test('el acceso general se puede abrir, aprobar o limitar por invitacion', async () => {
  const sql = await read('supabase/migrations/20260811_zzzz_access_control.sql');
  for (const feature of ['clan_access_settings','get_clan_access_settings','owner_set_clan_access_mode','invite_only','complete_my_onboarding']) {
    assert.match(sql, new RegExp(feature, 'i'), `Falta ${feature}`);
  }
  assert.match(sql, /selected_mode='open'/i);
  assert.match(sql, /membership_status='active'/i);
});

test('cuentas, integrantes y rankings comparten la misma regla de visibilidad', async () => {
  const [sql,client,operations] = await Promise.all([
    read('supabase/migrations/20260813_account_directory_consistency.sql'),
    read('prototipo-supabase.js'),
    read('lux-platform-v3.js')
  ]);
  assert.match(sql, /owner_list_removed_users/i);
  assert.match(sql, /where \(p\.id is null or \(p\.removed_at is null and p\.merged_into is null\)\)/i);
  assert.match(sql, /membership_status='expelled'/i);
  assert.match(sql, /update public\.user_roles set role='member'/i);
  assert.match(sql, /profiles_enforce_visibility/i);
  assert.match(client, /removed_at=is\.null&merged_into=is\.null/);
  assert.match(client, /MOVER A PAPELERA/);
  assert.match(operations, /owner_list_removed_users/);
});

test('el OCR separa los dos equipos antes de comparar integrantes', async () => {
  const ocr = await read('lux-match-ocr.js');
  assert.match(ocr, /selectClanSide/);
  assert.match(ocr, /side:'left'/);
  assert.match(ocr, /side:'right'/);
  assert.match(ocr, /prepareRegion/);
  assert.match(ocr, /kind:'name'/);
  assert.match(ocr, /kind:'stats'/);
  assert.match(ocr, /buildPlayerLines/);
  assert.match(ocr, /nameQuality/);
});

test('no se publicó ninguna clave privada de Supabase', async () => {
  const files = ['index.html','LUX_CLAN_EDITOR_BY.DAVID.XIT.html','prototipo-supabase.js','supabase-client-config.js'];
  for (const file of files) assert.ok(!(await read(file)).includes('sb_secret_'), `Clave privada en ${file}`);
});
