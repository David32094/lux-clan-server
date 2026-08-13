import { test, expect } from '@playwright/test';

const user = { id:'11111111-1111-4111-8111-111111111111', email:'player@example.test', user_metadata:{ full_name:'Jugador de prueba' }, app_metadata:{ providers:['google'] } };
const activeProfile = { id:user.id, display_name:'DAVID TEST', age:19, country_code:'br', country_name:'Brasil', avatar_path:null, onboarding_complete:true, membership_status:'active', is_public:true, public_slug:'david-test', primary_game_role:'Rusher', secondary_game_role:'Soporte', experience_level:'Competitivo' };

async function mockSupabase(page, { profile=activeProfile, role='member', accounts=[] }={}) {
  let currentProfile = profile ? { ...profile } : null;
  let currentAccounts = accounts.map(account => ({ ...account }));
  await page.route('**/supabase-client-config.js*', route => route.fulfill({ contentType:'text/javascript', body:"window.LUX_SUPABASE_CONFIG=Object.freeze({url:'https://test.supabase.co',publishableKey:'sb_publishable_test'});" }));
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(value), headers:{ 'access-control-allow-origin':'*' } });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.includes('/auth/v1/token')) return json({ access_token:'renewed-token', refresh_token:'refresh-token', expires_in:3600, user });
    if (url.pathname.includes('/rest/v1/user_roles')) return json([{ role }]);
    if (url.pathname.includes('/rest/v1/profiles') && request.method() === 'GET') return json(currentProfile ? [currentProfile] : []);
    if (url.pathname.includes('/rest/v1/rpc/complete_my_onboarding')) {
      const payload = JSON.parse(request.postData() || '{}');
      currentProfile = { ...currentProfile, display_name:payload.p_display_name, age:payload.p_age, country_code:payload.p_country_code, country_name:payload.p_country_name, avatar_path:payload.p_avatar_path,
        primary_game_role:payload.p_primary_game_role, secondary_game_role:payload.p_secondary_game_role, experience_level:payload.p_experience_level, onboarding_complete:true };
      return json(currentProfile);
    }
    if (url.pathname.includes('/rest/v1/rpc/get_public_clan_ranking') || url.pathname.includes('/rest/v1/rpc/get_public_ranking')) return json(currentProfile ? [{ ...currentProfile, player_id:currentProfile.id, victories_1v1:1, victories_2v2:0, victories_3v3:0, victories_4v4:2, victories_other:0, victories_total:3, matches_played:4, wins:3, losses:1, win_rate:75, kills_total:18, average_damage:2230 }] : []);
    if (url.pathname.includes('/rest/v1/rpc/get_authenticated_clan_directory') || url.pathname.includes('/rest/v1/rpc/get_clan_directory')) return json(currentProfile ? [{ ...currentProfile, player_id:currentProfile.id }] : []);
    if (url.pathname.includes('/rest/v1/rpc/get_period_ranking')) return json([]);
    if (url.pathname.includes('/rest/v1/rpc/get_clan_access_settings')) return json([{ access_mode:'open', updated_at:new Date().toISOString() }]);
    if (url.pathname.includes('/rest/v1/rpc/owner_list_clan_users')) return json(currentAccounts);
    if (url.pathname.includes('/rest/v1/rpc/owner_list_removed_users')) return json(currentAccounts.filter(account => account.removed_at && !account.merged_into));
    if (url.pathname.includes('/rest/v1/rpc/staff_soft_delete_member')) {
      const payload = JSON.parse(request.postData() || '{}');
      currentAccounts = currentAccounts.filter(account => account.user_id !== payload.p_user_id);
      return json(null);
    }
    if (url.pathname.includes('/storage/v1/object/sign/')) return json({ signedURL:'/object/sign/mock' });
    if (url.pathname.includes('/rest/v1/rpc/')) return json([]);
    if (request.method() === 'POST' || request.method() === 'PATCH' || request.method() === 'DELETE') return json([]);
    return json([]);
  });
}

function oauthUrl(path='LUX_CLAN_EDITOR_BY.DAVID.XIT.html') {
  return `/${path}#access_token=test-token&refresh_token=refresh-token&expires_in=3600&token_type=bearer`;
}

