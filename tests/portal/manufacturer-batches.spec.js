// Manufacturer portal > Production > Batches: Create Batch field limits and validation
// (MFG-BATCH-EDGE-*), the batches list search / filters / pagination / Bulk CSV entry point
// (MFG-BATCH-LIST-*), and the Bulk CSV upload latency target (TL-1659-TC04).
//
// Validation cases avoid creating data: where the form blocks the submit, no request is sent.
// Where the form lets an invalid value through, the server is the gate - if it accepts, the
// batch it created is logged and the test fails.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { loginAs } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');
const { qtest } = require('../helpers/qtest');
const { selectProduct, selectPackage } = require('../helpers/portal');

const PRODUCT = process.env.MFG_BATCH_PRODUCT || 'Telmicos 40 mg Oral Tablet';
const OTHER_PRODUCT = process.env.MFG_BATCH_OTHER_PRODUCT || 'Coempaken 5 mg/1000 mg Oral Tablet';
const RUN = Date.now();
const RUN36 = RUN.toString(36).toUpperCase(); // 8 chars, keeps generated serials short and unique
const BATCH_API = /\/api\/manufacturer\/batches(\?|$)/;
const CSV_API = /\/api\/manufacturer\/epcis-events\/csv-import/;

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// Pushes what the test saw into the workbook's Actual Result, pass or fail.
async function withObserved(fn) {
  const observed = [];
  try {
    await fn(observed);
  } finally {
    test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
    console.log(`[actual] ${test.info().title}: ${observed.join('; ')}`);
  }
}

// ---------- Create Batch form ----------

const createModal = (page) =>
  page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Create New Batch' }) });

async function openCreateBatch(page) {
  await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create Batch' }).first().click();
  await page.getByRole('heading', { name: 'Create New Batch' }).waitFor();
  return createModal(page);
}

async function fillBatchForm(page, { product, batchNo, expiry, serials } = {}) {
  if (product) {
    await selectProduct(page, product);
    await selectPackage(page);
  }
  if (batchNo !== undefined) await page.getByPlaceholder('Auto-generate (recommended)').fill(batchNo);
  if (expiry !== undefined) await page.locator('input[type=date]').fill(expiry);
  if (serials !== undefined) await page.getByPlaceholder('SN-001, SN-002, SN-003').fill(serials);
}

// Clicks Create Batch and reports whether a POST went out, and the server's answer if it did.
// `quietMs` is how long to wait for a request when the form may block the submit.
async function submitBatch(page, { quietMs = 2500, responseTimeout = 60_000 } = {}) {
  const modal = createModal(page);
  const before = await modal.innerText();
  let sent = false;
  const onRequest = (r) => {
    if (r.method() === 'POST' && BATCH_API.test(r.url())) sent = true;
  };
  page.on('request', onRequest);
  const respPromise = page
    .waitForResponse((r) => r.request().method() === 'POST' && BATCH_API.test(r.url()), { timeout: responseTimeout })
    .catch(() => null);
  await page.getByRole('button', { name: 'Create Batch' }).last().click();
  await page.waitForTimeout(quietMs);
  page.off('request', onRequest);
  let resp = null;
  if (sent) resp = await respPromise;
  let body = null;
  let text = '';
  if (resp) {
    text = await resp.text().catch(() => '');
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body, kept as text
    }
  }
  await page.waitForTimeout(500);
  const after = await modal.innerText().catch(() => '');
  const newText = after
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !before.includes(l));
  return { sent, resp, status: resp ? resp.status() : null, body, text, message: newText.join(' | ') };
}

// The server's error text; for an HTML error page (e.g. a gateway timeout) its title/heading.
const serverMessage = (r) => {
  const raw = (r.body?.message || r.body?.error || r.text || '').toString();
  const html = raw.match(/<title>([^<]*)<\/title>|<h1>([^<]*)<\/h1>/i);
  return (html ? `HTML page "${(html[1] || html[2]).trim()}"` : raw).slice(0, 240);
};

function logBatch(r, testId, serials, extra = {}) {
  const batchNo = r.body?.batch_no ?? r.body?.batchNo ?? null;
  logEntity({
    type: 'batch',
    identifier: batchNo || `unknown-batch-from-${testId}`,
    id: r.body?.id ?? null,
    serials: Array.isArray(serials) && serials.length > 20 ? `${serials.length} serials, ${serials[0]} .. ${serials[serials.length - 1]}` : serials,
    testId,
    cleanup: 'Manufacturer portal > Destruction: destroy this batch, or delete the batch row and its serials in the DB',
    ...extra,
  });
  return batchNo;
}

// ---------- Batches list ----------

const searchBox = (page) => page.getByPlaceholder(/Search by batch number/);
const expirySelect = (page) => page.locator('main select').filter({ has: page.locator('option', { hasText: 'All Expiry' }) });
const statusSelect = (page) => page.locator('main select').filter({ has: page.locator('option', { hasText: 'All Status' }) });
const showing = (page) => page.getByText(/^Showing \d+ to \d+ of \d+ batches$/);
const isListCall = (r) => r.request().method() === 'GET' && BATCH_API.test(r.url());

