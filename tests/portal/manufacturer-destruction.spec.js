// Manufacturer portal - Product Destruction ("Manufacturer - UI" sheet, MFG-DESTROY-*).
//
// Destruction permanently retires serials, so every test destroys only serials from a batch
// it has just created. MFG-DESTROY-006 uses the PNG fixtures in ./fixtures (regenerate them
// with `node tests/portal/fixtures/make-fixtures.cjs`).
const path = require('path');
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { logEntity } = require('../helpers/datalog');
const H = require('./manufacturer-helpers');

const SETUP_TIMEOUT = 300_000;
const SMALL_PNG = path.join(__dirname, 'fixtures', 'proof-small.png');
const LARGE_PNG = path.join(__dirname, 'fixtures', 'proof-large.png');
const LIMIT = 512 * 1024;

async function observe(fn) {
  const rec = H.recorder(test.info());
  try {
    await fn(rec.note);
  } finally {
    rec.done();
  }
}

const localToday = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

async function openRecordDestruction(page) {
  await page.goto('/manufacturer/destruction', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Record Destruction' }).click();
  await page.getByPlaceholder(/Search by batch number/).waitFor();
}

// Searches "Search by batch"; returns the dropdown option (e.g. "BATCH-… 2 eligible units ·
// product #3449") or null when the batch is not offered.
async function searchBatch(page, batchNo) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /product-destruction\/available-batches/.test(r.url()) && new URL(r.url()).searchParams.get('q') === batchNo),
    page.getByPlaceholder(/Search by batch number/).fill(batchNo),
  ]);
  const items = (await resp.json()).items || [];
  const hit = items.find((i) => i.batch_no === batchNo);
  return { hit: hit || null, items };
}

async function selectBatchAndApply(page, batchNo) {
  const { hit } = await searchBatch(page, batchNo);
  expect(hit, `batch ${batchNo} should be offered for destruction`).toBeTruthy();
  await page.getByText(batchNo).last().click();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {}); // close the dropdown
  const [serials] = await Promise.all([
    page.waitForResponse((r) => /warehouse_sgtins=1/.test(r.url()) && /batch_id=/.test(r.url())),
    page.getByRole('checkbox', { name: /Apply to entire batch/ }).check(),
  ]);
  return { eligible: hit.eligible_serial_count, listed: (await serials.json()).items || [] };
}

const sgtinChips = (page) => page.getByText(/^urn:epc:id:sgtin:/);
const notes = (page) => page.getByPlaceholder(/Describe why this product is being destroyed/);
const certificate = (page) => page.getByPlaceholder('e.g. DESTROY-CERT-001');

// Presses Confirm Destruction; returns { status, body, request } or null if nothing was sent.
async function confirm(page, timeout = 30_000) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /product-destruction\/initiate/.test(r.url()), { timeout }).catch(() => null),
    page.getByRole('button', { name: 'Confirm Destruction' }).click(),
  ]);
  if (!resp) return null;
  return { status: resp.status(), body: await H.json(resp), request: JSON.parse(resp.request().postData() || '{}') };
}

