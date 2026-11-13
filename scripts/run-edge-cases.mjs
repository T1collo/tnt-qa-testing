// Executes the abnormal / edge-case matrix against the live platform and writes
// reports/edge-cases.json, which scripts/make-edge-case-sheet.mjs turns into a workbook.
//
// Every case carries the documented rule it probes (where the onboarding guide states one)
// and a reasoned expectation where it does not, so the sheet distinguishes
// "system contradicts the guide" from "guide is silent, product decision needed".
//
// Run: node --env-file=.env scripts/run-edge-cases.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.API_BASE_URL;
const TOK = {
  MFG: process.env.MANUFACTURER_API_TOKEN,
  SUP: process.env.DISTRIBUTOR_API_TOKEN,
  FAC: process.env.FACILITY_API_TOKEN,
};
const URL_M = `${BASE}/api/integration/manufacturer/events`;
const URL_S = `${BASE}/api/integration/supplier/events`;
const URL_F = `${BASE}/api/integration/facility/events`;
const URL_D = `${BASE}/api/integration/facility/events/dispense`;

const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;
// SGTIN_PREFIX lets a regression pass swap in a product that is registered in master data,
// to separate genuine behaviour from unregistered-product noise. Defaults to the original.
const SGTIN_PREFIX = process.env.SGTIN_PREFIX || 'urn:epc:id:sgtin:0614141.000111';
const sgtin = () => `${SGTIN_PREFIX}.${d(7)}`;
const sscc = () => `urn:epc:id:sscc:0614141.${d(10)}`;
const SGLN = 'urn:epc:id:sgln:0614141.00001.0';
const SGLN_B = 'urn:epc:id:sgln:0619999.00002.0';
const iso = (ms) => new Date(Date.now() + (ms || 0)).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ILMD = () => ({ 'cbvmda:lotNumber': `LOT-${d(4)}`, 'cbvmda:itemExpirationDate': '2028-12-31' });

function ev(o = {}) {
  const base = {
    type: 'ObjectEvent', eventID: uuid(), eventTime: iso(), eventTimeZoneOffset: '+03:00',
    epcList: [sgtin()], action: 'ADD', bizStep: 'commissioning', disposition: 'active',
    readPoint: { id: SGLN }, bizLocation: { id: SGLN }, ilmd: ILMD(),
  };
  const m = { ...base, ...o };
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  return m;
}
const wrap = (e) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument', schemaVersion: '2.0', creationDate: iso(),
  epcisBody: { eventList: Array.isArray(e) ? e : [e] },
});

async function post(url, tok, body, ct = 'application/ld+json') {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': ct, ...(tok ? { 'X-API-Key': tok } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  const codes = [];
  if (j.code) codes.push(j.code);
  for (const k of ['errors', 'warnings', 'violations']) for (const e of (j[k] || [])) if (e.code) codes.push(e.code);
  return {
    status: res.status, codes: [...new Set(codes)],
    message: j.message || '', processed: j.events_processed,
    text: text.replace(/\s+/g, ' ').slice(0, 400),
  };
}

// commission a serial and return its EPC, for cases that need existing state
async function commission(over = {}) {
  const epc = sgtin();
  await post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], ...over })));
  await sleep(1400);
  return epc;
}

const CASES = [];
const C = (o) => CASES.push(o);

// ---------------------------------------------------------------- A. identity & lot binding
C({ id: 'EC-A01', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'One SGTIN, two lots, two sequential commissioning events',
  steps: 'Commission SGTIN with LOT-A. Wait. Commission the SAME SGTIN with LOT-B.',
  rule: '§6.3 duplicate payloads blocked by hashing key immutable fields per event type',
  expect: 'Second event must not silently create a second lot binding. Either reject, or record a lot correction.',
  run: async () => {
    const epc = sgtin();
    await post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], ilmd: { 'cbvmda:lotNumber': 'LOT-A1', 'cbvmda:itemExpirationDate': '2028-12-31' } })));
    await sleep(1400);
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], ilmd: { 'cbvmda:lotNumber': 'LOT-B2', 'cbvmda:itemExpirationDate': '2029-06-30' } })));
  } });