async function openBatchList(page) {
  const first = page.waitForResponse(isListCall, { timeout: 30_000 });
  await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
  await first;
  await searchBox(page).waitFor();
  await page.waitForTimeout(500);
}

// Runs an action that refetches the list and waits for the matching list response to render.
async function refetch(page, action, match = () => true) {
  const resp = page.waitForResponse((r) => isListCall(r) && match(new URL(r.url())), { timeout: 30_000 });
  await action();
  const r = await resp;
  await page.waitForTimeout(700);
  return new URL(r.url());
}

async function readRows(page) {
  return page.locator('main table tbody tr').evaluateAll((trs) =>
    trs
      .filter((tr) => tr.children.length >= 8)
      .map((tr) => {
        const td = [...tr.children].map((c) => c.innerText.trim());
        return { batch: td[0], product: td[1], expiry: td[2], total: td[3], shipped: td[4], available: td[5], serials: td[6], status: td[7] };
      })
  );
}

const totalOf = async (page) => {
  const t = (await showing(page).textContent().catch(() => '')) || '';
  const m = t.match(/of (\d+)/);
  return m ? Number(m[1]) : 0;
};

// The expiry cell is a browser-locale date ("06/01/2027" en-GB, "1/6/2027" en-US) plus a badge.
// daysLeft returns days from today (negative when expired); monthFirst comes from the page.
const localeMonthFirst = (page) =>
  page.evaluate(() => new Date(2001, 1, 3).toLocaleDateString().replace(/^0/, '').startsWith('2'));
function daysLeft(expiryCell, monthFirst) {
  const m = expiryCell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [day, month] = monthFirst ? [m[2], m[1]] : [m[1], m[2]];
  const d = new Date(Number(m[3]), Number(month) - 1, Number(day));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86_400_000);
}

const noResults = (page) => page.getByText('No batches found');

// =====================================================================================
// MFG-BATCH-EDGE: Create Batch field limits and validation
// =====================================================================================

