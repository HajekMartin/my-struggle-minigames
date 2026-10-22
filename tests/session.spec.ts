import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const address = 'http://127.0.0.1:3101';
const database = './test-results/persistence.sqlite';

async function start(production = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, PORT: '3101', SQLITE_PATH: database, NODE_ENV: production ? 'production' : 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server se nespustil.')); }, 10_000);
    child.stdout!.on('data', data => { if (data.toString().includes('Lobby běží')) { clearTimeout(timeout); resolve(); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server skončil (${code}).`)); });
  });
  return child;
}
async function stop(child: ChildProcess) {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('restart zachová SQLite session, zruší lobby; expirace a Secure v produkci', async ({ browser }) => {
  for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
  let server: ChildProcess | undefined = await start();
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(address);
    await page.getByLabel('Jméno hráče').fill('Stálý hráč');
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await page.getByRole('button', { name: 'Vytvořit lobby' }).click();
    await expect(page.locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
    const original = await (await context.request.get(`${address}/api/me`)).json();
    const cookie = (await context.cookies()).find(c => c.name === 'session')!;
    const db = new DatabaseSync(database);
    const saved = db.prepare('SELECT token_hash, expires_at FROM sessions').get()!;
    expect(saved.token_hash).not.toBe(cookie.value);
    expect(saved.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(saved.expires_at) - Date.now()).toBeGreaterThan(86_000_000);
    db.close();
    await stop(server); server = undefined;
    server = await start(true);
    await page.reload();
    await expect(page.locator('#choices')).toBeVisible();
    const restored = await (await context.request.get(`${address}/api/me`)).json();
    expect(restored.player).toEqual(original.player); expect(restored.lobbyCode).toBeNull();
    const response = await fetch(`${address}/api/player`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Produkce' }) });
    expect(response.headers.get('set-cookie')).toContain('; Secure');
    const expiredDb = new DatabaseSync(database);
    expiredDb.prepare('UPDATE sessions SET expires_at = ? WHERE player_id = ?').run(Date.now() - 1, original.player.id);
    expiredDb.close();
    await page.reload();
    await expect(page.getByLabel('Jméno hráče')).toBeVisible();
    expect((await context.request.post(`${address}/api/lobby`, { data: { action: 'create' } })).status()).toBe(401);
  } finally {
    await context.close();
    if (server) await stop(server);
  }
});

test('produkční registr spustí skutečný závod a nenabízí vývojový test', async ({ browser }) => {
  for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
  let server: ChildProcess | undefined = await start();
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const pages = [];
    // Seed persistent sessions before switching to production, without requiring an HTTPS test proxy.
    for (const [index, context] of contexts.entries()) {
      const page = await context.newPage(); pages.push(page);
      await page.goto(address);
      await page.getByLabel('Jméno hráče').fill(`Hráč ${index}`);
      await page.getByRole('button', { name: 'Pokračovat' }).click();
      await expect(page.locator('#choices')).toBeVisible();
    }
    await stop(server); server = undefined; server = await start(true);
    for (const page of pages) await page.reload();
    await pages[0].getByRole('button', { name: 'Vytvořit lobby' }).click();
    await expect(pages[0].locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
    await pages[1].getByLabel('Kód lobby', { exact: true }).fill((await pages[0].locator('#lobby-code').textContent())!);
    await pages[1].getByRole('button', { name: 'Připojit se do lobby' }).click();
    await expect(pages[0].locator('#players li')).toHaveCount(2);
    for (const page of pages) await page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click();
    for (const page of pages) {
      await expect(page.locator('#minigame-name')).toHaveText('Závod aut');
      await expect(page.locator('#match-panel')).toBeVisible();
      await expect(page.locator('#dev-finish')).toBeHidden();
    }
    const db = new DatabaseSync(database);
    try { expect(db.prepare('SELECT count(*) AS count FROM matches').get()!.count).toBe(0); }
    finally { db.close(); }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (server) await stop(server);
  }
});
