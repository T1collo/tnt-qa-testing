// EPCIS partner-API edge cases (Distributor / Facility / Special / Manufacturer API sheets).
//
// Each case runs in BOTH formats - EPCIS 2.0 JSON-LD and EPCIS 1.2 XML - side by side, each with
// its own fresh identifiers. Cases that need history first build it with the same identifiers
// (commission -> pack -> ship -> receive ...), letting each asynchronous step settle before the
// next, then send the event under test and assert the workbook's Expected Result.
//
// "Flagged" means the named code appears in the response: a warnings[] entry on a 2xx, or the
// code of a 4xx. Where the workbook names no code ("rejected or flagged"), a 4xx or a warning
// about the field under test is accepted.
//
// Runs on TrackIQ and tnt-demo: endpoints and keys come from tests/helpers/apiEnv.js (BASE_URL).
const { test, expect } = require('@playwright/test');
const { qtest } = require('../helpers/qtest');
const { apiKey } = require('../helpers/apiEnv');
const { T, LGTIN_PREFIX, event, send, sgtin, ok, bothFormats, messagesFor } = require('./epcis-edge-helpers');

const DIST_GLN = 'urn:epc:id:sgln:0123456.22222.0'; // the collection's distributor location
const OTHER_GLN = 'urn:epc:id:sgln:0123456.33333.0'; // a location no shipment was addressed to
const FUTURE_EXPIRY = '2028-12-31';

// Runs one case: both formats, evidence recorded for the workbook pass or fail.
function edgeCase(id, title, fn, { timeout = 240_000 } = {}) {
  qtest(id, title, async () => {
    test.setTimeout(timeout);
    const observed = [];
    try {
      await bothFormats(id, observed, fn);
    } finally {
      test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
      console.log(`[${id}] ${observed.join('; ')}`);
    }
  });
}

// ---------------------------------------------------------------- setup steps
const commission = (j, epcs, { lot = j.lot(), expiry = FUTURE_EXPIRY, settle = true } = {}) =>
  j.step('commission', 'manufacturer', event(T.commission, {
    epcList: epcs,
    ilmd: { 'cbvmda:lotNumber': lot, 'cbvmda:itemExpirationDate': expiry },
  }), { settle });
const mfgPack = (j, parent, children) => j.step('mfg pack', 'manufacturer', event(T.mfgPack, { parentID: parent, childEPCs: children }));
const mfgShip = (j, epcs) => j.step('mfg ship', 'manufacturer', event(T.mfgShip, { epcList: epcs }));
const distReceive = (j, epcs) => j.step('dist receive', 'distributor', event(T.distReceive, { epcList: epcs }));

// Commission `n` units, pack them into an SSCC, ship it to the distributor and receive it there.
async function caseAtDistributor(j, n = 3) {
  const units = Array.from({ length: n }, () => j.sgtin());
  const box = j.sscc();
  await commission(j, units);
  await mfgPack(j, box, units);
  await mfgShip(j, [box]);
  await distReceive(j, [box]);
  return { units, box };
}

const hasAny = (res, codes) => codes.some((c) => res.codes.includes(c));

