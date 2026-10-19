// Partner-portal form flows that sit behind Cloudflare Turnstile (sign-in, registration).
// Turnstile issues no token to a headless browser, nor to one launched inside the Playwright
// test runner, so each flow runs as its own process with a visible browser for a few seconds
// and prints one JSON line with what happened.
//
//   node tests/partner/partner-flows.js login    '{"email":"…","password":"…","out":"state.json"}'
//   node tests/partner/partner-flows.js register '{"orgName":"…","orgType":"DISTRIBUTOR","email":"…","password":"…","confirm":"…"}'
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORTAL = (process.env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, '');

// Enabled once Turnstile has issued its token (and the form's own checks allow it).
async function waitForTurnstile(page) {
  await page
    .waitForFunction(() => (document.querySelector('input[name="cf-turnstile-response"]')?.value || '').length > 0, null, { timeout: 60_000 })
    .catch(() => {});
}

async function login(page, context, { email, password, out }) {
  await page.goto(`${PORTAL}/partners/login`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('your.email@company.com').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.waitForFunction(() => !document.querySelector('button[type=submit]')?.disabled, null, { timeout: 60_000 });
  const signIn = page.waitForResponse((r) => /\/api\/auth\/user\/sign-in\/email/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await page.getByRole('button', { name: 'Sign In' }).click();
  const res = await signIn;
  // A refusal shows its message in a toast that disappears after a few seconds, so it is read
  // as soon as the refusal arrives rather than after waiting out the redirect.
  if (res && res.status() >= 400) {
    const toast = page.getByText(/invalid email or password|too many|locked|not verified|error/i).first();
    const message = await toast
      .waitFor({ timeout: 6_000 })
      .then(() => toast.innerText())
      .catch(async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300));
    return { ok: false, status: res.status(), url: page.url(), message };
  }
  const ok = await page
    .waitForURL('**/partners/dashboard', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const message = ok ? '' : (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
  if (ok && out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await context.storageState({ path: out });
  }
  return { ok, status: res ? res.status() : null, url: page.url(), message };
}

async function register(page, _context, form) {
  await page.goto(`${PORTAL}/partners/register`, { waitUntil: 'domcontentloaded' });
  const text = page.locator('input[type=text]');
  if (form.orgName !== undefined) await page.getByPlaceholder('ABC Pharmaceuticals Ltd').fill(form.orgName);
  if (form.orgType) await page.locator('select').selectOption(form.orgType);
  await page.getByPlaceholder('KE').fill(form.country || 'KE');
  if (form.gln) await page.getByPlaceholder('13-digit GLN if you have one').fill(form.gln);
  if (form.contactName) await text.nth(3).fill(form.contactName);
  if (form.phone) await page.locator('input[type=tel]').fill(form.phone);
  await page.locator('input[type=email]').fill(form.email);
  await page.locator('input[type=password]').nth(0).fill(form.password);
  await page.locator('input[type=password]').nth(1).fill(form.confirm ?? form.password);
  await waitForTurnstile(page);

  const registerCall = page.waitForResponse((r) => /\/api\/auth\/register/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await page.getByRole('button', { name: /Register organization/i }).click();
  const res = await registerCall;
  await page.waitForTimeout(2_500);
  let body = null;
  if (res) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  const message = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
  // Field-level validation messages the form showed, if any.
  const invalid = await page.locator('input:invalid, select:invalid').count();
  return {
    requestSent: Boolean(res),
    status: res ? res.status() : null,
    response: body,
    invalidFields: invalid,
    url: page.url(),
    message,
  };
}

const FLOWS = { login, register };

async function main([flow, json]) {
  const run = FLOWS[flow];
  if (!run) throw new Error(`unknown flow "${flow}" (have: ${Object.keys(FLOWS).join(', ')})`);
  const args = JSON.parse(json || '{}');
  // Without this flag Chromium announces itself as automated and Turnstile withholds its token.
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const result = await run(page, context, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await browser.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
  process.exit(1);
});