C({ id: 'EC-A02', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'One SGTIN, two lots, both events in a single document',
  steps: 'One EPCIS document containing two commissioning events for the same SGTIN with different lots.',
  rule: '§3.1.1.1 Lot Integrity Rule - one lot per commissioning event',
  expect: 'Rejected, or partially accepted with the conflict reported.',
  run: () => {
    const epc = sgtin();
    return post(URL_M, TOK.MFG, wrap([
      ev({ epcList: [epc], ilmd: { 'cbvmda:lotNumber': 'LOT-B1', 'cbvmda:itemExpirationDate': '2028-12-31' } }),
      ev({ epcList: [epc], ilmd: { 'cbvmda:lotNumber': 'LOT-B2', 'cbvmda:itemExpirationDate': '2029-01-31' } }),
    ]));
  } });

C({ id: 'EC-A03', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'Exact re-submission of the same commissioning event (idempotency)',
  steps: 'Submit one commissioning event, then submit the byte-identical document again.',
  rule: '§6.3 Idempotency - duplicate payloads automatically rejected',
  expect: '409 DUPLICATE, first event unchanged.',
  run: async () => {
    const doc = wrap(ev());
    await post(URL_M, TOK.MFG, doc);
    await sleep(1400);
    return post(URL_M, TOK.MFG, doc);
  } });

C({ id: 'EC-A04', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'Two SGTINs sharing one lot in a single event (documented happy path)',
  steps: 'One commissioning event, epcList with two distinct SGTINs, one ILMD lot.',
  rule: '§3.1.1.1 single lot per event is the supported shape',
  expect: 'Accepted. Control case proving the rule permits multi-serial single-lot events.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: [sgtin(), sgtin()] }))) });

C({ id: 'EC-A05', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'Re-commission a serial that has already shipped',
  steps: 'Commission, ship, then submit a fresh commissioning event for the same SGTIN.',
  rule: '§6.3 Event Immutability; lifecycle state machine',
  expect: 'Rejected or flagged - a shipped serial cannot be re-born.',
  run: async () => {
    const epc = await commission();
    await post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: undefined })));
    await sleep(1400);
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc] })));
  } });

C({ id: 'EC-A06', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'Shipping event declares a different lot than commissioning',
  steps: 'Commission with LOT-A, then ship the same serial carrying ILMD LOT-Z.',
  rule: 'Guide is silent on ILMD on non-commissioning events',
  expect: 'Contradictory lot data should be flagged rather than silently stored.',
  run: async () => {
    const epc = await commission({ ilmd: { 'cbvmda:lotNumber': 'LOT-ORIG', 'cbvmda:itemExpirationDate': '2028-12-31' } });
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: { 'cbvmda:lotNumber': 'LOT-CONTRADICTS', 'cbvmda:itemExpirationDate': '2030-01-01' } })));
  } });

C({ id: 'EC-A07', cat: 'Identity & lot binding', role: 'Manufacturer',
  title: 'Same serial number under two different GTINs',
  steps: 'Commission serial 0000001 under item ref 000111, then under item ref 000222.',
  rule: 'GS1: serial is only unique within a GTIN',
  expect: 'Both accepted - they are genuinely different SGTINs. Confirms dedupe is not keyed on bare serial.',
  run: async () => {
    const s = d(7);
    await post(URL_M, TOK.MFG, wrap(ev({ epcList: [`urn:epc:id:sgtin:0614141.000111.${s}`] })));
    await sleep(1400);
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [`urn:epc:id:sgtin:0614141.000222.${s}`] })));
  } });

// ---------------------------------------------------------------- B. missing / empty fields
const bCase = (id, title, steps, expect, over, rule = '§3.1.1 commissioning mandatory fields') =>
  C({ id, cat: 'Missing & malformed fields', role: 'Manufacturer', title, steps, rule, expect,
    run: () => post(URL_M, TOK.MFG, wrap(ev(over))) });

bCase('EC-B01', 'Commissioning with no ILMD block at all', 'Commissioning event with the ilmd key omitted entirely.',
  'Rejected - guide makes lot and expiry mandatory at commissioning.', { ilmd: undefined });
bCase('EC-B02', 'Commissioning with an empty ILMD object', 'ilmd present but {}.',
  'Rejected - same mandatory-field rule.', { ilmd: {} });
bCase('EC-B03', 'Lot number present but empty string', 'ilmd.lotNumber = "".',
  'Rejected or flagged - an empty lot is not a lot.', { ilmd: { 'cbvmda:lotNumber': '', 'cbvmda:itemExpirationDate': '2028-12-31' } });
