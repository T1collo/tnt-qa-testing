// Runs the 20-test CSV pack (scripts/csv/make-csv-20-pack.mjs) and the test 21 format files
// against the Partner portal's Bulk CSV (/partners/dashboard > Bulk CSV) and saves one screenshot
// per test in Proof/partner/, named the same way as the Manufacturer run (1.png ... 21i.png).
//
// The partner dialog posts to /api/partners/epcis-events/csv-import with a pasted manufacturer API
// key and forwards the rows to /integration/manufacturer/events/async. Each 202 is polled at
// .../csv-import/status/<correlation_id> until it ends; that final status is saved as
// <shot>-status.png because the dialog does not show warnings or rejected rows.
//
// Run:  PARTNER_EMAIL=... PARTNER_PASSWORD=... PARTNER_CSV_KEY=... \
//       node scripts/csv/run-csv-partner.mjs [--pack <dir>] [--only 1,2,13] [--extra "2b=path,4b=path"]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const PACK = args.pack || 'C:\\Users\\Collins\\Desktop\\uploads\\csv-partner';
const PROOF = path.join(ROOT, 'Proof', 'partner');
const EXTRA = args.extra ? args.extra.split(',').map((p) => p.split('=')) : null;
const ONLY = EXTRA ? new Set() : args.only ? new Set(args.only.split(',')) : null;
const BASE = 'https://tnt-demo.apeiro-digital.com';
const CSV_API = /\/api\/partners\/epcis-events\/csv-import$/;
const { PARTNER_EMAIL, PARTNER_PASSWORD, PARTNER_CSV_KEY } = process.env;
if (!PARTNER_EMAIL || !PARTNER_PASSWORD || !PARTNER_CSV_KEY) throw new Error('set PARTNER_EMAIL, PARTNER_PASSWORD and PARTNER_CSV_KEY');

const packFile = (prefix, dir = PACK) => {
  const name = fs.readdirSync(dir).find((n) => n.startsWith(prefix));
  if (!name) throw new Error(`no file starting ${prefix} in ${dir}`);
  return path.join(dir, name);
};

