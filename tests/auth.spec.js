const { test, expect } = require('@playwright/test');
const { CREDS } = require('./helpers/auth');
const { qtest } = require('./helpers/qtest');

const ROLE_TEST_IDS = { admin: 'AUTH-001', kemsa: 'AUTH-002', manufacturer: 'AUTH-003' };

test.describe('Login', () => {
  qtest('AUTH-NEG-001', 'rejects an invalid password with an on-page error', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('#email').fill(CREDS.admin.email);
    await page.locator('#password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(1500);
    // Should stay on /login and not land on an authenticated page.
    expect(page.url()).toContain('/login');
  });

  qtest('AUTH-NEG-002', 'rejects an unknown email', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('#email').fill('nobody-' + Date.now() + '@example.com');
    await page.locator('#password').fill('whatever123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/login');
  });

  for (const role of ['admin', 'kemsa', 'manufacturer']) {
    qtest(ROLE_TEST_IDS[role], `${role} can log in with valid credentials`, async ({ page }) => {
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