bCase('EC-B04', 'Lot number explicitly null', 'ilmd.lotNumber = null.',
  'Rejected or flagged; must behave the same as omitted.', { ilmd: { 'cbvmda:lotNumber': null, 'cbvmda:itemExpirationDate': '2028-12-31' } });
bCase('EC-B05', 'Expiry date missing, lot present', 'ilmd carries lotNumber only.',
  'Rejected - expiry is mandatory at commissioning.', { ilmd: { 'cbvmda:lotNumber': `LOT-${d(4)}` } });
bCase('EC-B06', 'countryOfOrigin absent', 'Commissioning with no cbvmda:countryOfOrigin.',
  'Accepted for a domestic MAH; must be rejected/flagged for a foreign MAH product.', {});
bCase('EC-B07', 'countryOfOrigin is not a valid ISO country code', 'cbvmda:countryOfOrigin = "ZZ9".',
  'Rejected or flagged - origin declaration is a regulatory field.',
  { ilmd: { 'cbvmda:lotNumber': `LOT-${d(4)}`, 'cbvmda:itemExpirationDate': '2028-12-31', 'cbvmda:countryOfOrigin': 'ZZ9' } });
bCase('EC-B08', 'bizLocation omitted', 'Event with no bizLocation.',
  'Rejected - guide calls bizLocation operationally mandatory on every event.', { bizLocation: undefined },
  '§3 "Every event must declare bizLocation"');
bCase('EC-B09', 'readPoint omitted', 'Event with no readPoint.',
  'Accepted - readPoint is optional per the guide.', { readPoint: undefined },
  '§3 readPoint optional by GS1 schema');
bCase('EC-B10', 'disposition omitted', 'Commissioning with no disposition.',
  'Accepted or flagged; disposition drives the lifecycle engine.', { disposition: undefined });
bCase('EC-B11', 'eventTimeZoneOffset omitted', 'Mandatory per §3.1.1 field list.',
  'Rejected - it is listed as mandatory.', { eventTimeZoneOffset: undefined });
bCase('EC-B12', 'Unknown extension field present', 'An unrecognised vendor field added to the event.',
  'Accepted and ignored - forward compatibility.', { 'acme:internalRef': 'XYZ-123' });
bCase('EC-B13', 'epcList present but empty', 'epcList = [].',
  'Rejected - an event with no subject is meaningless.', { epcList: [] });
bCase('EC-B14', 'epcList explicitly null', 'epcList = null.',
  'Rejected, same as empty.', { epcList: null });

// ---------------------------------------------------------------- C. time & ordering
C({ id: 'EC-C01', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'Out-of-order: shipping submitted before commissioning',
  steps: 'Submit a shipping event for a serial, then commission it afterwards.',
  rule: '§6.1.3 system accepts events in any order, temporal validation is async',
  expect: 'Both accepted; shipping flagged at the time, reconciled once commissioning arrives.',
  run: async () => {
    const epc = sgtin();
    await post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: undefined })));
    await sleep(1400);
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc] })));
  } });

C({ id: 'EC-C02', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'Two different events with an identical eventTime',
  steps: 'Commission two different serials with the exact same eventTime.',
  rule: 'Guide is silent',
  expect: 'Both accepted - identical timestamps are legitimate for a production run.',
  run: async () => {
    const t = iso();
    await post(URL_M, TOK.MFG, wrap(ev({ eventTime: t })));
    return post(URL_M, TOK.MFG, wrap(ev({ eventTime: t })));
  } });