test('Google abre el proveedor con selector de cuenta', async ({ page }) => {
  await mockSupabase(page, { profile:null });
  await page.goto('/LUX_CLAN_EDITOR_BY.DAVID.XIT.html');
  await page.getByRole('button', { name:/soy integrante/i }).click();
  const google = page.getByRole('button', { name:/continuar con google/i });
  await expect(google).toBeVisible();
  await google.click();
  await expect(page).toHaveURL(/test\.supabase\.co\/auth\/v1\/authorize/);
  expect(new URL(page.url()).searchParams.get('provider')).toBe('google');
  expect(new URL(page.url()).searchParams.get('prompt')).toBe('select_account');
});

test('la clasificación vuelve al inicio sin mostrar la interfaz antigua', async ({ page }) => {
  await mockSupabase(page, { profile:null });
  await page.goto('/LUX_CLAN_EDITOR_BY.DAVID.XIT.html');
  await expect.poll(() => page.evaluate(() => typeof window.luxSupabase?.openRanking)).toBe('function');
  await page.evaluate(() => window.luxSupabase.openRanking());
  await expect(page.locator('body')).toHaveClass(/lux-hub-public/);
  await expect(page.locator('#lux-public-screen')).toBeVisible();
  await page.locator('#lux-public-screen .lux-nav-brand').click();
  await expect(page.locator('body')).toHaveClass(/lux-hub-home/);
  await expect(page.locator('#hub-home')).toBeVisible();
  await expect(page.locator('#lux-public-screen')).toBeHidden();
});

test('la sesión de Google persiste después de recargar', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.user?.id)).toBe(user.id);
  expect(await page.evaluate(() => localStorage.getItem('lux_clan_auth_v1'))).toContain('refresh-token');
});

test('un perfil incompleto exige nombre, país y edad', async ({ page }) => {
  const pending = { ...activeProfile, display_name:'Jugador', age:null, country_code:null, country_name:null, onboarding_complete:false, membership_status:'pending', is_public:false };
  await mockSupabase(page, { profile:pending });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('profile'));
  await expect(page.locator('#hub-name')).toBeVisible();
  await expect(page.locator('#hub-age')).toBeVisible();
  await expect(page.locator('#hub-country')).toBeVisible();
});

test('los roles competitivos se guardan y sobreviven a una recarga', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('profile'));
  await page.locator('#lux-primary-role').selectOption('IGL');
  await page.locator('#lux-secondary-role').selectOption('Flexible');
  await page.locator('#lux-experience-level').selectOption('Veterano');
  await page.getByRole('button', { name:/guardar perfil/i }).click();
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.profile?.primary_game_role)).toBe('IGL');

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('profile'));
  await expect(page.locator('#lux-primary-role')).toHaveValue('IGL');
  await expect(page.locator('#lux-secondary-role')).toHaveValue('Flexible');
  await expect(page.locator('#lux-experience-level')).toHaveValue('Veterano');
});

test('los permisos de owner muestran operaciones privadas', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);
  await page.evaluate(() => window.luxSupabase.openLeader());
  await expect(page.getByText(/administración/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name:/cuentas|operaciones/i }).first()).toBeVisible();
});

test('la cabecera permanece estable y el último cambio de pestaña gana', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);
  await page.evaluate(() => window.luxSupabase.openLeader());
  await expect(page.locator('#lux-admin-tabs')).toBeVisible();

  await page.evaluate(() => {
    document.querySelector('#hub-admin .hub-nav').dataset.stabilityMarker = 'nav';
    document.querySelector('#lux-admin-tabs').dataset.stabilityMarker = 'tabs';
    void window.luxSupabase.navigateAdmin('requests');
    void window.luxSupabase.navigateAdmin('matches');
    void window.luxSupabase.navigateAdmin('directory');
  });

  await expect(page.locator('#lux-admin-tabs [data-admin-section="directory"]')).toHaveClass(/active/);
  await expect(page.locator('#hub-member-directory')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/lux-navigation-busy/);
  expect(await page.locator('#hub-admin .hub-nav').getAttribute('data-stability-marker')).toBe('nav');
  expect(await page.locator('#lux-admin-tabs').getAttribute('data-stability-marker')).toBe('tabs');
  expect(await page.evaluate(() => [...document.querySelector('#hub-admin .hub-page').children]
    .filter(child => child.id !== 'lux-admin-tabs' && !child.hidden).length)).toBe(1);
});

