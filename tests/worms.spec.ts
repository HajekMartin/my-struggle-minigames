import { test, expect, type Page } from '@playwright/test';
import { Room, Protocol } from '@colyseus/sdk';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue, LobbyState } from '../shared/types.js';
import { WORMS as W, type WormData, type WormInput } from '../shared/worms.js';

// Decode real network traffic. The test server narrows its in-memory registry in
// its own bootstrap; no game selection or debug API is added to the application.
function observe(page: Page) {
  let state: LobbyState | undefined;
  const sent: WormInput[] = [], decoder = new Room('probe');
  decoder.onMessage<LobbyState>('lobby', next => { state = next; });
  decoder.onMessage<{ matchId: string; roundIndex: number; data: object }>('minigameUpdate', update => {
    if (state?.match?.id === update.matchId && state.match.roundIndex === update.roundIndex) state.match.gameData = { ...state.match.gameData as object, ...update.data } as JsonValue;
  });
  decoder.onMessage<{ data: WormInput }>('minigame', value => sent.push(value.data));
  decoder.onMessage('*', () => {});
  page.on('websocket', socket => {
    const decode = ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== 'string' && (payload[0] & 31) === Protocol.ROOM_DATA) (decoder as unknown as { onMessageCallback(e: { data: Buffer }): void }).onMessageCallback({ data: payload });
    };
    socket.on('framereceived', decode); socket.on('framesent', decode);
  });
  return { get state() { return state; }, get game() { return state?.match?.gameData as unknown as WormData | undefined; }, sent };
}
async function key(page: Page, code: string, type: 'keydown' | 'keyup') {
  await page.evaluate(({ code, type }) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true })), { code, type });
}
function screenPoint(page: Page, x: number, y: number) {
  const { width, height } = page.viewportSize()!, top = Math.min(140, height * .22), available = Math.max(100, height - top - 90);
  const zoom = Math.min((width - 24) / W.width, available / W.height);
  return { x: width / 2 + (x - W.width / 2) * zoom, y: top + available / 2 + (y - W.height / 2) * zoom };
}

