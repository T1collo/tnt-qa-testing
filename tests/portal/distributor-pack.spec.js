// Distributor (KEMSA) > Hierarchy Management > Pack Operations. Workbook sheet
// "Distributor (KEMSA) - UI".
//
// Mapped live as KEMSA (TrackIQ, 19 Oct 2026):
//   /distributor/hierarchy, heading "Hierarchy Management", tab buttons "Unpack Operations" /
//   "Pack Operations" / "History".
//   - Unpack Operations lists received packages (GET /api/hierarchy/packages/available-for-unpack,
//     server-side ?search=). Each card has "Unpack Cases", which opens an "Unpack Items" modal
//     with "Unpack Selected (n)" / "Unpack All (n)" -> POST /api/hierarchy/unpack/<packageId>.
//   - Pack Operations lists only cases this distributor holds that are in no package
//     (GET /api/hierarchy/cases/available-for-packing?itemType=case), each a <label> with a
//     checkbox. "Create Package (n cases)" -> POST /api/distributor/packages
//     { label, case_ssccs: [...], reason } -> 201 with the new package (sscc_barcode, event_id).
//     The case list carries no location; its search box filters the loaded list client-side and
//     the "Open Scanner" option is camera-only.
// A case only becomes packable once KEMSA has received it and unpacked its package, so each test
// builds that state from fresh data: manufacturer batch -> case -> package -> regulator approval
// -> dispatch to KEMSA, then KEMSA receives and unpacks it - all through the portal UI.
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { loginAs, newRolePage } = require('../helpers/auth');
const { logEntity } = require('../helpers/datalog');
const { randomUUID } = require('crypto');
const { postEvent } = require('../helpers/apiEnv');
const H = require('./manufacturer-helpers');

// The second warehouse used for the cross-location case (the partner collection's distributor
// site). Override with DIST_SECOND_SITE.
const SECOND_SITE = process.env.DIST_SECOND_SITE || 'urn:epc:id:sgln:0123456.22222.0';

function recorder(observed) {
  return () => {
    test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
    console.log(`[actual] ${test.info().title}: ${observed.join('; ')}`);
  };
}

// TrackIQ renders an 18-digit SSCC as urn:epc:id:sscc:<digits 2-9>.<digits 10-18>; a standard
// GS1 URI drops the check digit instead. Either form is recognised.
const ssccOf = (urn) => String(urn || '').replace(/^urn:epc:id:sscc:/, '').replace(/\D/g, '');
const isSscc = (urn, sscc) => {
  const d = ssccOf(urn);
  const s = String(sscc);
  return d === s || d === s.slice(1) || (d.length === 17 && `${s[0]}${d}`.slice(0, 17) === s.slice(0, 17));
};

// ---------- KEMSA steps ----------