test.describe('Manufacturer batches - Create Batch edge cases', () => {
  qtest('MFG-BATCH-EDGE-001', 'Batch number at the exact 20-character limit is accepted', async ({ page }) => {
    await withObserved(async (observed) => {
      const batchNo = `QA-AUTO-${String(RUN).slice(-12)}`; // exactly 20 characters
      const serial = `QA${RUN36}E1`;
      expect(batchNo).toHaveLength(20);
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, batchNo, expiry: futureDate(730), serials: serial });
      const held = await page.getByPlaceholder('Auto-generate (recommended)').inputValue();
      observed.push(`batch number field holds "${held}" (${held.length} chars)`);
      const r = await submitBatch(page);
      observed.push(r.sent ? `server HTTP ${r.status}${r.status >= 400 ? `: ${serverMessage(r)}` : ''}` : `form blocked submit: ${r.message || 'no message'}`);
      if (r.status === 201 || r.status === 200) {
        const created = logBatch(r, 'MFG-BATCH-EDGE-001', [serial]);
        observed.push(`batch created as ${created}`);
        expect(created, 'the portal should keep the 20-character batch number as entered').toBe(batchNo);
      }
      expect(r.sent, 'a 20-character batch number should be submitted').toBe(true);
      expect([200, 201], 'a 20-character batch number should be accepted').toContain(r.status);
    });
  });

  qtest('MFG-BATCH-EDGE-002', 'Batch number exceeding 20 characters is rejected', async ({ page }) => {
    await withObserved(async (observed) => {
      const long = `QA-AUTO-${String(RUN).slice(-12)}X`; // 21 characters
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, batchNo: long, expiry: futureDate(730), serials: `QA${RUN36}E2` });
      const input = page.getByPlaceholder('Auto-generate (recommended)');
      const held = await input.inputValue();
      const maxlength = await input.getAttribute('maxlength');
      observed.push(`typed 21 chars; field maxlength=${maxlength}, holds ${held.length} chars "${held}"`);
      const formBlocks = held.length <= 20;

      // Server side, for the record: send the form's request with the full 21-character value.
      await page.route(BATCH_API, (route) => {
        const req = route.request();
        if (req.method() !== 'POST') return route.continue();
        const data = JSON.parse(req.postData() || '{}');
        return route.continue({ postData: JSON.stringify({ ...data, batch_no: long }) });
      });
      const r = await submitBatch(page);
      await page.unroute(BATCH_API);
      if (r.status === 201 || r.status === 200) {
        const created = logBatch(r, 'MFG-BATCH-EDGE-002', [`QA${RUN36}E2`], { note: '21-char batch number sent past the form limit' });
        observed.push(`server ACCEPTED a 21-char batch number when the form limit is bypassed (created ${created})`);
      } else if (r.sent) {
        observed.push(`server rejected the 21-char batch number: HTTP ${r.status} ${serverMessage(r)}`);
      } else {
        observed.push(`form blocked submit: ${r.message}`);
      }
      const serverRejects = r.sent && r.status >= 400 && /20/.test(serverMessage(r));
      expect(formBlocks || serverRejects, 'the form should stop a 21-character batch number, or the server should reject it citing the 20-character limit').toBe(true);
    });
  });

  qtest('MFG-BATCH-EDGE-003', 'Batch number with a forbidden character is rejected', async ({ page }) => {
    await withObserved(async (observed) => {
      const serial = `QA${RUN36}E3`;
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, batchNo: 'BATCH#2026', expiry: futureDate(730), serials: serial });
      const r = await submitBatch(page);
      if (!r.sent) observed.push(`form blocked submit: ${r.message || 'no message'}`);
      else observed.push(`form sent it; server HTTP ${r.status}: ${serverMessage(r)}`);
      if (r.status === 201 || r.status === 200) observed.push(`batch CREATED as ${logBatch(r, 'MFG-BATCH-EDGE-003', [serial])}`);
      const rejected = !r.sent ? /#|character|allowed|invalid/i.test(r.message) : r.status >= 400;
      expect(rejected, '"BATCH#2026" should be rejected: "#" is outside the GS1 batch number character set').toBe(true);
    });
  });

  qtest('MFG-BATCH-EDGE-004', 'Serial number at the exact 20-character limit is accepted', async ({ page }) => {
    await withObserved(async (observed) => {
      const serial = `SN${RUN}AAAAA`; // 2 + 13 + 5 = 20 characters
      expect(serial).toHaveLength(20);
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730), serials: serial });
      const r = await submitBatch(page);
      observed.push(r.sent ? `server HTTP ${r.status}${r.status >= 400 ? `: ${serverMessage(r)}` : ''}` : `form blocked submit: ${r.message || 'no message'}`);
      if (r.status === 201 || r.status === 200) observed.push(`batch ${logBatch(r, 'MFG-BATCH-EDGE-004', [serial])} created with 20-char serial ${serial}`);
      expect([200, 201], 'a 20-character serial should be accepted').toContain(r.status);
    });
  });

  qtest('MFG-BATCH-EDGE-005', 'Serial number exceeding 20 characters is rejected', async ({ page }) => {
    await withObserved(async (observed) => {
      const serial = `SN${RUN}AAAAAX`; // 21 characters
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730), serials: serial });
      const r = await submitBatch(page);
      if (!r.sent) observed.push(`form blocked submit: ${r.message || 'no message'}`);
      else observed.push(`form sent it; server HTTP ${r.status}: ${serverMessage(r)}`);
      if (r.status === 201 || r.status === 200) observed.push(`batch CREATED as ${logBatch(r, 'MFG-BATCH-EDGE-005', [serial])}`);
      const rejected = !r.sent ? /20|long|length|characters/i.test(r.message) : r.status >= 400;
      expect(rejected, 'a 21-character serial should be blocked by the form or rejected by the server').toBe(true);
    });
  });

  qtest('MFG-BATCH-EDGE-006', 'Serial number containing a forbidden character is rejected', async ({ page }) => {
    await withObserved(async (observed) => {
      // The workbook's "SN#001" plus this run's tag, so an accepted serial cannot collide later.
      const serial = `SN#${RUN36}`;
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730), serials: serial });
      const r = await submitBatch(page);
      if (!r.sent) observed.push(`form blocked submit of "${serial}": ${r.message || 'no message'}`);
      else observed.push(`form sent "${serial}"; server HTTP ${r.status}: ${serverMessage(r)}`);
      if (r.status === 201 || r.status === 200) observed.push(`batch CREATED as ${logBatch(r, 'MFG-BATCH-EDGE-006', [serial])}`);
      const rejected = !r.sent ? /#|character|allowed|invalid|forbidden/i.test(r.message) : r.status >= 400;
      expect(rejected, '"#" is a forbidden serial character and should be rejected').toBe(true);
    });
  });

  qtest('MFG-BATCH-EDGE-007', 'Duplicate serial numbers within the same batch submission are rejected or de-duplicated', async ({ page }) => {
    await withObserved(async (observed) => {
      // Workbook data is "SN-001, SN-001"; a run-unique serial is used so a cross-batch
      // duplicate rejection (SN-001 already exists) cannot mask the within-batch behaviour.
      const serial = `SN-${RUN36}D`;
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730), serials: `${serial}, ${serial}` });
      const r = await submitBatch(page);
      if (!r.sent) {
        observed.push(`form blocked the duplicate: ${r.message || 'no message'}`);
        expect(r.message, 'the form should say why it blocked the submit').toMatch(/duplicate|unique|already|twice/i);
        return;
      }
      observed.push(`form sent "${serial}, ${serial}"; server HTTP ${r.status}${r.status >= 400 ? `: ${serverMessage(r)}` : ''}`);
      // A clean rejection is a 4xx validation error; a 5xx is the server failing, not rejecting.
      expect(r.status, `the duplicate should be rejected with a validation error or de-duplicated, not HTTP ${r.status} "${serverMessage(r)}"`).not.toBeGreaterThanOrEqual(500);
      if (r.status >= 400) return; // rejected: one of the two acceptable outcomes
      const batchNo = logBatch(r, 'MFG-BATCH-EDGE-007', [serial, serial]);
      observed.push(`batch ${batchNo} created, response qty=${r.body?.qty ?? r.body?.quantity ?? '?'}`);
      await openBatchList(page);
      await refetch(page, () => searchBox(page).fill(batchNo), (u) => u.searchParams.get('search') === batchNo);
      const row = (await readRows(page)).find((x) => x.batch === batchNo);
      observed.push(row ? `list row: total ${row.total}, available ${row.available}, serials ${row.serials}` : 'batch row not found in list');
      expect(row, 'the created batch should be listed').toBeTruthy();
      expect(row.available, 'a de-duplicated batch should show AVAILABLE QTY 1').toBe('1');
    });
  });

  qtest('MFG-BATCH-EDGE-008', 'Re-submitting a serial number that already exists on another batch is rejected', async ({ page }) => {
    test.setTimeout(150_000);
    await withObserved(async (observed) => {
      const serial = `SN-DUP-${RUN36}`; // workbook "SN-DUP-001", made run-unique
      await loginAs(page, 'manufacturer');

      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730), serials: serial });
      const first = await submitBatch(page);
      expect([200, 201], `first batch with ${serial} should be created (HTTP ${first.status}: ${serverMessage(first)})`).toContain(first.status);
      observed.push(`first batch ${logBatch(first, 'MFG-BATCH-EDGE-008', [serial], { product: PRODUCT })} (${PRODUCT}) created with ${serial}`);

      // Workbook step: a second batch on a different product reusing the serial.
      await openCreateBatch(page);
      await fillBatchForm(page, { product: OTHER_PRODUCT, expiry: futureDate(700), serials: serial });
      const second = await submitBatch(page);
      if (!second.sent) observed.push(`second submission (${OTHER_PRODUCT}) blocked by form: ${second.message}`);
      else observed.push(`second submission (${OTHER_PRODUCT}) HTTP ${second.status}${second.status >= 400 ? `: ${serverMessage(second)}` : ''}`);
      if (second.status === 201 || second.status === 200) {
        observed.push(`second batch CREATED as ${logBatch(second, 'MFG-BATCH-EDGE-008', [serial], { product: OTHER_PRODUCT, note: 'duplicate serial accepted on another product' })}`);
      }

      // For the record: the same serial again on the same product (same GTIN), the case GS1
      // uniqueness (GTIN + serial) actually forbids.
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(700), serials: serial });
      const third = await submitBatch(page);
      observed.push(`same-product resubmission HTTP ${third.status ?? 'not sent'}${third.status >= 400 ? `: ${serverMessage(third)}` : ''}`);
      if (third.status === 201 || third.status === 200) {
        observed.push(`same-product duplicate CREATED as ${logBatch(third, 'MFG-BATCH-EDGE-008', [serial], { product: PRODUCT, note: 'duplicate serial accepted on the same GTIN' })}`);
      }

      const rejected = !second.sent || second.status >= 400;
      expect(rejected, 'reusing an already-commissioned serial on a second batch should be rejected or flagged').toBe(true);
    });
  });

  qtest('MFG-BATCH-EDGE-009', 'Empty serial numbers field blocks submission (Serial Numbers is required)', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      const modal = await openCreateBatch(page);
      await expect(modal.getByText(/^Serial numbers\s*\*/)).toBeVisible();
      observed.push('Serial numbers label carries *');
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730) });
      const r = await submitBatch(page);
      observed.push(r.sent ? `form SENT the request (HTTP ${r.status})` : `submit blocked, no request sent; message "${r.message}"`);
      if (r.status === 201 || r.status === 200) logBatch(r, 'MFG-BATCH-EDGE-009', []);
      expect(r.sent, 'an empty serial list should not be submitted').toBe(false);
      expect(r.message).toMatch(/serial/i);
    });
  });

  qtest('MFG-BATCH-EDGE-010', 'Missing/blank required Product field blocks submission', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      const modal = await openCreateBatch(page);
      const pkgPlaceholder = modal.getByText('Select a product first');
      await expect(pkgPlaceholder, 'Package / UOM should read "Select a product first"').toBeVisible();
      const pkgPickable = await modal.getByText('Select package size...').count();
      observed.push(`Package / UOM shows "Select a product first", package picker present: ${pkgPickable > 0}`);
      await fillBatchForm(page, { expiry: futureDate(730), serials: `QA${RUN36}E10` });
      const r = await submitBatch(page);
      observed.push(r.sent ? `form SENT the request (HTTP ${r.status})` : `submit blocked, no request sent; message "${r.message}"`);
      if (r.status === 201 || r.status === 200) logBatch(r, 'MFG-BATCH-EDGE-010', [`QA${RUN36}E10`]);
      expect(r.sent, 'a batch without a product should not be submitted').toBe(false);
      expect(pkgPickable, 'Package / UOM should stay disabled until a product is chosen').toBe(0);
      await expect(pkgPlaceholder).toBeVisible();
    });
  });

  qtest('MFG-BATCH-EDGE-011', 'Missing required Expiry Date blocks submission', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      const modal = await openCreateBatch(page);
      const required = await page.locator('input[type=date]').getAttribute('required');
      await expect(modal.getByText(/^Expiry Date\s*\*/)).toBeVisible();
      observed.push(`Expiry Date label carries *, input required=${required !== null}`);
      await fillBatchForm(page, { product: PRODUCT, serials: `QA${RUN36}E11` });
      const r = await submitBatch(page);
      observed.push(r.sent ? `form SENT the request (HTTP ${r.status})` : `submit blocked, no request sent; message "${r.message}"`);
      if (r.status === 201 || r.status === 200) logBatch(r, 'MFG-BATCH-EDGE-011', [`QA${RUN36}E11`]);
      expect(r.sent, 'a batch without an expiry date should not be submitted').toBe(false);
    });
  });

  qtest('MFG-BATCH-EDGE-012', 'Expiry Date in the past is rejected or flagged', async ({ page }) => {
    await withObserved(async (observed) => {
      const serial = `QA${RUN36}E12`;
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      const min = await page.locator('input[type=date]').getAttribute('min');
      await fillBatchForm(page, { product: PRODUCT, expiry: '2020-01-01', serials: serial });
      const r = await submitBatch(page);
      observed.push(`date input min=${min}`);
      if (!r.sent) {
        observed.push(`past expiry blocked client-side: "${r.message}"`);
        expect(r.message, 'the block should explain the expiry rule').toMatch(/expiry|date|today|past/i);
        return;
      }
      observed.push(`form sent expiry 2020-01-01; server HTTP ${r.status}${r.status >= 400 ? `: ${serverMessage(r)}` : ''}`);
      if (r.status >= 400) return; // rejected server-side
      // Accepted: the batch must then be flagged as expired stock.
      const batchNo = logBatch(r, 'MFG-BATCH-EDGE-012', [serial], { expiry: '2020-01-01' });
      await openBatchList(page);
      await refetch(page, () => searchBox(page).fill(batchNo), (u) => u.searchParams.get('search') === batchNo);
      const row = (await readRows(page)).find((x) => x.batch === batchNo);
      observed.push(`accepted as ${batchNo}; list expiry cell "${row?.expiry?.replace(/\n/g, ' ')}"`);
      expect(row?.expiry, 'an accepted past-expiry batch should be flagged as expired').toMatch(/Expired/);
    });
  });

  qtest('MFG-BATCH-EDGE-014', 'Very large serial count (approaching the 50,000/message platform limit) is handled gracefully', async ({ page }) => {
    test.setTimeout(420_000);
    await withObserved(async (observed) => {
      // Workbook data: 50,001 serials in one request, which must be refused (TOO_MANY_SERIALS)
      // with a clear error rather than timing out or silently truncating.
      const count = 50_001;
      const serials = Array.from({ length: count }, (_, i) => `Q${RUN36}${i.toString(36).toUpperCase()}`);
      await loginAs(page, 'manufacturer');
      await openCreateBatch(page);
      await fillBatchForm(page, { product: PRODUCT, expiry: futureDate(730) });
      await page.getByPlaceholder('SN-001, SN-002, SN-003').fill(serials.join(', '));
      observed.push(`entered ${count} comma-separated serials (${serials.join(', ').length} chars) in the form`);
      const started = Date.now();
      const r = await submitBatch(page, { quietMs: 3000, responseTimeout: 300_000 });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (!r.sent) {
        observed.push(`form blocked the submit after ${secs}s: "${r.message}"`);
        expect(r.message, 'the form should explain the serial-count limit').toMatch(/50,?000|too many|limit|maximum/i);
        return;
      }
      if (!r.resp) {
        observed.push(`no server response within 300s (timed out)`);
        expect(r.resp, 'the server should answer rather than time out').toBeTruthy();
      }
      const posted = JSON.parse(r.resp.request().postData() || '{}');
      observed.push(`form sent ${posted.serial_numbers?.length ?? '?'} serials (qty ${posted.qty}); server HTTP ${r.status} after ${secs}s: ${serverMessage(r)}`);
      if (r.status === 201 || r.status === 200) {
        const batchNo = logBatch(r, 'MFG-BATCH-EDGE-014', serials, { note: `${count}-serial batch accepted` });
        observed.push(`server ACCEPTED it as ${batchNo} (qty ${r.body?.qty ?? '?'})`);
      }
      expect(posted.serial_numbers?.length, 'the form should not silently truncate the serial list').toBe(count);
      expect(r.status, 'more than 50,000 serials in one request should be rejected').toBeGreaterThanOrEqual(400);
      expect(`${serverMessage(r)} ${r.message}`, 'the rejection should name the serial-count limit').toMatch(/50,?000|TOO_MANY_SERIALS|too many|limit|maximum|too large/i);
    });
  });
});

