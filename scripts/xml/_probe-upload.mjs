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
fs.mkdirSync(OUT, { recursive: true });

const id = randomUUID();
const serial = `QA${Date.now().toString().slice(-10)}`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<epcis:EPCISDocument xmlns:epcis="urn:epcglobal:epcis:xsd:1" xmlns:cbvmda="urn:epcglobal:cbv:mda" schemaVersion="1.2" creationDate="2026-11-09T09:00:00.000Z">
  <EPCISBody><EventList>
    <ObjectEvent>
      <eventID>urn:uuid:${id}</eventID>
      <eventTime>2026-11-09T08:55:00.000Z</eventTime>
      <eventTimeZoneOffset>+03:00</eventTimeZoneOffset>
      <epcList><epc>urn:epc:id:sgtin:0614141.107346.${serial}</epc></epcList>
      <action>ADD</action>
      <bizStep>urn:epcglobal:cbv:bizstep:commissioning</bizStep>
      <disposition>urn:epcglobal:cbv:disp:active</disposition>
      <readPoint><id>urn:epc:id:sgln:0614141.00001.0</id></readPoint>
      <bizLocation><id>urn:epc:id:sgln:0614141.00001.0</id></bizLocation>
      <extension><ilmd>
        <cbvmda:lotNumber>QAXML01</cbvmda:lotNumber>
        <cbvmda:itemExpirationDate>2028-12-31</cbvmda:itemExpirationDate>
      </ilmd></extension>
    </ObjectEvent>
  </EventList></EPCISBody>
</epcis:EPCISDocument>`;
const file = path.join(OUT, '_probe-commission.xml');
fs.writeFileSync(file, xml);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('request', (r) => {
  if (r.method() === 'POST' && /partners|upload|epcis|xml/i.test(r.url())) {
    console.log('REQ', r.method(), r.url(), r.headers()['content-type']);
  }
});
await page.goto(`${BASE}/partners/login`, { waitUntil: 'load' });
await page.locator('input[type=email]').fill(email);
await page.locator('input[type=password]').fill(password);
await page.locator('button[type=submit]').click();
await page.waitForURL((u) => /\/partners\//.test(u.pathname) && !u.pathname.includes('/login'), { timeout: 60_000 });

await page.goto(`${BASE}/partners/upload`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('input[type=file]').setInputFiles(file);
await page.waitForTimeout(800);
const respP = page.waitForResponse(
  (r) => r.request().method() === 'POST' && /upload|import|epcis|xml/i.test(r.url()),
  { timeout: 120_000 }
);
await page.getByRole('button', { name: 'Upload XML' }).click();
const resp = await respP;
const body = await resp.text();
console.log('POST', resp.status(), resp.url());
console.log('BODY', body.slice(0, 1500));
await page.waitForTimeout(3000);
console.log('UI:\n', (await page.locator('body').innerText()).slice(0, 2000));
await page.screenshot({ path: path.join(OUT, '_probe.png'), fullPage: true });

let statusUrl = null;
try {
  const j = JSON.parse(body);
  statusUrl = j.status_url || (j.correlation_id ? `/api/partners/uploads/status/${j.correlation_id}` : null)
    || (j.correlation_id ? `/api/partners/epcis-events/xml-import/status/${j.correlation_id}` : null);
  console.log('parsed keys', Object.keys(j));
} catch { /* */ }

const candidates = [
  statusUrl,
  (() => { try { return JSON.parse(body).status_url; } catch { return null; } })(),
].filter(Boolean);
for (const u of candidates) {
  const url = u.startsWith('http') ? u : `${BASE}${u}`;
  const s = await page.request.get(url);
  console.log('STATUS GET', s.status(), url, (await s.text()).slice(0, 800));
}

// also try common patterns from correlation_id
try {
  const id2 = JSON.parse(body).correlation_id;
  if (id2) {
    for (const p of [
      `/api/partners/uploads/${id2}`,
      `/api/partners/uploads/status/${id2}`,
      `/api/partners/epcis-events/xml-import/status/${id2}`,
      `/api/partners/async-submissions/${id2}`,
    ]) {
      const s = await page.request.get(`${BASE}${p}`);
      console.log('TRY', s.status(), p, (await s.text()).slice(0, 300));
    }
  }
} catch { /* */ }

await page.goto(`${BASE}/partners/async-submissions`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(2000);
console.log('async page', page.url());
console.log((await page.locator('body').innerText()).slice(0, 1500));
await page.screenshot({ path: path.join(OUT, '_probe-async.png'), fullPage: true }).catch(() => {});
await browser.close();