async function receiveShipment(page, shipmentNumber, observed) {
  await page.goto('/distributor/shipments', { waitUntil: 'domcontentloaded' });
  await page.locator('select').filter({ has: page.locator('option[value=incoming]') }).first().selectOption('incoming');
  await page.getByPlaceholder(/Search by shipment/).fill(shipmentNumber.split('-').pop());
  const row = page.locator('main tbody tr').filter({ hasText: shipmentNumber }).first();
  await expect(row, `setup: ${shipmentNumber} is incoming at KEMSA`).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: 'Receive' }).click();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /shipments\/receive/.test(r.url()), { timeout: 60_000 }),
    page.getByRole('button', { name: 'Confirm Receive' }).click(),
  ]);
  const body = await H.json(resp);
  expect(resp.status(), `setup: KEMSA receives ${shipmentNumber} (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
  observed.push(`KEMSA received ${shipmentNumber}`);
  logEntity({ type: 'shipment_received', identifier: shipmentNumber, testId: test.info().annotations.find((a) => a.type === 'testId')?.description, cleanup: 'none (received by KEMSA)' });
}

async function unpackPackage(page, packageLabel, observed) {
  await page.goto('/distributor/hierarchy', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Hierarchy Management' })).toBeVisible({ timeout: 20_000 });
  const listed = page.waitForResponse((r) => /available-for-unpack\?search=/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await page.locator('main input:not([type=checkbox])').first().fill(packageLabel.split('-').pop());
  await listed;
  const card = page.locator('main div').filter({ hasText: packageLabel }).filter({ has: page.getByRole('button', { name: 'Unpack Cases' }) }).last();
  await expect(card, `setup: ${packageLabel} is offered for unpacking`).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Unpack Cases' }).click();
  await expect(page.getByRole('heading', { name: 'Unpack Items' })).toBeVisible({ timeout: 15_000 });
  const [resp] = await Promise.all([
    page.waitForResponse(H.isPost(/\/api\/hierarchy\/unpack\/\d+$/), { timeout: 60_000 }),
    page.getByRole('button', { name: /^Unpack All/ }).click(),
  ]);
  const body = await H.json(resp);
  expect(resp.status(), `setup: KEMSA unpacks ${packageLabel} (${JSON.stringify(body).slice(0, 200)})`).toBe(201);
  observed.push(`KEMSA unpacked ${packageLabel}`);
}

async function openPackOperations(page) {
  await page.goto('/distributor/hierarchy', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Hierarchy Management' })).toBeVisible({ timeout: 20_000 });
  const listed = page.waitForResponse((r) => /\/api\/hierarchy\/cases\/available-for-packing/.test(r.url()), { timeout: 30_000 });
  await page.getByRole('button', { name: 'Pack Operations', exact: true }).click();
  const res = await listed;
  await expect(page.getByText(/Available Cases to Pack \(\d+\)/)).toBeVisible({ timeout: 20_000 });
  return res.json();
}

const packableCase = (page, caseLabel) => page.locator('main label').filter({ hasText: caseLabel }).locator('input[type=checkbox]');

// Presses "Create Package (n cases)" and returns the POST /api/distributor/packages answer.
async function submitPack(page, reason) {
  await page.getByPlaceholder(/Repacking for regional distribution/).fill(reason);
  const button = page.getByRole('button', { name: /^Create Package \(/ });
  await expect(button).toBeEnabled({ timeout: 10_000 });
  const [resp] = await Promise.all([page.waitForResponse(H.isPost(/\/api\/distributor\/packages$/), { timeout: 60_000 }), button.click()]);
  return { status: resp.status(), body: await H.json(resp), request: JSON.parse(resp.request().postData() || '{}') };
}

// A case KEMSA holds and can pack: fresh manufacturer data dispatched to KEMSA, received, unpacked.
async function kemsaPackableCase(page, browser, testId, observed) {
  const mfr = await newRolePage(browser, 'manufacturer');
  let fresh;
  try {
    fresh = await H.freshDispatchedShipment(mfr, browser, { testId });
  } finally {
    await mfr.context().close();
  }
  observed.push(`setup: ${fresh.kase.label} (SSCC ${fresh.kase.sscc_barcode}) in ${fresh.pkg.label}, dispatched to KEMSA in ${fresh.shipment.shipment_number}`);
  await loginAs(page, 'kemsa');
  await receiveShipment(page, fresh.shipment.shipment_number, observed);
  await unpackPackage(page, fresh.pkg.label, observed);
  return { caseLabel: fresh.kase.label, caseSscc: fresh.kase.sscc_barcode, ...fresh };
}

// ---------- Regulator reads ----------

// The newest events of `type` that mention `sscc` as parent, child or EPC (newest first), read
// from the same EPCIS API the Events Explorer uses.
async function eventsFor(reg, sscc, type, pages = 3) {
  const hits = [];
  for (let p = 1; p <= pages; p++) {
    const res = await reg.request.get(`/api/epcis/events?eventType=${type}&page=${p}&perPage=100`);
    const data = (await res.json().catch(() => ({}))).data || [];
    for (const e of data) {
      const epcs = [e.parentID, ...(e.childEPCs || []), ...(e.epcList || [])].filter(Boolean);
      if (epcs.some((u) => isSscc(u, sscc))) hits.push(e);
    }
    if (hits.length || data.length < 100) break;
  }
  return hits;
}

const locationOf = (e) => (e && (e.bizLocation?.id || e.readPoint?.id)) || null;

test.describe('Distributor UI repack', () => {
  qtest('DIST-PACK-001', 'Distributor re-packs received/unpacked items into a new logistics unit', async ({ page, browser }) => {
    test.setTimeout(420_000);
    const observed = [];
    try {
      const { caseLabel, caseSscc } = await kemsaPackableCase(page, browser, 'DIST-PACK-001', observed);

      const available = await openPackOperations(page);
      observed.push(`Pack Operations lists ${available.length} packable case(s)`);
      const box = packableCase(page, caseLabel);
      await expect(box, 'Pack Operations lists the received, unpacked case').toBeVisible({ timeout: 20_000 });
      await box.check();
      await expect(page.getByText('Selected Cases to Pack (1)')).toBeVisible();

      const res = await submitPack(page, `QA-AUTO ${H.uniqueTag()} repack by automated test`);
      const sscc = res.body.sscc_barcode;
      observed.push(`POST /api/distributor/packages ${JSON.stringify(res.request)} -> ${res.status}: package ${res.body.label}, SSCC ${sscc}, event ${res.body.event_id}`);
      expect(res.status, `pack is accepted (${JSON.stringify(res.body).slice(0, 200)})`).toBe(201);
      expect(String(sscc), 'a new 18-digit SSCC is created as parent').toMatch(/^\d{18}$/);
      logEntity({
        type: 'package',
        identifier: res.body.label,
        id: res.body.id,
        sscc,
        children: [caseLabel],
        testId: 'DIST-PACK-001',
        cleanup: 'Unpack it in Distributor > Hierarchy Management > Unpack Operations',
      });

      // The regulator sees an AggregationEvent (ADD) with the new SSCC as parent.
      const reg = await newRolePage(browser, 'admin');
      try {
        const events = await eventsFor(reg, sscc, 'AggregationEvent');
        const ev = events.find((e) => e.eventID === res.body.event_id) || events.find((e) => isSscc(e.parentID, sscc));
        observed.push(
          ev
            ? `EPCIS ${ev.type} ${ev.action} ${ev.eventID}: parent ${ev.parentID}, children ${(ev.childEPCs || []).join(', ')}, bizStep ${ev.bizStep}, disposition ${ev.disposition}, bizLocation ${locationOf(ev)}`
            : 'no AggregationEvent with the new SSCC as parent was found',
        );
        expect(ev, 'an AggregationEvent is recorded for the new package').toBeTruthy();
        expect(ev.action, 'aggregation action').toBe('ADD');
        expect(isSscc(ev.parentID, sscc), 'the new SSCC is the parent').toBe(true);
        expect((ev.childEPCs || []).some((u) => isSscc(u, caseSscc)), 'the packed case is a child').toBe(true);

        // The same event in the Events Explorer (searched by its child, the only EPC the
        // explorer's quick search matches), with its disposition on the detail view.
        await reg.goto('/regulator/events/explorer', { waitUntil: 'domcontentloaded' });
        await expect(reg.getByText(/^Events \(\d+\)/).first()).toBeVisible({ timeout: 30_000 });
        const quick = reg.getByPlaceholder('Optional EPC/Event quick search...');
        await quick.fill(ev.childEPCs.find((u) => isSscc(u, caseSscc)));
        await quick.press('Enter');
        const cards = reg.locator('main').getByText('Aggregation', { exact: true });
        await expect(cards.first(), 'the explorer lists the aggregation').toBeVisible({ timeout: 30_000 });
        let detail = '';
        for (let i = 0; i < (await cards.count()) && !detail.includes(ev.parentID); i++) {
          await cards.nth(i).click();
          await reg.waitForTimeout(1500);
          detail = (await reg.locator('body').innerText()).replace(/\s+/g, ' ');
        }
        const uiDisposition = (detail.match(/disposition\W+(.{0,30})/i) || [])[1];
        observed.push(`explorer detail ${detail.includes(ev.parentID) ? 'shows' : 'does not show'} parent ${ev.parentID}; disposition shown: ${uiDisposition || 'not found'}`);
        expect(detail, 'the explorer shows the event for the new SSCC').toContain(ev.parentID);

        expect(ev.disposition, 'parent disposition').toMatch(/^(urn:epcglobal:cbv:disp:)?active$/i);
      } finally {
        await reg.context().close();
      }
    } finally {
      recorder(observed)();
    }
  });

  // KEMSA can only pack cases it holds, and the Pack Operations list shows no locations, so the
  // two-site precondition is built explicitly: two cases are received and unpacked at KEMSA's
  // site, then one of them is sighted at a second warehouse with a stock-taking ObjectEvent sent
  // through the partner (distributor) API. Both are still offered for packing; packing them
  // together in one event must be refused by the same-bizLocation rule.
  qtest('DIST-PACK-002', 'Cross-location packing within a single event is rejected', async ({ page, browser }) => {
    test.setTimeout(480_000);
    const observed = [];
    try {
      const a = await kemsaPackableCase(page, browser, 'DIST-PACK-002', observed);
      const b = await kemsaPackableCase(page, browser, 'DIST-PACK-002', observed);

      const reg = await newRolePage(browser, 'admin');
      let locA;
      let locB;
      try {
        // b's EPC exactly as TrackIQ records it (taken from its own aggregation event).
        const bAgg = (await eventsFor(reg, b.caseSscc, 'AggregationEvent'))[0];
        const bUrn = bAgg && [...(bAgg.childEPCs || []), bAgg.parentID].find((u) => isSscc(u, b.caseSscc));
        expect(bUrn, `setup: EPC of ${b.caseLabel} found in EPCIS`).toBeTruthy();
        const now = new Date().toISOString();
        const sighting = {
          '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
          type: 'EPCISDocument',
          schemaVersion: '2.0',
          creationDate: now,
          epcisBody: {
            eventList: [
              {
                type: 'ObjectEvent',
                eventID: `urn:uuid:${randomUUID()}`,
                eventTime: now,
                eventTimeZoneOffset: '+03:00',
                epcList: [bUrn],
                action: 'OBSERVE',
                bizStep: 'stock_taking',
                disposition: 'active',
                readPoint: { id: SECOND_SITE },
                bizLocation: { id: SECOND_SITE },
              },
            ],
          },
        };
        const posted = await postEvent('distributor', sighting);
        observed.push(`stock_taking sighting of ${bUrn} at ${SECOND_SITE} via the distributor API -> ${posted.status}${posted.warnings.length ? ` (warnings ${posted.warnings.join(', ')})` : ''}`);
        expect(posted.status, `setup: sighting accepted (${posted.text.slice(0, 200)})`).toBeLessThan(300);
        logEntity({
          type: 'epcis_event',
          identifier: (posted.json && posted.json.event_ids && posted.json.event_ids[0]) || sighting.epcisBody.eventList[0].eventID,
          testId: 'DIST-PACK-002',
          epc: bUrn,
          cleanup: 'none (EPCIS stock_taking sighting at a second site)',
        });

        // Where each item was last sighted, as the regulator sees it: the newest event naming the
        // case or the package that carried it (a receive is recorded against the package SSCC).
        const latest = async (...ssccs) => {
          const all = [];
          for (const sscc of ssccs) all.push(...(await eventsFor(reg, sscc, 'AggregationEvent')), ...(await eventsFor(reg, sscc, 'ObjectEvent')));
          all.sort((x, y) => String(y.eventTime).localeCompare(String(x.eventTime)));
          return all[0] || null;
        };
        let eb = null;
        await expect
          .poll(async () => {
            eb = await latest(b.caseSscc, b.pkg.sscc_barcode);
            return locationOf(eb);
          }, { timeout: 30_000, message: 'the sighting is processed (async ingest)' })
          .toBe(SECOND_SITE)
          .catch(() => {});
        const ea = await latest(a.caseSscc, a.pkg.sscc_barcode);
        locA = locationOf(ea);
        locB = locationOf(eb);
        observed.push(`${a.caseLabel} last sighted at ${locA} (${ea ? `${ea.type} ${ea.bizStep}` : 'no event'}); ${b.caseLabel} last sighted at ${locB} (${eb ? `${eb.type} ${eb.bizStep}` : 'no event'})`);
      } finally {
        await reg.context().close();
      }
      expect(locA && locB && locA !== locB, 'precondition: the two items are sighted at two different bizLocations').toBe(true);

      // Pack both into one new package through the UI.
      await openPackOperations(page);
      for (const item of [a, b]) {
        await expect(packableCase(page, item.caseLabel), `${item.caseLabel} is offered for packing`).toBeVisible({ timeout: 20_000 });
        await packableCase(page, item.caseLabel).check();
      }
      await expect(page.getByText('Selected Cases to Pack (2)')).toBeVisible();
      const res = await submitPack(page, `QA-AUTO ${H.uniqueTag()} cross-location pack by automated test`);
      await page.waitForTimeout(1000);
      const message = await page
        .locator('[role=alert], [data-sonner-toast], main .text-red-600, main .bg-red-50')
        .allInnerTexts()
        .then((t) => t.join(' ').replace(/\s+/g, ' ').trim())
        .catch(() => '');
      observed.push(`pack ${JSON.stringify(res.request.case_ssccs)} (${locA} + ${locB}) -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}; message "${message.slice(0, 160)}"`);
      if (res.status < 300) {
        logEntity({
          type: 'package',
          identifier: res.body.label,
          id: res.body.id,
          sscc: res.body.sscc_barcode,
          children: [a.caseLabel, b.caseLabel],
          testId: 'DIST-PACK-002',
          cleanup: 'Cross-location pack was ACCEPTED - unpack it in Distributor > Hierarchy Management > Unpack Operations',
        });
      }
      expect(res.status, 'cross-location pack is rejected').toBeGreaterThanOrEqual(400);
      expect(`${JSON.stringify(res.body)} ${message}`, 'the rejection names the location rule').toMatch(/location|bizLocation|cross/i);
    } finally {
      recorder(observed)();
    }
  });
});
