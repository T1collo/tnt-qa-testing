// Signs the facility partner in once and saves the session for the partner specs.
//
// The login form is gated by Cloudflare Turnstile, which never issues a token to a headless
// browser, nor to one launched inside the test runner. So: reuse the saved session while the
// portal still accepts it, and only when it has expired run the login flow (partner-flows.js)
// as a separate process - it opens a visible browser briefly, signs in and saves the session.
const fs = require('fs');
const { test, expect, request } = require('@playwright/test');
const { PORTAL, AUTH_FILE, FACILITY_LOGIN, partnerFlow } = require('./partner-helpers');

async function sessionStillValid() {
  if (!fs.existsSync(AUTH_FILE)) return false;
  const ctx = await request.newContext({ storageState: AUTH_FILE });
  try {
    const res = await ctx.get(`${PORTAL}/api/partners/certification/status?_=${Date.now()}`);
    return res.status() === 200;
  } finally {
    await ctx.dispose();
  }
}

test('sign in to the partner portal (facility)', async () => {
  test.setTimeout(120_000);
  if (await sessionStillValid()) return;

  const login = partnerFlow('login', { email: FACILITY_LOGIN.email, password: FACILITY_LOGIN.password, out: AUTH_FILE });
  expect(login.ok, `partner sign-in failed: ${login.message || login.error || login.status}`).toBe(true);
  expect(await sessionStillValid(), 'the saved partner session was not accepted').toBe(true);
});
