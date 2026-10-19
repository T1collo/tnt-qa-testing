// Portal logins per role, for both environments the suite runs against.
//
// Credentials follow the environment under test (BASE_URL): TrackIQ accounts (TRACKIQ_* in
// .env) on trackiq, the tnt-demo ones otherwise - a login from one is rejected by the other.
//
// TrackIQ's /login is gated by Cloudflare Turnstile, which never clears for a browser driven
// by the test runner. There, a role's session (one httpOnly cookie) is created once by
// headed-login.js - a separate process that opens a visible browser for a few seconds - saved
// under playwright/.auth/, and restored into each test's context until it expires. tnt-demo
// has no Turnstile and keeps the plain form login.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isTrackiq = () => /trackiq/i.test(process.env.BASE_URL || '');
const baseUrl = () => (process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');

function credsFor(role) {
  const env = process.env;
  if (isTrackiq()) {
    return {
      admin: { email: env.TRACKIQ_ADMIN_EMAIL, password: env.TRACKIQ_ADMIN_PASSWORD },
      kemsa: { email: env.TRACKIQ_DISTRIBUTOR_EMAIL, password: env.TRACKIQ_DISTRIBUTOR_PASSWORD },
      manufacturer: { email: env.TRACKIQ_MANUFACTURER_EMAIL, password: env.TRACKIQ_MANUFACTURER_PASSWORD },
    }[role];
  }
  return {
    admin: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    kemsa: { email: env.KEMSA_EMAIL, password: env.KEMSA_PASSWORD },
    manufacturer: { email: env.MANUFACTURER_EMAIL, password: env.MANUFACTURER_PASSWORD },
  }[role];
}

// Resolved on access, so the environment chosen for the run decides the accounts.
const CREDS = new Proxy({}, { get: (_, role) => credsFor(role) });

// One sign-in through the real login form in a visible browser (see headed-login.js).
// Returns { ok, url, message }; with `stateOut`, a successful session is saved there.
function headedLoginOnce(email, password, stateOut) {
  const args = [path.join(__dirname, 'headed-login.js'), baseUrl(), email, password];
  if (stateOut) args.push(stateOut);
  const run = spawnSync(process.execPath, args, { encoding: 'utf-8', timeout: 110_000 });
  const line = String(run.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, url: null, message: (run.stderr || run.stdout || 'sign-in process failed').trim() };
  }
}

// One retry when the attempt never reached a verdict (Turnstile can be slow after several
// sign-ins in a row). A rejected password ends back on /login and is not retried.
function headedLogin(email, password, stateOut) {
  const first = headedLoginOnce(email, password, stateOut);
  const rejected = !first.ok && /\/login/.test(first.url || '');
  return first.ok || rejected ? first : headedLoginOnce(email, password, stateOut);
}

const sessionFile = (role) =>
  path.join(__dirname, '..', '..', 'playwright', '.auth', `portal-${new URL(baseUrl()).hostname}-${role}.json`);

async function restoreSession(context, file) {
  const { cookies } = JSON.parse(fs.readFileSync(file, 'utf-8'));
  await context.addCookies(cookies);
}

// Asks the auth API rather than looking at the URL: TrackIQ's landing page "/" is public, so
// "not on /login" says nothing about the session. get-session answers null when signed out.
async function landedSignedIn(page) {
  const res = await page.request.get('/api/auth/get-session');
  const body = res.ok() ? await res.json().catch(() => null) : null;
  if (!body?.session) return false;
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return true;
}

async function loginAs(page, role) {
  const creds = credsFor(role);
  if (!creds || !creds.email || !creds.password) {
    throw new Error(`Missing credentials for role "${role}" - check your .env file (see .env.example)`);
  }

  if (isTrackiq()) {
    const file = sessionFile(role);
    if (fs.existsSync(file)) {
      await restoreSession(page.context(), file);
      if (await landedSignedIn(page)) return;
      await page.context().clearCookies();
    }
    const result = headedLogin(creds.email, creds.password, file);
    if (!result.ok) throw new Error(`TrackIQ sign-in failed for ${role}: ${result.message || result.url}`);
    await restoreSession(page.context(), file);
    if (!(await landedSignedIn(page))) throw new Error(`TrackIQ session for ${role} was not accepted`);
    return;
  }

  await page.goto('/login', { waitUntil: 'load' });
  await page.locator('#email').fill(creds.email);
  await page.locator('#password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(500);
}

// A page signed in as `role` in its own browser context, for tests that act as two roles
// (e.g. a manufacturer creates, the regulator approves). Close it with page.context().close().
async function newRolePage(browser, role, contextOptions = {}) {
  const context = await browser.newContext({ baseURL: baseUrl(), viewport: { width: 1440, height: 900 }, ...contextOptions });
  const page = await context.newPage();
  await loginAs(page, role);
  return page;
}

module.exports = { loginAs, newRolePage, headedLogin, CREDS, isTrackiq, baseUrl };
