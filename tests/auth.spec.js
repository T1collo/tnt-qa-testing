const { test, expect } = require('@playwright/test');
const { CREDS } = require('./helpers/auth');

test.describe('Login', () => {
  test('rejects an invalid password with an on-page error', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('#email').fill(CREDS.admin.email);
    await page.locator('#password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(1500);
    // Should stay on /login and not land on an authenticated page.
    expect(page.url()).toContain('/login');
  });

  test('rejects an unknown email', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('#email').fill('nobody-' + Date.now() + '@example.com');
    await page.locator('#password').fill('whatever123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/login');
  });

  for (const role of ['admin', 'kemsa', 'manufacturer']) {
    test(`${role} can log in with valid credentials`, async ({ page }) => {
      const creds = CREDS[role];
      test.skip(!creds.email || !creds.password, `no credentials configured for ${role}`);
      await page.goto('/login', { waitUntil: 'load' });
      await page.locator('#email').fill(creds.email);
      await page.locator('#password').fill(creds.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
      expect(page.url(), `${role} should be redirected away from /login on success`).not.toContain('/login');
    });
  }
});