// =====================================================================================
// MFG-BATCH-LIST: batches list search, filters, pagination, Bulk CSV entry point
// =====================================================================================

test.describe('Manufacturer batches - list', () => {
  qtest('MFG-BATCH-LIST-001', 'Search batches by batch number', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      // Workbook example is "BATCH-20260804"; use it when that day has batches here, otherwise
      // the date prefix of the newest batch, so the case runs on any environment.
      let term = 'BATCH-20260804';
      await refetch(page, () => searchBox(page).fill(term), (u) => u.searchParams.get('search') === term);
      let rows = await readRows(page);
      if (!rows.length) {
        await refetch(page, () => searchBox(page).fill(''), (u) => !u.searchParams.get('search'));
        const newest = (await readRows(page))[0]?.batch;
        expect(newest, 'the list should have at least one batch to search for').toBeTruthy();
        term = newest.split('-').slice(0, 2).join('-');
        observed.push(`no batches for "BATCH-20260804" here, searched the newest batch's prefix instead`);
        await refetch(page, () => searchBox(page).fill(term), (u) => u.searchParams.get('search') === term);
        rows = await readRows(page);
      }
      const off = rows.filter((x) => !x.batch.includes(term));
      observed.push(`search "${term}": ${rows.length} rows on page, ${await totalOf(page)} total, ${off.length} not containing it`);
      expect(rows.length).toBeGreaterThan(0);
      expect(off.map((x) => x.batch), 'every row should contain the search text').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-002', 'Search batches by product name', async ({ page }) => {
    await withObserved(async (observed) => {
      const term = 'Telmicos';
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const unfiltered = (await readRows(page)).filter((x) => x.product.includes(term)).length;
      await refetch(page, () => searchBox(page).fill(term), (u) => u.searchParams.get('search') === term);
      const rows = await readRows(page);
      const off = rows.filter((x) => !x.product.includes(term));
      const empty = await noResults(page).isVisible();
      observed.push(`unfiltered page 1 has ${unfiltered} ${term} batches; search "${term}" -> ${rows.length} rows${empty ? ' ("No batches found")' : ''}, ${off.length} of another product; placeholder "${await searchBox(page).getAttribute('placeholder')}"`);
      expect(rows.length, `searching "${term}" should return that product's batches`).toBeGreaterThan(0);
      expect(off.map((x) => x.product), 'only batches of that product should be shown').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-003', 'Search batches by GTIN', async ({ page }) => {
    await withObserved(async (observed) => {
      const gtin = '6161102974997';
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const unfiltered = (await readRows(page)).filter((x) => x.product.includes(gtin)).length;
      await refetch(page, () => searchBox(page).fill(gtin), (u) => u.searchParams.get('search') === gtin);
      const rows = await readRows(page);
      const off = rows.filter((x) => !x.product.includes(gtin));
      const empty = await noResults(page).isVisible();
      observed.push(`unfiltered page 1 has ${unfiltered} batches with GTIN ${gtin}; search -> ${rows.length} rows${empty ? ' ("No batches found")' : ''}, ${off.length} with another GTIN`);
      expect(rows.length, `searching GTIN ${gtin} should return its batches`).toBeGreaterThan(0);
      expect(off.map((x) => x.product), 'only batches with that GTIN should be shown').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-004', 'Search with no matches shows an empty state, not an error', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`);
      });
      const term = 'zzznonexistentzzz';
      let status;
      await refetch(
        page,
        async () => {
          page.once('response', (r) => {
            if (isListCall(r)) status = r.status();
          });
          await searchBox(page).fill(term);
        },
        (u) => u.searchParams.get('search') === term
      );
      const rows = await readRows(page);
      const empty = await noResults(page).isVisible();
      const alert = await page.getByRole('alert').allInnerTexts().catch(() => []);
      observed.push(`search "${term}": list API HTTP ${status ?? '?'}, ${rows.length} rows, empty state "No batches found" visible: ${empty}; console/page errors: ${errors.length ? errors.join(' | ') : 'none'}${alert.filter(Boolean).length ? `; alerts: ${alert.join(' | ')}` : ''}`);
      expect(rows).toHaveLength(0);
      expect(empty, 'a "no results" state should be shown').toBe(true);
      expect(errors, 'no console or page errors').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-005', 'Expiry filter narrows results correctly', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const mf = await localeMonthFirst(page);
      const before = await readRows(page);
      const soonBefore = before.filter((x) => {
        const d = daysLeft(x.expiry, mf);
        return d !== null && d >= 0 && d <= 90;
      });
      const url = await refetch(page, () => expirySelect(page).selectOption({ label: 'Expiring Soon (≤90 days)' }));
      const rows = await readRows(page);
      const off = rows.filter((x) => {
        const d = daysLeft(x.expiry, mf);
        return d === null || d < 0 || d > 90;
      });
      observed.push(`unfiltered page 1: ${soonBefore.length} batches within 90 days (e.g. ${soonBefore.slice(0, 2).map((x) => x.batch).join(', ') || 'none'}); filter "Expiring Soon" (expiry=${url.searchParams.get('expiry')}) -> ${rows.length} rows, ${await totalOf(page)} total, ${off.length} outside 0-90 days${off.length ? ` (e.g. ${off.slice(0, 3).map((x) => `${x.batch} ${x.expiry.replace(/\n/g, ' ')}`).join('; ')})` : ''}`);
      expect(off.map((x) => `${x.batch} ${x.expiry}`), 'only batches expiring within 90 days should be shown').toEqual([]);
      if (soonBefore.length) expect(rows.length, 'batches visibly within 90 days should appear under the filter').toBeGreaterThan(0);
    });
  });

  qtest('MFG-BATCH-LIST-006', 'Status filter narrows to Active/Inactive batches only', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const totalAll = await totalOf(page);
      const url = await refetch(page, () => statusSelect(page).selectOption({ label: 'Active' }));
      const rows = await readRows(page);
      const off = rows.filter((x) => x.status !== 'Active');
      observed.push(`all: ${totalAll} batches; filter Active (status=${url.searchParams.get('status')}) -> ${rows.length} rows, ${await totalOf(page)} total, non-Active rows: ${off.length ? off.map((x) => `${x.batch}=${x.status}`).slice(0, 4).join(', ') : 'none'}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(off.map((x) => `${x.batch}=${x.status}`), 'only Active batches should be shown').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-007', 'Pagination controls move between pages without losing the active filter', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      // The first filter that yields more than one page, with how to tell a row matches it.
      const mf = await localeMonthFirst(page);
      const candidates = [
        [statusSelect, 'Active', 'status', (x) => x.status === 'Active'],
        [expirySelect, 'Expired', 'expiry', (x) => daysLeft(x.expiry, mf) < 0],
        [expirySelect, 'Valid (90+ days)', 'expiry', (x) => daysLeft(x.expiry, mf) > 90],
      ];
      let chosen = null;
      for (const [sel, label, param, matches] of candidates) {
        await refetch(page, async () => {
          await statusSelect(page).selectOption({ label: 'All Status' }).catch(() => {});
          await expirySelect(page).selectOption({ label: 'All Expiry' }).catch(() => {});
          await sel(page).selectOption({ label });
        }).catch(() => {});
        await page.waitForTimeout(500);
        const total = await totalOf(page);
        observed.push(`filter ${label}: ${total} batches`);
        if (total > 25) {
          chosen = { sel, label, param, matches, total };
          break;
        }
      }
      expect(chosen, 'some filter should yield 2+ pages').toBeTruthy();
      const filterValue = await chosen.sel(page).inputValue();
      const rows1 = await readRows(page);
      const page1 = rows1.map((x) => x.batch);
      const url2 = await refetch(page, () => page.getByRole('button', { name: 'Next' }).click(), (u) => u.searchParams.get('page') === '2');
      const rows2 = await readRows(page);
      const page2 = rows2.map((x) => x.batch);
      const overlap = page2.filter((b) => page1.includes(b));
      const stillSelected = await chosen.sel(page).inputValue();
      const showingText = await showing(page).textContent().catch(() => '');
      const off = [...rows1, ...rows2].filter((x) => !chosen.matches(x));
      observed.push(`page 2 request: ${chosen.param}=${url2.searchParams.get(chosen.param)}; "${showingText}"; ${page2.length} rows, ${overlap.length} repeated from page 1; filter select still "${stillSelected}"; rows on pages 1-2 not matching "${chosen.label}": ${off.length ? off.slice(0, 4).map((x) => `${x.batch} (${x.status}, ${x.expiry.replace(/\n/g, ' ')})`).join(', ') : 'none'}`);
      expect(url2.searchParams.get(chosen.param), 'page 2 should be requested with the filter').toBe(filterValue);
      expect(stillSelected, 'the filter should stay selected on page 2').toBe(filterValue);
      expect(page2.length).toBeGreaterThan(0);
      expect(overlap, 'page 2 should show different rows').toEqual([]);
      expect(showingText).toMatch(/^Showing 26 to/);
      expect(off.map((x) => x.batch), 'pages 1 and 2 should both show only rows matching the filter').toEqual([]);
    });
  });

  qtest('MFG-BATCH-LIST-008', 'Bulk CSV import button is present and opens an import flow', async ({ page }) => {
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      const button = page.getByRole('button', { name: 'Bulk CSV' });
      await expect(button, 'a "Bulk CSV" button should be present').toBeVisible();
      await button.click();
      const modal = page.locator('div.fixed.inset-0').filter({ has: page.locator('input[type=file]') });
      await expect(modal, 'a CSV upload flow should open').toBeVisible();
      const title = (await modal.getByRole('heading').first().textContent().catch(() => '')) || '';
      const accept = await modal.locator('input[type=file]').getAttribute('accept');
      const help = modal.getByText(/How .*CSV works/);
      if (await help.count()) await help.first().click();
      await page.waitForTimeout(500);
      const text = await modal.innerText();
      const rules = {
        'max 20 characters': /max(imum)?\s*20\s*char/i.test(text),
        'batch character set': /! " % & ' \( \) \* \+ ,/.test(text),
        'serial character set': /A-Z, a-z, 0-9, - _ \. \//.test(text),
      };
      observed.push(`"Bulk CSV" opens "${title.trim()}" with a file input (accept=${accept}); GS1 rules in the import flow: ${Object.entries(rules).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      expect(Object.values(rules).some(Boolean), 'the import flow should reference the same GS1 batch/serial number rules as the manual form').toBe(true);
    });
  });
});

