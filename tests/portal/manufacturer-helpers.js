// Shared steps for the Manufacturer portal logistics and destruction specs
// (manufacturer-logistics.spec.js, manufacturer-destruction.spec.js).
//
// Everything here drives the real portal UI, so setup data (batch -> case -> package ->
// regulator decision) is created exactly the way a user would create it. Each helper returns
// the server's response body, because the portal replaces client-side labels (the "CASE-MAN001-…"
// shown in the form) with its own ("CASE-<epoch>-XXXX") when it saves.
const { expect } = require('@playwright/test');
const { loginAs, newRolePage } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');
const { selectProduct, selectPackage } = require('../helpers/portal');

const PRODUCT_NAME = process.env.LIFECYCLE_PRODUCT || 'Telmicos 40 mg Oral Tablet';
const PRODUCT_2_NAME = process.env.SECOND_PRODUCT || 'Arbitel AM 5 mg/40 mg Oral Tablet';
const RECEIVER_NAME = process.env.LIFECYCLE_RECEIVER || 'Kenya Medical Supplies Authority';
const CARRIER_NAME = process.env.LIFECYCLE_CARRIER || 'DHL Supply Chain Kenya';

const isoDate = (d) => d.toISOString().slice(0, 10);
function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return isoDate(d);
}

let tagSeq = 0;
// Unique, short, upper-case tag for serials and free text in this run.
const uniqueTag = () => `${Date.now().toString().slice(-8)}${(tagSeq++ % 10)}`;

const isPost = (re) => (r) => r.request().method() === 'POST' && re.test(new URL(r.url()).pathname);