C({ id: 'EC-C03', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'eventTimeZoneOffset contradicts the eventTime offset',
  steps: 'eventTime carries Z (UTC) while eventTimeZoneOffset says +03:00.',
  rule: 'Guide is silent on cross-field consistency',
  expect: 'Accepted - Z plus a declared local offset is valid EPCIS - but worth confirming.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ eventTime: iso(), eventTimeZoneOffset: '+03:00' }))) });

C({ id: 'EC-C04', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'Impossible timezone offset',
  steps: 'eventTimeZoneOffset = "+25:00".',
  rule: 'EPCIS schema: offset range -14:00..+14:00',
  expect: 'Rejected as a schema violation.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ eventTimeZoneOffset: '+25:00' }))) });

C({ id: 'EC-C05', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'Client supplies its own recordTime',
  steps: 'Event includes recordTime set one year in the past.',
  rule: 'EPCIS: recordTime is assigned by the repository, not the client',
  expect: 'Client value ignored or rejected; must not be trusted as the audit timestamp.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ recordTime: iso(-365 * 864e5) }))) });

C({ id: 'EC-C06', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'eventTime as an epoch integer rather than ISO-8601',
  steps: 'eventTime = 1789200000000.',
  rule: 'EPCIS requires ISO-8601',
  expect: 'Rejected as a schema violation.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ eventTime: 1789200000000 }))) });

C({ id: 'EC-C07', cat: 'Time & ordering', role: 'Manufacturer',
  title: 'eventTime exactly at the 5-minute future boundary',
  steps: 'eventTime = now + 5 minutes exactly.',
  rule: '§6.1.1 FUTURE_EVENT_TIME beyond 5 minutes',
  expect: 'Boundary must be deterministic and documented.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ eventTime: iso(300000) }))) });

// ---------------------------------------------------------------- D. document structure
C({ id: 'EC-D01', cat: 'Document structure', role: 'Manufacturer',
  title: 'Empty eventList array',
  steps: 'epcisBody.eventList = [].',
  rule: 'Guide is silent',
  expect: 'Rejected or accepted as a no-op, but never a server error.',
  run: () => post(URL_M, TOK.MFG, wrap([])) });

C({ id: 'EC-D02', cat: 'Document structure', role: 'Manufacturer',
  title: 'Mixed document: one valid event, one hard-reject event',
  steps: 'One document containing a valid commissioning event and a future-dated one.',
  rule: '§6.2 207 PARTIALLY_ACCEPTED - some events accepted, others rejected',
  expect: '207 with a per-event breakdown, or documented all-or-nothing 400.',
  run: () => post(URL_M, TOK.MFG, wrap([ev(), ev({ eventTime: iso(864e5) })])) });

C({ id: 'EC-D03', cat: 'Document structure', role: 'Manufacturer',
  title: 'Mixed document: one valid event, one warning-level event',
  steps: 'One valid commissioning event plus one 8-day-stale event.',
  rule: '§6.1.2 flag codes are advisory',
  expect: 'Both stored, warning attributed to the right event.',
  run: () => post(URL_M, TOK.MFG, wrap([ev(), ev({ eventTime: iso(-8 * 864e5) })])) });

C({ id: 'EC-D04', cat: 'Document structure', role: 'Manufacturer',
  title: '@context supplied as a string instead of an array',
  steps: '"@context": "https://ref.gs1.org/..." rather than an array.',
  rule: '§2.4 JSON-LD context requirements',
  expect: 'Accepted - both forms are valid JSON-LD.',
  run: () => post(URL_M, TOK.MFG, { '@context': 'https://ref.gs1.org/standards/epcis/epcis-context.jsonld', type: 'EPCISDocument', schemaVersion: '2.0', creationDate: iso(), epcisBody: { eventList: [ev()] } }) });

C({ id: 'EC-D05', cat: 'Document structure', role: 'Manufacturer',
  title: 'Unsupported Content-Type',
  steps: 'Valid JSON-LD body sent as Content-Type: text/plain.',
  rule: '§6.2 415 UNSUPPORTED_FORMAT',
  expect: '415.',
  run: () => post(URL_M, TOK.MFG, wrap(ev()), 'text/plain') });

C({ id: 'EC-D06', cat: 'Document structure', role: 'Manufacturer',
  title: 'CBV tokens in URN long form inside JSON-LD',
  steps: 'bizStep = urn:epcglobal:cbv:bizstep:commissioning in a 2.0 JSON-LD document.',
  rule: '§2.4 JSON-LD must use plain CBV tokens; URN form "Not allowed"',
  expect: 'Rejected or flagged per the guide.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ bizStep: 'urn:epcglobal:cbv:bizstep:commissioning' }))) });

C({ id: 'EC-D07', cat: 'Document structure', role: 'Manufacturer',
  title: 'EPC URN in uppercase',
  steps: 'epcList entry written as URN:EPC:ID:SGTIN:...',
  rule: 'RFC 8141: URN scheme is case-insensitive, namespace-specific string is not',
  expect: 'Deterministic handling - must not create a second identity for the same serial.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: [`URN:EPC:ID:SGTIN:0614141.000111.${d(7)}`] }))) });

C({ id: 'EC-D08', cat: 'Document structure', role: 'Manufacturer',
  title: 'EPC padded with leading and trailing whitespace',
  steps: 'epcList entry surrounded by spaces.',
  rule: 'Guide is silent',
  expect: 'Trimmed and accepted, or rejected - never stored with the padding.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: [`  ${sgtin()}  `] }))) });

C({ id: 'EC-D09', cat: 'Document structure', role: 'Manufacturer',
  title: 'Lot number carrying unicode and emoji',
  steps: 'ilmd.lotNumber = "LOT-éçñ-💊".',
  rule: 'Guide is silent',
  expect: 'Accepted and round-tripped intact, or rejected with a charset rule.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ ilmd: { 'cbvmda:lotNumber': 'LOT-éçñ-💊', 'cbvmda:itemExpirationDate': '2028-12-31' } }))) });

C({ id: 'EC-D10', cat: 'Document structure', role: 'Manufacturer',
  title: 'Extremely long lot number (1000 characters)',
  steps: 'ilmd.lotNumber = 1000 characters.',
  rule: 'GS1 AI 10 permits at most 20 characters',
  expect: 'Rejected - lot exceeds the GS1 maximum.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ ilmd: { 'cbvmda:lotNumber': 'L'.repeat(1000), 'cbvmda:itemExpirationDate': '2028-12-31' } }))) });

C({ id: 'EC-D11', cat: 'Document structure', role: 'Manufacturer',
  title: 'Duplicate JSON keys in one event object',
  steps: 'Raw JSON with bizStep declared twice (commissioning, then shipping).',
  rule: 'Guide is silent; JSON parsers normally keep the last value',
  expect: 'Deterministic and safe - ideally rejected as ambiguous.',
  run: () => {
    const raw = JSON.stringify(wrap(ev())).replace('"bizStep":"commissioning"', '"bizStep":"commissioning","bizStep":"shipping"');
    return post(URL_M, TOK.MFG, raw);
  } });

// ---------------------------------------------------------------- E. quantity / class level
C({ id: 'EC-E01', cat: 'Quantity & class level', role: 'Manufacturer',
  title: 'quantityList with an LGTIN and no epcList',
  steps: 'Class-level commissioning using quantityList only.',
  rule: '§2.2 accepted identifiers',
  expect: 'Accepted if class-level is supported, else a clear rejection.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: undefined, quantityList: [{ epcClass: 'urn:epc:class:lgtin:0614141.000111.LOT-A', quantity: 100, uom: 'EA' }] }))) });

C({ id: 'EC-E02', cat: 'Quantity & class level', role: 'Manufacturer',
  title: 'Quantity of zero',
  steps: 'quantityList entry with quantity 0.',
  rule: 'Guide is silent',
  expect: 'Rejected - a zero-quantity movement is meaningless.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: undefined, quantityList: [{ epcClass: 'urn:epc:class:lgtin:0614141.000111.LOT-A', quantity: 0, uom: 'EA' }] }))) });

C({ id: 'EC-E03', cat: 'Quantity & class level', role: 'Manufacturer',
  title: 'Negative quantity',
  steps: 'quantityList entry with quantity -50.',
  rule: 'Guide is silent',
  expect: 'Rejected - negative stock cannot be commissioned.',
  run: () => post(URL_M, TOK.MFG, wrap(ev({ epcList: undefined, quantityList: [{ epcClass: 'urn:epc:class:lgtin:0614141.000111.LOT-A', quantity: -50, uom: 'EA' }] }))) });

C({ id: 'EC-E04', cat: 'Quantity & class level', role: 'Facility',
  title: 'Dispensing at class level with quantityList',
  steps: 'Dispense using quantityList rather than individual SGTINs.',
  rule: '§3.3.3 dispensing must be at unit level',
  expect: 'Rejected - dispensing requires SGTINs.',
  run: () => post(URL_D, TOK.FAC, wrap(ev({ action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined, epcList: undefined, quantityList: [{ epcClass: 'urn:epc:class:lgtin:0614141.000111.LOT-A', quantity: 5, uom: 'EA' }] }))) });

// ---------------------------------------------------------------- F. aggregation
const agg = (o) => ev({ type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress', ilmd: undefined, epcList: undefined, ...o });

C({ id: 'EC-F01', cat: 'Aggregation', role: 'Manufacturer',
  title: 'Container aggregated into itself',
  steps: 'AggregationEvent where parentID also appears in childEPCs.',
  rule: 'Guide is silent; logically impossible',
  expect: 'Rejected - a container cannot contain itself.',
  run: () => { const p = sscc(); return post(URL_M, TOK.MFG, wrap(agg({ parentID: p, childEPCs: [p] }))); } });

C({ id: 'EC-F02', cat: 'Aggregation', role: 'Manufacturer',
  title: 'ADD aggregation with an empty childEPCs array',
  steps: 'childEPCs = [].',
  rule: 'Guide is silent',
  expect: 'Rejected - nothing is being aggregated.',
  run: () => post(URL_M, TOK.MFG, wrap(agg({ parentID: sscc(), childEPCs: [] }))) });

C({ id: 'EC-F03', cat: 'Aggregation', role: 'Manufacturer',
  title: 'One child aggregated under two parents in the same document',
  steps: 'Two ADD events in one document placing the same SGTIN under different SSCCs.',
  rule: 'Physical impossibility - an item is in one container',
  expect: 'Rejected or flagged as a conflict.',
  run: async () => {
    const epc = await commission();
    return post(URL_M, TOK.MFG, wrap([
      agg({ parentID: sscc(), childEPCs: [epc] }),
      agg({ parentID: sscc(), childEPCs: [epc] }),
    ]));
  } });

C({ id: 'EC-F04', cat: 'Aggregation', role: 'Manufacturer',
  title: 'Hierarchy deeper than the documented maximum of 3',
  steps: 'Build item -> case -> pallet -> container, a 4-level hierarchy.',
  rule: '§3 Max level of hierarchy = 3',
  expect: 'Fourth level rejected or flagged.',
  run: async () => {
    const item = await commission();
    const cas = sscc(); const pallet = sscc(); const container = sscc();
    await post(URL_M, TOK.MFG, wrap(agg({ parentID: cas, childEPCs: [item] })));
    await sleep(1200);
    await post(URL_M, TOK.MFG, wrap(agg({ parentID: pallet, childEPCs: [cas] })));
    await sleep(1200);
    return post(URL_M, TOK.MFG, wrap(agg({ parentID: container, childEPCs: [pallet] })));
  } });

C({ id: 'EC-F05', cat: 'Aggregation', role: 'Manufacturer',
  title: 'Same child listed twice in childEPCs',
  steps: 'childEPCs contains the identical SGTIN twice.',
  rule: '§6.1.1 DUPLICATE_EPC_IN_EVENT applies to childEPCs as well as epcList',
  expect: 'Rejected, as for epcList.',
  run: () => { const c = sgtin(); return post(URL_M, TOK.MFG, wrap(agg({ parentID: sscc(), childEPCs: [c, c] }))); } });

C({ id: 'EC-F06', cat: 'Aggregation', role: 'Distributor',
  title: 'Unpack a child that was never aggregated',
  steps: 'DELETE aggregation naming a child with no prior ADD.',
  rule: '§3.2.2 Unpack',
  expect: 'Flagged - no prior pack event.',
  run: () => post(URL_S, TOK.SUP, wrap(agg({ action: 'DELETE', bizStep: 'unpacking', parentID: sscc(), childEPCs: [sgtin()] }))) });

C({ id: 'EC-F07', cat: 'Aggregation', role: 'Manufacturer',
  title: 'Aggregate a serial that is already dispensed',
  steps: 'Commission, dispense, then pack the dispensed serial into a case.',
  rule: 'Lifecycle: dispensed is terminal',
  expect: 'Rejected or flagged - terminal serials cannot be re-packed.',
  run: async () => {
    const epc = await commission();
    await post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined })));
    await sleep(1400);
    return post(URL_M, TOK.MFG, wrap(agg({ parentID: sscc(), childEPCs: [epc] })));
  } });

// ---------------------------------------------------------------- G. roles & authorization
const roleMatrix = [
  ['EC-G01', 'MFG', 'manufacturer', URL_M, true], ['EC-G02', 'MFG', 'supplier', URL_S, false], ['EC-G03', 'MFG', 'facility', URL_F, false],
  ['EC-G04', 'SUP', 'manufacturer', URL_M, false], ['EC-G05', 'SUP', 'supplier', URL_S, true], ['EC-G06', 'SUP', 'facility', URL_F, false],
  ['EC-G07', 'FAC', 'manufacturer', URL_M, false], ['EC-G08', 'FAC', 'supplier', URL_S, false], ['EC-G09', 'FAC', 'facility', URL_F, true],
];
for (const [id, role, ep, url, own] of roleMatrix) {
  C({ id, cat: 'Roles & authorization', role,
    title: `${role} key against the ${ep} endpoint`,
    steps: `POST a commissioning event to /api/integration/${ep}/events using the ${role} API key.`,
    rule: '§2.5.1 Authentication / role scoping',
    expect: own ? 'Accepted - the key owns this endpoint.' : '403 FORBIDDEN - authenticated but not authorised.',
    run: () => post(url, TOK[role], wrap(ev())) });
}

C({ id: 'EC-G10', cat: 'Roles & authorization', role: 'Manufacturer',
  title: 'Manufacturer key against the dispense endpoint',
  steps: 'POST a dispensing event to /facility/events/dispense with the manufacturer key.',
  rule: '§3.3.3 dispensing is a facility operation',
  expect: '403 FORBIDDEN.',
  run: () => post(URL_D, TOK.MFG, wrap(ev({ action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined }))) });

C({ id: 'EC-G11', cat: 'Roles & authorization', role: 'None',
  title: 'No API key supplied',
  steps: 'POST with the X-API-Key header omitted.',
  rule: '§6.2 401 UNAUTHORIZED',
  expect: '401.',
  run: () => post(URL_M, null, wrap(ev())) });

C({ id: 'EC-G12', cat: 'Roles & authorization', role: 'None',
  title: 'Malformed API key',
  steps: 'X-API-Key set to a junk string.',
  rule: '§6.2 401 UNAUTHORIZED',
  expect: '401, with no detail leaked about why.',
  run: () => post(URL_M, 'not-a-real-key-000', wrap(ev())) });

C({ id: 'EC-G13', cat: 'Roles & authorization', role: 'Facility',
  title: 'Facility submits a commissioning event',
  steps: 'Facility key posts commissioning to its own endpoint.',
  rule: '§3.1 commissioning is a manufacturer event',
  expect: 'Flagged - a facility does not commission product.',
  run: () => post(URL_F, TOK.FAC, wrap(ev())) });

C({ id: 'EC-G14', cat: 'Roles & authorization', role: 'Distributor',
  title: 'Distributor submits a commissioning event',
  steps: 'Supplier key posts commissioning to its own endpoint.',
  rule: '§3.2 distributor events are receive/pack/unpack/ship',
  expect: 'Flagged - a distributor does not commission product.',
  run: () => post(URL_S, TOK.SUP, wrap(ev())) });

// ---------------------------------------------------------------- H. lifecycle & state
C({ id: 'EC-H01', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Dispense a serial that was never commissioned',
  steps: 'Dispense a fresh, unknown SGTIN.',
  rule: '§3.3.3 dispensing is synchronous and validated',
  expect: 'Rejected at the sync endpoint - dispensing unknown stock is a safety issue.',
  run: () => post(URL_D, TOK.FAC, wrap(ev({ action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined }))) });

C({ id: 'EC-H02', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Dispense a serial that has already been destroyed',
  steps: 'Commission, destroy, then dispense.',
  rule: 'Lifecycle: destroyed is terminal',
  expect: 'Rejected - destroyed stock must never reach a patient.',
  run: async () => {
    const epc = await commission();
    await post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed', ilmd: undefined })));
    await sleep(1400);
    return post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined })));
  } });

C({ id: 'EC-H03', cat: 'Lifecycle & state', role: 'Manufacturer',
  title: 'Ship the same serial twice from the same location',
  steps: 'Commission, ship, ship again.',
  rule: 'Lifecycle: cannot ship what has already left',
  expect: 'Second shipping flagged.',
  run: async () => {
    const epc = await commission();
    const ship = () => post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: undefined })));
    await ship(); await sleep(1400); return ship();
  } });

C({ id: 'EC-H04', cat: 'Lifecycle & state', role: 'Distributor',
  title: 'Receive the same serial twice',
  steps: 'Commission, ship, receive, receive again.',
  rule: 'Lifecycle: duplicate receipt',
  expect: 'Second receipt flagged.',
  run: async () => {
    const epc = await commission();
    await post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: undefined })));
    await sleep(1200);
    const recv = () => post(URL_S, TOK.SUP, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'receiving', disposition: 'in_progress', ilmd: undefined })));
    await recv(); await sleep(1400); return recv();
  } });

C({ id: 'EC-H05', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Return a serial after it has been dispensed',
  steps: 'Commission, dispense, then submit a return shipping event.',
  rule: '§4.2 Return Events; dispensed is terminal',
  expect: 'Flagged - dispensed product cannot re-enter the supply chain.',
  run: async () => {
    const epc = await commission();
    await post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined })));
    await sleep(1400);
    return post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'returned', ilmd: undefined })));
  } });