// =====================================================================================
// TL-1659-TC04: Bulk CSV upload latency with ~2 MB of data
// =====================================================================================

// Turns the portal's template (500 COMMISSIONING rows, the last 20 deliberately future-dated
// so they are rejected) into 500 valid rows, padded to `targetBytes` through the free-text
// Transaction_Reference column, which commissioning events do not use.
function buildLatencyCsv(templateText, targetBytes, tag) {
  const lines = templateText.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  const iTs = header.indexOf('Event_Timestamp');
  const iLot = header.indexOf('Lot_Batch_Number');
  const iUnit = header.indexOf('Unit_ID');
  const iPad = header.indexOf('Transaction_Reference');
  if ([iTs, iLot, iUnit, iPad].includes(-1)) throw new Error(`Template header changed: ${lines[0]}`);
  const now = Date.now();
  const good = rows.find((r) => new Date(r[iTs]).getTime() < now);
  if (!good) throw new Error('Template has no past-dated row to copy the event time from');
  for (const r of rows) {
    if (new Date(r[iTs]).getTime() >= now) {
      r[iTs] = good[iTs];
      r[iLot] = good[iLot];
    }
  }
  const join = () => `${[lines[0], ...rows.map((r) => r.join(','))].join('\n')}\n`;
  const per = Math.floor((targetBytes - Buffer.byteLength(join())) / rows.length);
  if (per > tag.length) for (const r of rows) r[iPad] = `${tag}${'X'.repeat(per - tag.length)}`;
  return { csv: join(), rows: rows.length, lots: [...new Set(rows.map((r) => r[iLot]))], gtins: [...new Set(rows.map((r) => r[header.indexOf('GTIN')]))], first: rows[0][iUnit], last: rows[rows.length - 1][iUnit] };
}