test('integrante y administrador usan una cabecera de pestañas con la misma altura', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('home'));
  await expect(page.locator('#lux-member-tabs')).toBeVisible();
  const member = await page.locator('#lux-member-tabs').evaluate(tabs => ({
    height:tabs.getBoundingClientRect().height,
    rows:new Set([...tabs.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size
  }));

  await page.evaluate(() => window.luxSupabase.openLeader());
  await expect(page.locator('#lux-admin-tabs')).toBeVisible();
  const admin = await page.locator('#lux-admin-tabs').evaluate(tabs => ({
    height:tabs.getBoundingClientRect().height,
    rows:new Set([...tabs.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size
  }));

  expect(member.rows).toBe(1);
  expect(admin.rows).toBe(1);
  expect(Math.abs(member.height - admin.height)).toBeLessThanOrEqual(1);
});

test('victorias y partidos se envían a RPC segura', async ({ page }) => {
  let secureRpc = false;
  await mockSupabase(page);
  page.on('request', request => { if (request.url().includes('/rpc/submit_victory_secure')) secureRpc = true; });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('victories'));
  const capture = await page.screenshot({ type:'png' });
  await page.locator('#hub-victory').setInputFiles({ name:'victoria.png', mimeType:'image/png', buffer:capture });
  await page.evaluate(() => window.luxHub.registerVictory());
  await expect.poll(() => secureRpc).toBe(true);
});

test('registrar partido pide solo modo y captura y deja el resto como correccion opcional', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(() => window.luxSupabase.openMember('matches'));
  await expect(page.locator('#lux-match-mode')).toBeVisible();
  await expect(page.locator('#lux-match-file')).toBeVisible();
  await expect(page.getByRole('button', { name:/leer captura automáticamente/i })).toBeVisible();
  await expect(page.locator('#lux-match-details')).not.toHaveAttribute('open');
  await page.locator('#lux-match-details summary').click();
  await expect(page.locator('#lux-match-result')).toBeVisible();
  await expect(page.locator('.lux-v3-help').filter({hasText:/K\/D\/A.*bajas.*muertes.*asistencias/i})).toBeVisible();
});

test('el lector de partidas prepara marcador, resultado y jugador conocido', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.parseResult)).toBe('function');
  const parsed = await page.evaluate(profile => window.luxMatchOCR.parseResult([
    { text:'VICTORIA 7 VS 4', confidence:94 },
    { text:'14/6/3 5791 DAVID TEST', confidence:88 }
  ], 'VICTORIA 7 VS 4\n14/6/3 5791 DAVID TEST', { members:[profile], aliases:[], mode:'4v4', result:'win' }), activeProfile);
  expect(parsed.result).toBe('win');
  expect(parsed.scoreFor).toBe(7);
  expect(parsed.scoreAgainst).toBe(4);
  expect(parsed.matched[0]?.playerId).toBe(user.id);
  expect(parsed.matched[0]?.damage).toBe(5791);
});

test('eliminar una cuenta la quita de Cuentas y no mezcla la papelera', async ({ page }) => {
  const targetId = '22222222-2222-4222-8222-222222222222';
  const removedId = '33333333-3333-4333-8333-333333333333';
  let removalRequested = false;
  const row = (id,email,name,extra={}) => ({ user_id:id,email,display_name:name,role:'member',providers:'google',created_at:new Date().toISOString(),last_sign_in_at:new Date().toISOString(),onboarding_complete:true,membership_status:'active',removed_at:null,purge_after:null,merged_into:null,...extra });
  await mockSupabase(page, { role:'owner', accounts:[
    row(user.id,user.email,activeProfile.display_name,{ role:'owner' }),
    row(targetId,'target@example.test','INTEGRANTE ACTIVO'),
    row(removedId,'trash@example.test','CUENTA EN PAPELERA',{ membership_status:'expelled',removed_at:new Date().toISOString(),purge_after:new Date(Date.now()+86400000).toISOString() })
  ] });
  page.on('request', request => { if (request.url().includes('/rpc/staff_soft_delete_member')) removalRequested = true; });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);
  await page.evaluate(() => window.luxSupabase.openLeader());
  await page.evaluate(() => window.luxSupabase.navigateAdmin('accounts'));
  await expect(page.getByText('target@example.test')).toBeVisible();
  await expect(page.getByText('trash@example.test')).toHaveCount(0);
  await page.locator('.lux-owner-account', { hasText:'target@example.test' }).getByRole('button', { name:/mover a papelera/i }).click();
  await page.locator('#lux-remove-reason').fill('Prueba de consistencia');
  await page.locator('#lux-remove-confirm').click();
  await expect.poll(() => removalRequested).toBe(true);
  await expect(page.getByText('target@example.test')).toHaveCount(0);
});

