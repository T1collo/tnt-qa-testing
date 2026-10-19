// Manufacturer portal - cases, packages and shipments ("Manufacturer - UI" sheet).
//
// Every test builds the data it needs from scratch through the portal UI (batch -> case ->
// package -> regulator decision), with unique serials, so tests are independent and can run in
// any order. The shipment-list tests read existing shipments instead of creating new ones.
// Expectations come from the master workbook; where it allows alternatives either is accepted.
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { logEntity } = require('../helpers/datalog');
const H = require('./manufacturer-helpers');

const SETUP_TIMEOUT = 300_000;

// Runs `fn` with an observation recorder and always records the Actual Result.
async function observe(fn) {
  const rec = H.recorder(test.info());
  try {
    await fn(rec.note);
  } finally {
    rec.done();
  }
}

test.describe('Manufacturer - cases', () => {
  qtest('MFG-CASE-004', '"Select First N" picks exactly N serials from the chosen batch', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-CASE-004', serialCount: 5 });
      await H.openCreateCase(page);
      const serialsResp = page.waitForResponse((r) => r.url().includes(`/batches/${batch.id}/available-serials`));
      const opt = await H.chooseCaseBatch(page, batch.batchNo);
      note(`batch ${batch.batchNo} (5 serials) offered as "${opt}"`);
      await H.quantityInput(page).fill('2');
      await H.openSerialStep(page);
      const listed = (await (await serialsResp).json()).items;
      await page.getByRole('button', { name: /select first 2/i }).click();
      await expect(page.getByText('2 of 2 serials selected')).toBeVisible();
      note('counter reads "2 of 2 serials selected"');

      await page.getByRole('button', { name: /review & create case/i }).click();
      await page.getByRole('heading', { name: 'Review & Create Case' }).waitFor();
      const { status, body, request, attempts } = await H.clickCreateCase(page);
      if (attempts > 1) note(`Create case needed ${attempts} attempts (HTTP 500 case-id collisions)`);
      const sent = request.products[0].serialization_ids;
      const firstTwo = listed.slice(0, 2);
      note(`case POST ${status} with serialization_ids [${sent}]; first 2 listed: ${firstTwo.map((s) => `${s.id}=${s.serial_number}`).join(', ')}`);
      if (new Set(firstTwo.map((s) => s.serial_number)).size < 2) {
        note('NOTE: the first 2 list entries are the same serial number twice (each serial is stored under GTIN-13 and GTIN-14)');
      }
      if (status === 201) {
        logEntity({ type: 'case', identifier: body.label, id: body.id, sscc: body.sscc_barcode, fromBatch: batch.batchNo, testId: 'MFG-CASE-004', cleanup: 'Destroy via Manufacturer > Destruction' });
      }
      expect(sent, 'exactly the first 2 serials in list order are selected').toEqual(firstTwo.map((s) => s.id));
      expect(status).toBe(201);
    });
  });

  qtest('MFG-CASE-005', 'Multiple products can be added to a single case via "+ Add Product"', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const b1 = await H.createBatch(page, { testId: 'MFG-CASE-005', serialCount: 1 });
      const b2 = await H.createBatch(page, { testId: 'MFG-CASE-005', serialCount: 1, productName: H.PRODUCT_2_NAME });
      note(`batches ${b1.batchNo} (${H.PRODUCT_NAME}) and ${b2.batchNo} (${H.PRODUCT_2_NAME})`);

      await H.openCreateCase(page);
      await page.getByRole('button', { name: '+ Add Product' }).click();
      await expect(page.getByText('Product #2', { exact: true })).toBeVisible();
      note('"Product #2" block appeared after "+ Add Product"');

      const res = await H.createCase(page, [{ batchNo: b1.batchNo, qty: 1 }, { batchNo: b2.batchNo, qty: 1 }], { testId: 'MFG-CASE-005' });
      note(`case POST ${res.status} with ${res.request.products?.length} product entries${res.attempts > 1 ? ` after ${res.attempts} attempts (HTTP 500 case-id collisions)` : ''}`);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);

      const cases = await (await page.request.get('/api/manufacturer/cases')).json();
      const saved = cases.find((c) => c.id === res.body.id);
      const batchNos = (saved?.products || []).map((p) => p.batch?.batch_no);
      note(`saved case ${res.body.label} holds batches [${batchNos.join(', ')}]`);
      expect(batchNos).toEqual(expect.arrayContaining([b1.batchNo, b2.batchNo]));
    });
  });

  qtest('MFG-CASE-EDGE-001', 'Quantity cannot exceed the batch\'s Available count', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-CASE-EDGE-001', serialCount: 2 });
      await H.openCreateCase(page);
      const opt = await H.chooseCaseBatch(page, batch.batchNo);
      note(`batch created with 2 serials is offered as "${opt}"`);
      await H.quantityInput(page).fill('3');
      note(`Quantity field holds "${await H.quantityInput(page).inputValue()}" after entering 3`);

      // Try to proceed: the only way forward is the serial step, then Review, then Create.
      const serialBtn = page.getByRole('button', { name: /select serial numbers/i });
      let status = null;
      let body = null;
      if (await serialBtn.isVisible()) {
        await serialBtn.click();
        await page.getByText(/of \d+ serials selected/).first().waitFor();
        const firstN = page.getByRole('button', { name: /select first 3/i });
        if (await firstN.isVisible()) await firstN.click();
        await page.getByRole('button', { name: /review & create case/i }).click();
        const create = page.getByRole('button', { name: 'Create case', exact: true });
        if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
          const res = await H.clickCreateCase(page, { timeout: 15_000, allowNoRequest: true });
          if (res.attempts > 1) note(`Create case needed ${res.attempts} attempts (HTTP 500 case-id collisions)`);
          status = res.status;
          body = res.body;
        }
      }
      if (status === 201) {
        logEntity({ type: 'case', identifier: body.label, id: body.id, fromBatch: batch.batchNo, testId: 'MFG-CASE-EDGE-001', cleanup: 'Destroy via Manufacturer > Destruction' });
        note(`case ${body.label} created (201) claiming 3 units from a 2-serial batch`);
      } else {
        note(status ? `server rejected the case: HTTP ${status} ${JSON.stringify(body).slice(0, 150)}` : 'form did not allow submission');
      }
      expect(status, 'a case must not claim more units than the batch holds (2 serials)').not.toBe(201);
    });
  });

  qtest('MFG-CASE-EDGE-002', 'Quantity of 0 is rejected', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-CASE-EDGE-002', serialCount: 1 });
      await H.openCreateCase(page);
      await H.chooseCaseBatch(page, batch.batchNo);
      await H.quantityInput(page).fill('0');
      note(`Quantity field holds "${await H.quantityInput(page).inputValue()}"`);

      const posts = [];
      page.on('request', (r) => r.method() === 'POST' && /\/api\/manufacturer\/cases$/.test(new URL(r.url()).pathname) && posts.push(r));
      let reachedReview = false;
      const serialBtn = page.getByRole('button', { name: /select serial numbers/i });
      if (await serialBtn.isVisible()) {
        await serialBtn.click();
        await page.getByText(/of \d+ serials selected/).first().waitFor();
        note(`serial step: "${(await page.getByText(/of \d+ serials selected/).first().textContent()).trim()}"`);
        await page.getByRole('button', { name: /review & create case/i }).click();
        const create = page.getByRole('button', { name: 'Create case', exact: true });
        reachedReview = await create.isVisible({ timeout: 3000 }).catch(() => false);
        if (reachedReview) {
          const { status, body, attempts } = await H.clickCreateCase(page, { timeout: 15_000, allowNoRequest: true });
          if (status !== null) {
            note(`Create case -> HTTP ${status}${attempts > 1 ? ` after ${attempts} attempts` : ''} ${JSON.stringify(body).slice(0, 150)}`);
            if (status === 201) logEntity({ type: 'case', identifier: body.label, id: body.id, fromBatch: batch.batchNo, testId: 'MFG-CASE-EDGE-002', cleanup: 'Destroy via Manufacturer > Destruction' });
            expect(status, 'a 0-unit case must not be created').not.toBe(201);
          } else {
            note('Create case clicked, no request sent');
          }
        } else {
          note('Review step was not reached with Quantity 0');
        }
      } else {
        note('serial-selection step not offered with Quantity 0');
      }
      const toast = await page.getByText(/quantity|at least|greater than/i).last().textContent({ timeout: 1000 }).catch(() => null);
      if (toast) note(`message shown: "${toast.trim().slice(0, 120)}"`);
      note(`${posts.length} case POST request(s) sent`);
    });
  });

  qtest('MFG-CASE-EDGE-003', 'Creating a case with no batch selected is blocked', async ({ page }) => {
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      await H.openCreateCase(page);
      await H.batchSelect(page).locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
      expect(await H.batchSelect(page).inputValue()).toBe('');
      const qtyDisabled = await H.quantityInput(page).isDisabled();
      const serialStep = await page.getByRole('button', { name: /select serial numbers/i }).isVisible();
      const review = await page.getByRole('button', { name: /review & create case/i }).isVisible();
      note(`no batch: Quantity disabled=${qtyDisabled}, "Select serial numbers" visible=${serialStep}, "Review & create case" visible=${review}`);
      expect(serialStep || review, 'no way to proceed to Review & Create without a batch').toBe(false);
    });
  });

  qtest('MFG-CASE-EDGE-004', 'A batch with 0 Available serials does not appear as usable in the batch dropdown', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-CASE-EDGE-004', serialCount: 1 });
      await H.openCreateCase(page);
      const opt = await H.chooseCaseBatch(page, batch.batchNo);
      const available = H.availableIn(opt);
      note(`fresh 1-serial batch offered as "${opt}"`);
      await page.getByRole('button', { name: 'Cancel' }).click();

      // Consume everything the dropdown says is available, so Available reaches 0.
      const res = await H.createCase(page, [{ batchNo: batch.batchNo, qty: available }], { testId: 'MFG-CASE-EDGE-004' });
      expect(res.status, `setup: consuming case (${JSON.stringify(res.body).slice(0, 200)})`).toBe(201);
      note(`case ${res.body.label} consumed ${available} unit(s)`);

      await H.openCreateCase(page);
      await H.batchSelect(page).locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 });
      const option = H.batchSelect(page).locator('option', { hasText: batch.batchNo });
      const count = await option.count();
      const text = count ? (await option.first().textContent()).trim() : null;
      const disabled = count ? await option.first().isDisabled() : null;
      note(count ? `exhausted batch still listed as "${text}" (disabled=${disabled})` : 'exhausted batch no longer listed');
      if (count) {
        expect(H.availableIn(text), 'if listed, it must show Available: 0').toBe(0);
      }
    });
  });

  qtest('MFG-CASE-EDGE-005', 'Selecting fewer serials than the entered Quantity is blocked at Review step', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-CASE-EDGE-005', serialCount: 3 });
      await H.openCreateCase(page);
      const serialsResp = page.waitForResponse((r) => r.url().includes(`/batches/${batch.id}/available-serials`));
      await H.chooseCaseBatch(page, batch.batchNo);
      await H.quantityInput(page).fill('3');
      await H.openSerialStep(page);
      const listed = (await (await serialsResp).json()).items;
      // Pick two distinct serials by clicking their tiles.
      const distinct = [...new Set(listed.map((s) => s.serial_number))].slice(0, 2);
      for (const sn of distinct) await page.getByText(sn, { exact: true }).first().click();
      const counter = (await page.getByText(/of \d+ serials selected/).first().textContent()).trim();
      note(`picked ${distinct.join(', ')}; counter reads "${counter}"`);

      await page.getByRole('button', { name: /review & create case/i }).click();
      await page.waitForTimeout(1000);
      const create = page.getByRole('button', { name: 'Create case', exact: true });
      const reviewOpen = await create.isVisible();
      const warning = await page.getByText(/mismatch|must select|select \d+ more|exactly \d+|does not match|fewer/i).first().textContent({ timeout: 1000 }).catch(() => null);
      note(`Review dialog opened=${reviewOpen}${warning ? `, warning "${warning.trim()}"` : ', no mismatch warning'}`);
      if (!reviewOpen || warning) return; // blocked, or a mismatch warning is shown - both pass

      const { status, body, request, attempts } = await H.clickCreateCase(page, { timeout: 15_000, allowNoRequest: true });
      if (status === null) {
        const msg = await page.getByText(/must match|serial count/i).first().textContent({ timeout: 3000 }).catch(() => null);
        note(`Create case pressed: no request sent (blocked client-side)${msg ? `; message "${msg.trim().slice(0, 120)}"` : ', no message shown'}`);
        return;
      }
      if (attempts > 1) note(`Create case needed ${attempts} attempts (HTTP 500 case-id collisions)`);
      const sent = request.products[0];
      note(`Create case -> HTTP ${status} (qty ${sent.qty}, ${sent.serialization_ids?.length} serial ids)`);
      if (status === 201) logEntity({ type: 'case', identifier: body.label, id: body.id, fromBatch: batch.batchNo, testId: 'MFG-CASE-EDGE-005', cleanup: 'Destroy via Manufacturer > Destruction' });
      expect(status, 'quantity 3 with only 2 selected serials must be blocked or warned').not.toBe(201);
    });
  });
});

