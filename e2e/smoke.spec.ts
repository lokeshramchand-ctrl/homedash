import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? '';

// Every page in the navigation. Pages behind a feature flag are skipped when the server does not enable them.
const PAGES = ['setup', 'overview', 'node', 'cluster', 'guests', 'gpu', 'tasks', 'scenes', 'health', 'protection', 'capacity', 'netmap', 'nginx', 'kuma', 'grafana', 'diagnostics', 'logs', 'crowdsec', 'data', 'tiles', 'llama', 'access', 'notifications'];

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.locator('nav, .sidebar').first()).toBeVisible();
}

test.skip(!PASS, 'set E2E_PASS (and E2E_USER) for a user on the running server');

test('every page renders without script errors', async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console] ${m.text()}`); });
  await signIn(page);
  for (const id of PAGES) {
    problems.push(`--- ${id}`);
    await page.goto(`/#/${id}`);
    await page.waitForTimeout(1200);
    const crashed = await page.getByText(/something went wrong|unexpected error/i).count();
    if (crashed) problems.push(`[crash] ${id} shows the error boundary`);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${id}.png`, fullPage: false });
  }
  const real = problems.filter((p) => !p.startsWith('---'));
  console.log(problems.join('\n'));
  expect(real.filter((p) => p.startsWith('[pageerror]') || p.startsWith('[crash]'))).toEqual([]);
});

test('a fresh install can reach Services and open the Add service form', async ({ page }) => {
  await signIn(page);
  await page.locator('a[href="#/tiles"], [data-nav="tiles"]').first().click();
  await expect(page).toHaveURL(/#\/tiles/);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.getByRole('button', { name: /add service/i }).click();
  await expect(page.getByText('Add a service')).toBeVisible();
});

test('an integration that is not switched on is explained, not reported as a failure', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/overview');
  await expect(page.getByText(/Couldn't load this panel/)).toHaveCount(0);
});

test('Setup shows a checklist and the YAML to switch an integration on', async ({ page }) => {
  await signIn(page);
  await page.locator('a[href="#/setup"]').first().click();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ checks done/)).toBeVisible();
  await expect(page.getByText('Connect to Proxmox')).toBeVisible();
  await page.getByRole('button', { name: /Uptime Kuma/ }).click();
  await expect(page.locator('pre').filter({ hasText: 'api_key: ${KUMA_API_KEY}' })).toBeVisible();
});

test('the Overview points an administrator at the unfinished setup, and it can be dismissed', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => localStorage.removeItem('setup-nudge-dismissed'));
  await page.goto('/#/overview');
  await page.reload();
  const nudge = page.getByText('Finish setting up homedash');
  await expect(nudge).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(nudge).toHaveCount(0);
});
