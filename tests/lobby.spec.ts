import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function player(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Jméno hráče').fill(name);
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await expect(page.getByRole('button', { name: 'Vytvořit lobby' })).toBeVisible();
  return { context, page };
}
async function create(page: Page) {
  await page.getByRole('button', { name: 'Vytvořit lobby' }).click();
  await expect(page.locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  return (await page.locator('#lobby-code').textContent())!;
}
async function join(page: Page, code: string) {
  await page.getByLabel('Kód lobby').fill(code);
  await page.getByRole('button', { name: 'Připojit se do lobby' }).click();
}
async function ready(page: Page) { await page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click(); }
async function close(...contexts: BrowserContext[]) { await Promise.all(contexts.map(context => context.close())); }

test('dva hráči, reset ready, reload, cookie, spuštění a zákaz nových hráčů', async ({ browser }) => {
  const a = await player(browser, '  Alice  ');
  const b = await player(browser, 'Bob');
  const c = await player(browser, 'Cyril');
  try {
    const code = await create(a.page);
    const identity = await (await a.context.request.get('/api/me')).json();
    const cookie = (await a.context.cookies()).find(c => c.name === 'session')!;
    expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Lax');
    expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);
    expect(await a.page.evaluate(() => document.cookie)).not.toContain('session=');
    await ready(a.page);
    await expect(a.page.getByRole('button', { name: 'Ještě nejsem připraven/a' })).toBeVisible();
    await join(b.page, `  ${code.toLowerCase()}  `);
    await expect(a.page.locator('#players li')).toHaveCount(2);
    await expect(a.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
    await a.page.screenshot({ path: 'test-results/lobby.png', fullPage: true });
    await ready(a.page);
    await a.page.reload();
    await expect(a.page.locator('#players li')).toHaveCount(2);
    await expect(a.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
    expect((await (await a.context.request.get('/api/me')).json()).player.id).toBe(identity.player.id);
    // A second tab replaces the connection and retains one logical player.
    const tab = await a.context.newPage(); await tab.goto('/');
    await expect(tab.locator('#players li')).toHaveCount(2);
    await expect(a.page.getByRole('alert')).toContainText('jiné kartě');
    await expect(b.page.locator('#players li')).toHaveCount(2);
    await ready(tab); await ready(b.page);
    await expect(tab.getByRole('heading', { name: 'Hra spuštěna', exact: true })).toBeVisible();
    await expect(b.page.getByRole('heading', { name: 'Hra spuštěna', exact: true })).toBeVisible();
    await tab.reload();
    await expect(tab.getByRole('heading', { name: 'Hra spuštěna', exact: true })).toBeVisible();
    await expect(tab.locator('#players li')).toHaveCount(2);
    await join(c.page, code);
    await expect(c.page.getByRole('alert')).toContainText('už byla spuštěna');
    await tab.getByRole('button', { name: 'Opustit lobby' }).click();
    await b.page.getByRole('button', { name: 'Opustit lobby' }).click();
    await expect(b.page.locator('#choices')).toBeVisible();
    await join(c.page, code);
    await expect(c.page.getByRole('alert')).toContainText('neexistuje');
  } finally { await close(a.context, b.context, c.context); }
});

test('výpadek blokuje start, návrat a odebrání po 30 sekundách', async ({ browser }) => {
  const a = await player(browser, 'Dana');
  const b = await player(browser, 'Eva');
  try {
    const code = await create(a.page); await join(b.page, code);
    await expect(a.page.locator('#players li')).toHaveCount(2);
    await b.context.setOffline(true);
    await expect(a.page.locator('#players')).toContainText('Odpojen/a', { timeout: 10_000 });
    await expect(b.page.locator('#connection')).toContainText('Spojení bylo přerušeno', { timeout: 10_000 });
    await b.context.setOffline(false);
    await expect(a.page.locator('#players')).not.toContainText('Odpojen/a', { timeout: 10_000 });
    await expect(b.page.locator('#connection')).toBeHidden();
    await ready(b.page);
    await b.page.goto('about:blank');
    await expect(a.page.locator('#players')).toContainText('Odpojen/a');
    await ready(a.page);
    await expect(a.page.getByRole('heading', { name: 'Čekáme na partu' })).toBeVisible();
    await b.page.goto('/');
    await expect(b.page.locator('#players li')).toHaveCount(2);
    await expect(b.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
    await b.page.goto('about:blank');
    await expect(a.page.locator('#players')).toContainText('Odpojen/a');
    await expect(a.page.locator('#players li')).toHaveCount(1, { timeout: 35_000 });
    await expect(a.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
    await a.page.getByRole('button', { name: 'Opustit lobby' }).click();
  } finally { await close(a.context, b.context); }
});

test('validace jména, plná lobby a bezpečné zobrazení', async ({ browser, request }) => {
  const anonymous = await request.post('/api/lobby', { data: { action: 'create', playerId: 'fake' } });
  expect(anonymous.status()).toBe(401);
  expect((await request.post('/matchmake/create/lobby', { data: {} })).status()).toBe(404);
  expect((await request.post('/api/player', { headers: { Origin: 'https://other.example' }, data: { name: 'Ada' } })).status()).toBe(403);
  expect((await request.post('/api/player', { data: { name: '   ' } })).status()).toBe(400);
  expect((await request.post('/api/player', { data: { name: 'x'.repeat(21) } })).status()).toBe(400);
  const players = [];
  try {
    for (let i = 0; i < 9; i++) players.push(await player(browser, i === 0 ? '<b>Ada</b>' : `Hráč ${i}`));
    const code = await create(players[0].page);
    for (const p of players.slice(1, 8)) {
      await join(p.page, code);
      await expect(p.page.locator('#lobby')).toBeVisible();
    }
    await expect(players[0].page.locator('#players li')).toHaveCount(8);
    await expect(players[0].page.locator('#players')).toContainText('<b>Ada</b>');
    await expect(players[0].page.locator('#players b')).toHaveCount(0);
    await join(players[8].page, code);
    await expect(players[8].page.getByRole('alert')).toContainText('plná');
    const otherCode = await create(players[8].page);
    const denied = await players[0].context.request.post('/api/lobby', { data: { action: 'join', code: otherCode } });
    expect(denied.status()).toBe(409);
    // A full room still accepts its existing member after reload.
    await players[0].page.reload();
    await expect(players[0].page.locator('#players li')).toHaveCount(8);
    for (const p of players) await p.page.getByRole('button', { name: 'Opustit lobby' }).click();
  } finally { await close(...players.map(p => p.context)); }
});
