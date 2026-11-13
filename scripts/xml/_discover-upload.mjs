// One-shot discovery of /partners/upload for manufacturer XML.
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const email = process.env.PARTNER_EMAIL || process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL;
const password = process.env.PARTNER_PASSWORD || process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD;
if (!email || !password) throw new Error('need PARTNER_EMAIL/PASSWORD or TRACKIQ_MANUFACTURER_PARTNER_*');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const posts = [];
page.on('request', (r) => {
  if (r.method() === 'POST' || /upload|import|epcis|xml/i.test(r.url())) {
    posts.push(`${r.method()} ${r.url()}`);
  }
});
await page.goto(`${BASE}/partners/login`, { waitUntil: 'load' });
await page.locator('input[type=email]').fill(email);
await page.locator('input[type=password]').fill(password);
await page.locator('button[type=submit]').click();
await page.waitForURL((u) => /\/partners\//.test(u.pathname) && !u.pathname.includes('/login'), { timeout: 60_000 });
console.log('after partner login', page.url(), 'as', email);

await page.goto(`${BASE}/partners/upload`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
console.log('upload page', page.url());
console.log('title', await page.title());
const buttons = (await page.locator('button').allTextContents()).map((t) => t.trim()).filter(Boolean);
console.log('buttons', buttons);
const labels = (await page.locator('label').allTextContents()).map((t) => t.trim()).filter(Boolean);
console.log('labels', labels.slice(0, 40));
const text = (await page.locator('body').innerText()).slice(0, 3500);
console.log('BODY:\n', text);
const files = await page.locator('input[type=file]').evaluateAll((els) =>
  els.map((e) => ({ accept: e.accept, name: e.name, id: e.id, multiple: e.multiple }))
);
console.log('file inputs', JSON.stringify(files, null, 2));
const selects = await page.locator('select').evaluateAll((els) =>
  els.map((e) => ({ name: e.name, options: [...e.options].map((o) => o.textContent.trim()) }))
);
console.log('selects', JSON.stringify(selects, null, 2));
const inputs = await page.locator('input').evaluateAll((els) =>
  els.map((e) => ({ type: e.type, name: e.name, placeholder: e.placeholder, accept: e.accept }))
);
console.log('inputs', JSON.stringify(inputs, null, 2));
await page.screenshot({ path: path.join(ROOT, 'Proof', 'xml', '_discover.png'), fullPage: true });
await browser.close();
console.log('interesting requests', posts.filter((u) => !/faro|guest-token/i.test(u)).slice(0, 40));
