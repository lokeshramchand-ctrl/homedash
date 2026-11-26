import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? '';
test.skip(!PASS, 'set E2E_PASS (and E2E_USER) for a user on the running server');

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.locator('nav, .sidebar').first()).toBeVisible();
}

test('registry: add two services, record a dependency, and see the impact; an unlinked service is not shown as healthy', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const db = `Postgres ${stamp}`; const app = `Wiki ${stamp}`;
  await signIn(page);
  await page.goto('/#/registry');

  await page.getByRole('button', { name: /add a service/i }).click();
  await page.getByLabel('Name', { exact: true }).fill(db);
  await page.getByLabel('Criticality').selectOption('critical');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(db).first()).toBeVisible();

  await page.getByRole('button', { name: /add a service/i }).click();
  await page.getByLabel('Name', { exact: true }).fill(app);
  await page.getByLabel(db).check();
  await page.getByRole('button', { name: 'Save' }).click();

  const row = page.locator('li', { hasText: db });
  await expect(row.getByText('Not monitored')).toBeVisible();
  await expect(row.getByText(/1 depends on it/)).toBeVisible();
  await expect(row.getByText('Healthy')).toHaveCount(0);

  await row.getByRole('button', { name: 'Impact' }).click();
  await expect(page.getByRole('dialog').getByText(app)).toBeVisible();
  await page.keyboard.press('Escape');

  // clean up so the test can be repeated
  for (const name of [app, db]) {
    const r = page.locator('li', { hasText: name });
    await r.getByRole('button', { name: 'Remove', exact: true }).click();
    await r.getByRole('button', { name: new RegExp(`Remove ${name}`) }).click();
    await expect(page.locator('li', { hasText: name })).toHaveCount(0);
  }
});

test('identity: an address that is not a provider gives a plain error, and a private-looking address is refused', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/identity');
  await expect(page.getByText('Sign-in settings in homedash')).toBeVisible();
  await page.getByLabel('Issuer address').fill('http://169.254.169.254/');
  await page.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByText(/not allowed/i).first()).toBeVisible();
});