test.describe('Manufacturer - packages', () => {
  qtest('MFG-PKG-003', 'Package assembly supports selecting multiple cases into one package', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-PKG-003', serialCount: 2 });
      const c1 = await H.createCase(page, [{ batchNo: batch.batchNo, qty: 1 }], { testId: 'MFG-PKG-003' });
      const c2 = await H.createCase(page, [{ batchNo: batch.batchNo, qty: 1 }], { testId: 'MFG-PKG-003' });
      expect(c1.status).toBe(201);
      expect(c2.status).toBe(201);
      const pkg = await H.createPackage(page, [c1.body.label, c2.body.label], { testId: 'MFG-PKG-003' });
      note(`package ${pkg.body.label} POST ${pkg.status} with case_ids [${pkg.request.case_ids}]`);
      expect(pkg.request.case_ids).toEqual(expect.arrayContaining([c1.body.id, c2.body.id]));

      await page.goto('/manufacturer/packages', { waitUntil: 'domcontentloaded' });
      const row = page.locator('tr').filter({ hasText: pkg.body.label }).first();
      await row.waitFor({ timeout: 20_000 });
      const text = await row.innerText();
      const shown = [c1.body.sscc_barcode, c2.body.sscc_barcode].filter((s) => text.includes(s));
      note(`Packages list CASE SSCCS shows ${shown.length}/2 (${shown.join(', ')})`);
      expect(shown).toEqual([c1.body.sscc_barcode, c2.body.sscc_barcode]);
    });
  });

  qtest('MFG-PKG-EDGE-002', 'A case that already belongs to another package cannot be selected again', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-PKG-EDGE-002', serialCount: 1 });
      const kase = await H.createCase(page, [{ batchNo: batch.batchNo, qty: 1 }], { testId: 'MFG-PKG-EDGE-002' });
      expect(kase.status).toBe(201);
      await H.openCreatePackage(page);
      await expect(H.caseCheckbox(page, kase.body.label), 'sanity: unpackaged case is offered').toHaveCount(1);
      await page.keyboard.press('Escape').catch(() => {});
      const pkg = await H.createPackage(page, [kase.body.label], { testId: 'MFG-PKG-EDGE-002' });
      note(`case ${kase.body.label} packaged into ${pkg.body.label}`);

      await H.openCreatePackage(page);
      const still = await page.locator('label').filter({ hasText: kase.body.label }).count();
      note(still ? 'case is still offered in Select Cases' : 'case no longer offered in Select Cases');
      expect(still, 'an already-packaged case must not be offered again').toBe(0);
    });
  });

  qtest('MFG-PKG-EDGE-003', 'Maximum aggregation depth (Item > Case > Pallet) is enforced', async ({ page }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const batch = await H.createBatch(page, { testId: 'MFG-PKG-EDGE-003', serialCount: 1 });
      const kase = await H.createCase(page, [{ batchNo: batch.batchNo, qty: 1 }], { testId: 'MFG-PKG-EDGE-003' });
      const pkg = await H.createPackage(page, [kase.body.label], { testId: 'MFG-PKG-EDGE-003' });

      await H.openCreatePackage(page);
      const entries = await page.locator('label').filter({ has: page.locator('input[type=checkbox]') }).allInnerTexts();
      const packageLike = entries.filter((t) => t.includes(pkg.body.label) || t.includes(pkg.body.sscc_barcode) || /^PKG-/.test(t.trim()));
      note(`Select Cases offers ${entries.length} entries; package ${pkg.body.label} offered: ${packageLike.length > 0}`);
      expect(packageLike, 'a package must not be selectable as a "case" of another package').toEqual([]);
    });
  });
});

