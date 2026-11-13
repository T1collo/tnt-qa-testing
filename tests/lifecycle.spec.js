// Full supply-chain lifecycle, run end to end against a live environment:
//   Manufacturer commissions a Batch -> aggregates into a Case -> aggregates into a Package
//   -> Regulator approves the Package -> Manufacturer dispatches a Shipment to KEMSA
//   -> KEMSA receives the Shipment.
//
// This is the single most important regression check for this system: if this test
// passes after a migration, the core GS1/EPCIS commissioning-through-receiving chain
// still works across all three roles and the regulator approval gate.
//
// The steps drive the portal's real forms through the shared helpers in
// portal/manufacturer-helpers.js. Where tnt-demo and TrackIQ word a control differently (the
// Create Case confirm button, the package submit button) both variants are accepted, so the
// chain runs on either environment.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/auth');
const { logEntity } = require('./helpers/datalog');
const { qtest } = require('./helpers/qtest');
const { selectProduct, selectPackage } = require('./helpers/portal');
const {
  PRODUCT_NAME,
  RECEIVER_NAME,
  futureDate,
  uniqueTag,
  chooseCaseBatch,
  quantityInput,
  openSerialStep,
  clickCreateCase,
  caseCheckbox,
  openCreateShipment,
  fillShipment,
  submitShipment,
  savedDispatchState,
  isPost,
  json,
  recorder,
} = require('./portal/manufacturer-helpers');

const SERIAL_COUNT = 2;