test('souboj ve dvou kontextech: společný start, autorita tahu, stamina, skok, myš, kráter, další tah a výsledky', async ({ browser }) => {
  const database = './test-results/worms.sqlite';
  for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
  const server = spawn(process.execPath, ['--input-type=module', '-e', "const { minigames } = await import('./dist/server/minigames/index.js'); minigames.splice(0, minigames.length, minigames.find(g => g.id === 'worms')); await import('./dist/server/index.js');"], {
    env: { ...process.env, PORT: '3104', SQLITE_PATH: database, NODE_ENV: 'test', MINIGAME_TEST_ONLY: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const contexts = [await browser.newContext(), await browser.newContext()], errors: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server souboje se nespustil.')), 10_000);
      server.stdout.on('data', data => { if (data.toString().includes('Lobby běží')) { clearTimeout(timer); resolve(); } });
      server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server skončil (${code}).`)); });
    });
    const pages = [await contexts[0].newPage(), await contexts[1].newPage()], probes = pages.map(observe), ids: string[] = [];
    for (const [i, page] of pages.entries()) {
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:3104');
      await page.getByLabel('Jméno hráče').fill(['Alice', 'Bob'][i]);
      await page.getByRole('button', { name: 'Pokračovat' }).click();
      await expect(page.locator('#choices')).toBeVisible();
      ids.push((await (await contexts[i].request.get('http://127.0.0.1:3104/api/me')).json()).player.id);
    }
    await pages[0].getByRole('button', { name: 'Vytvořit lobby' }).click();
    await expect(pages[0].locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
    await pages[1].getByLabel('Kód lobby', { exact: true }).fill((await pages[0].locator('#lobby-code').textContent())!);
    await pages[1].getByRole('button', { name: 'Připojit se do lobby' }).click();
    await expect(pages[0].locator('#players li')).toHaveCount(2);
    for (const page of pages) await page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click();
    for (const page of pages) await expect(page.locator('#worms-canvas canvas')).toBeVisible();
    await expect(pages[0].locator('#match-phase')).toHaveText('Společný odpočet', { timeout: 6_000 });
    expect(probes[0].game!.terrain).toEqual(probes[1].game!.terrain);
    expect(probes[0].game!.snapshot.running).toBe(false);
    await expect(pages[0].locator('#match-phase')).toHaveText('Probíhá minihra', { timeout: 6_000 });
    const activeIndex = ids.indexOf(probes[0].game!.snapshot.activeId!), otherIndex = 1 - activeIndex;
    const active = pages[activeIndex], other = pages[otherIndex], own = () => probes[0].game!.snapshot.characters.find(c => c.id === ids[activeIndex])!;
    await expect(active.locator('#worms-end')).toBeEnabled(); await expect(other.locator('#worms-end')).toBeDisabled();
    const positions = probes[0].game!.snapshot.characters.map(c => c.x);
    await key(other, 'KeyD', 'keydown');
    await expect.poll(() => probes[otherIndex].sent.length).toBe(0);
    await key(other, 'KeyD', 'keyup');
    expect(probes[0].game!.snapshot.characters.map(c => c.x)).toEqual(positions);
    const before = own().x;
    await key(active, 'KeyD', 'keydown');
    await expect.poll(() => own().x).toBeGreaterThan(before + 8);
    await key(active, 'KeyD', 'keyup');
    expect(own().stamina).toBeLessThan(W.stamina - 5);
    await expect.poll(() => own().grounded).toBe(true);
    const beforeJump = own().stamina;
    await key(active, 'Space', 'keydown'); await key(active, 'Space', 'keyup');
    await expect.poll(() => own().stamina).toBeLessThanOrEqual(beforeJump - W.jumpCost);
    await expect.poll(() => own().grounded, { timeout: 4_000 }).toBe(true);
    // Fire directly into nearby terrain through the actual pointer/charging controls.
    const at = screenPoint(active, own().x, own().y + 100), revision = probes[0].game!.terrain.revision;
    await active.mouse.move(at.x, at.y); await active.mouse.down();
    await expect.poll(() => probes[0].game!.snapshot.chargeStartedAt).not.toBeNull();
    await expect.poll(async () => Number(await active.locator('#worms-power').getAttribute('value'))).toBeGreaterThan(0);
    await active.mouse.up();
    await expect.poll(() => probes[0].game!.terrain.revision).toBe(revision + 1);
    await expect.poll(() => own().hp).toBeLessThan(100);
    expect(probes[activeIndex].sent.filter(m => m.type === 'fire')).toHaveLength(1);
    await expect(active.locator('#worms-end')).toBeDisabled();
    await expect.poll(() => probes[0].game!.snapshot.activeId, { timeout: 7_000 }).toBe(ids[otherIndex]);
    expect(probes[0].game!.terrain).toEqual(probes[1].game!.terrain);
    await active.screenshot({ path: 'test-results/worms-crater.png', fullPage: true });
    await other.getByRole('button', { name: 'Ukončit tah', exact: true }).click();
    await expect.poll(() => probes[0].game!.snapshot.activeId, { timeout: 4_000 }).toBe(ids[activeIndex]);
    expect(own().stamina).toBe(W.stamina);
    await contexts[otherIndex].setOffline(true);
    await expect(active.locator('#match-phase')).toHaveText('Výsledky kola', { timeout: 7_000 });
    await expect(active.locator('#scores tr')).toHaveCount(2);
    await expect(active.locator('#scores tr').last()).toContainText('Vyloučen/a po odpojení');
    await expect(active.locator('#scores tr').first().locator('td').nth(2)).toHaveText('1');
    await expect(active.locator('#worms-canvas canvas')).toHaveCount(0);
    await expect(active.locator('body')).not.toHaveClass(/worms/);
    await expect(active.locator('#match-phase')).toHaveText('Celkové výsledky', { timeout: 7_000 });
    const db = new DatabaseSync(database);
    try { expect(db.prepare('SELECT count(*) AS count FROM matches').get()!.count).toBe(1); }
    finally { db.close(); }
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(c => c.close()));
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  }
});
