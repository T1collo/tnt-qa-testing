// Full supply-chain lifecycle, run end to end against a live environment:
//   Manufacturer commissions a Batch -> aggregates into a Case -> aggregates into a Package
//   -> Regulator approves the Package -> Manufacturer dispatches a Shipment to KEMSA
//   -> KEMSA receives the Shipment.
//
// This is the single most important regression check for this system: if this test
// passes after a migration, the core GS1/EPCIS commissioning-through-receiving chain
// still works across all three roles and the regulator approval gate.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/auth');
const { logEntity } = require('./helpers/datalog');

const PRODUCT_NAME = process.env.LIFECYCLE_PRODUCT || 'Telmicos 40 mg Oral Tablet';
const RECEIVER_NAME = process.env.LIFECYCLE_RECEIVER || 'Kenya Medical Supplies Authority';
const CARRIER_NAME = process.env.LIFECYCLE_CARRIER || 'DHL Supply Chain Kenya';

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

test.describe.serial('Full lifecycle: Commission -> Pack -> Aggregate -> Approve -> Ship -> Receive', () => {
  let batchNo;
  let caseLabel;
  let packageLabel;
  let packageId;
  let shipmentNumber;
  const runTag = Date.now().toString().slice(-8);
  const serial1 = `QA${runTag}1`;
  const serial2 = `QA${runTag}2`;

  test('Manufacturer commissions a new batch with 2 serials', async ({ page }) => {
    await loginAs(page, 'manufacturer');
    await page.goto('/manufacturer/batches', { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Create Batch' }).first().click();
    await page.waitForTimeout(1000);

    await page.locator('text=Search by brand name, generic name...').first().click();
    const productSearch = page.getByPlaceholder('Type to search products...');
    await productSearch.fill(PRODUCT_NAME);
    await page.waitForTimeout(1000);
    // Scope the click to the dropdown popup (input's parent container) - an unscoped
    // getByText match also hits the same product name repeated in the background
    // batches table, and picking the wrong element there gets blocked by the modal
    // backdrop's z-index instead of actually selecting the product.
    await productSearch.locator('../..').getByText(PRODUCT_NAME, { exact: true }).first().click();
    await page.waitForTimeout(800);

    // If this product has multiple package sizes, a "Select package size..." combobox
    // appears and must be resolved manually - only pick a package that shows a GTIN,
    // since packages without one are rejected server-side (see MFG-BATCH-NEG rows).
    const pkgCombo = page.locator('text=Select package size...');
    if (await pkgCombo.count()) {
      await pkgCombo.first().click();
      await page.waitForTimeout(600);
      const gtinOption = page.locator('text=GTIN:').first();
      await expect(gtinOption, 'expected at least one package option with a registered GTIN').toBeVisible({ timeout: 5000 });
      await gtinOption.click();
      await page.waitForTimeout(500);
    }

    await page.locator('input[type=date]').first().fill(futureDate(730));
    await page.locator('textarea').last().fill(`${serial1}, ${serial2}`);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/manufacturer\/batches/.test(r.url())),
      page.getByRole('button', { name: 'Create Batch' }).last().click(),
    ]);
    expect(resp.status(), 'batch creation should return 201').toBe(201);
    const body = await resp.json();
    batchNo = body.batch_no;
    logEntity({ type: 'batch', identifier: batchNo, id: body.id, serials: [serial1, serial2], testId: 'LIFECYCLE-01' });
  });

  test('Manufacturer aggregates the batch serials into a Case', async ({ page }) => {
    test.skip(!batchNo, 'previous step did not produce a batch number');
    await loginAs(page, 'manufacturer');
    await page.goto('/manufacturer/cases', { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Create Case' }).first().click();
    await page.waitForSelector('text=Loading...', { state: 'detached', timeout: 20000 }).catch(() => {});

    const batchSelect = page.locator('select').last();
    await batchSelect.selectOption({ label: `${batchNo} -  (Available: 2)` });
    await page.locator('input[type=number]').fill('2');
    await page.getByRole('button', { name: 'Select Serial Numbers (Optional)' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Select First 2/ }).click();
    await page.getByRole('button', { name: 'Review & Create Case →' }).click();
    await page.waitForTimeout(500);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/manufacturer\/cases/.test(r.url())),
      page.getByRole('button', { name: 'Create Case' }).last().click(),
    ]);
    expect(resp.status(), 'case creation should return 201').toBe(201);
    const body = await resp.json();
    caseLabel = body.label;
    logEntity({ type: 'case', identifier: caseLabel, id: body.id, sscc: body.sscc_barcode, fromBatch: batchNo, testId: 'LIFECYCLE-02' });
  });

  test('Manufacturer aggregates the case into a Package', async ({ page }) => {
    test.skip(!caseLabel, 'previous step did not produce a case label');
    await loginAs(page, 'manufacturer');
    await page.goto('/manufacturer/packages', { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Create Package' }).first().click();
    await page.waitForSelector('text=Loading...', { state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Newest case is listed first in "Select Cases".
    await expect(page.getByText(caseLabel, { exact: true })).toBeVisible({ timeout: 10000 });
    await page.locator('input[type=checkbox]').first().check();

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/manufacturer\/packages/.test(r.url())),
      page.getByRole('button', { name: 'Create Package' }).last().click(),
    ]);
    expect(resp.status(), 'package creation should return 201').toBe(201);
    const body = await resp.json();
    packageLabel = body.label;
    packageId = body.id;
    expect(body.approval_status, 'a freshly created package must start PENDING_APPROVAL').toBe('PENDING_APPROVAL');
    logEntity({ type: 'package', identifier: packageLabel, id: packageId, sscc: body.sscc_barcode, fromCase: caseLabel, testId: 'LIFECYCLE-03' });
  });

  test('Regulator approves the package', async ({ page }) => {
    test.skip(!packageLabel, 'previous step did not produce a package label');
    await loginAs(page, 'admin');
    await page.goto('/regulator/package-approval', { waitUntil: 'load' });
    await page.getByPlaceholder('Package label or SSCC...').fill(packageLabel.split('-').pop());
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Pending' }).first().click();
    await page.waitForTimeout(500);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() !== 'GET' && /package-approval/.test(r.url())),
      page.getByRole('button', { name: 'Approve Package' }).click(),
    ]);
    expect(resp.status(), 'approve action should return 201').toBe(201);
    const body = await resp.json();
    expect(body.approval_status).toBe('APPROVED');
    logEntity({ type: 'package_approved', identifier: packageLabel, id: packageId, testId: 'LIFECYCLE-04' });
  });

  test('Manufacturer dispatches a shipment to KEMSA', async ({ page }) => {
    test.skip(!packageLabel, 'previous step did not produce a package label');
    await loginAs(page, 'manufacturer');
    await page.goto('/manufacturer/shipments/create', { waitUntil: 'load' });

    await page.locator('text=Select Receiver').first().click();
    await page.getByPlaceholder('Search parties...').fill(RECEIVER_NAME);
    await page.waitForTimeout(800);
    await page.getByText(RECEIVER_NAME, { exact: true }).first().click();

    await page.locator('text=Who is transporting?').first().click();
    await page.waitForTimeout(400);
    await page.getByText(CARRIER_NAME, { exact: true }).first().click();

    await page.locator('input[type=date]').nth(0).fill(futureDate(1));
    await page.locator('input[type=date]').nth(1).fill(futureDate(3));
    const ref = `AUTOQA-${runTag}`;
    await page.getByPlaceholder('e.g. ASN123').fill(ref);

    await page.locator('text=Select packages...').first().click();
    const packageSearch = page.getByPlaceholder('Search...');
    await packageSearch.fill(packageLabel.split('-').pop());
    await page.waitForTimeout(800);
    // The option is a button whose accessible name is "<label> — SSCC <sscc> SSCC: <sscc>",
    // not just the label, so match by prefix rather than exact text.
    await page.getByRole('button', { name: new RegExp(`^${packageLabel}\\b`) }).first().click();
    await page.keyboard.press('Escape').catch(() => {});

    await page.getByPlaceholder('e.g., Warehouse A, Industrial Area, Nairobi').fill('Automated QA Warehouse, Nairobi');
    await page.getByPlaceholder('e.g., Hospital Road, P.O. Box 20723, Nairobi').fill('KEMSA National Depot, Nairobi');

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/manufacturer\/shipments/.test(r.url())),
      page.getByRole('button', { name: 'Dispatch Now' }).click(),
    ]);
    expect(resp.status(), 'shipment dispatch should return 201').toBe(201);
    const body = await resp.json();
    shipmentNumber = body.shipment_number;
    expect(body.customer, 'shipment must be addressed to the intended receiver').toBe(RECEIVER_NAME);
    logEntity({ type: 'shipment', identifier: shipmentNumber, id: body.id, receiver: RECEIVER_NAME, testId: 'LIFECYCLE-05' });
  });

  test('KEMSA receives the shipment', async ({ page }) => {
    test.skip(!shipmentNumber, 'previous step did not produce a shipment number');
    await loginAs(page, 'kemsa');
    await page.goto('/distributor/shipments', { waitUntil: 'load' });
    await page.locator('select').nth(1).selectOption('incoming');
    await page.waitForTimeout(800);
    await page.getByPlaceholder(/Search by shipment/).fill(shipmentNumber.split('-').pop());
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Receive' }).first().click();
    await page.waitForTimeout(600);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /shipments\/receive/.test(r.url())),
      page.getByRole('button', { name: 'Confirm Receive' }).click(),
    ]);
    expect(resp.status(), 'receive action should return 201').toBe(201);
    const body = await resp.json();
    expect(body.receive_event_id, 'a successful receive must produce an EPCIS receive event id').toBeTruthy();
    logEntity({ type: 'shipment_received', identifier: shipmentNumber, receiveEventId: body.receive_event_id, testId: 'LIFECYCLE-06' });
  });
});
