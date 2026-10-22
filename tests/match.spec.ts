import { test, expect, type Browser } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { MAX_ROUNDS } from '../shared/config.js';

async function player(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Jméno hráče').fill(name);
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await expect(page.getByRole('button', { name: 'Vytvořit lobby' })).toBeVisible();
  return { context, page };
}

test('dvě kola se čtyřmi hráči, remíza, reload, odchod, uložení a stejná lobby', async ({ browser }) => {
  const people = [];
  try {
    for (const name of ['Anna', 'Bára', 'Cyril', 'Dana']) people.push(await player(browser, name));
    const [a, b, c, d] = people;
    await a.page.getByRole('button', { name: 'Vytvořit lobby' }).click();
    await expect(a.page.locator('#lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
    const code = (await a.page.locator('#lobby-code').textContent())!;
    for (const p of people.slice(1)) {
      await p.page.getByLabel('Kód lobby', { exact: true }).fill(code);
      await p.page.getByRole('button', { name: 'Připojit se do lobby' }).click();
      await expect(p.page.locator('#players li')).toHaveCount(people.indexOf(p) + 1);
    }
    await expect(a.page.getByLabel('Počet kol')).toBeEnabled();
    await expect(b.page.getByLabel('Počet kol')).toBeDisabled();
    await expect(a.page.locator('#round-count option')).toHaveCount(MAX_ROUNDS);
    await b.page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click();
    await expect(b.page.getByRole('button', { name: 'Zrušit připravenost' })).toBeVisible();
    await a.page.getByLabel('Počet kol').selectOption('2');
    for (const p of people) {
      await expect(p.page.getByLabel('Počet kol')).toHaveValue('2');
      await expect(p.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
    }
    for (const p of people) await p.page.getByRole('button', { name: 'Jsem připraven/a', exact: true }).click();
    await expect(a.page.locator('#match-phase')).toHaveText('Pravidla');
    await expect(a.page.locator('#match-round')).toHaveText('Kolo 1 / 2');
    await b.page.reload();
    await expect(b.page.locator('#match-round')).toHaveText('Kolo 1 / 2');
    await expect(a.page.locator('#match-phase')).toHaveText('Společný odpočet', { timeout: 6_000 });
    await expect(a.page.locator('#phase-time')).toHaveText(/[0-3] s/);
    await expect(a.page.getByRole('button', { name: 'Vyhodnotit testovací kolo' })).toBeVisible({ timeout: 6_000 });
    await expect(b.page.getByRole('button', { name: 'Vyhodnotit testovací kolo' })).toBeHidden();
    await a.page.getByRole('button', { name: 'Vyhodnotit testovací kolo' }).click();
    await expect(a.page.locator('#match-phase')).toHaveText('Výsledky kola');
    await expect(a.page.locator('#scores tr')).toHaveCount(4);
    await expect(a.page.locator('#scores tr').nth(0).locator('td')).toHaveText(['1.', 'Anna', '2,5', '2,5', 'Testovací remíza']);
    await expect(a.page.locator('#scores tr').nth(1).locator('td')).toHaveText(['1.', 'Bára', '2,5', '2,5', 'Testovací remíza']);
    // A departed participant stays in the locked scoring roster for round two.
    await d.page.getByRole('button', { name: 'Opustit lobby' }).click();
    await expect(a.page.locator('#match-round')).toHaveText('Kolo 2 / 2', { timeout: 7_000 });
    await expect(a.page.locator('#match-phase')).toHaveText('Výsledky kola', { timeout: 13_000 });
    await expect(a.page.locator('#scores tr')).toHaveCount(4);
    await expect(a.page.locator('#scores tr').nth(3).locator('td')).toHaveText(['4.', 'Dana', '0', '0', 'Nedokončil/a']);
    await a.page.screenshot({ path: 'test-results/round-results.png', fullPage: true });
    await expect(a.page.locator('#match-phase')).toHaveText('Celkové výsledky', { timeout: 7_000 });
    await expect(a.page.locator('#winner')).toHaveText('Vítězové: Anna, Bára');
    await expect(a.page.locator('#scores tr').nth(0).locator('td')).toHaveText(['1.', 'Anna', '—', '5', 'Vítěz']);
    const db = new DatabaseSync('./test-results/lobby.sqlite');
    try {
      const rows = db.prepare('SELECT * FROM matches WHERE lobby_code = ?').all(code);
      expect(rows).toHaveLength(1);
      const saved = rows[0];
      expect(JSON.parse(String(saved.participants_json))).toHaveLength(4);
      expect(JSON.parse(String(saved.minigames_json)).map((g: { id: string }) => g.id)).toEqual(['development-test', 'development-test']);
      expect(JSON.parse(String(saved.rounds_json))).toHaveLength(2);
      expect(JSON.parse(String(saved.scores_json)).map((s: { total: number }) => s.total)).toEqual([5, 5, 2, 0]);
    } finally { db.close(); }
    await expect(a.page.locator('#match-panel')).toBeHidden({ timeout: 10_000 });
    await expect(a.page.locator('#lobby-code')).toHaveText(code);
    for (const p of [a, b, c]) {
      await expect(p.page.getByRole('button', { name: 'Jsem připraven/a', exact: true })).toBeVisible();
      await expect(p.page.locator('#players li')).toHaveCount(3);
    }
    for (const p of [a, b, c]) await p.page.getByRole('button', { name: 'Opustit lobby' }).click();
    await d.page.getByLabel('Kód lobby', { exact: true }).fill(code);
    await d.page.getByRole('button', { name: 'Připojit se do lobby' }).click();
    await expect(d.page.getByRole('alert')).toContainText('neexistuje');
  } finally { await Promise.all(people.map(p => p.context.close())); }
});