test.describe('Manufacturer batches - Bulk CSV latency', () => {
  qtest('TL-1659-TC04', 'CSV upload latency with 2MB data - post-fix target <= 2 seconds', async ({ page }) => {
    test.setTimeout(240_000);
    await withObserved(async (observed) => {
      await loginAs(page, 'manufacturer');
      await openBatchList(page);
      await page.getByRole('button', { name: 'Bulk CSV' }).click();
      const modal = page.locator('div.fixed.inset-0').filter({ has: page.locator('input[type=file]') });
      await modal.waitFor();
      await modal.getByText(/How .*CSV works/).first().click();
      const [download] = await Promise.all([page.waitForEvent('download'), modal.getByText('Download template').click()]);
      const templatePath = test.info().outputPath('template.csv');
      await download.saveAs(templatePath);
      // 2,000,000 bytes: the "2 MB" of the case, just inside the portal's 2 MB cap.
      const built = buildLatencyCsv(fs.readFileSync(templatePath, 'utf-8'), 2_000_000, `QA-AUTO-${RUN}-`);
      const csvPath = test.info().outputPath('bulk-2mb.csv');
      fs.writeFileSync(csvPath, built.csv);
      const bytes = Buffer.byteLength(built.csv);
      observed.push(`template ${download.suggestedFilename()} -> ${built.rows} COMMISSIONING rows, ${bytes} bytes, lot ${built.lots.join('/')}`);

      await modal.locator('input[type=file]').setInputFiles(csvPath);
      const respPromise = page.waitForResponse((r) => r.request().method() === 'POST' && CSV_API.test(r.url()), { timeout: 180_000 });
      const t0 = Date.now();
      await modal.getByRole('button', { name: 'Import' }).click();
      const resp = await respPromise;
      const tResp = Date.now() - t0;
      const outcome = modal.getByText(/Upload successful|did not complete/);
      await outcome.first().waitFor({ timeout: 30_000 }).catch(() => {});
      const tDone = Date.now() - t0;
      const status = resp.status();
      let body = {};
      try {
        body = await resp.json();
      } catch {
        // non-JSON
      }
      const outcomeText = (await outcome.allInnerTexts().catch(() => [])).join(' ');
      observed.push(`Import click -> HTTP ${status} in ${(tResp / 1000).toFixed(2)}s, "${outcomeText || 'no outcome message'}" shown at ${(tDone / 1000).toFixed(2)}s${status >= 400 ? `: ${body.message || ''}` : `, ${body.created?.event_count ?? '?'} events created`}`);
      if (status === 201 || status === 200) {
        logEntity({
          type: 'epcis-csv-import',
          identifier: built.lots.join('/'),
          testId: 'TL-1659-TC04',
          gtin: built.gtins.join('/'),
          serials: `${built.rows} SGTIN commissions, ${built.first} .. ${built.last}`,
          eventCount: body.created?.event_count ?? null,
          cleanup: `Manufacturer portal > Destruction: destroy lot ${built.lots.join('/')} (${built.rows} serials), or delete its EPCIS events/serials in the DB`,
        });
      }
      expect([200, 201], 'the 2 MB upload should succeed').toContain(status);
      expect(tResp, 'upload should complete in <= 2 seconds').toBeLessThanOrEqual(2000);
    });
  });
});
