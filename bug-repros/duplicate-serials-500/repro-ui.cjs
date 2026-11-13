// Reproduces "duplicate serials in one batch -> HTTP 500" through the Manufacturer portal UI
// (Batches > Create Batch) and saves the exact POST, the response and a screenshot to evidence/.
// env: CAP_BASE (portal origin), CAP_SESSION (Playwright storage file: a name in playwright/.auth, or an absolute path),
//      CAP_PRODUCT (product name, default Telmicos 40 mg Oral Tablet)
// Run: CAP_BASE=https://trackiq.apeiro-digital.com CAP_SESSION=portal-trackiq.apeiro-digital.com-manufacturer.json \
//      node bug-repros/duplicate-serials-500/repro-ui.cjs
const ROOT = require('path').join(__dirname, '..', '..');
const path = require('path');
const fs = require('fs');
const r = (m) => require(require.resolve(m, { paths: [ROOT] }));
r('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = r('playwright');
const { selectProduct, selectPackage } = require(path.join(ROOT, 'tests/helpers/portal'));

const BASE = (process.env.CAP_BASE || process.env.BASE_URL).replace(/\/$/, '');
const PRODUCT = process.env.CAP_PRODUCT || 'Telmicos 40 mg Oral Tablet';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const sess = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'playwright/.auth', process.env.CAP_SESSION), 'utf8'));
  await ctx.addCookies(sess.cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto('/manufacturer/batches', { waitUntil: 'load' });
  if (page.url().includes('/login')) throw new Error('saved session not accepted: ' + page.url());
  await page.getByRole('button', { name: 'Create Batch' }).first().click();
  await page.getByRole('heading', { name: 'Create New Batch' }).waitFor();
  await selectProduct(page, PRODUCT);
  await selectPackage(page);
  const d = new Date();
  d.setDate(d.getDate() + 730);
  await page.locator('input[type=date]').first().fill(d.toISOString().slice(0, 10));
  const serial = 'DUP' + Date.now().toString(36).toUpperCase();
  await page.locator('textarea').last().fill(`${serial}, ${serial}`);
  const [resp] = await Promise.all([
    page.waitForResponse((x) => x.request().method() === 'POST' && /\/api\/manufacturer\/batches/.test(x.url()), { timeout: 60000 }),
    page.getByRole('button', { name: 'Create Batch' }).last().click(),
  ]);
  const req = resp.request();
  const headers = await req.allHeaders();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'evidence', `ui-500-${Date.now()}.png`) });
  const out = {
    at: new Date().toISOString(),
    base: BASE,
    product: PRODUCT,
    serial,
    request: {
      method: req.method(),
      url: req.url(),
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(cookie|authorization)$/i.test(k))),
      authHeaders: Object.keys(headers).filter((k) => /^(cookie|authorization)$/i.test(k)),
      body: req.postData(),
    },
    response: { status: resp.status(), headers: await resp.allHeaders(), body: await resp.text() },
    cookieNames: (await ctx.cookies()).map((c) => c.name),
  };
  fs.writeFileSync(path.join(__dirname, 'evidence', `ui-capture-${Date.now()}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