const gdtiOf = (record) => (JSON.stringify(record).match(/urn:epc:id:gdti:[^"\\]+/) || [])[0] || null;

function logDestruction(res, batchNo, testId) {
  const records = Array.isArray(res.body) ? res.body : [];
  logEntity({
    type: 'destruction',
    identifier: records.map((r) => `#${r.id}`).join(',') || batchNo,
    batch: batchNo,
    sgtins: res.request.sgtin_list,
    testId,
    cleanup: 'none - destruction is terminal; serials came from a batch created for this test',
  });
}

test.describe('Manufacturer - destruction', () => {
  qtest('MFG-DESTROY-001', 'Record destruction for serials still at the manufacturer\'s own site', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-DESTROY-001', serialCount: 2 });
      await openRecordDestruction(page);
      const { eligible } = await selectBatchAndApply(page, batch.batchNo);
      const cert = `QA-AUTO-${H.uniqueTag()}`;
      await page.locator('input[type=date]').fill(localToday());
      await certificate(page).fill(cert);
      await notes(page).fill(`QA-AUTO-${H.uniqueTag()} expired stock`);
      note(`batch ${batch.batchNo}: ${eligible} eligible units, ${await sgtinChips(page).count()} SGTIN chips; cert "${cert}"`);

      const res = await confirm(page);
      expect(res, 'Confirm Destruction should submit').not.toBeNull();
      logDestruction(res, batch.batchNo, 'MFG-DESTROY-001');
      const records = Array.isArray(res.body) ? res.body : [];
      note(`POST initiate -> HTTP ${res.status}, ${records.length} record(s), statuses [${[...new Set(records.map((r) => r.status))].join(', ')}], cert ${gdtiOf(records[0])}`);
      expect(res.status).toBe(201);
      expect(records.length).toBe(res.request.sgtin_list.length);
      for (const r of records) expect(r.status).toBe('COMPLETED');

      // Destruction Records list shows the batch, certificate and date.
      await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
      const rows = page.locator('tr').filter({ hasText: batch.batchNo });
      await rows.first().waitFor({ timeout: 20_000 });
      const rowText = await rows.first().innerText();
      const dateShown = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      note(`Destruction Records: ${await rows.count()} row(s) for ${batch.batchNo}; first row "${rowText.replace(/\s+/g, ' ').trim()}"`);
      expect(rowText).toContain(cert);
      expect(rowText).toMatch(/Product|#\d+/);
      expect(rowText.replace(/\s+/g, ' ')).toContain(dateShown);

      // Terminal disposition: the destroyed serials are no longer offered for destruction.
      await openRecordDestruction(page);
      const after = await searchBatch(page, batch.batchNo);
      note(`after destruction, batch offered again: ${Boolean(after.hit)}${after.hit ? ` (${after.hit.eligible_serial_count} eligible)` : ''}`);
      expect(after.hit, 'destroyed serials must not remain eligible').toBeNull();
    });
  });

  qtest('MFG-DESTROY-002', '"Apply to entire batch" adds every eligible serial from selected batches', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-DESTROY-002', serialCount: 3 });
      await openRecordDestruction(page);
      const { eligible, listed } = await selectBatchAndApply(page, batch.batchNo);
      await expect(sgtinChips(page)).toHaveCount(listed.length);
      const chips = await sgtinChips(page).allInnerTexts();
      const missing = batch.serials.filter((s) => !chips.some((c) => c.toLowerCase().endsWith(`.${s.toLowerCase()}`)));
      note(`batch of 3 serials shows "${eligible} eligible units"; ${chips.length} chips added; serials missing from chips: ${missing.length}`);
      if (eligible !== batch.serials.length) note(`NOTE: eligible count is ${eligible} for ${batch.serials.length} serials (each serial is listed under GTIN-13 and GTIN-14)`);
      expect(chips.length).toBe(eligible);
      expect(missing).toEqual([]);
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
  });

  qtest('MFG-DESTROY-003', 'Only units still at the manufacturer\'s site are offered for destruction', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { batch, shipment } = await H.freshDispatchedShipment(page, browser, { testId: 'MFG-DESTROY-003' });
      const batches = await (await page.request.get('/api/manufacturer/batches?page=1&limit=100')).json();
      const stored = (batches.batches || []).find((b) => b.batch_no === batch.batchNo);
      note(`batch ${batch.batchNo} (1 serial) dispatched in ${shipment.shipment_number}; qty=${stored?.qty} sent_qty=${stored?.sent_qty}`);
      expect(Number(stored?.sent_qty)).toBe(Number(stored?.qty));

      await openRecordDestruction(page);
      const { hit } = await searchBatch(page, batch.batchNo);
      note(hit ? `fully dispatched batch is still offered (${hit.eligible_serial_count} eligible unit(s))` : 'fully dispatched batch is not offered');
      expect(hit, 'a fully dispatched batch must not be listed').toBeNull();
    });
  });

  qtest('MFG-DESTROY-004', 'Notes field is required', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-DESTROY-004', serialCount: 1 });
      await openRecordDestruction(page);
      await selectBatchAndApply(page, batch.batchNo);
      await page.locator('input[type=date]').fill(localToday());
      await expect(notes(page)).toHaveValue('');
      const res = await confirm(page, 8000);
      const msg = await page.locator('[role=alert], [data-sonner-toast]').allInnerTexts().catch(() => []);
      const required = await page.getByText('Notes *').count();
      note(`Notes blank: ${res ? `request sent, HTTP ${res.status}` : 'no request sent'}; messages [${msg.join(' | ')}]; "Notes *" marker shown: ${required > 0}`);
      if (res) logDestruction(res, batch.batchNo, 'MFG-DESTROY-004');
      expect(res === null || res.status >= 400, 'submission without Notes must be blocked').toBe(true);
    });
  });

  qtest('MFG-DESTROY-005', 'Certificate reference auto-generates a GDTI-format URN when left blank', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const prefix = (await (await page.request.get('/api/manufacturer/sscc/generate')).json()).companyPrefix;
      const batch = await H.createBatch(page, { testId: 'MFG-DESTROY-005', serialCount: 1 });
      await openRecordDestruction(page);
      await selectBatchAndApply(page, batch.batchNo);
      await expect(certificate(page)).toHaveValue('');
      await notes(page).fill(`QA-AUTO-${H.uniqueTag()} expired stock`);
      const res = await confirm(page);
      expect(res, 'Confirm Destruction should submit').not.toBeNull();
      logDestruction(res, batch.batchNo, 'MFG-DESTROY-005');
      const records = Array.isArray(res.body) ? res.body : [];
      const inResponse = records.map((r) => `#${r.id}=${gdtiOf(r) || 'none'}`);
      note(`company prefix ${prefix}; HTTP ${res.status}; certificate per record in response: ${inResponse.join(', ')}`);
      expect(res.status).toBe(201);

      // What the server saved, as the Destruction Records list shows it.
      await page.getByRole('button', { name: 'Refresh' }).click().catch(() => {});
      const rows = page.locator('tr').filter({ hasText: batch.batchNo });
      await rows.first().waitFor({ timeout: 20_000 });
      const listed = (await rows.allInnerTexts()).map((t) => (t.match(/urn:epc:id:gdti:\S+/) || ['none'])[0]);
      note(`Destruction Records certificate per row: ${listed.join(', ')}`);
      const pattern = new RegExp(`^urn:epc:id:gdti:${prefix}\\.99999\\.\\S+$`);
      for (const c of listed) expect(c, 'every destroyed SGTIN carries an auto-generated GDTI').toMatch(pattern);
    });
  });

  qtest('MFG-DESTROY-006', 'Proof of destruction photo upload respects the 512 KB size limit', async ({ page }) => {
    await observe(async (note) => {
      const large = fs.statSync(LARGE_PNG).size;
      const small = fs.statSync(SMALL_PNG).size;
      expect(large, 'fixture must exceed 512 KB').toBeGreaterThan(LIMIT);
      expect(small, 'fixture must be within 512 KB').toBeLessThanOrEqual(LIMIT);
      await H.loginAs(page, 'manufacturer');
      await openRecordDestruction(page);
      const input = page.locator('input[type=file]');

      await input.setInputFiles(LARGE_PNG);
      const tooLarge = page.getByText(/too large|maximum 512 KB|max(imum)? .*512/i).last();
      await expect(tooLarge).toBeVisible();
      const largeMsg = (await tooLarge.textContent()).trim();
      const largeAttached = await page.getByText('Image attached').isVisible();
      note(`${Math.round(large / 1024)} KB PNG: "${largeMsg}", attached=${largeAttached}`);
      expect(largeAttached).toBe(false);

      await input.setInputFiles(SMALL_PNG);
      await expect(page.getByText('Image attached')).toBeVisible();
      note(`${Math.round(small / 1024)} KB PNG: "Image attached"`);
      await page.getByRole('button', { name: 'Cancel' }).click();
    });
  });
});
