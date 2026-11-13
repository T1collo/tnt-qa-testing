// Retest of the three CSV findings through the CSV upload that exists in the UI today:
// Partner portal > Upload > CSV mode ("Hierarchy Bulk CSV": GTIN, Batch Number, Expiry, Serial Numbers,
// Case Group, Package Group, Case SSCC, Package SSCC). The old 27-column event CSV has no screen any more.
//   A. rows rejected inside a file -> expected: partial acceptance, bad rows reported   (H12, H16, H06, H21, H04)
//   B. placeholder serials stored as real serials                                       (H14a, H14b)
//   C. serials changed when stored (case / SGTIN URI)                                    (HC)
// Each file is uploaded through the page; evidence per test in Proof/csv-hierarchy/:
//   <id>-1-upload.png (Upload page with the final Live status), <id>-2-details.png (View full details),
//   <id>-3-async.png (Async submissions row), <id>-rejected-rows.csv (the page's rejected-rows download),
//   <id>-4-batch.png (Manufacturer > Batches with the batch expanded, when the batch is visible there).
// Run: node --env-file=.env scripts/csv/retest-hierarchy-csv.mjs [--only H12,HC]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const ROOT = path.join(import.meta.dirname, '..', '..');
const BASE = 'https://tnt-demo.apeiro-digital.com';
const PACK = 'C:\\Users\\Collins\\Desktop\\uploads\\csv-hierarchy';
const PROOF = path.join(ROOT, 'Proof', 'csv-hierarchy');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

