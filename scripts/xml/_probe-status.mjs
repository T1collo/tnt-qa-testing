import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = require('@playwright/test');

const BASE = process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const email = process.env.PARTNER_EMAIL || process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL;
const password = process.env.PARTNER_PASSWORD || process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD;
const OUT = path.join(ROOT, 'Proof', 'xml');
const id = randomUUID();
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="1.2" creationDate="2026-11-09T09:00:00.000Z">
  <EPCISBody><EventList><ObjectEvent>
    <eventID>urn:uuid:${id}</eventID>
    <eventTime>2026-11-09T08:55:00.000Z</eventTime>
    <eventTimeZoneOffset>+03:00</eventTimeZoneOffset>
    <epcList><epc>urn:epc:id:sgtin:0614141.107346.S${Date.now().toString().slice(-12)}</epc></epcList>
    <action>ADD</action>
    <bizStep>urn:epcglobal:cbv:bizstep:commissioning</bizStep>
    <disposition>urn:epcglobal:cbv:disp:active</disposition>
    <readPoint><id>urn:epc:id:sgln:0614141.00001.0</id></readPoint>
    <bizLocation><id>urn:epc:id:sgln:0614141.00001.0</id></bizLocation>
    <extension><ilmd>
      <cbvmda:lotNumber>QAXML02</cbvmda:lotNumber>
      <cbvmda:itemExpirationDate>2028-12-31</cbvmda:itemExpirationDate>
    </ilmd></extension>
  </ObjectEvent></EventList></EPCISBody>
</epcis:EPCISDocument>`;
const file = path.join(OUT, '_probe2.xml');
fs.writeFileSync(file, xml);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const gets = [];
page.on('response', async (r) => {
  const u = r.url();
  if (/upload|async|status|submission/i.test(u) && !/faro|_rsc|static/i.test(u)) {
    const t = await r.text().catch(() => '');
    gets.push({ method: r.request().method(), status: r.status(), url: u, body: t.slice(0, 600) });
  }
});
await page.goto(`${BASE}/partners/login`, { waitUntil: 'load' });
await page.locator('input[type=email]').fill(email);
await page.locator('input[type=password]').fill(password);
await page.locator('button[type=submit]').click();
await page.waitForURL((u) => /\/partners\//.test(u.pathname) && !u.pathname.includes('/login'), { timeout: 60_000 });
await page.goto(`${BASE}/partners/upload`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.locator('input[type=file]').setInputFiles(file);
const respP = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/partners\/uploads/.test(r.url()));
await page.getByRole('button', { name: 'Upload XML' }).click();
const resp = await respP;
const body = JSON.parse(await resp.text());
console.log('accept', body.request_id, body.status);

// click Refresh status repeatedly until completed/failed
for (let i = 0; i < 30; i += 1) {
  await page.getByRole('button', { name: /Refresh status/i }).click().catch(() => {});
  await page.waitForTimeout(2000);
  const live = await page.locator('body').innerText();
  const m = live.match(/Live status\s*\n([^\n]+)/i) || live.match(/Live status\s+([a-z_]+)/i);
  console.log('tick', i, m?.[1] || live.match(/succeeded|failed|processing|accepted|rejected/i)?.[0]);
  if (/succeeded|failed|rejected|error|completed/i.test(live) && !/accepted|processing|queued/i.test(m?.[1] || '')) break;
  if (/(succeeded|failed|rejected)/i.test(m?.[1] || '')) break;
}
await page.screenshot({ path: path.join(OUT, '_probe-status-ui.png'), fullPage: true });
console.log('NETWORK');
for (const g of gets) console.log(JSON.stringify(g));

// Try API patterns with cookies
const rid = body.request_id;
for (const p of [
  `/api/partners/uploads/${rid}`,
  `/api/partners/uploads/${rid}/status`,
  `/api/partners/uploads/status/${rid}`,
  `/api/partners/async-submissions/${rid}`,
  `/api/partners/uploads?request_id=${rid}`,
]) {
  const s = await page.request.get(`${BASE}${p}`);
  console.log('API', s.status(), p, (await s.text()).slice(0, 400));
}
await browser.close();
