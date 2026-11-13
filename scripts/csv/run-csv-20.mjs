// Runs the 20-test CSV pack (scripts/csv/make-csv-20-pack.mjs) against the Manufacturer portal's
// Bulk CSV import and saves one screenshot per test in Proof/, named by test number (1.png ...
// 20d-2.png) to match the Jira comment. Each upload's HTTP status and response body go to
// Proof/results.json so the Result lines can be filled in from the evidence.
//
// Signs in through the login page's "Test Manufacturer" demo quick login (the .env password for
// that account is no longer accepted on tnt-demo).
//
// Run:  node scripts/csv/run-csv-20.mjs [--pack <dir>] [--only 1,2,13]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => {
    if (a.startsWith('--')) pairs.push([a.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const PACK = args.pack || 'C:\\Users\\Collins\\Desktop\\uploads\\csv-20';
const PROOF = path.join(ROOT, 'Proof');
// --extra "2b=C:\path\file.csv,4b=..." uploads just those files under those screenshot names.
const EXTRA = args.extra ? args.extra.split(',').map((p) => p.split('=')) : null;
const ONLY = EXTRA ? new Set() : args.only ? new Set(args.only.split(',')) : null;
const BASE = process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const CSV_API = /\/api\/manufacturer\/epcis-events\/csv-import/;

const packFile = (prefix) => {
  const name = fs.readdirSync(PACK).find((n) => n.startsWith(prefix));
  if (!name) throw new Error(`no file starting ${prefix} in ${PACK}`);
  return path.join(PACK, name);
};

const results = [];
const record = (shot, data) => {
  results.push({ shot, ...data });
  fs.writeFileSync(path.join(PROOF, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${shot.padEnd(6)} ${data.file ? path.basename(data.file) : ''} -> ${data.status ?? '-'} ${String(data.summary || '').slice(0, 160)}`);
};

async function signIn(browser) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto('/login', { waitUntil: 'load' });
  await page.getByText('Test Manufacturer', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30_000 });
  return page;
}

async function openBulkCsv(page) {
  await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Bulk CSV' }).click();
  const modal = page.locator('div.fixed.inset-0').filter({ has: page.locator('input[type=file]') });
  await modal.waitFor();
  return modal;
}

// Uploads one file and screenshots the dialog's outcome.
async function upload(page, shot, file, { before } = {}) {
  const modal = await openBulkCsv(page);
  await modal.locator('input[type=file]').setInputFiles(file);
  await page.waitForTimeout(800);
  if (before) await before(page);
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && CSV_API.test(r.url()), { timeout: 120_000 }).catch(() => null);
  const importBtn = modal.getByRole('button', { name: 'Import' });
  let clicked = true;
  if (await importBtn.isDisabled().catch(() => false)) clicked = false;
  else await importBtn.click();
  const resp = clicked ? await respP : null;
  let body = null;
  if (resp) body = await resp.text().catch(() => null);
  // A 202 is processed in the background; the dialog shows "Processing…" until the job ends.
  const statusUrl = (() => { try { return JSON.parse(body).status_url; } catch { return null; } })();
  let final = null;
  if (statusUrl) {
    await modal.getByText('Processing…').first().waitFor({ state: 'detached', timeout: 300_000 }).catch(() => {});
    final = await page.request.get(statusUrl).then((r) => r.text()).catch(() => null);
  }
  await page.waitForTimeout(1500);
  if (final) body = `${body}\nSTATUS: ${final}`;
  const text = await modal.innerText().catch(async () => page.locator('body').innerText());
  await page.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
  if (final) await shootStatus(page.context(), shot, final);
  record(shot, {
    file, status: resp ? resp.status() : null, sent: Boolean(resp), importEnabled: clicked,
    summary: (body || text).replace(/\s+/g, ' ').slice(0, 400), body: body && body.length < 200_000 ? body : (body || '').slice(0, 5000), dialog: text.slice(0, 4000),
  });
  return { resp, body };
}

// The import job's final status (accepted count, error and warning codes), which the dialog does
// not show, rendered as a page so it can be attached as evidence: <shot>-status.png.
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
  await p.setContent(`<h3 style="font-family:sans-serif">Test ${shot}: import job status (${BASE})</h3><pre style="font-size:13px;white-space:pre-wrap">${esc}</pre>`);
  await p.screenshot({ path: path.join(PROOF, `${shot}-status.png`), fullPage: true });
  await p.close();
}

async function destroyItems(page, shot, lot) {
  await page.goto('/manufacturer/destruction', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record Destruction' }).click();
  const search = page.getByPlaceholder(/Search by batch number/);
  await search.waitFor();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /product-destruction\/available-batches/.test(r.url()) && new URL(r.url()).searchParams.get('q') === lot, { timeout: 30_000 }).catch(() => null),
    search.fill(lot),
  ]);
  const items = resp ? (await resp.json().catch(() => ({}))).items || [] : [];
  if (!items.some((i) => i.batch_no === lot)) {
    await page.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
    record(shot, { summary: `batch ${lot} not offered for destruction (it may not have been imported)` });
    return false;
  }
  await page.getByText(lot).last().click();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.getByRole('checkbox', { name: /Apply to entire batch/ }).check();
  await page.getByPlaceholder(/Describe why this product is being destroyed/).fill('QA CSV test 11: destroyed so a CSV can try to pack them');
  await page.getByPlaceholder('e.g. DESTROY-CERT-001').fill(`QA-CSV11-${Date.now()}`).catch(() => {});
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /product-destruction\/initiate/.test(r.url()), { timeout: 30_000 }).catch(() => null),
    page.getByRole('button', { name: 'Confirm Destruction' }).click(),
  ]);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
  record(shot, { status: res ? res.status() : null, summary: res ? (await res.text()).slice(0, 300) : 'no request sent' });
  return Boolean(res && res.ok());
}

const lotOf = (file) => fs.readFileSync(file, 'utf8').split('\n')[1].split(',')[9];
const want = (shot) => !ONLY || ONLY.has(shot.replace(/[a-z-]+\d*$/, '')) || ONLY.has(shot);

fs.mkdirSync(PROOF, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await signIn(browser);
  for (const [shot, file] of EXTRA || []) await upload(page, shot, file);
  const plain = [['1', 'CSV-01_'], ['2', 'CSV-02_'], ['3', 'CSV-03_'], ['4', 'CSV-04_'], ['5', 'CSV-05_'], ['6', 'CSV-06_'],
    ['7', 'CSV-07_'], ['8', 'CSV-08_'], ['9', 'CSV-09_'], ['10', 'CSV-10_']];
  for (const [shot, prefix] of plain) if (want(shot)) await upload(page, shot, packFile(prefix));

  if (want('11')) {
    const a = packFile('CSV-11a_');
    await upload(page, '11a', a);
    await destroyItems(page, '11b', lotOf(a));
    await upload(page, '11c', packFile('CSV-11b_'));
  }
  if (want('12')) {
    await upload(page, '12a', packFile('CSV-12a_'));
    await upload(page, '12b', packFile('CSV-12b_'));
  }
  if (want('13')) {
    await upload(page, '13a', packFile('CSV-13_identity'));
    // 13b: the session expires (cookies cleared) between choosing the file and pressing Import.
    const valid = packFile('CSV-13_valid');
    const p2 = await signIn(browser);
    await upload(p2, '13b', valid, { before: (pg) => pg.context().clearCookies() });
    await p2.context().close();
    // 13c: X-User-Id on the import request replaced with another value.
    const p3 = await signIn(browser);
    let header = null;
    await p3.route(CSV_API, (route) => {
      const h = route.request().headers();
      header = Object.keys(h).find((k) => k.toLowerCase() === 'x-user-id') || null;
      return route.continue({ headers: { ...h, 'x-user-id': '00000000-0000-4000-8000-000000000001' } });
    });
    await upload(p3, '13c', valid);
    results.at(-1).xUserIdHeaderPresent = Boolean(header);
    await p3.context().close();
  }
  for (const [shot, prefix] of [['14', 'CSV-14_'], ['15', 'CSV-15_'], ['16', 'CSV-16_'], ['17a', 'CSV-17a_'], ['17b', 'CSV-17b_'],
    ['18a', 'CSV-18a_'], ['18b', 'CSV-18b_'], ['19', 'CSV-19_']]) {
    if (want(shot)) await upload(page, shot, packFile(prefix));
  }

  if (want('20')) {
    // 20b: the import as it appears in the batch list (what record of the upload is kept).
    const lot = lotOf(packFile('CSV-01_'));
    await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder(/search/i).first().fill(lot).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(PROOF, '20b.png'), fullPage: true });
    record('20b', { summary: `batch list searched for ${lot}` });
    // 20d: two uploads started at the same moment from two sessions.
    const [q1, q2] = [await signIn(browser), await signIn(browser)];
    const [m1, m2] = [await openBulkCsv(q1), await openBulkCsv(q2)];
    await m1.locator('input[type=file]').setInputFiles(packFile('CSV-20d-1_'));
    await m2.locator('input[type=file]').setInputFiles(packFile('CSV-20d-2_'));
    const wait = (p) => p.waitForResponse((r) => r.request().method() === 'POST' && CSV_API.test(r.url()), { timeout: 60_000 }).catch(() => null);
    const [r1, r2] = await Promise.all([wait(q1), wait(q2), m1.getByRole('button', { name: 'Import' }).click(), m2.getByRole('button', { name: 'Import' }).click()]);
    await Promise.all([q1.waitForTimeout(2500), q2.waitForTimeout(2500)]);
    for (const [shot, q, r] of [['20d-1', q1, r1], ['20d-2', q2, r2]]) {
      await q.screenshot({ path: path.join(PROOF, `${shot}.png`), fullPage: true });
      record(shot, { status: r ? r.status() : null, summary: r ? (await r.text()).slice(0, 300) : 'no request' });
    }
  }
} finally {
  await browser.close();
}
console.log(`\nScreenshots and results.json in ${PROOF}`);