test('el lector separa aliados y rivales en una captura de Free Fire', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.parseResult)).toBe('function');
  const parsed = await page.evaluate(() => window.luxMatchOCR.parseResult([
    { text:'VICTORIA 7 VS 3', confidence:96, side:'unknown' },
    { text:'DAVID IA LUX UP 9/3/1 3001', confidence:91, side:'left' },
    { text:'Aaraon 10 LUX UP 5/4/1 1569', confidence:88, side:'left' },
    { text:'LX_MIKELITO LUX UP 2/7/3 1268', confidence:90, side:'right' }
  ], 'VICTORIA 7 VS 3', { members:[
    { id:'david', display_name:'DAVID IA' },
    { id:'aaron', display_name:'Aaraon 10' },
    { id:'mikelito', display_name:'LX_MIKELITO' }
  ], aliases:[], mode:'4v4' }));
  expect(parsed.teamSide).toBe('left');
  expect(parsed.scoreFor).toBe(7);
  expect(parsed.scoreAgainst).toBe(3);
  expect(parsed.matched.map(row => row.playerId)).toEqual(expect.arrayContaining(['david','aaron']));
  expect(parsed.matched.map(row => row.playerId)).not.toContain('mikelito');
});

test('el lector rechaza fragmentos de estadisticas como nombres', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.nameQuality)).toBe('function');
  const result = await page.evaluate(() => ({
    first:window.luxMatchOCR.nameQuality('m n Mk MH'),
    second:window.luxMatchOCR.nameQuality('IR pS pd is'),
    niko:window.luxMatchOCR.nameQuality('EDUxNIKO'),
    chris:window.luxMatchOCR.nameQuality('CHRISX AURA'),
    decorated:window.luxMatchOCR.similarity('Aargen 10','Aarøøn')
  }));
  expect(result.first).toBe(0);
  expect(result.second).toBe(0);
  expect(result.niko).toBeGreaterThan(0.7);
  expect(result.chris).toBeGreaterThan(0.7);
  expect(result.decorated).toBeGreaterThan(0.85);
});

test('el lector corrige caracteres decorados usando un integrante unico', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.parseResult)).toBe('function');
  const parsed=await page.evaluate(() => window.luxMatchOCR.parseResult([
    {text:'EDUxNIKO 10/6/8 4211',gameName:'EDUxNIKO',confidence:96,side:'left',kind:'player'},
    {text:'Aargen 10 6/6/17 2640',gameName:'Aargen 10',confidence:67,side:'left',kind:'player'}
  ],'VICTORIA 7 VS 6',{currentPlayerId:'edu',members:[
    {id:'edu',display_name:'EDUxNIKO'},
    {id:'aaron',display_name:'Aarøøn'}
  ],aliases:[],mode:'4v4',result:'win'}));
  const aaron=parsed.matched.find(row=>row.playerId==='aaron');
  expect(aaron).toBeTruthy();
  expect(aaron.detectedName).toBe('Aarøøn');
  expect(parsed.unmatched).toEqual([]);
});

test('el lector completa mapa tipo equipos marcador y estadisticas visibles', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.parseResult)).toBe('function');
  const parsed=await page.evaluate(() => window.luxMatchOCR.parseResult([
    {text:'EDUxNIKO 10/6/8 4211',gameName:'EDUxNIKO',stats:{kills:10,deaths:6,assists:8,damage:4211,confirmed:true},confidence:96,side:'left',kind:'player',rowIndex:0},
    {text:'SILENCIADORES',confidence:90,side:'left',kind:'team-label'},
    {text:'AULLADORES',confidence:90,side:'right',kind:'team-label'},
    {text:'7 VS 6',confidence:94,side:'unknown'}
  ],'DUELO DE ESCUADRAS\nBERMUDA\nVICTORIA\n7 VS 6',{currentPlayerId:'edu',members:[{id:'edu',display_name:'EDUxNIKO'}],aliases:[],mode:'4v4',result:'win'}));
  expect(parsed).toMatchObject({map:'BERMUDA',gameType:'DUELO DE ESCUADRAS',teamFor:'SILENCIADORES',teamAgainst:'AULLADORES',scoreFor:7,scoreAgainst:6});
  expect(parsed.matched[0]).toMatchObject({kills:10,deaths:6,assists:8,damage:4211,confirmed:true});
});

