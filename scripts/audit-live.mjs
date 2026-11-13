// Live conformance audit: does the platform actually behave the way the Taifacare
// Technical Onboarding Guide v0.2 says it does?
//
// Each check states the guide's rule, fires one request, and compares the real response to
// the documented expectation. Every payload is minted fresh so nothing trips the duplicate
// matrix key. Read-only in the sense that it never mutates the repo, but it DOES submit
// events to the sandbox - that is the point.
//
// Run: node scripts/audit-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.join(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const BASE = env.API_BASE_URL || 'https://tnt-demo.apeiro-digital.com';
const MFG = env.MANUFACTURER_API_TOKEN;
const FAC = env.FACILITY_API_TOKEN;

const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const uuid = () => `urn:uuid:${crypto.randomUUID()}`;
const sgtin = () => `urn:epc:id:sgtin:0614141.000111.${digits(7)}`;

function commission(overrides = {}, ilmd = {}) {
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: {
      eventList: [{
        type: 'ObjectEvent',
        eventID: uuid(),
        eventTime: new Date().toISOString(),
        eventTimeZoneOffset: '+03:00',
        epcList: [sgtin()],
        action: 'ADD',
        bizStep: 'commissioning',
        disposition: 'active',
        readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' },
        bizLocation: { id: 'urn:epc:id:sgln:0614141.00001.0' },
        ilmd: { 'cbvmda:lotNumber': `BATCH-AUDIT-${digits(4)}`, ...ilmd },
        ...overrides,
      }],
    },
  };
}

async function post(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json', ...(token ? { 'X-API-Key': token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let code = '';
  try {
    const parsed = JSON.parse(text);
    code = parsed.code || parsed.category || parsed.error || (parsed.success ? 'accepted' : '');
  } catch { /* non-JSON body */ }
  return { status: res.status, code, text };
}

const results = [];
async function check(rule, expectation, run) {
  try {
    const { status, code, verdict } = await run();
    results.push({ rule, expectation, actual: `${status}${code ? ' ' + code : ''}`, pass: verdict });
  } catch (err) {
    results.push({ rule, expectation, actual: `threw: ${err.message}`, pass: false });
  }
}

const EVENTS = `${BASE}/api/integration/manufacturer/events`;
const DISPENSE = `${BASE}/api/integration/facility/events/dispense`;

// --- §6.2 status codes --------------------------------------------------------------------
await check('§6.2 async submission returns 202 ACCEPTED', '202', async () => {
  const r = await post(EVENTS, MFG, commission());
  return { ...r, verdict: r.status === 202 };
});

await check('§2.6.1 dispensing is synchronous and returns 201', '201', async () => {
  const doc = commission({
    action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed',
    bizLocation: { id: 'urn:epc:id:sgln:0614141.00001.0' },
  });
  delete doc.epcisBody.eventList[0].ilmd;
  const r = await post(DISPENSE, FAC, doc);
  return { ...r, verdict: r.status === 201 };
});

// --- §6.1.1 hard rejects (documented as HTTP 400, event not stored) ------------------------
await check('§6.1.1 FUTURE_EVENT_TIME', '400 (>5 min ahead)', async () => {
  const r = await post(EVENTS, MFG, commission({ eventTime: new Date(Date.now() + 864e5).toISOString() }));
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 INVALID_EXPIRY_FORMAT', '400 (not YYYY-MM-DD)', async () => {
  const r = await post(EVENTS, MFG, commission({}, { 'cbvmda:itemExpirationDate': '15/07/2027' }));
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 INVALID_GS1_IDENTIFIER (SSCC 16 digits)', '400', async () => {
  const r = await post(EVENTS, MFG, commission({
    type: 'AggregationEvent', action: 'ADD', bizStep: 'packing', disposition: 'in_progress',
    parentID: 'urn:epc:id:sscc:0614141.000000001', childEPCs: [sgtin()], epcList: undefined,
  }));
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 INVALID_GS1_IDENTIFIER (malformed SGTIN)', '400', async () => {
  const r = await post(EVENTS, MFG, commission({ epcList: ['urn:epc:id:sgtin:6161102974997.CW2278'] }));
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 INVALID_GS1_IDENTIFIER (malformed SGLN)', '400', async () => {
  const r = await post(EVENTS, MFG, commission({ bizLocation: { id: 'urn:epc:id:sgln:8888888.888888' } }));
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 MISSING_NEEDED_FIELDS', '400 (no eventTime)', async () => {
  const doc = commission();
  delete doc.epcisBody.eventList[0].eventTime;
  const r = await post(EVENTS, MFG, doc);
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 INVALID_JSON_STRUCTURE', '400', async () => {
  const r = await post(EVENTS, MFG, '{}');
  return { ...r, verdict: r.status === 400 };
});

await check('§6.1.1 DUPLICATE_EVENT_ID', '409 on resubmit', async () => {
  const doc = commission();
  await post(EVENTS, MFG, doc);
  const r = await post(EVENTS, MFG, doc);
  return { ...r, verdict: r.status === 409 };
});

// --- §3.3.3 dispensing rules --------------------------------------------------------------
await check('§3.3.3 dispensing rejects an SSCC in epcList', 'rejected or flagged', async () => {
  const doc = commission({
    action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed',
    epcList: [`urn:epc:id:sscc:0614141.${digits(10)}`],
  });
  delete doc.epcisBody.eventList[0].ilmd;
  const r = await post(DISPENSE, FAC, doc);
  const flagged = r.status >= 400 || /SSCC|INVALID/i.test(r.text);
  return { ...r, verdict: flagged };
});

// --- §2.5.1 authentication ----------------------------------------------------------------
await check('§2.5.1 missing API key', '401', async () => {
  const r = await post(EVENTS, null, commission());
  return { ...r, verdict: r.status === 401 };
});

await check('§2.5.1 invalid API key', '401', async () => {
  const r = await post(EVENTS, 'not-a-real-key', commission());
  return { ...r, verdict: r.status === 401 };
});

await check('§2.5.1 invalid API key on dispense', '401', async () => {
  const doc = commission({
    action: 'OBSERVE', bizStep: 'dispensing', disposition: 'dispensed',
  });
  delete doc.epcisBody.eventList[0].ilmd;
  const r = await post(DISPENSE, 'not-a-real-key', doc);
  return { ...r, verdict: r.status === 401 };
});

await check('§2.5.1 wrong-role key is refused', '403', async () => {
  const r = await post(`${BASE}/api/integration/facility/events`, MFG, commission());
  return { ...r, verdict: r.status === 403 };
});

// --- Report -------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(`Live conformance audit — ${BASE}\n`);
console.log(pad('', 4) + pad('Guide rule', 50) + pad('Expected', 22) + 'Actual');
console.log('-'.repeat(110));
for (const r of results) {
  console.log(pad(r.pass ? ' OK ' : 'FAIL', 4) + pad(r.rule, 50) + pad(r.expectation, 22) + r.actual);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} conform to the guide.`);
if (failed.length) {
  console.log('\nDeviations:');
  for (const f of failed) console.log(`  - ${f.rule}: expected ${f.expectation}, got ${f.actual}`);
}