const GTIN = '6161102974997'; // the template's own product (Telmicos)
const RUN = `${Date.now().toString(36).toUpperCase().slice(-5)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;
const HEAD = 'GTIN,Batch Number,Expiry,Serial Numbers,Case Group,Package Group,Case SSCC,Package SSCC';
const line = (o) => [o.gtin ?? GTIN, o.batch, o.expiry ?? '2028-12-31', o.serial, o.cg, o.pg, '', ''].join(',');
const csv = (rows) => `${HEAD}\n${rows.join('\n')}\n`;

// The format allows each batch number once per file (one row = one batch), as in the page's own template.
const rowOf = (code, i, o = {}) => line({ batch: `B${RUN}${code}${String(i).padStart(3, '0')}`, serial: `S${RUN}${code}${String(i).padStart(3, '0')}`, cg: `C${code}${i}`, pg: `P${code}${i}`, ...o });
const T = [
  { id: 'H12', finding: 'A', what: '100 rows, row 52 (data row 51) has Expiry "not-a-date"', expect: 'partial: 99 accepted, the bad row rejected with its row number',
    build: () => csv(Array.from({ length: 100 }, (_, i) => rowOf('12', i + 1, i === 50 ? { expiry: 'not-a-date' } : {}))) },
  { id: 'H16', finding: 'A', what: '4 rows: one with an extra field, one with a missing field, plus blank lines', expect: 'partial: the 2 good rows accepted, both broken rows rejected with row numbers',
    build: () => `${HEAD}\n${rowOf('16', 1)}\n${rowOf('16', 2)},EXTRA\n\n${rowOf('16', 3).split(',').slice(0, 5).join(',')}\n${rowOf('16', 4)}\n\n` },
  { id: 'H06', finding: 'A', what: '3 rows; file rows 3 and 4 carry the same serial', expect: 'partial: the duplicate rejected with its row number, the rest accepted',
    build: () => csv([rowOf('06', 1), rowOf('06', 2), rowOf('06', 3, { serial: `S${RUN}06002` })]) },
  { id: 'H21', finding: 'A', latin1: true, what: 'Latin-1 encoded file; row 3 batch number contains "É"', expect: 'whole file rejected as not UTF-8, or every row handled; never a row silently missing',
    build: () => csv([rowOf('21', 1), rowOf('21', 2, { batch: `B${RUN}21É02` })]) },
  { id: 'H04', finding: 'A', what: 'Serials with characters the portal lists as allowed (- _ . /) and a 20-character serial', expect: 'all 5 rows accepted',
    build: () => csv([`${RUN}-45`, `${RUN}_95`, `${RUN}.46`, `${RUN}/47`, `S${RUN}${'A'.repeat(20 - RUN.length - 1)}`].map((s, i) => rowOf('04', i + 1, { serial: s }))) },
  { id: 'H14a', finding: 'B', what: 'Placeholder serials 0, NA, DUMMY', expect: 'rejected as placeholders (not stored as serials)',
    build: () => csv(['0', 'NA', 'DUMMY'].map((s, i) => line({ batch: `B${RUN}14A${i}`, serial: s, cg: `C14A${i}`, pg: `P14A${i}` }))) },
  // Placeholder words this product has never been sent. Already used (now duplicates): TBC, SAMPLE, BLANK, NOSERIAL,
  // 999999, NONE, TEST, XXXX, 000000, UNKNOWN (12 Nov API retest) and PENDING, NOTSET, EMPTY, NOSN, 00000000 (12 Nov UI).
  { id: 'H14b', finding: 'B', what: 'Placeholder serials never used before: PLACEHOLDER, NOTAVAILABLE, NULLSERIAL, TOBEASSIGNED, XXXXXXXXXX', expect: 'rejected as placeholders (not stored as serials)',
    build: () => csv(['PLACEHOLDER', 'NOTAVAILABLE', 'NULLSERIAL', 'TOBEASSIGNED', 'XXXXXXXXXX'].map((s, i) => line({ batch: `B${RUN}14B${i}`, serial: s, cg: `C14B${i}`, pg: `P14B${i}` }))) },
  // Serial case cannot be read back by a partner (no payload, diagnostics or log entry for these jobs),
  // so it is tested by behaviour: HC sends mixed/upper case, HC2 then sends the same serials in lower case.
  // If the platform still lower-cases serials, HC2 collides with HC and is rejected as a duplicate.
  { id: 'HC', finding: 'C', what: `Mixed/upper-case serials Ab${RUN}c1, UP${RUN}C2, MiXeD${RUN}3`, expect: 'accepted, stored exactly as sent',
    build: () => csv([`Ab${RUN}c1`, `UP${RUN}C2`, `MiXeD${RUN}3`].map((s, i) => rowOf('CA', i + 1, { serial: s }))) },
  { id: 'HC2', finding: 'C', what: 'The same three serials in lower case, new batches', expect: 'accepted (different serials: GS1 serials are case-sensitive); a duplicate rejection means case is still folded',
    build: () => csv([`Ab${RUN}c1`, `UP${RUN}C2`, `MiXeD${RUN}3`].map((s, i) => rowOf('CB', i + 1, { serial: s.toLowerCase() }))) },
].filter((t) => !ONLY || ONLY.has(t.id));

fs.mkdirSync(PACK, { recursive: true });
fs.mkdirSync(PROOF, { recursive: true });
for (const t of T) {
  const text = t.build();
  t.file = path.join(PACK, `${t.id}_${RUN}.csv`);
  fs.writeFileSync(t.file, Buffer.from(text, t.latin1 ? 'latin1' : 'utf8'));
  t.rows = text.split('\n').slice(1).filter((l) => l.trim()).length;
  t.batches = [...new Set(text.split('\n').slice(1).map((l) => l.split(',')[1]).filter(Boolean))];
  t.serials = text.split('\n').slice(1).map((l) => l.split(',')[3]).filter(Boolean);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('/partners/login', { waitUntil: 'load' });
await page.locator('input[type=email]').fill(process.env.PARTNER_EMAIL);
await page.locator('input[type=password]').fill(process.env.PARTNER_PASSWORD);
await page.locator('button[type=submit]').click();
await page.waitForURL(/\/partners\/dashboard/, { timeout: 60_000 });

// Manufacturer portal in a second context, only to look for the stored batch in Batches.
const mfr = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } })).newPage();
await mfr.goto('/login', { waitUntil: 'load' });
await mfr.getByText('Test Manufacturer', { exact: true }).click();
await mfr.getByRole('button', { name: 'Sign in' }).click();
await mfr.waitForTimeout(6000);

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const shot = (p, name) => p.screenshot({ path: path.join(PROOF, name), fullPage: true });

for (const t of T) {
  await page.goto('/partners/upload', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /CSV available/i }).click();
  await page.locator('input[type=file]').setInputFiles(t.file);
  await page.waitForTimeout(800);
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && /hierarchy-bulk\/csv-import\/async/.test(r.url()), { timeout: 60_000 }).catch(() => null);
  await page.getByRole('button', { name: /Upload CSV/i }).click();
  const resp = await respP;
  t.upload = resp ? { status: resp.status(), body: (await resp.text().catch(() => '')).slice(0, 3000) } : { status: null, body: 'no request sent' };
  const accept = json(t.upload.body) || {};
  t.requestId = accept.correlation_id || accept.request_id || null;

  // Wait for the job to finish (same status endpoint the page polls), then let the page catch up.
  if (t.requestId) {
    for (let i = 0; i < 100; i += 1) {
      t.final = await (await page.request.get(`${BASE}/api/partners/hierarchy-bulk/csv-import/status/${t.requestId}`)).json().catch(() => null);
      if (t.final && !/^(accepted|queued|processing|pending|running|in_progress)$/i.test(t.final.status || '')) break;
      await page.waitForTimeout(3000);
    }
    const refresh = page.getByRole('button', { name: /Refresh status/i });
    if (await refresh.count()) await refresh.first().click().catch(() => {});
    await page.waitForTimeout(4000);
  } else {
    await page.waitForTimeout(2000);
  }
  await shot(page, `${t.id}-1-upload.png`);
  t.pageText = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 3000);

  // The page's own rejected-rows download, when offered.
  const dlBtn = page.getByRole('button', { name: /rejected|errors|download.*(row|csv)/i }).filter({ hasNotText: /template/i });
  if (await dlBtn.count()) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }).catch(() => null), dlBtn.first().click()]);
    if (dl) { await dl.saveAs(path.join(PROOF, `${t.id}-rejected-rows.csv`)); t.rejectedRowsFile = `${t.id}-rejected-rows.csv`; }
  }
  const details = page.getByRole('button', { name: /View full details/i });
  if (await details.count()) {
    await details.first().click();
    await page.waitForTimeout(2500);
    await shot(page, `${t.id}-2-details.png`);
    t.detailsText = (await page.locator('[role=dialog]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 3000);
    await page.keyboard.press('Escape');
  }
  if (t.requestId) {
    await page.goto(`/partners/async?correlation_id=${encodeURIComponent(t.requestId)}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await shot(page, `${t.id}-3-async.png`);
  }

  // Stored serials, if the batches appear in Manufacturer > Batches.
  t.stored = [];
  for (const b of t.batches) {
    const list = (await (await mfr.request.get(`${BASE}/api/manufacturer/batches?page=1&limit=5&search=${encodeURIComponent(b)}`)).json().catch(() => ({}))).batches || [];
    const hit = list.find((x) => x.batch_no === b);
    if (!hit) { t.stored.push({ batch: b, found: false }); continue; }
    const serials = await (await mfr.request.get(`${BASE}/api/manufacturer/batches/${hit.id}/serials`)).json().catch(() => []);
    t.stored.push({ batch: b, found: true, id: hit.id, manufacturing_date: hit.manufacturing_date, expiry: hit.expiry, serials: (serials || []).map((s) => s.serial_number) });
  }
  if (t.stored.some((s) => s.found)) {
    const term = t.batches.reduce((p, s) => { while (!s.startsWith(p)) p = p.slice(0, -1); return p; }, t.batches[0]);
    await mfr.goto('/manufacturer/batches', { waitUntil: 'networkidle' });
    const box = mfr.getByPlaceholder(/search/i).first();
    await box.fill(term);
    await box.press('Enter');
    await mfr.waitForTimeout(3000);
    const rows = mfr.locator('tbody tr').filter({ hasText: term });
    for (let i = 0; i < await rows.count(); i += 1) { await rows.nth(i).click().catch(() => {}); await mfr.waitForTimeout(1000); }
    await shot(mfr, `${t.id}-4-batch.png`);
  }
  const f = t.final || {};
  const storedSerials = t.stored.flatMap((s) => s.serials || []);
  console.log(`${t.id.padEnd(5)} rows ${t.rows} | upload ${t.upload.status} ${t.requestId || t.upload.body.slice(0, 120)} | job ${f.status || '-'} | stored ${storedSerials.length} [${storedSerials.slice(0, 6).join(', ')}]`);
}
await browser.close();

fs.writeFileSync(path.join(PROOF, `results-${RUN}.json`), JSON.stringify({ at: new Date().toISOString(), run: RUN, tests: T.map(({ build, ...t }) => t) }, null, 2));
console.log(`\nrun ${RUN}; evidence in ${path.relative(ROOT, PROOF)}`);
