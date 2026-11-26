import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const USER = process.env.E2E_USER ?? 'admin';
const PASS = process.env.E2E_PASS ?? '';
test.skip(!PASS, 'set E2E_PASS');

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel(/user/i).fill(USER);
  await page.getByLabel(/password/i).fill(PASS);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForSelector('nav, .sidebar');
}

/** Calls the API from inside the page so the request carries the browser's own origin and cookie. */
const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/api${p as string}`, { method: m as string, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, path, body] as const);

test('Services layout can be exported and imported', async ({ page }) => {
  await signIn(page);
  const made = await call(page, 'POST', '/admin/tiles', { kind: 'http', name: 'E2E mock', url: 'http://127.0.0.1:8911/api2/json/version' });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  try {
    await page.goto('/#/tiles');
    await page.reload();
    await page.getByRole('button', { name: 'Launcher' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /export layout/i }).click()]);
    expect(dl.suggestedFilename()).toBe('homedash-services-layout.json');
    const text = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ homedash: 'services-layout', view: 'launcher' });

    // back to cards, then import the file: the launcher view returns
    await page.getByRole('button', { name: 'Cards' }).click();
    await expect(page.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Import layout file').setInputFiles({ name: 'l.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.getByRole('button', { name: 'Launcher' })).toHaveAttribute('aria-pressed', 'true');

    // a file that is not a layout is refused with a message
    await page.getByLabel('Import layout file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await expect(page.getByText('not a homedash Services layout')).toBeVisible();
  } finally {
    await call(page, 'DELETE', `/admin/tiles/${(made.body as { id: string }).id}`);
  }
});

test('Backups and audit: run a backup, then verify the audit trail', async ({ page }) => {
  await signIn(page);
  await page.locator('a[href="#/backups"]').first().click();
  await expect(page.getByRole('heading', { name: 'Backups and audit' })).toBeVisible();
  await page.getByRole('button', { name: /back up now/i }).click();
  await expect(page.getByText(/Backup written: homedash-\d{8}-\d{6}\.db/)).toBeVisible();
  await expect(page.getByText('newest', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /verify now/i }).click();
  await expect(page.getByText('The trail is intact.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'CEF (for SIEM tools)' })).toHaveAttribute('href', /format=cef/);
});

test('an API token signs in without a cookie (what the mobile app does for two-step and SSO accounts)', async ({ page, playwright, baseURL }) => {
  await signIn(page);
  const made = await call(page, 'POST', '/auth/tokens', { name: 'e2e mobile', days: 1, role: 'viewer' });
  expect(made.status).toBe(200);
  const { token, id } = made.body as { token: string; id: number };
  expect(token).toMatch(/^hd_[0-9a-f]{12}_[A-Za-z0-9_-]{40,}$/); // the shape the app checks before sending it
  const bare = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Requested-With': 'homedash' } });
  try {
    expect((await bare.get('/api/auth/me')).status()).toBe(401); // no cookie, no token: refused
    const auth = { Authorization: `Bearer ${token}` };
    const me = await bare.get('/api/auth/me', { headers: auth });
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { username: string }).username).toBe(USER);
    expect((await bare.get('/api/guests', { headers: auth })).status()).toBe(200);
    expect((await bare.post('/api/auth/logout', { headers: auth })).status()).toBe(403); // tokens cannot sign out; the app just forgets it
  } finally {
    await bare.dispose();
    await call(page, 'DELETE', `/auth/tokens/${id}`);
  }
});
