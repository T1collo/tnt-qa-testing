// Retest of three Manufacturer-portal CSV findings on tnt-demo (TL-1897 / TL-1861 CSV run):
//   A. rows dropped while the import reports success   (tests 12a, 16, 4b, 6b, 21c)
//   B. placeholder serials stored as real serials       (test 14b + placeholders never used before)
//   C. serials changed when stored (case / SGTIN URI)   (any commissioned serial with letters)
//
// The Batches page no longer has the Bulk CSV button, so files go to the same session API the
// dialog used: /api/manufacturer/epcis-events/csv-import (plus its /validate dry run). The original
// pack files are reused with only their identity refreshed: new serial/lot token, new SSCCs (check
// digit recomputed) and timestamps moved forward by the same amount, so a future row stays future.
// What was stored is read back from the batch view's API (/manufacturer/batches, /serials).
//
// Run:  node scripts/csv/retest-csv-findings.mjs
// Out:  Proof/csv-retest/ (results.json, <test>-status.png, <test>-batch.png) and the pack in
//       C:\Users\Collins\Desktop\uploads\csv-retest
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const ROOT = path.join(import.meta.dirname, '..', '..');
const BASE = 'https://tnt-demo.apeiro-digital.com';
const API = `${BASE}/api/manufacturer`;
const SRC = 'C:\\Users\\Collins\\Desktop\\uploads\\csv-20';
const PACK = 'C:\\Users\\Collins\\Desktop\\uploads\\csv-retest';
const PROOF = path.join(ROOT, 'Proof', 'csv-retest');

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RUN = Array.from(crypto.randomBytes(3), (b) => ALNUM[b % ALNUM.length]).join('');
const SSCC_RUN = String(crypto.randomInt(10, 100));
const checkDigit = (body) => String((10 - ([...body].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 ? 1 : 3), 0) % 10)) % 10);

// Same file, new identity. Old tokens are XP5 (serials SXP5..., lots LXP5...) and FGN4P (21c).
function freshen(text, shiftMs) {
  return text
    .replace(/\b([SLsl])(XP5|xp5)/g, (_, p, t) => `${p}${t === 'xp5' ? RUN.toLowerCase() : RUN}`)
    .replace(/FGN4P/g, `${RUN}21`)
    .replace(/\b06164003\d{2}(\d{7})\d\b/g, (_, rest) => { const body = `06164003${SSCC_RUN}${rest}`; return body + checkDigit(body); })
    .replace(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\b/g, (ts) => {
      if (ts.startsWith('2027')) return ts; // the deliberately future row stays as it was
      return new Date(Date.parse(`${ts}Z`) + shiftMs).toISOString().slice(0, 19);
    });
}

const header = fs.readFileSync(path.join(SRC, 'CSV-12a_100_rows_one_bad.csv'), 'utf8').split('\n')[0];
const blank = header.split(',').map(() => '');
const col = Object.fromEntries(header.split(',').map((c, i) => [c, i]));
const row = (fields) => { const r = [...blank]; for (const [k, v] of Object.entries(fields)) r[col[k]] = v; return r.join(','); };

