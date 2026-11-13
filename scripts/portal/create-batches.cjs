// Creates batches through the Manufacturer portal UI (Batches > Create Batch) and reports the
// batch number and expiry the portal assigned, so API commissioning can use a lot the
// platform already knows instead of a made-up one (which draws INVALID_LOT).
//
// Input  (env PORTAL_BATCH_REQUEST, JSON):
//   { baseUrl?, headed?, batches: [{ key, productName, gtin, serials: ["123", ...], expiry? }] }
//   `serials` are the bare serial parts (the segment after the last dot of an SGTIN).
// Output: one line per event on stdout, prefixed with @@BATCH@@ and JSON-encoded:
//   { type: 'batch', key, ok, batchNo, expiry, batchId, status, error, response }
//   { type: 'done', ok }
//
// Run by hand:
//   PORTAL_BATCH_REQUEST='{"batches":[{"key":"a","productName":"Telmicos 40 mg Oral Tablet","gtin":"6161102974997","serials":["QA1","QA2"]}]}' \
//   node scripts/portal/create-batches.cjs
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { chromium } = require('playwright');
const { loginAs } = require('../../tests/helpers/auth');
const { logEntity } = require('../../tests/helpers/datalog');
const { selectProduct, selectPackage } = require('../../tests/helpers/portal');

const MARKER = '@@BATCH@@';
const emit = (event) => process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function createBatch(page, batch) {
  await page.goto('/manufacturer/batches', { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Create Batch' }).first().click();
  await page.getByRole('heading', { name: 'Create New Batch' }).waitFor();

  await selectProduct(page, batch.productName);
  await selectPackage(page, batch.gtin);

  const expiry = batch.expiry || futureDate(730);
  await page.locator('input[type=date]').first().fill(expiry);
  // Batch number left blank: the portal generates one, which is the lot we then read back.
  await page.locator('textarea').last().fill(batch.serials.join(', '));

  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/manufacturer\/batches/.test(r.url()),
      { timeout: 60_000 }
    ),
    page.getByRole('button', { name: 'Create Batch' }).last().click(),
  ]);
  const text = await resp.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // reported as-is below
  }
  if (resp.status() !== 201 && resp.status() !== 200) {
    const reason = body?.message || body?.error || text.slice(0, 200);
    throw Object.assign(new Error(`Portal refused the batch (HTTP ${resp.status()}): ${reason}`), {
      status: resp.status(),
      response: body ?? text.slice(0, 500),
    });
  }

  const batchNo = body?.batch_no ?? body?.batchNo ?? body?.batch_number ?? null;
  if (!batchNo) {
    throw Object.assign(new Error('Portal created the batch but returned no batch number'), {
      status: resp.status(),
      response: body,
    });
  }
  // Prefer what the portal stored; fall back to what was entered.
  const stored = body?.expiry_date ?? body?.expiryDate ?? body?.expiry ?? null;
  return {
    batchNo,
    expiry: stored ? String(stored).slice(0, 10) : expiry,
    batchId: body?.id ?? null,
    status: resp.status(),
    response: body,
  };
}

(async () => {
  let request;
  try {
    request = JSON.parse(process.env.PORTAL_BATCH_REQUEST || '');
  } catch {
    emit({ type: 'done', ok: false, error: 'PORTAL_BATCH_REQUEST is missing or not JSON' });
    process.exit(2);
  }
  const baseURL = request.baseUrl || process.env.BASE_URL || 'https://tnt-demo.apeiro-digital.com';
  const browser = await chromium.launch({ headless: !request.headed });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  let allOk = true;
  try {
    await loginAs(page, 'manufacturer');
  } catch (err) {
    for (const b of request.batches) emit({ type: 'batch', key: b.key, ok: false, error: `Manufacturer login failed: ${err.message}` });
    emit({ type: 'done', ok: false });
    await browser.close();
    process.exit(1);
  }

  for (const batch of request.batches) {
    try {
      // One retry: the portal occasionally never answers the submit. A retry reloads the page,
      // so a half-filled form is never resubmitted.
      const result = await createBatch(page, batch).catch((err) => {
        if (err.status) throw err; // the portal answered and refused - retrying will not help
        process.stdout.write(`retrying ${batch.productName}: ${err.message}
`);
        return createBatch(page, batch);
      });
      logEntity({
        type: 'batch',
        identifier: result.batchNo,
        id: result.batchId,
        serials: batch.serials,
        expiry: result.expiry,
        source: 'dashboard portal-batch',
      });
      emit({ type: 'batch', key: batch.key, ok: true, ...result });
    } catch (err) {
      allOk = false;
      // A screenshot of the form as it was when the step failed, so an unattended run can be
      // diagnosed afterwards without re-running it.
      const shot = path.join(__dirname, '..', '..', 'run_data', 'portal-batch-failures', `${Date.now()}-${batch.key}.png`);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot }).catch(() => {});
      emit({ type: 'batch', key: batch.key, ok: false, error: err.message, screenshot: shot, status: err.status ?? null, response: err.response ?? null });
    }
  }
  emit({ type: 'done', ok: allOk });
  await browser.close();
  process.exit(allOk ? 0 : 1);
})();
