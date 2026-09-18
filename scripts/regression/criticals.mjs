// Targeted re-proof of the known Critical/High L5 findings, each stated against the guide
// rule it tests and the last time it was observed.
//
// Scope note: the manufacturer key is revoked (Gate 0), so async probes run on the SUPPLIER
// route with the distributor key, and dispense/destroy probes on the facility routes. The
// supplier route accepts commissioning events (EC-G14), so it carries the same validation
// probes the manufacturer route did - but a result here is "supplier route", not a
// like-for-like re-run of the 7 Sep manufacturer-route audit, and is labelled that way.
//
// Run: node --env-file=.env scripts/regression/criticals.mjs --out=<file>
//      SGTIN_PREFIX=urn:epc:id:sgtin:8904179.170218 ... (registered-product pass)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.API_BASE_URL;
const SUP = process.env.DISTRIBUTOR_API_TOKEN;
const FAC = process.env.FACILITY_API_TOKEN;
const URL_S = `${BASE}/api/integration/supplier/events`;
const URL_F = `${BASE}/api/integration/facility/events`;
const URL_D = `${BASE}/api/integration/facility/events/dispense`;

const PREFIX = process.env.SGTIN_PREFIX || 'urn:epc:id:sgtin:0614141.000111';
const SGLN = 'urn:epc:id:sgln:0614141.00001.0';

const d = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;
const sgtin = () => `${PREFIX}.${d(7)}`;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wrap = (...events) => ({
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument', schemaVersion: '2.0', creationDate: iso(),
  epcisBody: { eventList: events },
});