async function json(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

// ---------- Batch ----------

async function createBatch(page, { testId, serialCount = 2, productName = PRODUCT_NAME } = {}) {
  const tag = uniqueTag();
  const serials = Array.from({ length: serialCount }, (_, i) => `QAAUTO${tag}${String(i + 1).padStart(2, '0')}`);
  await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create Batch' }).first().click();
  await page.getByRole('heading', { name: 'Create New Batch' }).waitFor();
  await selectProduct(page, productName);
  await selectPackage(page);
  await page.locator('input[type=date]').first().fill(futureDate(730));
  await page.locator('textarea').last().fill(serials.join(', '));
  const [resp] = await Promise.all([
    page.waitForResponse(isPost(/\/api\/manufacturer\/batches$/), { timeout: 60_000 }),
    page.getByRole('button', { name: 'Create Batch' }).last().click(),
  ]);
  const body = await json(resp);
  expect(resp.status(), `setup: batch creation (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
  logEntity({
    type: 'batch',
    identifier: body.batch_no,
    id: body.id,
    serials,
    testId,
    cleanup: 'Destroy remaining serials via Manufacturer > Destruction (batches cannot be deleted in the portal)',
  });
  return { batchNo: body.batch_no, id: body.id, productId: body.product_id, serials };
}

// ---------- Case ----------

async function openCreateCase(page) {
  await page.goto('/manufacturer/cases', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create Case' }).first().click();
  await page.getByRole('heading', { name: 'Create New Case' }).waitFor();
}

// The n-th product block's batch <select> (one per "Product #N").
const batchSelect = (page, index = 0) =>
  page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a batch...' }) }).nth(index);
const quantityInput = (page, index = 0) => page.locator('input[type=number]').nth(index);

// Selects `batchNo` in product block `index` and returns the option text, e.g.
// "BATCH-… -  (Available: 4)", or null when the batch is not offered at all.
async function chooseCaseBatch(page, batchNo, index = 0) {
  const select = batchSelect(page, index);
  await select.locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
  const option = select.locator('option', { hasText: batchNo });
  if (!(await option.count())) return null;
  const text = (await option.first().textContent()).trim();
  await select.selectOption(await option.first().getAttribute('value'));
  return text;
}

const availableIn = (optionText) => Number((String(optionText).match(/Available:\s*(\d+)/) || [])[1]);

// Opens the serial-selection step from the edit form.
async function openSerialStep(page) {
  await page.getByRole('button', { name: /select serial numbers/i }).first().click();
  await page.getByText(/of \d+ serials selected/).first().waitFor();
}

// Full case creation: products = [{ batchNo, qty }]. Serials are picked with "Select First N"
// for each product, as a user would. Returns the POST response body (status included).
async function createCase(page, products, { testId, pickFirst = true } = {}) {
  await openCreateCase(page);
  for (let i = 0; i < products.length; i++) {
    if (i > 0) await page.getByRole('button', { name: '+ Add Product' }).click();
    const opt = await chooseCaseBatch(page, products[i].batchNo, i);
    expect(opt, `setup: batch ${products[i].batchNo} should be offered in Create Case`).toBeTruthy();
    await quantityInput(page, i).fill(String(products[i].qty));
  }
  await openSerialStep(page);
  for (let i = 0; i < products.length; i++) {
    if (pickFirst) await page.getByRole('button', { name: new RegExp(`select first ${products[i].qty}`, 'i') }).click();
    if (i < products.length - 1) await page.getByRole('button', { name: /^next product/i }).click();
    else await page.getByRole('button', { name: /review & create case/i }).click();
  }
  await page.getByRole('heading', { name: 'Review & Create Case' }).waitFor();
  const { status, body, request, attempts } = await clickCreateCase(page);
  if (status === 201) {
    logEntity({
      type: 'case',
      identifier: body.label,
      id: body.id,
      sscc: body.sscc_barcode,
      fromBatches: products.map((p) => p.batchNo),
      testId,
      cleanup: 'Destroy via Manufacturer > Destruction (cases cannot be deleted in the portal)',
    });
  }
  return { status, body, request, attempts };
}

// Presses "Create case" in the Review dialog and returns the POST response.
//
// TrackIQ defect (19 Oct 2026): the cases table's id sequence was reset below existing ids, so
// an insert that draws an id already in use fails with HTTP 500 "Internal server error" and
// nothing is written; the next attempt draws the next id. The form cannot be resubmitted after
// that error, so only a bare 500 is retried by replaying the form's exact request body (with a
// fresh preview SSCC, as the form would fetch) through the same signed-in session. Validation
// answers (4xx) and successes end the loop at once, so verdicts are the server's real answer.
// Returns { status, body, request, attempts }; `attempts` goes into each test's Actual Result.
const CASE_500_RETRIES = Number(process.env.CASE_500_RETRIES || 150);
const bare500 = (status, body) => status === 500 && /Internal server error/i.test(JSON.stringify(body || ''));
// With `allowNoRequest`, a click that sends nothing within `timeout` (the form blocked it
// client-side) returns { status: null } instead of throwing.
async function clickCreateCase(page, { timeout = 60_000, allowNoRequest = false } = {}) {
  const [resp] = await Promise.all([
    page.waitForResponse(isPost(/\/api\/manufacturer\/cases$/), { timeout }).catch((err) => {
      if (allowNoRequest) return null;
      throw err;
    }),
    page.getByRole('button', { name: 'Create case', exact: true }).click(),
  ]);
  if (!resp) return { status: null, body: null, request: null, attempts: 1 };
  let status = resp.status();
  let body = await json(resp);
  let request = JSON.parse(resp.request().postData() || '{}');
  let attempts = 1;
  while (bare500(status, body) && attempts < CASE_500_RETRIES) {
    attempts++;
    const preview = await page.request.get('/api/manufacturer/sscc/generate').then((r) => r.json()).catch(() => ({}));
    request = { ...request, sscc: preview.sscc || request.sscc };
    const replay = await page.request.post('/api/manufacturer/cases', { data: request });
    status = replay.status();
    body = await json(replay);
  }
  return { status, body, request, attempts };
}

// ---------- Package ----------

async function openCreatePackage(page) {
  await page.goto('/manufacturer/packages', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create Package' }).first().click();
  await page.getByRole('heading', { name: 'Create New Package' }).waitFor();
  await page.getByText('Select one or more cases').waitFor();
  await page.waitForTimeout(1500); // the case list fills in after the modal opens
}

const caseCheckbox = (page, caseLabel) =>
  page.locator('label').filter({ hasText: caseLabel }).locator('input[type=checkbox]');

async function createPackage(page, caseLabels, { testId } = {}) {
  await openCreatePackage(page);
  for (const label of caseLabels) await caseCheckbox(page, label).check();
  const [resp] = await Promise.all([
    page.waitForResponse(isPost(/\/api\/manufacturer\/packages$/), { timeout: 60_000 }),
    page.getByRole('button', { name: /create package \(/i }).click(),
  ]);
  const body = await json(resp);
  expect(resp.status(), `setup: package creation (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
  logEntity({
    type: 'package',
    identifier: body.label,
    id: body.id,
    sscc: body.sscc_barcode,
    fromCases: caseLabels,
    testId,
    cleanup: 'Destroy via Manufacturer > Destruction (packages cannot be deleted in the portal)',
  });
  return { status: resp.status(), body, request: JSON.parse(resp.request().postData() || '{}') };
}

// ---------- Regulator decision ----------

// decision: 'approve' | 'reject'. Runs as the PPB regulator in its own browser context.
async function regulatorDecide(browser, packageLabel, decision, { testId } = {}) {
  const page = await newRolePage(browser, 'admin');
  try {
    // The reject button asks for the reason with a native prompt().
    page.on('dialog', (d) => d.accept(`QA-AUTO-${uniqueTag()} rejected by automated test`).catch(() => {}));
    await page.goto('/regulator/package-approval', { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Package label or SSCC...').fill(packageLabel.split('-').pop());
    const row = page.locator('tr').filter({ hasText: packageLabel });
    await row.first().waitFor({ timeout: 20_000 });
    await row.first().getByRole('button', { name: 'Pending' }).click();
    await page.getByPlaceholder(/Add notes for approval\/rejection/).fill(`QA-AUTO-${uniqueTag()} ${decision} by automated test`);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() !== 'GET' && /package-approval/.test(r.url()), { timeout: 30_000 }),
      page.getByRole('button', { name: decision === 'approve' ? 'Approve Package' : 'Reject Package' }).click(),
    ]);
    const body = await json(resp);
    expect(resp.status(), `setup: regulator ${decision} (${JSON.stringify(body).slice(0, 200)})`).toBeLessThan(300);
    const expected = decision === 'approve' ? 'APPROVED' : 'REJECTED';
    expect(body.approval_status, `setup: package should be ${expected}`).toBe(expected);
    logEntity({ type: `package_${expected.toLowerCase()}`, identifier: packageLabel, testId, cleanup: 'none (state change only)' });
    return body;
  } finally {
    await page.context().close();
  }
}

// A package created from a fresh batch, optionally decided by the regulator.
async function freshPackage(page, browser, { testId, decision = null, serialCount = 1 } = {}) {
  const batch = await createBatch(page, { testId, serialCount });
  const kase = await createCase(page, [{ batchNo: batch.batchNo, qty: serialCount }], { testId });
  expect(kase.status, `setup: case creation (${JSON.stringify(kase.body).slice(0, 200)})`).toBe(201);
  const pkg = await createPackage(page, [kase.body.label], { testId });
  if (decision) await regulatorDecide(browser, pkg.body.label, decision, { testId });
  return { batch, kase: kase.body, pkg: pkg.body };
}

// ---------- Shipment ----------

async function openCreateShipment(page) {
  await page.goto('/manufacturer/shipments/create', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Create New Shipment' }).waitFor();
}

async function pickReceiver(page, name = RECEIVER_NAME) {
  await page.getByText('Select Receiver').first().click();
  await page.getByPlaceholder('Search parties...').fill(name);
  await page.getByText(name, { exact: true }).first().click();
}

async function pickCarrier(page, name = CARRIER_NAME) {
  await page.getByText('Who is transporting?').first().click();
  await page.getByText(name, { exact: true }).first().click();
}

const packagePickerOption = (page, packageLabel) =>
  page.getByRole('button', { name: new RegExp(`^${packageLabel}\\b`) });

// Opens the Package IDs picker and searches it; returns the matching option locator.
async function searchPackagePicker(page, packageLabel) {
  const search = page.getByPlaceholder('Search...');
  if (!(await search.isVisible())) await page.getByText('Select packages...').first().click();
  await search.fill(packageLabel.split('-').pop());
  await page.waitForTimeout(1000);
  return packagePickerOption(page, packageLabel);
}

// Fills the Create Shipment form. Pass `skip: ['receiver', 'carrier', 'pickupLocation', ...]`
// to leave a field empty. Returns the reference number used ('' when left blank).
async function fillShipment(page, opts = {}) {
  const skip = new Set(opts.skip || []);
  if (!skip.has('receiver')) await pickReceiver(page, opts.receiver);
  if (!skip.has('carrier')) await pickCarrier(page, opts.carrier);
  const dates = page.locator('input[type=date]');
  if (!skip.has('pickupDate')) await dates.nth(0).fill(opts.pickupDate || futureDate(1));
  if (!skip.has('deliveryDate')) await dates.nth(1).fill(opts.deliveryDate || futureDate(3));
  const ref = opts.reference === undefined ? `QA-AUTO-${uniqueTag()}` : opts.reference;
  if (ref) await page.getByPlaceholder('e.g. ASN123').fill(ref);
  for (const label of opts.packages || []) {
    const option = await searchPackagePicker(page, label);
    await option.first().click();
  }
  if ((opts.packages || []).length) await page.keyboard.press('Escape');
  if (!skip.has('pickupLocation')) {
    await page.getByPlaceholder('e.g., Warehouse A, Industrial Area, Nairobi').fill(`QA-AUTO Warehouse ${uniqueTag()}, Nairobi`);
  }
  if (!skip.has('destination')) {
    await page.getByPlaceholder('e.g., Hospital Road, P.O. Box 20723, Nairobi').fill('QA-AUTO KEMSA National Depot, Nairobi');
  }
  return ref;
}

const dispatchButton = (page) => page.getByRole('button', { name: /^Dispatch Now/ });
const draftButton = (page) => page.getByRole('button', { name: /^Save as Draft/ });

// Clicks Dispatch Now / Save as Draft and collects every write the portal makes within
// `windowMs`. Returns { create, forward, writes } where create/forward are { status, body }.
async function submitShipment(page, which, { testId, windowMs = 8000 } = {}) {
  const writes = [];
  const onResp = async (r) => {
    if (r.request().method() === 'GET' || !/\/api\/manufacturer\/shipments/.test(r.url())) return;
    writes.push({ url: new URL(r.url()).pathname, status: r.status(), body: await json(r), request: r.request().postData() });
  };
  page.on('response', onResp);
  await (which === 'draft' ? draftButton(page) : dispatchButton(page)).click();
  // What the form tells the user: toasts (collected while waiting - they fade) and native
  // validation messages on invalid fields.
  const seen = new Set();
  const collect = async () => {
    for (const t of await page.locator('[role=alert], [data-sonner-toast]').allInnerTexts().catch(() => [])) {
      if (t.trim()) seen.add(t.trim());
    }
  };
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await collect();
    const done = writes.some((w) => /\/forward$/.test(w.url)) || (which === 'draft' && writes.length);
    if (done) break;
    await page.waitForTimeout(250);
  }
  const invalid = await page
    .locator('input:invalid, textarea:invalid, select:invalid')
    .evaluateAll((els) => els.map((e) => `${e.placeholder || e.type}: ${e.validationMessage}`))
    .catch(() => []);
  const messages = [...seen, ...invalid];
  await page.waitForTimeout(1000);
  page.off('response', onResp);
  const create = writes.find((w) => /\/api\/manufacturer\/shipments$/.test(w.url)) || null;
  const forward = writes.find((w) => /\/forward$/.test(w.url)) || null;
  if (create && create.status < 300 && create.body.shipment_number) {
    logEntity({
      type: which === 'draft' ? 'shipment_draft' : 'shipment',
      identifier: create.body.shipment_number,
      id: create.body.id,
      testId,
      cleanup: which === 'draft' ? 'Draft shipment - leave or delete from Shipments list' : 'Dispatched to KEMSA - receive or return it from the distributor portal',
    });
  }
  return { create, forward, writes, messages };
}

// Whether the shipment a submitShipment() call created ended up dispatched, read back from the
// Shipments list API (the forward response can still say is_dispatched=false while the
// dispatch completes). False when no shipment was created.
async function savedDispatchState(page, res, { waitMs = 15_000 } = {}) {
  const id = res.create && res.create.status < 300 ? res.create.body.id : null;
  if (!id) return false;
  const deadline = Date.now() + waitMs;
  let saved = null;
  do {
    const list = await page.request.get('/api/manufacturer/shipments').then((r) => r.json()).catch(() => []);
    saved = (Array.isArray(list) ? list : list.shipments || list.data || []).find((s) => s.id === id) || null;
    if (saved && saved.is_dispatched) return true;
    await page.waitForTimeout(1500);
  } while (Date.now() < deadline);
  return Boolean(saved && saved.is_dispatched);
}

// A dispatched shipment from fresh, approved data. Returns { pkg, shipment }.
async function freshDispatchedShipment(page, browser, { testId } = {}) {
  const { pkg, kase, batch } = await freshPackage(page, browser, { testId, decision: 'approve' });
  await openCreateShipment(page);
  await fillShipment(page, { packages: [pkg.label] });
  const res = await submitShipment(page, 'dispatch', { testId });
  expect(res.create && res.create.status, `setup: shipment create (${JSON.stringify(res.create && res.create.body).slice(0, 200)})`).toBe(201);
  expect(res.forward && res.forward.status, 'setup: shipment forward/dispatch').toBe(201);
  return { batch, kase, pkg, shipment: res.forward.body };
}

// ---------- Observed-result recording ----------

// Collects observations for the workbook's Actual Result; call done() in a finally block.
function recorder(testInfo) {
  const observed = [];
  return {
    observed,
    note: (s) => observed.push(s),
    done: () => {
      testInfo.annotations.push({ type: 'actual', description: observed.join('; ') });
      console.log(`[actual] ${observed.join('; ')}`);
    },
  };
}

module.exports = {
  PRODUCT_NAME,
  PRODUCT_2_NAME,
  RECEIVER_NAME,
  CARRIER_NAME,
  futureDate,
  uniqueTag,
  isPost,
  json,
  loginAs,
  createBatch,
  openCreateCase,
  batchSelect,
  quantityInput,
  chooseCaseBatch,
  availableIn,
  openSerialStep,
  createCase,
  clickCreateCase,
  openCreatePackage,
  caseCheckbox,
  createPackage,
  regulatorDecide,
  freshPackage,
  openCreateShipment,
  pickReceiver,
  pickCarrier,
  searchPackagePicker,
  packagePickerOption,
  fillShipment,
  dispatchButton,
  draftButton,
  submitShipment,
  savedDispatchState,
  freshDispatchedShipment,
  recorder,
};