const results = [];
const record = (shot, data) => {
  results.push({ shot, ...data });
  fs.writeFileSync(path.join(PROOF, args.results || 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${shot.padEnd(6)} ${data.file ? path.basename(data.file) : ''} -> ${data.status ?? '-'} ${String(data.summary || '').slice(0, 200)}`);
};

async function signIn(browser) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto('/partners/login', { waitUntil: 'load' });
  await page.locator('input[type=email]').fill(PARTNER_EMAIL);
  await page.locator('input[type=password]').fill(PARTNER_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(/\/partners\/dashboard/, { timeout: 60_000 });
  return page;
}

async function openBulkCsv(page, key = PARTNER_CSV_KEY) {
  await page.goto('/partners/dashboard', { waitUntil: 'domcontentloaded' });
  await page.getByText('Bulk CSV', { exact: true }).first().click();
  const modal = page.locator('div.fixed.inset-0.z-50').filter({ has: page.locator('input[type=file]') });
  await modal.waitFor();
  if (key) await modal.locator('input[type=password]').fill(key);
  return modal;
}

// Polls the import job until it leaves accepted/processing.
async function finalStatus(page, id) {
  const url = `${BASE}/api/partners/epcis-events/csv-import/status/${id}`;
  for (let i = 0; i < 150; i += 1) {
    const text = await page.request.get(url).then((r) => r.text()).catch(() => null);
    try {
      if (!['accepted', 'processing', 'queued'].includes(JSON.parse(text).status)) return text;
    } catch { return text; }
    await page.waitForTimeout(2000);
  }
  return null;
}

// Uploads one file and screenshots the dialog's outcome.
async function upload(page, shot, file, { before, key } = {}) {
  const modal = await openBulkCsv(page, key);
  await modal.locator('input[type=file]').setInputFiles(file);
  await page.waitForTimeout(800);
  if (before) await before(page);
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && CSV_API.test(new URL(r.url()).pathname), { timeout: 120_000 }).catch(() => null);
  const importBtn = modal.getByRole('button', { name: 'Import' });
  let clicked = true;
  if (await importBtn.isDisabled().catch(() => false)) clicked = false;
  else await importBtn.click();
  const resp = clicked ? await respP : null;
  let body = resp ? await resp.text().catch(() => null) : null;
  const id = (() => { try { return JSON.parse(body).correlation_id; } catch { return null; } })();
  const final = id && resp.status() === 202 ? await finalStatus(page, id) : null;
  // The dialog polls the same status endpoint; give it time to show the final outcome.
  await modal.getByText(/Upload successful|failed|rejected|error/i).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (final) body = `${body}\nSTATUS: ${final}`;
  const text = await modal.innerText().catch(async () => page.locator('body').innerText());
  await page.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
  if (final) await shootStatus(page.context(), shot, final);
  record(shot, {
    file, status: resp ? resp.status() : null, sent: Boolean(resp), importEnabled: clicked,
    summary: (final || body || text).replace(/\s+/g, ' ').slice(0, 400), body: (body || '').slice(0, 200_000), dialog: text.slice(0, 4000),
  });
  return { resp, body };
}

// The import job's final status (accepted count, error, rejected rows and warning codes), which the
// dialog does not show, rendered as a page so it can be attached as evidence: <shot>-status.png.
async function shootStatus(context, shot, statusText) {
  let pretty = statusText;
  try {
    const s = JSON.parse(statusText);
    delete s.event_ids;
    if (s.result_summary) delete s.result_summary.event_ids;
    pretty = JSON.stringify(s, null, 2);
  } catch { /* keep the raw text */ }
  const esc = pretty.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const p = await context.newPage();
  await p.setContent(`<h3 style="font-family:sans-serif">Partner test ${shot}: import job status (${BASE}/partners)</h3><pre style="font-size:13px;white-space:pre-wrap">${esc}</pre>`);
  await p.screenshot({ path: path.join(PROOF, `${shot}-status.png`), fullPage: true });
  await p.close();
}

const want = (shot) => !ONLY || ONLY.has(shot.replace(/[a-z-]+\d*$/, '')) || ONLY.has(shot);

fs.mkdirSync(PROOF, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await signIn(browser);
  for (const [shot, file] of EXTRA || []) await upload(page, shot, file);
  const plain = [['1', 'CSV-01_'], ['2', 'CSV-02_'], ['3', 'CSV-03_'], ['4', 'CSV-04_'], ['5', 'CSV-05_'], ['6', 'CSV-06_'],
    ['7', 'CSV-07_'], ['8', 'CSV-08_'], ['9', 'CSV-09_'], ['10', 'CSV-10_']];
  for (const [shot, prefix] of plain) if (want(shot)) await upload(page, shot, packFile(prefix));

  // 11: the partner portal has no destruction screen, so only the in-file rule is exercised:
  // 11a commissions two items, 11c tries to pack items that were never destroyed here.
  if (want('11')) {
    await upload(page, '11a', packFile('CSV-11a_'));
    await upload(page, '11c', packFile('CSV-11b_'));
  }
  if (want('12')) {
    await upload(page, '12a', packFile('CSV-12a_'));
    await upload(page, '12b', packFile('CSV-12b_'));
  }
  if (want('13')) {
    await upload(page, '13a', packFile('CSV-13_identity'));
    const valid = packFile('CSV-13_valid');
    // 13b: the session expires (cookies cleared) between choosing the file and pressing Import.
    const p2 = await signIn(browser);
    await upload(p2, '13b', valid, { before: (pg) => pg.context().clearCookies() });
    await p2.context().close();
    // 13c: X-User-Id on the import request replaced with another value.
    const p3 = await signIn(browser);
    await p3.route(CSV_API, (route) => route.continue({ headers: { ...route.request().headers(), 'x-user-id': '00000000-0000-4000-8000-000000000001' } }));
    await upload(p3, '13c', valid);
    await p3.context().close();
    // 13e: no API key pasted. 13f: a made-up API key.
    await upload(page, '13e', valid, { key: '' });
    await upload(page, '13f', valid, { key: 'trk_test_QAinvalidKey000000000000000000000000000000000000000000000' });
  }
  for (const [shot, prefix] of [['14', 'CSV-14_'], ['15', 'CSV-15_'], ['16', 'CSV-16_'], ['17a', 'CSV-17a_'], ['17b', 'CSV-17b_'],
    ['18a', 'CSV-18a_'], ['18b', 'CSV-18b_'], ['19', 'CSV-19_']]) {
    if (want(shot)) await upload(page, shot, packFile(prefix));
  }

  if (want('20')) {
    // 20b: the record the portal keeps of the uploads (Async submissions list).
    await page.goto('/partners/async', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(PROOF, '20b.png'), fullPage: true });
    record('20b', { summary: 'Async submissions list after the run' });
    // 20d: two uploads started at the same moment from two sessions.
    const [q1, q2] = [await signIn(browser), await signIn(browser)];
    const [m1, m2] = [await openBulkCsv(q1), await openBulkCsv(q2)];
    await m1.locator('input[type=file]').setInputFiles(packFile('CSV-20d-1_'));
    await m2.locator('input[type=file]').setInputFiles(packFile('CSV-20d-2_'));
    const wait = (p) => p.waitForResponse((r) => r.request().method() === 'POST' && CSV_API.test(new URL(r.url()).pathname), { timeout: 60_000 }).catch(() => null);
    const [r1, r2] = await Promise.all([wait(q1), wait(q2), m1.getByRole('button', { name: 'Import' }).click(), m2.getByRole('button', { name: 'Import' }).click()]);
    for (const [shot, q, r] of [['20d-1', q1, r1], ['20d-2', q2, r2]]) {
      const body = r ? await r.text() : null;
      const id = (() => { try { return JSON.parse(body).correlation_id; } catch { return null; } })();
      const final = id ? await finalStatus(q, id) : null;
      await q.waitForTimeout(3000);
      await q.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
      if (final) await shootStatus(q.context(), shot, final);
      record(shot, { status: r ? r.status() : null, summary: (final || body || 'no request').replace(/\s+/g, ' ').slice(0, 400), body: `${body}\nSTATUS: ${final}` });
    }
  }

  if (want('21')) {
    const fmt = path.join(PACK, 'format');
    for (const k of 'abcdefghi') await upload(page, `21${k}`, packFile(`CSV-21${k}_`, fmt));
  }
} finally {
  await browser.close();
}
console.log(`\nScreenshots and results in ${PROOF}`);