test.describe('Manufacturer - shipments', () => {
  qtest('MFG-SHIP-003', 'Save as Draft persists a shipment without dispatching it', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg } = await H.freshPackage(page, browser, { testId: 'MFG-SHIP-003', decision: 'approve' });
      await H.openCreateShipment(page);
      await H.fillShipment(page, { packages: [pkg.label] });
      const res = await H.submitShipment(page, 'draft', { testId: 'MFG-SHIP-003' });
      note(`writes: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ')}`);
      expect(res.create && res.create.status).toBe(201);
      expect(res.forward, 'Save as Draft must not call the dispatch (forward) endpoint').toBeNull();
      const number = res.create.body.shipment_number;
      note(`draft ${number} saved with is_dispatched=${res.create.body.is_dispatched}`);
      expect(res.create.body.is_dispatched).toBe(false);

      await page.goto('/manufacturer/shipments', { waitUntil: 'domcontentloaded' });
      const row = page.locator('tr').filter({ hasText: number }).first();
      await row.waitFor({ timeout: 20_000 });
      const status = (await row.locator('td').nth(6).innerText()).trim();
      note(`Shipments list status "${status}"; KEMSA "Local Drafts" not checked (KEMSA TrackIQ login unavailable)`);
      expect(status).not.toBe('Dispatched');
    });
  });

  qtest('MFG-SHIP-004', 'Reference number auto-generates when left blank', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg } = await H.freshPackage(page, browser, { testId: 'MFG-SHIP-004', decision: 'approve' });
      await H.openCreateShipment(page);
      await H.fillShipment(page, { packages: [pkg.label], reference: '' });
      await expect(page.getByPlaceholder('e.g. ASN123')).toHaveValue('');
      const res = await H.submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-004' });
      note(`writes: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'none'}`);
      expect(res.create && res.create.status, JSON.stringify(res.create && res.create.body).slice(0, 300)).toBe(201);
      const sentRef = JSON.parse(res.create.request || '{}').desadv_reference_number;
      const ref = res.create.body.desadv_reference_number;
      note(`request desadv_reference_number=${JSON.stringify(sentRef)}; response desadv_reference_number=${JSON.stringify(ref)}`);
      expect(ref, 'a reference is generated automatically').toBeTruthy();
    });
  });

  qtest('MFG-SHIP-EDGE-001', 'A package still PENDING_APPROVAL cannot be selected for shipment', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg } = await H.freshPackage(page, browser, { testId: 'MFG-SHIP-EDGE-001' });
      note(`package ${pkg.label} approval_status=${pkg.approval_status}`);
      expect(pkg.approval_status).toBe('PENDING_APPROVAL');
      await H.openCreateShipment(page);
      await H.fillShipment(page, {});
      const option = await H.searchPackagePicker(page, pkg.label);
      const offered = (await option.count()) > 0;
      note(`picker offers the pending package: ${offered}`);
      if (!offered) return;
      await option.first().click();
      await page.keyboard.press('Escape');
      const res = await H.submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-EDGE-001' });
      const dispatched = await H.savedDispatchState(page, res);
      note(`dispatch: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'no request'}${res.create?.body?.shipment_number ? ` (${res.create.body.shipment_number}, is_dispatched=${dispatched})` : ''}`);
      expect(dispatched, 'an unapproved package must be rejected on dispatch').toBe(false);
    });
  });

  qtest('MFG-SHIP-EDGE-002', 'A REJECTED package cannot be selected for shipment', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg } = await H.freshPackage(page, browser, { testId: 'MFG-SHIP-EDGE-002', decision: 'reject' });
      note(`package ${pkg.label} rejected by regulator`);
      await H.openCreateShipment(page);
      await H.fillShipment(page, {});
      const option = await H.searchPackagePicker(page, pkg.label);
      const offered = (await option.count()) > 0;
      note(`picker offers the rejected package: ${offered}`);
      if (!offered) return;
      await option.first().click();
      await page.keyboard.press('Escape');
      const res = await H.submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-EDGE-002' });
      const dispatched = await H.savedDispatchState(page, res);
      note(`dispatch: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'no request'}${res.create?.body?.shipment_number ? ` (${res.create.body.shipment_number}, is_dispatched=${dispatched})` : ''}`);
      expect(dispatched, 'a rejected package must not be shippable').toBe(false);
    });
  });

  qtest('MFG-SHIP-EDGE-003', 'A package already attached to a dispatched shipment cannot be selected again', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg, shipment } = await H.freshDispatchedShipment(page, browser, { testId: 'MFG-SHIP-EDGE-003' });
      note(`package ${pkg.label} dispatched in ${shipment.shipment_number}`);
      await H.openCreateShipment(page);
      const option = await H.searchPackagePicker(page, pkg.label);
      const offered = await option.count();
      note(offered ? 'package is offered again in the picker' : 'package is excluded from the picker');
      expect(offered).toBe(0);
    });
  });

  qtest('MFG-SHIP-EDGE-004', 'Expected Delivery Date before Pickup Date is rejected or flagged', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      await H.loginAs(page, 'manufacturer');
      const { pkg } = await H.freshPackage(page, browser, { testId: 'MFG-SHIP-EDGE-004', decision: 'approve' });
      // Workbook dates (2026-08-10 / 2026-08-05) are in the past now; same 5-day inversion, in the future.
      const pickupDate = H.futureDate(10);
      const deliveryDate = H.futureDate(5);
      await H.openCreateShipment(page);
      await H.fillShipment(page, { packages: [pkg.label], pickupDate, deliveryDate });
      const res = await H.submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-EDGE-004', windowMs: 5000 });
      const dateFlags = res.messages.filter((m) => /delivery|pickup|date|later|earlier/i.test(m));
      const created = Boolean(res.create && res.create.status < 300);
      note(`pickup ${pickupDate}, delivery ${deliveryDate}; messages [${res.messages.join(' | ')}]; writes: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'none'}`);
      if (created) note(`shipment ${res.create.body.shipment_number} saved with pickup ${res.create.body.pickup_date}, delivery ${res.create.body.expected_delivery_date}`);
      expect(!created || dateFlags.length > 0, 'delivery before pickup must be blocked or flagged').toBe(true);
    });
  });

  // Fills a valid form with a fresh approved package, minus `skip`, and presses Dispatch Now.
  async function missingFieldCase(page, browser, testId, skip, note) {
    await H.loginAs(page, 'manufacturer');
    const { pkg } = await H.freshPackage(page, browser, { testId, decision: 'approve' });
    await H.openCreateShipment(page);
    await H.fillShipment(page, { packages: [pkg.label], skip });
    const label = (await H.dispatchButton(page).textContent()).trim();
    const enabled = await H.dispatchButton(page).isEnabled();
    let res = { writes: [], create: null, messages: [] };
    if (enabled) res = await H.submitShipment(page, 'dispatch', { testId, windowMs: 5000 });
    const created = Boolean(res.create && res.create.status < 300);
    note(`left ${skip.join(' + ')} empty: button "${label}" enabled=${enabled}; messages [${res.messages.join(' | ')}]; writes: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'none'}`);
    return { created, pkg };
  }

  qtest('MFG-SHIP-EDGE-005', 'Missing required Receiver blocks Dispatch Now', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      const { created } = await missingFieldCase(page, browser, 'MFG-SHIP-EDGE-005', ['receiver'], note);
      expect(created, 'no shipment may be created without a Receiver').toBe(false);
    });
  });

  qtest('MFG-SHIP-EDGE-006', 'Missing required Logistics Provider blocks Dispatch Now', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      const { created } = await missingFieldCase(page, browser, 'MFG-SHIP-EDGE-006', ['carrier'], note);
      const required = await page.getByText('Logistics Provider *').count();
      note(`"Logistics Provider *" required marker shown: ${required > 0}`);
      expect(created, 'no shipment may be created without a Logistics Provider').toBe(false);
    });
  });

  qtest('MFG-SHIP-EDGE-007', 'Missing Pickup Location or Destination Address blocks Dispatch Now', async ({ page, browser }) => {
    test.setTimeout(SETUP_TIMEOUT);
    await observe(async (note) => {
      const first = await missingFieldCase(page, browser, 'MFG-SHIP-EDGE-007', ['pickupLocation'], note);
      expect(first.created, 'no shipment may be created without a Pickup Location').toBe(false);
      // Same form: now fill the pickup location and clear the destination instead.
      await page.getByPlaceholder('e.g., Warehouse A, Industrial Area, Nairobi').fill('QA-AUTO Warehouse, Nairobi');
      await page.getByPlaceholder('e.g., Hospital Road, P.O. Box 20723, Nairobi').fill('');
      const enabled = await H.dispatchButton(page).isEnabled();
      let res = { writes: [], create: null, messages: [] };
      if (enabled) res = await H.submitShipment(page, 'dispatch', { testId: 'MFG-SHIP-EDGE-007', windowMs: 5000 });
      const created = Boolean(res.create && res.create.status < 300);
      note(`left destination empty: Dispatch enabled=${enabled}; messages [${res.messages.join(' | ')}]; writes: ${res.writes.map((w) => `${w.url} ${w.status}`).join(', ') || 'none'}`);
      const markers = await page.getByText(/Pickup Location \(Your Warehouse\) \*|Destination Address \*/).count();
      note(`required markers shown: ${markers}/2`);
      expect(created, 'no shipment may be created without a Destination Address').toBe(false);
    });
  });
});