C({ id: 'EC-H06', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Dispense the same serial to two different patients',
  steps: 'Commission, dispense, then dispense again with a new eventID.',
  rule: '§6.1.2 SERIAL_ALREADY_DISPENSED',
  expect: 'Second dispense rejected or flagged - this is the core anti-counterfeit check.',
  run: async () => {
    const epc = await commission();
    await post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined })));
    await sleep(1600);
    return post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined, bizLocation: { id: SGLN_B }, readPoint: { id: SGLN_B } })));
  } });

C({ id: 'EC-H07', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Destroy a serial twice',
  steps: 'Commission, destroy, destroy again.',
  rule: 'Lifecycle: destroyed is terminal',
  expect: 'Second destruction flagged.',
  run: async () => {
    const epc = await commission();
    const destroy = () => post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed', ilmd: undefined })));
    await destroy(); await sleep(1400); return destroy();
  } });

C({ id: 'EC-H08', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Mark a dispensed serial as damaged',
  steps: 'Commission, dispense, then submit a damaged product-status event.',
  rule: '§4.4.1 Damaged',
  expect: 'Flagged - status changes after dispensing need a defined policy.',
  run: async () => {
    const epc = await commission();
    await post(URL_D, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined })));
    await sleep(1400);
    return post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'holding', disposition: 'damaged', ilmd: undefined })));
  } });

