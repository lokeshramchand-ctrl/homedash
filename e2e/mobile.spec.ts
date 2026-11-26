import { expect, test } from '@playwright/test';

const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? '';
test.skip(!PASS, 'set E2E_PASS');

const PAGES = ['overview', 'node', 'cluster', 'guests', 'tasks', 'scenes', 'health', 'protection', 'capacity', 'netmap', 'nginx', 'kuma', 'grafana', 'diagnostics', 'logs', 'tiles', 'access', 'notifications', 'setup'];

test.use({ viewport: { width: 390, height: 800 } });

test('nothing spills sideways on a phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('main');
  const wide: string[] = [];
  for (const id of PAGES) {
    await page.goto(`/#/${id}`);
    await page.waitForTimeout(1000);
    const over = await page.evaluate(() => {
      const doc = document.documentElement;
      if (doc.scrollWidth <= doc.clientWidth + 1) return null;
      // name the widest culprit to make the failure actionable
      let worst: Element | null = null; let w = 0;
      for (const el of document.querySelectorAll('main *')) { const r = el.getBoundingClientRect(); if (r.right > doc.clientWidth + 1 && r.right > w) { w = r.right; worst = el; } }
      return `${doc.scrollWidth}px wide; widest: ${worst ? `${worst.tagName.toLowerCase()}.${String((worst as HTMLElement).className).split(' ')[0]}` : '?'}`;
    });
    if (over) wide.push(`${id}: ${over}`);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/m-${id}.png` });
  }
  console.log(wide.join('\n') || 'no overflow');
  expect(wide).toEqual([]);
});
