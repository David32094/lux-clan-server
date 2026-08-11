import { test, expect } from '@playwright/test';

const user = { id:'11111111-1111-4111-8111-111111111111', email:'player@example.test', user_metadata:{ full_name:'Jugador de prueba' }, app_metadata:{ providers:['google'] } };
const activeProfile = { id:user.id, display_name:'DAVID TEST', age:19, country_code:'br', country_name:'Brasil', avatar_path:null, onboarding_complete:true, membership_status:'active', is_public:true, public_slug:'david-test', primary_game_role:'Rusher', secondary_game_role:'Soporte', experience_level:'Competitivo' };

async function mockSupabase(page, { profile=activeProfile, role='member' }={}) {
  await page.route('**/supabase-client-config.js*', route => route.fulfill({ contentType:'text/javascript', body:"window.LUX_SUPABASE_CONFIG=Object.freeze({url:'https://test.supabase.co',publishableKey:'sb_publishable_test'});" }));
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = value => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(value), headers:{ 'access-control-allow-origin':'*' } });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.includes('/auth/v1/token')) return json({ access_token:'renewed-token', refresh_token:'refresh-token', expires_in:3600, user });
    if (url.pathname.includes('/rest/v1/user_roles')) return json([{ role }]);
    if (url.pathname.includes('/rest/v1/profiles') && request.method() === 'GET') return json(profile ? [profile] : []);
    if (url.pathname.includes('/rest/v1/rpc/get_public_clan_ranking')) return json(profile ? [{ ...profile, player_id:profile.id, victories_1v1:1, victories_2v2:0, victories_3v3:0, victories_4v4:2, victories_other:0, victories_total:3, matches_played:4, wins:3, losses:1, win_rate:75, kills_total:18, average_damage:2230 }] : []);
    if (url.pathname.includes('/rest/v1/rpc/get_authenticated_clan_directory')) return json(profile ? [profile] : []);
    if (url.pathname.includes('/rest/v1/rpc/get_period_ranking')) return json([]);
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