// Opens Create Case and waits until its batch list has loaded (the form shows "Loading..."
// first). Works for both portals: neither the heading nor the button wording is relied on.
async function openCreateCaseForm(page) {
  await page.goto('/manufacturer/cases', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create Case' }).first().click();
  await page.waitForSelector('text=Loading...', { state: 'detached', timeout: 20_000 }).catch(() => {});
}

// Presses the final confirm in the Review step. TrackIQ labels it "Create case" (and needs the
// HTTP 500 retry in clickCreateCase - a known backend id-sequence defect); tnt-demo labels it
// "✓ Create Case". Returns { status, body, attempts }.
async function confirmCreateCase(page) {
  const trackiqButton = page.getByRole('button', { name: 'Create case', exact: true });
  if (await trackiqButton.isVisible().catch(() => false)) return clickCreateCase(page);
  const [resp] = await Promise.all([
    page.waitForResponse(isPost(/\/api\/manufacturer\/cases$/), { timeout: 60_000 }),
    page.getByRole('button', { name: /create case/i }).last().click(),
  ]);
  return { status: resp.status(), body: await json(resp), attempts: 1 };
}

test.describe.serial('Full lifecycle: Commission -> Pack -> Aggregate -> Approve -> Ship -> Receive', () => {
  let batchNo;
  let caseLabel;
  let packageLabel;
  let packageId;
  let shipmentNumber;

  qtest('MFG-BATCH-001', 'Manufacturer commissions a new batch with 2 serials', async ({ page }) => {
    test.setTimeout(120_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'manufacturer');
      const tag = uniqueTag();
      const serials = Array.from({ length: SERIAL_COUNT }, (_, i) => `QA${tag}${i + 1}`);
      await page.goto('/manufacturer/batches', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Create Batch' }).first().click();
      await selectProduct(page, PRODUCT_NAME);
      await selectPackage(page);
      await page.locator('input[type=date]').first().fill(futureDate(730));
      await page.locator('textarea').last().fill(serials.join(', '));
      const [resp] = await Promise.all([
        page.waitForResponse(isPost(/\/api\/manufacturer\/batches$/), { timeout: 60_000 }),
        page.getByRole('button', { name: 'Create Batch' }).last().click(),
      ]);
      const body = await json(resp);
      rec.note(`POST /api/manufacturer/batches -> ${resp.status()}: batch ${body.batch_no} (id ${body.id}) with serials ${serials.join(', ')}`);
      expect(resp.status(), `batch creation should return 201 (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
      batchNo = body.batch_no;
      logEntity({
        type: 'batch',
        identifier: batchNo,
        id: body.id,
        serials,
        testId: 'MFG-BATCH-001',
        cleanup: 'Destroy remaining serials via Manufacturer > Destruction (batches cannot be deleted in the portal)',
      });
      expect(batchNo, 'an auto-generated batch number is assigned').toMatch(/^BATCH-\d{8}-[A-Z0-9]{6}$/);
    } finally {
      rec.done();
    }
  });

  qtest('MFG-CASE-001', 'Manufacturer aggregates the batch serials into a Case', async ({ page }) => {
    test.skip(!batchNo, 'previous step did not produce a batch number');
    test.setTimeout(300_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'manufacturer');
      await openCreateCaseForm(page);
      const option = await chooseCaseBatch(page, batchNo);
      rec.note(`Create Case offers the batch as "${option}"`);
      expect(option, `batch ${batchNo} is offered in Create Case`).toBeTruthy();
      await quantityInput(page).fill(String(SERIAL_COUNT));
      await openSerialStep(page);
      await page.getByRole('button', { name: new RegExp(`select first ${SERIAL_COUNT}`, 'i') }).click();
      await page.getByRole('button', { name: /review & create case/i }).click();
      await page.getByText(/review & create case/i).first().waitFor();

      const { status, body, attempts } = await confirmCreateCase(page);
      rec.note(`POST /api/manufacturer/cases -> ${status}${attempts > 1 ? ` after ${attempts} attempts (TrackIQ id-sequence HTTP 500s retried)` : ''}: label ${body && body.label}, SSCC ${body && body.sscc_barcode}`);
      expect(status, `case creation should return 201 (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
      caseLabel = body.label;
      expect(String(body.sscc_barcode), 'an 18-digit SSCC is assigned').toMatch(/^\d{18}$/);
      logEntity({
        type: 'case',
        identifier: caseLabel,
        id: body.id,
        sscc: body.sscc_barcode,
        fromBatch: batchNo,
        testId: 'MFG-CASE-001',
        cleanup: 'Destroy via Manufacturer > Destruction (cases cannot be deleted in the portal)',
      });
    } finally {
      rec.done();
    }
  });

  qtest('MFG-PKG-001', 'Manufacturer aggregates the case into a Package', async ({ page }) => {
    test.skip(!caseLabel, 'previous step did not produce a case label');
    test.setTimeout(120_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'manufacturer');
      await page.goto('/manufacturer/packages', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Create Package' }).first().click();
      await page.waitForSelector('text=Loading...', { state: 'detached', timeout: 20_000 }).catch(() => {});
      await expect(page.getByText(caseLabel, { exact: true }).first(), 'the new case is offered').toBeVisible({ timeout: 20_000 });
      const box = caseCheckbox(page, caseLabel);
      if (await box.count()) await box.first().check();
      else await page.locator('input[type=checkbox]').first().check(); // newest case is listed first

      // TrackIQ's submit reads "Create Package (1 case)"; tnt-demo's is a second "Create Package".
      const counted = page.getByRole('button', { name: /create package \(/i });
      const submit = (await counted.count()) ? counted.first() : page.getByRole('button', { name: 'Create Package' }).last();
      const [resp] = await Promise.all([page.waitForResponse(isPost(/\/api\/manufacturer\/packages$/), { timeout: 60_000 }), submit.click()]);
      const body = await json(resp);
      rec.note(`POST /api/manufacturer/packages -> ${resp.status()}: label ${body.label}, SSCC ${body.sscc_barcode}, approval_status ${body.approval_status}`);
      expect(resp.status(), `package creation should return 201 (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
      packageLabel = body.label;
      packageId = body.id;
      logEntity({
        type: 'package',
        identifier: packageLabel,
        id: packageId,
        sscc: body.sscc_barcode,
        fromCase: caseLabel,
        testId: 'MFG-PKG-001',
        cleanup: 'Destroy via Manufacturer > Destruction (packages cannot be deleted in the portal)',
      });
      expect(body.approval_status, 'a freshly created package must start PENDING_APPROVAL').toBe('PENDING_APPROVAL');
    } finally {
      rec.done();
    }
  });

  qtest('REG-APPR-001', 'Regulator approves the package', async ({ page }) => {
    test.skip(!packageLabel, 'previous step did not produce a package label');
    test.setTimeout(120_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'admin');
      await page.goto('/regulator/package-approval', { waitUntil: 'domcontentloaded' });
      await page.getByPlaceholder('Package label or SSCC...').fill(packageLabel.split('-').pop());
      const row = page.locator('tr').filter({ hasText: packageLabel }).first();
      await expect(row, 'the package is listed for approval').toBeVisible({ timeout: 20_000 });
      await row.getByRole('button', { name: 'Pending' }).click();
      const notes = page.getByPlaceholder(/Add notes for approval\/rejection/);
      if (await notes.isVisible().catch(() => false)) await notes.fill('QA-AUTO lifecycle approval by automated test');

      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() !== 'GET' && /package-approval/.test(r.url()), { timeout: 30_000 }),
        page.getByRole('button', { name: 'Approve Package' }).click(),
      ]);
      const body = await json(resp);
      rec.note(`${resp.request().method()} ${new URL(resp.url()).pathname} -> ${resp.status()}: approval_status ${body.approval_status}, approved_by_user_id ${body.approved_by_user_id || 'not set'}`);
      expect(resp.status(), 'approve action should return 201').toBe(201);
      expect(body.approval_status).toBe('APPROVED');
      expect(body.approved_by_user_id, 'approved_by_user_id is populated').toBeTruthy();
      logEntity({ type: 'package_approved', identifier: packageLabel, id: packageId, testId: 'REG-APPR-001', cleanup: 'none (state change only)' });
    } finally {
      rec.done();
    }
  });

  qtest('MFG-SHIP-001', 'Manufacturer dispatches a shipment to KEMSA', async ({ page }) => {
    test.skip(!packageLabel, 'previous step did not produce a package label');
    test.setTimeout(120_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'manufacturer');
      await openCreateShipment(page);
      const ref = await fillShipment(page, { packages: [packageLabel] });
      const res = await submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-001' });
      const { create, forward } = res;
      rec.note(`reference ${ref}; POST /api/manufacturer/shipments -> ${create ? create.status : 'not sent'}${forward ? `, forward -> ${forward.status}` : ''}; messages: ${res.messages.join(' | ') || 'none'}`);
      expect(create && create.status, `shipment creation should return 201 (${JSON.stringify(create && create.body).slice(0, 200)})`).toBe(201);
      shipmentNumber = create.body.shipment_number;
      rec.note(`shipment ${shipmentNumber} to ${create.body.customer}`);
      expect(create.body.customer, 'shipment must be addressed to the intended receiver').toBe(RECEIVER_NAME);
      if (forward) expect(forward.status, `dispatch (forward) should succeed (${JSON.stringify(forward.body).slice(0, 200)})`).toBeLessThan(300);
      const dispatched = await savedDispatchState(page, res);
      rec.note(`Shipments list: ${dispatched ? 'Dispatched' : 'not dispatched'}`);
      expect(dispatched, 'the shipment is listed as dispatched').toBe(true);
    } finally {
      rec.done();
    }
  });

  qtest('DIST-RECV-001', 'KEMSA receives the shipment', async ({ page }) => {
    test.skip(!shipmentNumber, 'previous step did not produce a shipment number');
    test.setTimeout(120_000);
    const rec = recorder(test.info());
    try {
      await loginAs(page, 'kemsa');
      await page.goto('/distributor/shipments', { waitUntil: 'domcontentloaded' });
      const statusFilter = page.locator('select').filter({ has: page.locator('option[value=incoming]') }).first();
      await statusFilter.selectOption('incoming');
      await page.getByPlaceholder(/Search by shipment/).fill(shipmentNumber.split('-').pop());
      const row = page.locator('main tbody tr').filter({ hasText: shipmentNumber }).first();
      await expect(row, 'the dispatched shipment is listed as incoming').toBeVisible({ timeout: 30_000 });
      rec.note(`listed as "${(await row.innerText()).replace(/\s+/g, ' ').trim().slice(0, 140)}"`);

      await row.getByRole('button', { name: 'Receive' }).click();
      await expect(page.getByRole('button', { name: 'Confirm Receive' })).toBeVisible({ timeout: 15_000 });
      const ssccs = await page.locator('textarea').last().inputValue().catch(() => '');
      rec.note(`Receive dialog SSCC list: ${ssccs.replace(/\s+/g, ', ') || 'empty'}`);

      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && /shipments\/receive/.test(r.url()), { timeout: 60_000 }),
        page.getByRole('button', { name: 'Confirm Receive' }).click(),
      ]);
      const body = await json(resp);
      rec.note(`POST ${new URL(resp.url()).pathname} -> ${resp.status()}: receive_event_id in response ${body.receive_event_id || 'missing'} (body ${JSON.stringify(body).slice(0, 300)})`);
      expect(resp.status(), `receive action should return 201 (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
      // Soft, so the persisted record and the status change below are still checked and recorded.
      expect.soft(body.receive_event_id, 'the receive response must include a non-empty EPCIS receive_event_id').toBeTruthy();

      // What the server stored for the shipment.
      const stored = await page.request
        .get('/api/distributor/shipments?scope=all')
        .then((r) => r.json())
        .then((list) => (Array.isArray(list) ? list : []).find((s) => s.shipment_number === shipmentNumber) || null)
        .catch(() => null);
      rec.note(`stored shipment: receive_event_id ${stored ? stored.receive_event_id : 'record not found'}, recadv ${stored ? stored.recadv_reference_number : '-'}`);
      logEntity({
        type: 'shipment_received',
        identifier: shipmentNumber,
        receiveEventId: body.receive_event_id || (stored && stored.receive_event_id) || null,
        testId: 'DIST-RECV-001',
        cleanup: 'none (received by KEMSA)',
      });
      expect(stored && stored.receive_event_id, 'the received shipment carries an EPCIS receive event id').toBeTruthy();

      // The shipment moves from "incoming" to "received".
      await statusFilter.selectOption('received');
      const received = page.locator('main tbody tr').filter({ hasText: shipmentNumber }).first();
      await expect(received, 'the shipment is now listed as received').toBeVisible({ timeout: 30_000 });
      rec.note(`after receive: "${(await received.innerText()).replace(/\s+/g, ' ').trim().slice(0, 140)}"`);
    } finally {
      rec.done();
    }
  });
});