const T = [
  { id: '12a', finding: 'A', src: 'CSV-12a_100_rows_one_bad.csv', what: '100 rows, line 52 has a future Event_Timestamp (2027-01-01)' },
  { id: '16', finding: 'A', src: 'CSV-16_broken_rows.csv', what: '4 rows: one with an extra field, one with a missing field, blank lines' },
  { id: '4b', finding: 'A', src: 'CSV-04b_without_rejected_rows.csv', what: '10 rows of values that must pass' },
  { id: '6b', finding: 'A', src: 'CSV-06b_without_rejected_rows.csv', what: '8 rows with duplicates in the file' },
  { id: '21c', finding: 'A', src: 'CSV-21c_latin1.csv', latin1: true, what: '2 rows, Latin-1 encoded, one with "Côte d\'Ivoire"' },
  // Rejected as duplicates, so the batch shot shows where 0, NA and DUMMY are still stored: the first run's lots.
  { id: '14b', finding: 'B', src: 'CSV-14b_placeholders_only.csv', search: 'LXP514', what: 'Placeholder serials 0, NA, DUMMY (fresh lots)' },
  // NONE, TEST, XXXX, 000000 and UNKNOWN were stored by the 12 Nov 07:37 run (request ad77bd67), so they
  // now come back as duplicates; this set has never been sent. alsoSearch shows the earlier set still stored.
  { id: '14n', finding: 'B', alsoSearch: 'LRLC14N', what: 'Placeholder serials never used before: TBC, SAMPLE, BLANK, NOSERIAL, 999999', build: () => {
    const base = Date.now() - 50 * 60_000;
    const lines = ['TBC', 'SAMPLE', 'BLANK', 'NOSERIAL', '999999'].map((sn, i) => row({
      Event_Type: 'COMMISSIONING', Identifier_Type: 'SGTIN', GTIN: '6161102974997', Unit_ID: sn, Packaging_Level: 'Item',
      Event_Timestamp: new Date(base + i * 60_000 + 3 * 3600_000).toISOString().slice(0, 19), Event_TimeZone_Offset: '+03:00',
      BizLocation_GLN: '6164003000000', Lot_Batch_Number: `L${RUN}14N${i}`, Lot_Manufacturing_Date: new Date().toISOString().slice(0, 8) + '01',
      Lot_Expiry_Date: `${new Date().getFullYear() + 2}-12-31`, Manufacturing_Origin: 'DOMESTIC', Country_of_Origin: 'KE',
    }));
    return `${header}\n${lines.join('\n')}\n`;
  } },
];

// --only 4b,21c re-runs just those tests; their results replace the earlier ones in results.json.
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const RUN_T = T.filter((t) => !ONLY || ONLY.has(t.id));

fs.mkdirSync(PACK, { recursive: true });
fs.mkdirSync(PROOF, { recursive: true });
for (const t of RUN_T) {
  let text;
  if (t.build) text = t.build();
  else {
    const file = path.join(SRC, t.src);
    // Shift so the file's rows end 10 hours ago (Nairobi local time): far enough back that a row
    // with a western offset (4b has -05:00) is still in the past, well inside the 7-day stale window.
    const raw = fs.readFileSync(file, t.latin1 ? 'latin1' : 'utf8');
    const times = [...raw.matchAll(/\b(2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\b/g)].map((m) => Date.parse(`${m[1]}Z`));
    const shift = Date.now() + 3 * 3600_000 - 10 * 3600_000 - Math.max(...times);
    text = freshen(raw, shift);
  }
  t.file = path.join(PACK, `CSV-${t.id}_retest.csv`);
  fs.writeFileSync(t.file, Buffer.from(text, t.latin1 ? 'latin1' : 'utf8'));
  t.rows = text.split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
  t.lots = [...new Set(text.split(/\r?\n/).slice(1).map((l) => l.split(',')[col.Lot_Batch_Number]).filter(Boolean))];
  t.serials = text.split(/\r?\n/).slice(1).map((l) => l.split(',')[col.Unit_ID]).filter(Boolean);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } })).newPage();
await page.goto('/login', { waitUntil: 'load' });
await page.getByText('Test Manufacturer', { exact: true }).click();
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForTimeout(6000);

// The upload screen is gone: Batches has no Bulk CSV button, yet Create Batch still points to one.
await page.goto('/manufacturer/batches', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(PROOF, '00a-batches-no-bulk-csv-button.png') });
await page.getByRole('button', { name: 'Create Batch' }).click();
await page.getByText(/use Bulk Import CSV on the batches list/).scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(PROOF, '00b-create-batch-points-to-bulk-csv.png') });
await page.keyboard.press('Escape');

const send = async (endpoint, t) => {
  const r = await page.request.post(`${API}/epcis-events/${endpoint}`, {
    multipart: { file: { name: path.basename(t.file), mimeType: 'text/csv', buffer: fs.readFileSync(t.file) } },
  });
  return { status: r.status(), body: await r.text() };
};
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