test.describe('Manufacturer - shipment list', () => {
  const mainRows = (page) => page.locator('tbody tr').filter({ has: page.getByRole('button', { name: /^Expand shipment/ }) });

  async function openList(page) {
    await H.loginAs(page, 'manufacturer');
    await page.goto('/manufacturer/shipments', { waitUntil: 'domcontentloaded' });
    await mainRows(page).first().waitFor({ timeout: 30_000 });
  }

  qtest('MFG-SHIP-LIST-001', 'Search shipments by SSCC, customer, carrier, or ID', async ({ page }) => {
    await observe(async (note) => {
      await openList(page);
      const before = await mainRows(page).count();
      const number = (await mainRows(page).first().locator('td').nth(1).innerText()).trim();
      const fragment = number.split('-').pop();
      await page.getByPlaceholder('Search by SSCC, customer, carrier, or ID...').fill(fragment);
      await expect(mainRows(page).filter({ hasText: number })).toHaveCount(1);
      await page.waitForTimeout(800);
      const texts = await mainRows(page).allInnerTexts();
      const nonMatching = texts.filter((t) => !t.includes(fragment));
      note(`searched "${fragment}" (from ${number}): ${before} rows -> ${texts.length}; non-matching rows: ${nonMatching.length}`);
      expect(nonMatching).toEqual([]);
    });
  });

  qtest('MFG-SHIP-LIST-002', 'Status filter narrows shipments correctly', async ({ page }) => {
    await observe(async (note) => {
      await openList(page);
      const statusCol = async () => (await mainRows(page).evaluateAll((rows) => rows.map((r) => r.querySelectorAll('td')[6]?.innerText.trim())));
      const before = await statusCol();
      const filter = page.locator('select').filter({ has: page.locator('option[value=dispatched]') });
      await filter.selectOption('dispatched');
      await page.waitForTimeout(1500);
      const after = await statusCol();
      const others = after.filter((s) => s !== 'Dispatched');
      note(`before: ${before.length} rows (${new Set(before).size} statuses: ${[...new Set(before)].join('/')}); after "Dispatched": ${after.length} rows, non-Dispatched: ${others.length}`);
      expect(after.length).toBeGreaterThan(0);
      expect(others).toEqual([]);
    });
  });

  qtest('MFG-SHIP-LIST-003', 'Expanding a shipment row via chevron reveals its package/case/batch/serial hierarchy', async ({ page }) => {
    await observe(async (note) => {
      await openList(page);
      const row = mainRows(page).filter({ hasText: 'Dispatched' }).first();
      const number = (await row.locator('td').nth(1).innerText()).trim();
      const [resp] = await Promise.all([
        page.waitForResponse((r) => /\/shipments\/\d+\/hierarchy/.test(r.url())),
        row.getByRole('button', { name: /^Expand shipment/ }).click(),
      ]);
      const tree = await resp.json();
      const section = page.getByText('Shipment hierarchy (packages').locator('xpath=..');
      await expect(section).toBeVisible();

      // Walk the first branch down to a serial, opening each level's node.
      const path = [];
      let node = tree;
      while (node) {
        path.push(node);
        node = (node.children || [])[0];
      }
      const levels = [];
      for (const n of path) {
        const text = n.type === 'serial' ? `#${n.serial_number}` : n.type === 'batch' ? n.batch_no : n.type === 'shipment' ? n.sscc : n.label;
        const el = section.getByText(text, { exact: n.type !== 'batch' }).first();
        await expect(el, `${n.type} level "${text}" is shown`).toBeVisible();
        levels.push(`${n.type}:${text}`);
        // Each tree node is a button; its label span is select-text and does not toggle.
        if (n.type !== 'serial') await el.locator('xpath=ancestor::button[1]').click();
      }
      note(`expanded ${number}: ${levels.join(' > ')}`);
      expect(path.map((n) => n.type)).toEqual(['shipment', 'package', 'case', 'batch', 'serial']);
    });
  });
});