test('las estadisticas KDA eligen la lectura repetida y no una lectura aislada', async ({ page }) => {
  await mockSupabase(page);await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => typeof window.luxMatchOCR?.parseResult)).toBe('function');
  const parsed=await page.evaluate(() => window.luxMatchOCR.parseResult([
    {text:'FX 07',gameName:'FX 07',confidence:96,side:'left',kind:'player',rowIndex:0,stats:{kills:7,deaths:3,assists:1,damage:5273,confirmed:true}}
  ],'VICTORIA 7 VS 3',{currentPlayerId:'fx',members:[{id:'fx',display_name:'FX 07'}],aliases:[],mode:'4v4',result:'win'}));
  expect(parsed.matched[0]).toMatchObject({kills:7,deaths:3,assists:1,damage:5273,confirmed:true});
});

test('el ranking conserva la misma cabecera de integrante y administrador', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);

  await page.evaluate(() => window.luxSupabase.openMember('home'));
  await page.locator('#hub-member .hub-nav').evaluate(node => { node.dataset.rankingMarker='member'; });
  await page.evaluate(() => window.luxSupabase.openRanking('member'));
  await expect(page.locator('#lux-member-ranking-panel')).toBeVisible();
  await expect(page.locator('#hub-member .hub-nav')).toHaveAttribute('data-ranking-marker','member');

  await page.evaluate(() => window.luxSupabase.openLeader());
  await page.locator('#hub-admin .hub-nav').evaluate(node => { node.dataset.rankingMarker='admin'; });
  await page.evaluate(() => window.luxSupabase.openRanking('admin'));
  await expect(page.locator('#lux-admin-ranking-panel')).toBeVisible();
  await expect(page.locator('#hub-admin .hub-nav')).toHaveAttribute('data-ranking-marker','admin');
});

test('el perfil muestra resumen corto y oculta el desglose inicialmente', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  await page.evaluate(async id => { await window.luxSupabase._core.renderPublic(); await window.luxSupabase.openPublicPlayer(id); }, user.id);
  await expect(page.locator('.lux-profile-key-stats')).toBeVisible();
  await expect(page.locator('.lux-profile-key-stats article')).toHaveCount(4);
  await expect(page.locator('.lux-profile-stat-details')).not.toHaveAttribute('open');
  await expect(page.locator('.lux-profile-stat-details .lux-public-player-stats')).toBeHidden();
});

test('el owner ve el enlace general y los tres modos de acceso', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => window.luxSupabase?._core?.state?.isOwner)).toBe(true);
  await page.evaluate(() => window.luxPlatformV3.navigateAdmin('operations'));
  await expect(page.locator('#lux-access-control')).toBeVisible();
  await expect(page.locator('#lux-access-mode')).toHaveValue('open');
  await expect(page.locator('#lux-access-mode option')).toHaveCount(3);
  await expect(page.locator('#lux-access-control code')).toContainText('http://127.0.0.1');
});

test('placas y banners cargan sin depender de archivos incrustados', async ({ page }) => {
  await mockSupabase(page, { role:'owner' });
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  expect(await page.evaluate(() => typeof window.luxPlateImport?.analyze === 'function')).toBeTruthy();
  await page.evaluate(() => window.luxHub.openEditor(false));
  await expect(page.locator('#c-integ')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('#c-integ')?.width || 0)).toBeGreaterThan(500);
});

test('la navegación móvil no produce desbordamiento horizontal', async ({ page }) => {
  await mockSupabase(page);
  await page.goto(oauthUrl());
  await expect.poll(() => page.evaluate(() => Boolean(window.luxSupabase?._core?.state?.user))).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
  await expect(page.locator('body')).toHaveCSS('overflow-x', 'hidden');
});