for (const t of RUN_T) {
  t.validate = await send('csv-import/validate', t);
  t.import = await send('csv-import', t);
  const id = json(t.import.body)?.correlation_id;
  if (id) {
    for (let i = 0; i < 100; i += 1) {
      t.final = await (await page.request.get(`${API}/epcis-events/csv-import/status/${id}`)).json().catch(() => null);
      if (t.final && !/^(accepted|queued|processing|pending)$/i.test(t.final.status || '')) break;
      await page.waitForTimeout(3000);
    }
  }
  // Read back what the batch view shows for each lot in the file.
  t.stored = [];
  for (const lot of t.lots) {
    const list = (await (await page.request.get(`${API}/batches?page=1&limit=5&search=${encodeURIComponent(lot)}`)).json().catch(() => ({}))).batches || [];
    const b = list.find((x) => x.batch_no === lot);
    if (!b) { t.stored.push({ lot, batch: null }); continue; }
    const serials = await (await page.request.get(`${API}/batches/${b.id}/serials`)).json().catch(() => []);
    t.stored.push({ lot, batch: b.id, created_at: b.created_at, manufacturing_date: b.manufacturing_date, expiry: b.expiry, qty: b.qty, serials: (serials || []).map((s) => s.serial_number) });
  }
  t.storedSerials = t.stored.flatMap((s) => s.serials || []);
  const f = t.final || {};
  console.log(`${t.id.padEnd(4)} rows ${t.rows} | validate ${t.validate.status} ${t.validate.body.slice(0, 90)} | import ${t.import.status} | job ${f.status || '-'} partial=${f.partial} accepted=${f.accepted_count ?? '-'} err=${f.error_code || ''} | stored ${t.storedSerials.length} [${t.storedSerials.slice(0, 6).join(', ')}]`);

  // Evidence: the job status as a page, and the batch view of the first lot that exists.
  const shown = { file: path.basename(t.file), rows_in_file: t.rows, validate: json(t.validate.body) || t.validate.body, import_http: t.import.status, import_response: json(t.import.body) || t.import.body, final_status: f.event_ids ? { ...f, event_ids: `(${f.event_ids.length} ids)` } : f, stored: t.stored };
  const p = await page.context().newPage();
  await p.setContent(`<h3 style="font-family:sans-serif">CSV retest ${t.id}: ${t.what.replace(/</g, '&lt;')}<br><small>Import job status from ${API}/epcis-events/csv-import (the Manufacturer portal has no screen for CSV import jobs), ${new Date().toISOString()}</small></h3><pre style="font-size:12px;white-space:pre-wrap">${JSON.stringify(shown, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
  await p.screenshot({ path: path.join(PROOF, `${t.id}-status.png`), fullPage: true });
  await p.close();
  // The real batch view: Manufacturer > Batches, searched for this test's lots, every row expanded
  // to show its serial numbers. (There is no batch detail page; /manufacturer/batches/<id> is a 404.)
  await shootBatches(t.search || commonPrefix(t.lots), t.id);
  if (t.alsoSearch) await shootBatches(t.alsoSearch, `${t.id}-earlier`);
}

function commonPrefix(list) {
  return list.reduce((p, s) => { while (!s.startsWith(p)) p = p.slice(0, -1); return p; }, list[0] || '');
}

async function shootBatches(term, name) {
  await page.goto('/manufacturer/batches', { waitUntil: 'networkidle' });
  const box = page.getByPlaceholder(/search/i).first();
  await box.fill(term);
  await box.press('Enter');
  await page.waitForResponse((r) => /\/api\/manufacturer\/batches\?/.test(r.url()), { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const rows = page.locator('tbody tr').filter({ hasText: term });
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) {
    await rows.nth(i).click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: path.join(PROOF, `${name}-batch.png`), fullPage: true });
}
await browser.close();

const resultsFile = path.join(PROOF, 'results.json');
const earlier = ONLY && fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')).tests : [];
const ran = new Set(RUN_T.map((t) => t.id));
const tests = T.map(({ build, ...t }) => (ran.has(t.id) ? { ...t, run: RUN } : earlier.find((e) => e.id === t.id))).filter(Boolean);
fs.writeFileSync(resultsFile, JSON.stringify({ at: new Date().toISOString(), tests }, null, 2));
console.log(`\nrun token ${RUN}; evidence in ${path.relative(ROOT, PROOF)}`);