test.describe('EPCIS partner-API edge cases', () => {
  test.beforeAll(() => {
    for (const role of ['manufacturer', 'distributor', 'facility']) {
      expect(apiKey(role), `the ${role} API key for this environment is missing from .env`).toBeTruthy();
    }
  });

  // ============================================================ Distributor - receiving
  edgeCase('API-DIST-RECV-002', 'Receiving with disposition=returned on a normal inbound receipt is rejected or flagged', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    await mfgShip(j, [unit]);
    const res = await j.send('receive disposition=returned', 'distributor', event(T.distReceive, { epcList: [unit], disposition: 'returned' }));
    const flagged = !ok(res.status) || res.codes.some((c) => /DISPOSITION|RETURN/.test(c));
    expect(flagged, `${j.format}: a normal receipt with disposition "returned" must be rejected or flagged; got HTTP ${res.status} [${res.codes.join(', ')}]`).toBe(true);
  });

  edgeCase('API-DIST-RECV-003', 'Receiving at a party not listed as the shipment destination is flagged RECEIVING_WITHOUT_SHIPPING', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    await mfgShip(j, [unit]); // addressed to DIST_GLN
    const res = await j.send('receive at a non-destination GLN', 'distributor', event(T.distReceive, {
      epcList: [unit],
      readPoint: { id: OTHER_GLN },
      bizLocation: { id: OTHER_GLN },
      destinationList: [{ type: 'owning_party', destination: OTHER_GLN }],
    }));
    expect(ok(res.status), `${j.format}: the event must still be accepted and stored (HTTP ${res.status})`).toBe(true);
    expect(res.codes, `${j.format}: receipt at ${OTHER_GLN}, shipment was addressed to ${DIST_GLN}`).toContain('RECEIVING_WITHOUT_SHIPPING');
  });

  edgeCase('API-DIST-RECV-004', 'Receiving an EPC with no prior shipping event is flagged RECEIVING_WITHOUT_SHIPPING', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    const res = await j.send('receive never-shipped unit', 'distributor', event(T.distReceive, { epcList: [unit] }));
    expect(ok(res.status), `${j.format}: the event must still be accepted (HTTP ${res.status})`).toBe(true);
    expect(res.codes).toContain('RECEIVING_WITHOUT_SHIPPING');
  });

  edgeCase('API-DIST-RECV-005', 'A short receipt is not recorded by the receiving event; the discrepancy needs a separate status event', async (j) => {
    const units = [j.sgtin(), j.sgtin(), j.sgtin()];
    await commission(j, units);
    await mfgShip(j, units);
    // Only two of the three shipped units physically arrive.
    const recv = await j.step('receive 2 of 3 shipped units', 'distributor', event(T.distReceive, { epcList: units.slice(0, 2) }));
    expect(recv.codes.filter((c) => /DISCREPANC|QUANTITY|MISMATCH_COUNT/.test(c)), `${j.format}: the receiving event itself records no discrepancy`).toEqual([]);
    // The missing unit is reported through its own Product Status (Damaged) event. It was never
    // received, so it is still in_transit, and in_transit -> damaged is an allowed transition.
    const status = await j.send('separate Damaged event for the missing unit', 'distributor', event(T.distDamaged, { epcList: [units[2]] }));
    expect(ok(status.status), `${j.format}: the separate status event must be accepted (HTTP ${status.status} ${status.text.slice(0, 200)})`).toBe(true);
    expect(status.codes, `${j.format}: the missing unit must not have been changed by the short receipt: ${messagesFor(status, 'INVALID_DISPOSITION').join(' | ')}`).not.toContain('INVALID_DISPOSITION');
  });

  edgeCase('API-DIST-RECV-006', 'Receiving without the mandatory recadv bizTransactionList is rejected or flagged', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    await mfgShip(j, [unit]);
    const res = await j.send('receive without bizTransactionList', 'distributor', event(T.distReceive, { epcList: [unit], bizTransactionList: undefined }));
    const flagged = !ok(res.status) || res.codes.some((c) => /BIZ_?TRANSACTION|RECADV|MISSING/.test(c));
    expect(flagged, `${j.format}: recadv is mandated; got HTTP ${res.status} [${res.codes.join(', ')}]`).toBe(true);
  });

  // ============================================================ Distributor - unpacking
  edgeCase('API-DIST-UNPACK-001', 'Partial unpack detaches only the listed child; the rest stay aggregated', async (j) => {
    const { units, box } = await caseAtDistributor(j, 3);
    const [a, b] = units;
    const res = await j.step('unpack 1 of 3', 'distributor', event(T.distUnpack, { parentID: box, childEPCs: [a] }));
    expect(res.status, `${j.format}: partial unpack must answer 202`).toBe(202);
    expect(res.codes.filter((c) => ['INVALID_PARENT_CHILD_RELATION', 'UNPACK_WITHOUT_AGGREGATION'].includes(c)),
      `${j.format}: the unpack names a real child of an active parent: ${messagesFor(res, 'INVALID_PARENT_CHILD_RELATION').join(' | ')}`).toEqual([]);
    // Proof by aggregation state: a remaining child still has its parent, the unpacked one does not.
    const remaining = await j.send('pack a remaining child elsewhere', 'distributor', event(T.distPack, { parentID: j.sscc(), childEPCs: [b] }));
    expect(remaining.codes, `${j.format}: the 2 remaining children must still be aggregated`).toContain('CHILD_ALREADY_AGGREGATED');
    const detached = await j.send('pack the unpacked child elsewhere', 'distributor', event(T.distPack, { parentID: j.sscc(), childEPCs: [a] }));
    expect(detached.codes, `${j.format}: the unpacked child must be detached: ${messagesFor(detached, 'CHILD_ALREADY_AGGREGATED').join(' | ')}`).not.toContain('CHILD_ALREADY_AGGREGATED');
  });

  edgeCase('API-DIST-UNPACK-003', 'Unpacking a parent/child pair that was never aggregated is flagged INVALID_PARENT_CHILD_RELATION', async (j) => {
    const packed = j.sgtin();
    const stranger = j.sgtin();
    const box = j.sscc();
    await commission(j, [packed, stranger]);
    await mfgPack(j, box, [packed]);
    const res = await j.send('unpack a child that was never in the case', 'distributor', event(T.distUnpack, { parentID: box, childEPCs: [stranger] }));
    expect(res.codes).toContain('INVALID_PARENT_CHILD_RELATION');
  });

  edgeCase('API-DIST-UNPACK-004', 'An unpack event without disposition is rejected or flagged', async (j) => {
    const { units, box } = await caseAtDistributor(j, 2);
    const res = await j.send('unpack without disposition', 'distributor', event(T.distUnpack, { parentID: box, childEPCs: units, disposition: undefined }));
    const flagged = !ok(res.status) || res.codes.some((c) => /DISPOSITION|MISSING/.test(c));
    expect(flagged, `${j.format}: disposition is required on DELETE unpack events; got HTTP ${res.status} [${res.codes.join(', ')}]`).toBe(true);
  });

  edgeCase('API-DIST-UNPACK-005', 'Unpacking leaves children active; a damaged unit needs a separate status event', async (j) => {
    const { units, box } = await caseAtDistributor(j, 3);
    const res = await j.step('unpack all 3', 'distributor', event(T.distUnpack, { parentID: box, childEPCs: units }));
    expect(res.status).toBe(202);
    expect(res.codes, `${j.format}: the unpack must be valid: ${messagesFor(res, 'INVALID_PARENT_CHILD_RELATION').join(' | ')}`).not.toContain('INVALID_PARENT_CHILD_RELATION');
    // The damaged unit is reported afterwards. active -> damaged is allowed, so no INVALID_DISPOSITION
    // proves the unpack left it active (not damaged, recalled or anything else).
    const dmg = await j.send('separate Damaged event after unpack', 'distributor', event(T.distDamaged, { epcList: [units[0]] }));
    expect(ok(dmg.status), `${j.format}: HTTP ${dmg.status}`).toBe(true);
    expect(dmg.codes, `${j.format}: ${messagesFor(dmg, 'INVALID_DISPOSITION').join(' | ')}`).not.toContain('INVALID_DISPOSITION');
    // And the detached children are free of the case.
    const repack = await j.send('repack a detached child', 'distributor', event(T.distPack, { parentID: j.sscc(), childEPCs: [units[1]] }));
    expect(repack.codes, `${j.format}: detached children must no longer be aggregated`).not.toContain('CHILD_ALREADY_AGGREGATED');
  });

  // ============================================================ Distributor - packing / shipping
  edgeCase('API-DIST-PACK-002', 'Packing a child that already has an active parent is flagged CHILD_ALREADY_AGGREGATED', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    await mfgPack(j, j.sscc(), [unit]);
    const res = await j.send('pack into a second SSCC', 'distributor', event(T.distPack, { parentID: j.sscc(), childEPCs: [unit] }));
    expect(res.codes).toContain('CHILD_ALREADY_AGGREGATED');
  });

  edgeCase('API-DIST-SHIP-002', 'Shipping a child SGTIN independently of its active parent is accepted with INVALID_PARENT_CHILD_RELATION', async (j) => {
    const { units } = await caseAtDistributor(j, 2);
    const res = await j.send('ship a child SGTIN alone', 'distributor', event(T.distShip, { epcList: [units[0]] }));
    expect(ok(res.status), `${j.format}: HTTP ${res.status}`).toBe(true);
    expect(res.codes).toContain('INVALID_PARENT_CHILD_RELATION');
  });

  // Recalled cannot be set through the partner API (bizStep "holding" is refused with 403 for every
  // partner type), so the non-active states used are damaged and destroyed - both named by the case.
  edgeCase('API-DIST-SHIP-003', 'Shipping an EPC whose disposition is not active (damaged / destroyed) is flagged', async (j) => {
    const damaged = j.sgtin();
    const destroyed = j.sgtin();
    await commission(j, [damaged, destroyed]);
    await mfgShip(j, [damaged, destroyed]);
    await distReceive(j, [damaged, destroyed]);
    await j.step('mark both damaged', 'distributor', event(T.distDamaged, { epcList: [damaged, destroyed] }));
    await j.step('destroy one (damaged -> destroyed)', 'distributor', event(T.distDestroy, { epcList: [destroyed], quantityList: undefined }));
    const resDamaged = await j.send('ship damaged unit', 'distributor', event(T.distShip, { epcList: [damaged] }));
    const resDestroyed = await j.send('ship destroyed unit', 'distributor', event(T.distShip, { epcList: [destroyed] }));
    expect(!ok(resDamaged.status) || hasAny(resDamaged, ['INVALID_DISPOSITION', 'INVALID_TERMINAL_STATE']),
      `${j.format}: damaged -> in_transit must be flagged; got HTTP ${resDamaged.status} [${resDamaged.codes.join(', ')}]`).toBe(true);
    expect(resDestroyed.codes, `${j.format}: destroyed additionally triggers INVALID_TERMINAL_STATE`).toContain('INVALID_TERMINAL_STATE');
  });

  // ============================================================ Facility - dispensing
  edgeCase('API-FAC-DISP-003', 'Dispensing serialized SGTINs plus a class-level quantity in one event', async (j) => {
    const units = [j.sgtin(), j.sgtin()];
    const lot = j.lot();
    await commission(j, units, { lot });
    const res = await j.send('dispense 2 SGTINs + 3 EA class-level', 'dispense', event(T.dispense, {
      epcList: units,
      quantityList: [{ epcClass: `${LGTIN_PREFIX}.${lot}`, quantity: 3, uom: 'EA' }],
    }));
    j.note(`response ${JSON.stringify({ epcs_processed: res.json?.epcs_processed, class_level: res.json?.class_level })}`);
    expect(res.status, `${j.format}: ${res.text.slice(0, 300)}`).toBe(201);
    expect(res.json?.epcs_processed, `${j.format}: both SGTINs recorded`).toBe(2);
    expect(res.json?.class_level, `${j.format}: the class-level quantity recorded in the same event`).toBe(true);
  });

  // Recalled cannot be set through the partner API (see SHIP-003); the case allows "recalled or
  // expired", so the unit is put into expired with the facility's Expired event.
  edgeCase('API-FAC-DISP-EDGE-002', 'Dispensing an SGTIN whose disposition is not active (expired) is flagged INVALID_DISPOSITION', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    await j.step('facility Expired event (-> expired)', 'facility', event(T.facExpired, { epcList: [unit] }));
    const res = await j.send('dispense the expired-state unit', 'dispense', event(T.dispense, { epcList: [unit] }));
    expect(res.codes, `${j.format}: HTTP ${res.status} ${res.text.slice(0, 200)}`).toContain('INVALID_DISPOSITION');
  });

  edgeCase('API-FAC-DISP-EDGE-003', 'Dispensing an already-dispensed serial is flagged SERIAL_ALREADY_DISPENSED', async (j) => {
    const unit = j.sgtin();
    await commission(j, [unit]);
    const first = await j.send('first dispense', 'dispense', event(T.dispense, { epcList: [unit] }));
    expect(first.status, `${j.format}: the first dispense must succeed: ${first.text.slice(0, 200)}`).toBe(201);
    const second = await j.send('second dispense', 'dispense', event(T.dispense, { epcList: [unit] }));
    expect(second.codes, `${j.format}: HTTP ${second.status} ${second.text.slice(0, 200)}`).toContain('SERIAL_ALREADY_DISPENSED');
  });

  edgeCase('API-FAC-DISP-EDGE-004', 'Dispensing a product whose ILMD expiry is in the past is flagged EXPIRED_PRODUCT', async (j) => {
    const unit = j.sgtin();
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await commission(j, [unit], { expiry: past });
    const res = await j.send(`dispense unit expired ${past}`, 'dispense', event(T.dispense, { epcList: [unit] }));
    j.note(ok(res.status) ? 'flag-with-201 model' : `hard reject HTTP ${res.status}`);
    expect(res.codes, `${j.format}: HTTP ${res.status} ${res.text.slice(0, 200)}`).toContain('EXPIRED_PRODUCT');
  });

  // ============================================================ Special events
  // Needs units under a regulator-initiated recall. The partner API cannot create one (Recall
  // Initiation, bizStep "holding", is refused with 403 PARTNER_TYPE_BIZSTEP_MISMATCH for every
  // partner type), so the units come from RECALLED_SGTINS: comma-separated SGTIN URIs of a
  // portal-created batch the regulator has recalled (Regulator > Recalls > Initiate Recall). The
  // first is used for JSON-LD, the second for XML.
  qtest('API-SPEC-RECALL-002', 'An event for a recalled EPC is accepted but flagged RECALL_ACTIVE', async () => {
    test.setTimeout(120_000);
    const observed = [];
    try {
      const recalled = (process.env.RECALLED_SGTINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (recalled.length < 2) {
        // Document why there is no fixture: the documented partner-API recall initiation is refused.
        for (const role of ['manufacturer', 'distributor', 'facility']) {
          const res = await send(role, event(T.distDamaged, {
            bizStep: 'holding',
            disposition: 'recalled',
            epcList: [sgtin()],
            bizTransactionList: [{ type: 'cert', bizTransaction: `urn:epc:id:gdti:4012345.99999.QA-AUTO-${Date.now()}` }],
          }), 'JSON-LD');
          observed.push(`recall initiation (holding/recalled) as ${role}: HTTP ${res.status} [${res.codes.join(', ')}]`);
        }
        observed.push('no recalled units available (set RECALLED_SGTINS) - not executed');
        test.skip(true, 'Needs units under a regulator-initiated recall (set RECALLED_SGTINS); the partner API refuses Recall Initiation for every partner type');
        return;
      }
      await bothFormats('API-SPEC-RECALL-002', observed, async (j) => {
        const unit = recalled[j.format === 'XML' ? 1 : 0];
        const res = await j.send(`ship recalled ${unit}`, 'manufacturer', event(T.mfgShip, { epcList: [unit] }));
        expect(ok(res.status), `${j.format}: accepted for audit history (HTTP ${res.status})`).toBe(true);
        expect(res.codes).toContain('RECALL_ACTIVE');
      });
    } finally {
      test.info().annotations.push({ type: 'actual', description: observed.join('; ') });
      console.log(`[API-SPEC-RECALL-002] ${observed.join('; ')}`);
    }
  });

  // Partner docs 4.4.4 define Export as ObjectEvent OBSERVE, bizStep=decommissioning,
  // disposition=non_sellable_other, listing only the top-level aggregated EPCs. The docs are the
  // source of truth, so the event must be accepted without a disposition-transition flag.
  edgeCase('API-SPEC-STATUS-009', 'Declare units exported (decommissioning / non_sellable_other) on the top-level SSCC', async (j) => {
    const { box } = await caseAtDistributor(j, 2);
    const res = await j.send('export the SSCC', 'distributor', event(T.distLost, {
      epcList: [box],
      disposition: 'non_sellable_other',
      readPoint: { id: DIST_GLN },
      bizLocation: { id: DIST_GLN },
      bizTransactionList: [{ type: 'cert', bizTransaction: `QA-AUTO-EXPORT-${Date.now()}` }],
    }));
    expect(res.status, `${j.format}: ${res.text.slice(0, 200)}`).toBe(202);
    expect(res.codes, `${j.format}: docs 4.4.4 make active -> non_sellable_other the Export transition: ${messagesFor(res, 'INVALID_DISPOSITION').join(' | ')}`).not.toContain('INVALID_DISPOSITION');
  });

  // ============================================================ Manufacturer - commissioning
  // An EPCIS ILMD holds exactly one lot, so "one event mixing two lots" cannot be expressed. The
  // representable form is tested instead: one document carrying two commissioning ObjectEvents with
  // two different lots, which guide 3.1.1.1 (one lot per commissioning event) allows.
  edgeCase('API-MFG-COMM-EDGE-002', 'One commissioning document with two ObjectEvents for two different lots', async (j) => {
    const lotA = j.lot();
    const lotB = j.lot();
    j.note('interpretation: one ILMD holds one lot, so the case is run as one document with two commissioning events (lot A, lot B), per guide 3.1.1.1');
    const res = await j.send('commission lot A + lot B in one document', 'manufacturer', [
      event(T.commission, { epcList: [j.sgtin(), j.sgtin()], ilmd: { 'cbvmda:lotNumber': lotA, 'cbvmda:itemExpirationDate': FUTURE_EXPIRY } }),
      event(T.commission, { epcList: [j.sgtin(), j.sgtin()], ilmd: { 'cbvmda:lotNumber': lotB, 'cbvmda:itemExpirationDate': FUTURE_EXPIRY } }),
    ]);
    j.note(`event_ids ${res.json?.event_ids?.length ?? 0}, events_processed ${res.json?.events_processed ?? '-'}`);
    expect(res.status, `${j.format}: ${res.text.slice(0, 300)}`).toBe(202);
    expect(res.json?.event_ids?.length, `${j.format}: both events stored`).toBe(2);
    // Each event's own lot is what the platform evaluated: where it reports on lots (INVALID_LOT
    // when the lot is not in the batches registry) it must name both, not map all serials to one.
    const lotMessages = messagesFor(res, 'INVALID_LOT').join(' | ');
    if (lotMessages) {
      j.note(`lots evaluated: ${[lotA, lotB].filter((l) => lotMessages.includes(l)).join(' & ')}`);
      expect(lotMessages, `${j.format}: lot A evaluated`).toContain(lotA);
      expect(lotMessages, `${j.format}: lot B evaluated`).toContain(lotB);
    }
  });
});