function commission(over = {}) {
  const e = {
    type: 'ObjectEvent', eventID: uuid(), eventTime: iso(-60_000), eventTimeZoneOffset: '+03:00',
    epcList: [sgtin()], action: 'ADD', bizStep: 'commissioning', disposition: 'active',
    readPoint: { id: SGLN }, bizLocation: { id: SGLN },
    ilmd: { 'cbvmda:lotNumber': `LOT-${d(4)}`, 'cbvmda:itemExpirationDate': '2028-12-31' },
    ...over,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}
const dispense = (epc, over = {}) => commission({
  epcList: [epc], action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed', ilmd: undefined, ...over,
});
const destroy = (epc) => commission({
  epcList: [epc], action: 'DELETE', bizStep: 'destroying', disposition: 'destroyed', ilmd: undefined,
});

async function post(url, key, body, raw = false) {
  const headers = { 'Content-Type': 'application/ld+json' };
  if (key !== null) headers['X-API-Key'] = key;
  const res = await fetch(url, { method: 'POST', headers, body: raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let codes = [];
  let message = '';
  try {
    const j = JSON.parse(text);
    if (j.code) codes.push(j.code);
    for (const k of ['errors', 'warnings']) for (const e of j[k] || []) if (e.code) codes.push(e.code);
    message = j.message || '';
    return { status: res.status, codes: [...new Set(codes)], message, processed: j.events_processed };
  } catch {
    return { status: res.status, codes, message: text.slice(0, 120) };
  }
}

const PROBES = [];
const P = (o) => PROBES.push(o);

// ---- controls: behaviour that conformed last time and must still conform -----------------
P({ id: 'P01', title: 'Valid async event returns 202', rule: '§6.2 ACCEPTED 202',
  then: '202 (14 Sep, EC-G05)', pass: (r) => r.status === 202,
  run: () => post(URL_S, SUP, wrap(commission())) });

P({ id: 'P02', title: 'Valid dispense returns 201 synchronously', rule: '§2.6.1 / §3.3.3',
  then: '201 (14 Sep, EC-E04)', pass: (r) => r.status === 201,
  run: () => post(URL_D, FAC, wrap(dispense(sgtin()))) });

P({ id: 'P11', title: 'Future eventTime is rejected', rule: '§6.1.1 FUTURE_EVENT_TIME',
  then: '400 FUTURE_EVENT_TIME (7 Sep)', pass: (r) => r.status === 400,
  run: () => post(URL_S, SUP, wrap(commission({ eventTime: iso(86_400_000) }))) });

P({ id: 'P12', title: 'SSCC with 16 digits is rejected', rule: '§6.1.1 INVALID_GS1_IDENTIFIER',
  then: '400 INVALID_GS1_IDENTIFIER (7 Sep)', pass: (r) => r.status === 400,
  run: () => post(URL_S, SUP, wrap({
    type: 'AggregationEvent', eventID: uuid(), eventTime: iso(-60_000), eventTimeZoneOffset: '+03:00',
    parentID: 'urn:epc:id:sscc:0614141.000000001', childEPCs: [sgtin()], action: 'ADD',
    bizStep: 'packing', disposition: 'in_progress', readPoint: { id: SGLN }, bizLocation: { id: SGLN },
  })) });

P({ id: 'P13', title: 'Resubmitting the same eventID is rejected', rule: '§6.1.1 DUPLICATE_EVENT_ID',
  then: '409 DUPLICATE_EVENT_ID (7 Sep)', pass: (r) => r.status === 409,
  run: async () => {
    const doc = wrap(commission());
    await post(URL_S, SUP, doc); await sleep(1500);
    return post(URL_S, SUP, doc);
  } });

P({ id: 'P15', title: 'Whitespace-padded serial resolves to the same identity', rule: 'Identity normalisation',
  then: '409 on resubmit (14 Sep, EC-D08)', pass: (r) => r.status === 409,
  run: async () => {
    const epc = sgtin();
    await post(URL_S, SUP, wrap(commission({ epcList: [epc] }))); await sleep(2000);
    return post(URL_S, SUP, wrap(commission({ epcList: [`  ${epc}  `] })));
  } });

P({ id: 'P18', title: 'Commissioning with lot + expiry together is accepted', rule: '§3.1.1 ILMD',
  then: '500 on manufacturer route (7 Sep); 202 by 14 Sep', pass: (r) => r.status === 202,
  run: () => post(URL_S, SUP, wrap(commission())) });

P({ id: 'P04', title: 'Dispense with no API key is refused', rule: '§2.5.1 / §6.2 UNAUTHORIZED 401',
  then: '401 (14 Sep, EC-G11)', pass: (r) => r.status === 401,
  run: () => post(URL_D, null, wrap(dispense(sgtin()))) });

// ---- known deviations: did any of them move? ----------------------------------------------
P({ id: 'P03', title: 'Dispense with an invalid API key is refused', rule: '§2.5.1 / §6.2 UNAUTHORIZED 401',
  then: '201 CREATED - event accepted with a bad key (7 Sep audit)', pass: (r) => r.status === 401,
  run: () => post(URL_D, 'not-a-real-key', wrap(dispense(sgtin()))) });

P({ id: 'P19', title: 'Invalid API key on an async route is refused', rule: '§6.2 UNAUTHORIZED 401',
  then: '500 (7 Sep); 401 by 14 Sep (EC-G12)', pass: (r) => r.status === 401,
  run: () => post(URL_S, 'not-a-real-key', wrap(commission())) });

P({ id: 'P05', title: 'Dispensing a destroyed serial is refused or flagged', rule: '§3.3.3 prior disposition must be active',
  then: '201, no flag (14 Sep Critical)', pass: (r) => r.status >= 400 || r.codes.some((c) => /DISPOSITION|DESTROYED/.test(c)),
  run: async () => {
    const epc = sgtin();
    await post(URL_F, FAC, wrap(destroy(epc))); await sleep(3000);
    return post(URL_D, FAC, wrap(dispense(epc)));
  } });

P({ id: 'P06', title: 'Dispensing the same serial twice is refused or flagged', rule: '§6.1.2 SERIAL_ALREADY_DISPENSED',
  then: 'see 14 Sep error-code TC-S1-032', pass: (r) => r.status >= 400 || r.codes.includes('SERIAL_ALREADY_DISPENSED'),
  run: async () => {
    const epc = sgtin();
    await post(URL_D, FAC, wrap(dispense(epc))); await sleep(3000);
    return post(URL_D, FAC, wrap(dispense(epc)));
  } });

P({ id: 'P07', title: 'Batch with one bad event is partially accepted (207)', rule: '§6.2 PARTIALLY_ACCEPTED 207',
  then: '400, nothing stored (14 & 16 Sep)', pass: (r) => r.status === 207,
  run: () => post(URL_S, SUP, wrap(commission(), commission({ eventTime: iso(86_400_000) }))) });

P({ id: 'P08', title: 'Malformed SGTIN is rejected', rule: '§6.1.1 INVALID_GS1_IDENTIFIER',
  then: '202 accepted on manufacturer route (7 Sep)', pass: (r) => r.status === 400,
  // Same malformed shape as the collection's own serial (whole GTIN as prefix, alphanumeric
  // item ref, no serial segment), but unique: the original has been stored before, so it
  // trips the duplicate check before identifier validation ever sees it.
  run: () => post(URL_S, SUP, wrap(commission({ epcList: [`urn:epc:id:sgtin:6161102974997.CW${d(6)}`] }))) });

P({ id: 'P09', title: 'Malformed SGLN is rejected', rule: '§6.1.1 INVALID_GS1_IDENTIFIER',
  then: '202 accepted on manufacturer route (7 Sep)', pass: (r) => r.status === 400,
  run: () => post(URL_S, SUP, wrap(commission({ bizLocation: { id: 'urn:epc:id:sgln:8888888.888888' } }))) });

P({ id: 'P10', title: 'Event with no eventTime is rejected', rule: '§6.1.1 MISSING_NEEDED_FIELDS',
  then: '202 accepted on manufacturer route (7 Sep)', pass: (r) => r.status === 400,
  run: () => post(URL_S, SUP, wrap(commission({ eventTime: undefined }))) });

P({ id: 'P14', title: 'Uppercase URN does not create a second identity', rule: 'Identity normalisation (RFC 8141)',
  then: '202 - second identity created (14 Sep, EC-D07 High)', pass: (r) => r.status === 409,
  run: async () => {
    const epc = sgtin();
    await post(URL_S, SUP, wrap(commission({ epcList: [epc] }))); await sleep(2000);
    return post(URL_S, SUP, wrap(commission({ epcList: [epc.toUpperCase()] })));
  } });

// ---- limits (guide §6.1.1), on the supplier route ----------------------------------------
P({ id: 'P16', title: 'Over 50,000 serials in one message is rejected', rule: '§6.1.1 TOO_MANY_SERIALS',
  then: 'API-MFG-COMM-EDGE-008 - never executed', pass: (r) => r.status === 400 || r.status === 413,
  run: () => {
    const list = Array.from({ length: 50_001 }, (_, i) => `${PREFIX}.${String(i).padStart(9, '0')}${d(2)}`);
    return post(URL_S, SUP, wrap(commission({ epcList: list })));
  } });

P({ id: 'P17', title: 'Async message over 10 MB is rejected', rule: '§6.1.1 MESSAGE_SIZE_EXCEEDED / §6.2 413',
  then: 'API-MFG-COMM-EDGE-009 - never executed', pass: (r) => r.status === 413 || r.status === 400,
  run: () => post(URL_S, SUP, wrap(commission({
    ilmd: { 'cbvmda:lotNumber': `LOT-${'X'.repeat(10 * 1024 * 1024 + 512 * 1024)}` },
  }))) });

// ---- run ----------------------------------------------------------------------------------
const only = process.argv.slice(2).filter((a) => /^P\d+$/.test(a));
const out = [];
console.log(`criticals against ${BASE}  prefix=${PREFIX}\n`);
for (const probe of PROBES) {
  if (only.length && !only.includes(probe.id)) continue;
  const t0 = Date.now();
  let r;
  try { r = await probe.run(); } catch (err) { r = { status: 'ERR', codes: [], message: err.message }; }
  // A gateway error says nothing about the rule under test - the request never reached the
  // application, or the application was down. Record it as inconclusive, never as a result.
  const gateway = r.status === 'ERR' || [502, 503, 504].includes(r.status);
  const conforms = gateway ? null : probe.pass(r);
  out.push({ id: probe.id, title: probe.title, rule: probe.rule, then: probe.then,
    status: r.status, codes: r.codes, message: r.message, conforms, ms: Date.now() - t0, prefix: PREFIX });
  console.log(`${probe.id} ${conforms === null ? 'INCONCL. ' : conforms ? 'CONFORMS ' : 'DEVIATES '} ${String(r.status).padEnd(4)} [${r.codes.join(',') || '-'}] ${probe.title}`);
}

const outArg = process.argv.find((a) => a.startsWith('--out='));
if (outArg) {
  const file = path.resolve(outArg.slice(6));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n-> ${path.relative(process.cwd(), file)}`);
}
