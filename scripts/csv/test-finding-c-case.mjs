// Finding C: are ScP51100001 / SCP51100001 / scp51100001 stored as-sent or folded?
// Run: node --env-file=.env scripts/csv/test-finding-c-case.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const ROOT = path.join(import.meta.dirname, '..', '..');
const BASE = 'https://tnt-demo.apeiro-digital.com';
const OUT = 'C:\\Users\\Collins\\Desktop\\CSV';
const PROOF = path.join(ROOT, 'Proof', 'csv-hierarchy', 'finding-c-case');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROOF, { recursive: true });

const GTIN = '6161102974997';
const RUN = `${Date.now().toString(36).toUpperCase().slice(-5)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;
const HEAD = 'GTIN,Batch Number,Expiry,Serial Numbers,Case Group,Package Group,Case SSCC,Package SSCC';
const SERIALS = ['ScP51100001', 'SCP51100001', 'scp51100001'];

const files = SERIALS.map((serial, i) => {
  const batch = `BC${RUN}${i + 1}`;
  const name = `C_CASE_${i + 1}_${serial}.csv`;
  const body = `${HEAD}\n${[GTIN, batch, '2028-12-31', serial, `CC${i}`, `PC${i}`, '', ''].join(',')}\n`;
  const file = path.join(OUT, name);
  fs.writeFileSync(file, body);
  return { name, file, serial, batch };
});

console.log('run', RUN);
for (const f of files) console.log('wrote', f.name, 'batch', f.batch, 'serial', f.serial);

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('/partners/login', { waitUntil: 'load' });
await page.locator('input[type=email]').fill(process.env.PARTNER_EMAIL);
await page.locator('input[type=password]').fill(process.env.PARTNER_PASSWORD);
await page.locator('button[type=submit]').click();
await page.waitForURL(/\/partners\/dashboard/, { timeout: 60_000 });

const mfr = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } })).newPage();
await mfr.goto('/login', { waitUntil: 'load' });
await mfr.getByText('Test Manufacturer', { exact: true }).click();
await mfr.getByRole('button', { name: 'Sign in' }).click();
await mfr.waitForTimeout(6000);

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

for (const t of files) {
  await page.goto('/partners/upload', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /CSV available/i }).click();
  await page.locator('input[type=file]').setInputFiles(t.file);
  await page.waitForTimeout(500);
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && /hierarchy-bulk\/csv-import\/async/.test(r.url()), { timeout: 60_000 }).catch(() => null);
  await page.getByRole('button', { name: /Upload CSV/i }).click();
  const resp = await respP;
  t.uploadStatus = resp ? resp.status() : null;
  t.uploadBody = resp ? (await resp.text().catch(() => '')).slice(0, 3000) : 'no request';
  const accept = json(t.uploadBody) || {};
  t.requestId = accept.correlation_id || accept.request_id || null;

  if (t.requestId) {
    for (let i = 0; i < 80; i += 1) {
      t.final = await (await page.request.get(`${BASE}/api/partners/hierarchy-bulk/csv-import/status/${t.requestId}`)).json().catch(() => null);
      if (t.final && !/^(accepted|queued|processing|pending|running|in_progress)$/i.test(t.final.status || '')) break;
      await page.waitForTimeout(2000);
    }
    const refresh = page.getByRole('button', { name: /Refresh status/i });
    if (await refresh.count()) await refresh.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: path.join(PROOF, `${t.name.replace('.csv', '')}-upload.png`), fullPage: true });
  t.pageText = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 2500);

  const rejected = t.final?.rejected || t.final?.result_summary?.rejected || [];
  t.rejected = rejected.map((r) => ({
    code: r.code,
    message: r.message,
    epc: r.epc,
    row_index: r.row_index,
  }));

  const list = (await (await mfr.request.get(`${BASE}/api/manufacturer/batches?page=1&limit=20&search=${encodeURIComponent(t.batch)}`)).json().catch(() => ({}))).batches || [];
  const hit = list.find((x) => x.batch_no === t.batch);
  if (!hit) {
    t.stored = { found: false, searched: t.batch, nearby: list.slice(0, 5).map((x) => x.batch_no) };
  } else {
    const serialPayload = await (await mfr.request.get(`${BASE}/api/manufacturer/batches/${hit.id}/serials`)).json().catch(() => null);
    const arr = Array.isArray(serialPayload) ? serialPayload : (serialPayload?.serials || serialPayload?.items || []);
    t.stored = {
      found: true,
      batchId: hit.id,
      batch_no: hit.batch_no,
      serials: arr.map((s) => ({
        serial_number: s.serial_number || s.serial || s.serialNumber,
        epc: s.epc || s.epc_uri || s.sgtin || s.uri || null,
      })),
    };
    await mfr.goto('/manufacturer/batches', { waitUntil: 'networkidle' });
    const box = mfr.getByPlaceholder(/search/i).first();
    await box.fill(t.batch);
    await box.press('Enter');
    await mfr.waitForTimeout(2500);
    const row = mfr.locator('tbody tr').filter({ hasText: t.batch }).first();
    if (await row.count()) {
      await row.click().catch(() => {});
      await mfr.waitForTimeout(1500);
    }
    await mfr.screenshot({ path: path.join(PROOF, `${t.name.replace('.csv', '')}-batch.png`), fullPage: true });
  }

  console.log(
    `${t.name} | sent=${t.serial} | upload=${t.uploadStatus} | job=${t.final?.status || '-'} ` +
    `acc=${t.final?.accepted_count ?? '-'} rej=${t.final?.rejected_count ?? '-'} | ` +
    `stored=${JSON.stringify(t.stored?.serials || t.stored)} | rejects=${JSON.stringify(t.rejected).slice(0, 300)}`,
  );
}

const allStored = files.flatMap((t) => (t.stored?.serials || []).map((s) => s.serial_number));
const uniqueStored = [...new Set(allStored)];
const folded = uniqueStored.length === 1 && uniqueStored[0]?.toLowerCase() === 'scp51100001';
const preserved = SERIALS.every((s) => allStored.includes(s));

const verdict = {
  run: RUN,
  at: new Date().toISOString(),
  question: 'Are ScP51100001, SCP51100001, scp51100001 stored as-sent or all folded to scp51100001?',
  sent: SERIALS,
  storedSerials: allStored,
  uniqueStored,
  preservedAsSent: preserved,
  appearsFoldedToLowercase: folded || (uniqueStored.length > 0 && uniqueStored.every((s) => s === s.toLowerCase())),
  notes: [
    'If C2/C3 reject as DUPLICATE_EVENT_PAYLOAD after C1, case is folded (same EPC key).',
    'If all three store distinct serial_number values matching send case, case is preserved.',
  ],
  tests: files.map(({ file, ...rest }) => rest),
};

fs.writeFileSync(path.join(PROOF, 'results.json'), JSON.stringify(verdict, null, 2));
fs.writeFileSync(
  path.join(OUT, 'C_CASE_README.txt'),
  [
    `Finding C case test — run ${RUN}`,
    'Serials: ScP51100001, SCP51100001, scp51100001',
    'Upload order: C_CASE_1 → C_CASE_2 → C_CASE_3',
    '',
    ...files.map((f) => ` - ${f.name}  batch=${f.batch}  serial=${f.serial}`),
    '',
    `Evidence: ${PROOF}`,
  ].join('\n'),
);

await browser.close();
console.log('\nVERDICT');
console.log(JSON.stringify({
  sent: verdict.sent,
  storedSerials: verdict.storedSerials,
  uniqueStored: verdict.uniqueStored,
  preservedAsSent: verdict.preservedAsSent,
  appearsFoldedToLowercase: verdict.appearsFoldedToLowercase,
}, null, 2));
console.log(`evidence: ${path.relative(ROOT, PROOF)}`);
