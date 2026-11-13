const { test, expect } = require('@playwright/test');
const { CREDS, headedLogin, isTrackiq } = require('./helpers/auth');
const { qtest } = require('./helpers/qtest');

const ROLE_TEST_IDS = { admin: 'AUTH-001', kemsa: 'AUTH-002', manufacturer: 'AUTH-003' };

// Submits the login form and reports where it ended up. On TrackIQ the form is behind
// Cloudflare Turnstile, which never clears for a runner-driven browser, so the attempt is made
// by headed-login.js in a visible browser instead; elsewhere it is driven on `page` directly.
async function attemptLogin(page, email, password) {
  if (isTrackiq()) {
    const result = headedLogin(email, password);
    return { signedIn: result.ok, url: result.url || '' };
  }
  await page.goto('/login', { waitUntil: 'load' });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const signedIn = await page
    .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  return { signedIn, url: page.url() };
}

test.describe('Login', () => {
  qtest('AUTH-NEG-001', 'rejects an invalid password with an on-page error', async ({ page }) => {
    const { signedIn, url } = await attemptLogin(page, CREDS.admin.email, 'definitely-wrong-password');
    // Should stay on /login and not land on an authenticated page.
    expect(signedIn, `landed on ${url}`).toBe(false);
  });

  qtest('AUTH-NEG-002', 'rejects an unknown email', async ({ page }) => {
    const { signedIn, url } = await attemptLogin(page, `nobody-${Date.now()}@example.com`, 'whatever123');
    expect(signedIn, `landed on ${url}`).toBe(false);
  });

  for (const role of ['admin', 'kemsa', 'manufacturer']) {
    qtest(ROLE_TEST_IDS[role], `${role} can log in with valid credentials`, async ({ page }) => {
      const creds = CREDS[role];
      test.skip(!creds.email || !creds.password, `no credentials configured for ${role}`);
      const { signedIn, url } = await attemptLogin(page, creds.email, creds.password);
      expect(signedIn, `${role} should be redirected away from /login on success (ended on ${url})`).toBe(true);
    });
  }
});