C({ id: 'EC-H09', cat: 'Lifecycle & state', role: 'Facility',
  title: 'Report a serial stolen after it was destroyed',
  steps: 'Commission, destroy, then report stolen.',
  rule: '§4.4.2 Stolen',
  expect: 'Flagged - contradictory terminal states.',
  run: async () => {
    const epc = await commission();
    await post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed', ilmd: undefined })));
    await sleep(1400);
    return post(URL_F, TOK.FAC, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'holding', disposition: 'stolen', ilmd: undefined })));
  } });

C({ id: 'EC-H10', cat: 'Lifecycle & state', role: 'Manufacturer',
  title: 'Ship a serial from a location it was never received at',
  steps: 'Commission at location A, then ship from location B.',
  rule: '§6.1.2 INVENTORY_SIGHTING_MISMATCH',
  expect: 'Flagged - the serial was never at location B.',
  run: async () => {
    const epc = await commission();
    return post(URL_M, TOK.MFG, wrap(ev({ epcList: [epc], action: 'OBSERVE', bizStep: 'shipping', disposition: 'in_transit', ilmd: undefined, readPoint: { id: SGLN_B }, bizLocation: { id: SGLN_B } })));
  } });

// ---------------------------------------------------------------- execute
const only = process.argv.slice(2).filter((a) => a.startsWith('EC-'));
const out = [];
console.log(`running ${only.length || CASES.length} edge cases against ${BASE}\n`);

for (const c of CASES) {
  if (only.length && !only.includes(c.id)) continue;
  const t0 = Date.now();
  let r;
  try { r = await c.run(); }
  catch (err) { r = { status: 'ERR', codes: [], message: err.message, text: String(err.message) }; }
  const rec = {
    id: c.id, cat: c.cat, role: c.role, title: c.title, steps: c.steps, rule: c.rule, expect: c.expect,
    status: r.status, codes: r.codes, message: r.message, processed: r.processed,
    body: r.text, ms: Date.now() - t0,
  };
  out.push(rec);
  console.log(`${c.id} ${String(r.status).padEnd(4)} [${r.codes.join(',') || '-'}] ${c.title.slice(0, 62)}`);
}

// --out=<file> keeps a regression run from overwriting the baseline it is compared against.
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outFile = outArg
  ? path.resolve(outArg.slice('--out='.length))
  : path.join(import.meta.dirname, '..', 'reports', 'edge-cases.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\n${out.length} cases -> ${path.relative(process.cwd(), outFile)}`);
