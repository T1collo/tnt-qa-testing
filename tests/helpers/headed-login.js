// Standalone portal sign-in for environments whose /login is gated by Cloudflare Turnstile
// (TrackIQ). Turnstile issues no token to a headless browser, nor to one launched inside the
// Playwright test runner, so this runs as its own process with a visible browser for a few
// seconds. Prints one JSON line: { ok, url, message } - and, when an output path is given and
// the sign-in succeeded, saves the session (cookies + localStorage) there.
//   node tests/helpers/headed-login.js <baseUrl> <email> <password> [storageStatePath]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main([baseUrl, email, password, outFile]) {
  if (!baseUrl || !email || !password) throw new Error('usage: headed-login.js <baseUrl> <email> <password> [out]');
  // Without this flag Chromium announces itself as automated and Turnstile withholds its token.
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await page.goto(`${baseUrl.replace(/\/+$/, '')}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    // Enabled once Turnstile has issued its token.
    await page.waitForFunction(() => !document.querySelector('button[type=submit]')?.disabled, null, { timeout: 60_000 });
    await page.locator('button[type=submit]').click();
    const left = await page
      .waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(left ? 1_500 : 500);
    const message = left ? '' : (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    if (left && outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      await context.storageState({ path: outFile });
    }
    process.stdout.write(`${JSON.stringify({ ok: left, url: page.url(), message })}\n`);
  } finally {
    await browser.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, url: null, message: err.message })}\n`);
  process.exit(1);
});
