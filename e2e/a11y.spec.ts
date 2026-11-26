import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? '';
test.skip(!PASS, 'set E2E_PASS');

// Pages worth checking: the ones people use daily plus the new ones. serious and critical findings fail the test.
const PAGES = ['overview', 'guests', 'health', 'tiles', 'notifications', 'access', 'setup', 'scenes', 'capacity', 'cluster'];

for (const scheme of ['light', 'dark'] as const) test(`no serious or critical accessibility violations (${scheme} theme)`, async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('nav, .sidebar');
  const found: string[] = [];
  for (const id of PAGES) {
    await page.goto(`/#/${id}`);
    await page.waitForTimeout(1200);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    for (const v of r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
      found.push(`${id}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help} e.g. ${v.nodes[0].target.join(' ')}`);
    }
  }
  console.log(found.join('\n') || 'no findings');
  expect(found).toEqual([]);
});

test('the first Tab offers a way past the navigation', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForSelector('nav, .sidebar');
  await page.reload(); // focus starts at the top of a fresh page
  await page.waitForSelector('nav, .sidebar');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  expect(page.url()).not.toContain('main-content');
});
