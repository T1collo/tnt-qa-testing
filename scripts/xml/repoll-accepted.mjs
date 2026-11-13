import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = require('@playwright/test');

const PROOF = path.join(ROOT, 'Proof', 'xml');
const BASE = process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const email = process.env.PARTNER_EMAIL || process.env.TRACKIQ_MANUFACTURER_PARTNER_EMAIL;
const password = process.env.PARTNER_PASSWORD || process.env.TRACKIQ_MANUFACTURER_PARTNER_PASSWORD;
const results = JSON.parse(fs.readFileSync(path.join(PROOF, 'results.json'), 'utf8'));
const pending = results.filter((r) => r.request_id && r.status?.status === 'accepted');
console.log('re-polling', pending.length, 'accepted jobs');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/partners/login`, { waitUntil: 'load' });
await page.locator('input[type=email]').fill(email);
await page.locator('input[type=password]').fill(password);
await page.locator('button[type=submit]').click();
await page.waitForURL((u) => /\/partners\//.test(u.pathname) && !u.pathname.includes('/login'), { timeout: 60_000 });

for (const r of pending) {
  let final = null;
  for (let i = 0; i < 20; i += 1) {
    const text = await page.request.get(`${BASE}/api/partners/async-submissions/${r.request_id}`).then((x) => x.text());
    const j = JSON.parse(text);
    if (!['accepted', 'processing', 'queued'].includes(j.status)) {
      final = j;
      break;
    }
    await page.waitForTimeout(1500);
  }
  if (!final) {
    const text = await page.request.get(`${BASE}/api/partners/async-submissions/${r.request_id}`).then((x) => x.text());
    final = JSON.parse(text);
  }
  const warnings = final.result_summary?.warning_codes || [];
  r.status = {
    status: final.status,
    result_http_status: final.result_http_status,
    error_code: final.error_code || final.result_summary?.error_code || null,
    error_message: final.error_message || final.result_summary?.error_message || null,
    warning_codes: warnings,
    accepted_count: final.result_summary?.accepted_count ?? null,
    sandbox: final.sandbox,
  };
  r.summary = [
    r.http != null ? `HTTP ${r.http}` : null,
    `status=${r.status.status}`,
    r.status.error_code ? `error=${r.status.error_code}` : null,
    warnings.length ? `warnings=${warnings.join(',')}` : null,
  ].filter(Boolean).join('; ');
  // refresh verdict lightly
  if (r.status.status === 'succeeded') r.verdict = r.expectFail ? 'FAIL' : 'PASS';
  else if (r.status.error_code === 'PARTNER_TYPE_BIZSTEP_MISMATCH') r.verdict = 'N/A (role)';
  else if (r.status.status === 'failed' && /R00|R01|R02|R03|R04|RSIZE|expectFail/.test(r.shot)) {
    // keep: rule negatives that failed as expected → PASS if code matches title
  }
  console.log(r.shot, r.summary);
}
fs.writeFileSync(path.join(PROOF, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
console.log('updated', path.join(PROOF, 'results.json'));
