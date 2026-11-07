import { test, expect, type Page } from '@playwright/test';
import { Room, Protocol } from '@colyseus/sdk';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue, LobbyState } from '../shared/types.js';
import type { DriveInput, RaceData } from '../shared/race.js';

// Observe the actual Colyseus wire with its SDK decoder; no test API or position injection.
function observe(page: Page) {
  let state: LobbyState | undefined;
  const sent: DriveInput[] = [];
  const decoder = new Room('probe');
  decoder.onMessage<LobbyState>('lobby', next => { state = next; });
  decoder.onMessage<{ matchId: string; roundIndex: number; data: object }>('minigameUpdate', update => {
    if (state?.match?.id === update.matchId && state.match.roundIndex === update.roundIndex) state.match.gameData = { ...state.match.gameData as object, ...update.data } as JsonValue;
  });
  decoder.onMessage<{ data: DriveInput }>('minigame', value => { sent.push(value.data); });
  decoder.onMessage('*', () => {});
  page.on('websocket', socket => {
    const decode = ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== 'string' && (payload[0] & 31) === Protocol.ROOM_DATA) {
        (decoder as unknown as { onMessageCallback(event: { data: Buffer }): void }).onMessageCallback({ data: payload });
      }
    };
    socket.on('framereceived', decode); socket.on('framesent', decode);
  });
  return { get state() { return state; }, get race() { return state?.match?.gameData as unknown as RaceData | undefined; }, sent };
}

async function keys(page: Page, codes: string[], type: 'keydown' | 'keyup' = 'keydown') {
  await page.evaluate(({ codes, type }) => {
    window.dispatchEvent(new Event('focus'));
    for (const code of codes) window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  }, { codes, type });
}

test('dva prohlížeče: společný start, náraz, R, blur, vyloučení a návrat jako divák', async ({ browser }) => {
  const database = './test-results/race.sqlite';
  for (const suffix of ['', '-wal', '-shm']) await rm(database + suffix, { force: true });
  const server = spawn(process.execPath, ['--input-type=module', '-e', "const { minigames } = await import('./dist/server/minigames/index.js'); const { raceGame } = await import('./dist/server/minigames/race/index.js'); minigames.splice(0, minigames.length, raceGame); await import('./dist/server/index.js');"], {
    env: { ...process.env, PORT: '3103', SQLITE_PATH: database, NODE_ENV: 'test', MINIGAME_TEST_ONLY: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const contexts = [await browser.newContext(), await browser.newContext()];
  const errors: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Závodní server se nespustil.')), 10_000);
      server.stdout.on('data', data => { if (data.toString().includes('Lobby běží')) { clearTimeout(timeout); resolve(); } });
      server.once('error', reject); server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server skončil (${code}).`)); });
    });
    const pages = [await contexts[0].newPage(), await contexts[1].newPage()];
    const probes = pages.map(observe);
    for (const [i, page] of pages.entries()) {
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:3103');
      await page.getByLabel('Jméno hráče').fill(['Alice', 'Bob'][i]);
      await page.getByRole('button', { name: 'Pokračovat' }).click();
    }
    await pages[0].getByRole('button', { name: 'Vytvořit lobby' }).click();
    await expect(pages[0].locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
    await pages[1].getByLabel('Kód lobby', { exact: true }).fill((await pages[0].locator('#lobby-code').textContent())!);
    await pages[1].getByRole('button', { name: 'Připojit se do lobby' }).click();
    await expect(pages[0].locator('#players li')).toHaveCount(2);
    for (const page of pages) await page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click();
    for (const page of pages) await expect(page.locator('#race-canvas canvas')).toBeVisible();
    for (const page of pages) {
      const viewport = page.viewportSize()!;
      await expect.poll(async () => {
        const box = await page.locator('#race-canvas canvas').boundingBox();
        return box && [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
      }).toEqual([0, 0, viewport.width, viewport.height]);
    }
    await expect(pages[0].locator('#match-phase')).toHaveText('Společný odpočet', { timeout: 6_000 });
    expect(probes[0].race!.track).toEqual(probes[1].race!.track);
    const initial = probes[0].race!.snapshot.cars.map(car => [car.x, car.y]);
    for (const page of pages) await keys(page, ['KeyW']);
    expect(probes[0].race!.snapshot.running).toBe(false);
    expect(probes[0].race!.snapshot.cars.map(car => [car.x, car.y])).toEqual(initial);
    expect(probes[0].sent).toHaveLength(0);
    await expect(pages[0].locator('#match-phase')).toHaveText('Probíhá minihra', { timeout: 6_000 });
    for (const [i, page] of pages.entries()) {
      const car = probes[0].race!.snapshot.cars[i];
      await keys(page, [car.y < 0 ? 'KeyD' : 'KeyA']);
    }
    await expect.poll(() => probes[0].race?.snapshot.cars.every(c => c.collisions > 0), { timeout: 7_000 }).toBe(true);
    for (const page of pages) await keys(page, ['KeyW', 'KeyA', 'KeyD'], 'keyup');
    await pages[0].setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => {
      const box = await pages[0].locator('#race-canvas canvas').boundingBox();
      return box && [Math.round(box.width), Math.round(box.height)];
    }).toEqual([1440, 900]);
    await pages[0].screenshot({ path: 'test-results/race-collision.png', fullPage: true });
    const beforeReset = probes[0].race!.snapshot.cars[0];
    await keys(pages[0], ['KeyR']);
    await expect.poll(() => probes[0].race!.snapshot.cars[0].resetSerial).toBeGreaterThan(beforeReset.resetSerial);
    expect(probes[0].race!.snapshot.cars[0].progress).toBeLessThanOrEqual(beforeReset.progress + .1);
    expect(probes[0].race!.snapshot.cars[0].lockedUntil).toBeGreaterThan(probes[0].race!.snapshot.elapsedMs + 1700);
    await keys(pages[0], ['KeyW']);
    await pages[0].evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(() => probes[0].sent.at(-1)?.throttle).toBe(0);
    await contexts[0].setOffline(true);
    await expect.poll(() => probes[1].race?.snapshot.cars[0].status, { timeout: 7_000 }).toBe('excluded');
    await contexts[0].setOffline(false);
    await expect(pages[0].locator('#race-status')).toContainText('Vyloučen/a', { timeout: 10_000 });
    expect(probes[0].race!.snapshot.cars[0].status).toBe('excluded');
    await expect(pages[0].locator('#race-canvas canvas')).toBeVisible();
    await contexts[1].setOffline(true);
    await expect(pages[0].locator('#match-phase')).toHaveText('Výsledky kola', { timeout: 7_000 });
    await expect(pages[0].locator('#scores tr')).toHaveCount(2);
    await expect(pages[0].locator('#scores tr').first().locator('td')).toHaveText(['1.', 'Alice', '0,5', '0,5', 'Vyloučen/a po odpojení']);
    await expect(pages[0].locator('#scores tr').last().locator('td')).toHaveText(['1.', 'Bob', '0,5', '0,5', 'Vyloučen/a po odpojení']);
    await expect(pages[0].locator('#race-canvas canvas')).toHaveCount(0);
    await expect(pages[0].locator('body')).not.toHaveClass(/racing/);
    await expect(pages[0].locator('#match-phase')).toHaveText('Celkové výsledky', { timeout: 7_000 });
    const db = new DatabaseSync(database);
    try { expect(db.prepare('SELECT count(*) AS count FROM matches').get()!.count).toBe(1); }
    finally { db.close(); }
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  }
});
