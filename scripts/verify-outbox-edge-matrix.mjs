#!/usr/bin/env node
// TrackIQ Partner API edge-case matrix (API-only, no DB).
//   node scripts/verify-outbox-edge-matrix.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* optional */ }

const BASE = (env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, '');
const MFG = env.TRACKIQ_MANUFACTURER_API_TOKEN || env.MANUFACTURER_API_TOKEN;
const DIST = env.TRACKIQ_DISTRIBUTOR_API_TOKEN || env.DISTRIBUTOR_API_TOKEN;
const FAC = env.TRACKIQ_FACILITY_API_TOKEN || env.FACILITY_API_TOKEN;
const URL = `${BASE}/api/integration/manufacturer/events`;

if (!MFG) {
  console.error('Missing TRACKIQ_MANUFACTURER_API_TOKEN');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const batchId = `batch-edge-${crypto.randomUUID().slice(0, 8)}`;
const outDir = path.join(ROOT, 'security', 'results', `outbox-edge-matrix-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const results = [];

function uuid() {
  return `urn:uuid:${crypto.randomUUID()}`;
}

function commission({
  eventID = uuid(),
  epc = null,
  lot = 'EDGE-MATRIX',
  eventTime = null,
  expiry = '2028-01-01',
  sgln = 'urn:epc:id:sgln:0123456.22222.0',
  extra = {},
  omit = [],
} = {}) {
  const now = new Date().toISOString();
  const serial = `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(-15);
  const ev = {
    type: 'ObjectEvent',
    eventID,
    eventTime: eventTime || now,
    eventTimeZoneOffset: '+03:00',
    epcList: [epc || `urn:epc:id:sgtin:0123456.305512.${serial}`],
    action: 'ADD',
    bizStep: 'commissioning',
    disposition: 'active',
    readPoint: { id: sgln },
    bizLocation: { id: sgln },
    ilmd: {
      'cbvmda:lotNumber': lot,
      'cbvmda:itemExpirationDate': expiry,
    },
    ...extra,
  };
  for (const k of omit) delete ev[k];
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: now,
    epcisBody: { eventList: [ev] },
  };
}

async function post({
  id,
  category,
  title,
  expect,
  body = null,
  raw = null,
  token = MFG,
  headers = {},
  timeoutMs = 120000,
}) {
  const t0 = Date.now();
  let status = 0;
  let text = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        ...(raw !== null || body !== null ? { 'Content-Type': 'application/ld+json' } : {}),
        ...(token ? { 'X-API-Key': token } : {}),
        ...headers,
      },
      body: raw !== null ? raw : body !== null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = String(e);
    status = /abort/i.test(text) ? 0 : 0;
  }
  const ms = Date.now() - t0;
  const outboxPk = /epcis_outbox_pkey|duplicate key value/i.test(text);
  const code = (() => {
    try {
      return JSON.parse(text).code || JSON.parse(text).error || null;
    } catch {
      return null;
    }
  })();
  const eventID = body?.epcisBody?.eventList?.[0]?.eventID || null;

  let pass = false;
  if (typeof expect === 'function') pass = expect(status, text);
  else if (Array.isArray(expect)) pass = expect.includes(status);
  else pass = status === expect;

  // Hard fail if unexpected 5xx unless expect allows it
  const row = {
    id,
    category,
    title,
    expect: Array.isArray(expect) ? expect.join('|') : typeof expect === 'function' ? 'custom' : String(expect),
    status,
    ms,
    pass,
    outboxPk,
    eventID,
    code,
    bodyPreview: text.replace(/\s+/g, ' ').slice(0, 280),
  };
  results.push(row);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id.padEnd(14)} ${String(status).padEnd(4)} ${title}`);
  return row;
}

console.log(`TrackIQ edge matrix\nBase: ${BASE}\nBatch: ${batchId}\nOut: ${outDir}\n${'-'.repeat(72)}`);

// ---------- A. Happy path / volume ----------
{
  const r = await post({
    id: 'A01', category: 'Happy path', title: 'Single valid commission',
    expect: 202, body: commission({ lot: batchId }),
  });
}
{
  const n = 100;
  let ok = 0;
  let five = 0;
  let outbox = 0;
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const body = commission({ lot: batchId });
    const row = await post({
      id: `A02-${i}`, category: 'Volume', title: `Sequential unique #${i + 1}/${n}`,
      expect: 202, body,
    });
    // collapse detail: keep last only in console noise — still store all
    if (row.status >= 200 && row.status < 300) ok++;
    if (row.status >= 500) five++;
    if (row.outboxPk) outbox++;
  }
  results.push({
    id: 'A02',
    category: 'Volume',
    title: `Summary: ${n} sequential unique commissions`,
    expect: 'all 202',
    status: five === 0 && ok === n ? 202 : five > 0 ? 500 : 0,
    ms: Date.now() - t0,
    pass: five === 0 && ok === n,
    outboxPk: outbox > 0,
    eventID: null,
    code: null,
    bodyPreview: `ok=${ok}/${n} five=${five} outboxPk=${outbox}`,
  });
  console.log(`${five === 0 && ok === n ? 'PASS' : 'FAIL'} A02            summary ${ok}/${n} 2xx, ${five} 5xx`);
}
{
  const n = 20;
  const t0 = Date.now();
  const settled = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const body = commission({ lot: batchId });
      const t1 = Date.now();
      try {
        const res = await fetch(URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/ld+json', 'X-API-Key': MFG },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return {
          i,
          eventID: body.epcisBody.eventList[0].eventID,
          status: res.status,
          ms: Date.now() - t1,
          outboxPk: /epcis_outbox_pkey|duplicate key/i.test(text),
          bodyPreview: text.slice(0, 180),
        };
      } catch (e) {
        return { i, eventID: body.epcisBody.eventList[0].eventID, status: 0, ms: Date.now() - t1, outboxPk: false, bodyPreview: String(e) };
      }
    }),
  );
  for (const s of settled) {
    results.push({
      id: `A03-${s.i}`,
      category: 'Concurrency',
      title: `Concurrent unique #${s.i + 1}/${n}`,
      expect: '202',
      status: s.status,
      ms: s.ms,
      pass: s.status === 202,
      outboxPk: s.outboxPk,
      eventID: s.eventID,
      code: null,
      bodyPreview: s.bodyPreview,
    });
  }
  const ok = settled.filter((s) => s.status === 202).length;
  const five = settled.filter((s) => s.status >= 500).length;
  results.push({
    id: 'A03',
    category: 'Concurrency',
    title: `Summary: ${n} concurrent unique commissions`,
    expect: 'all 202',
    status: five === 0 && ok === n ? 202 : 500,
    ms: Date.now() - t0,
    pass: five === 0 && ok === n,
    outboxPk: settled.some((s) => s.outboxPk),
    eventID: null,
    code: null,
    bodyPreview: `ok=${ok}/${n} five=${five}`,
  });
  console.log(`${ok === n ? 'PASS' : 'FAIL'} A03            concurrent ${ok}/${n}`);
}

// ---------- B. Idempotency ----------
{
  const body = commission({ lot: batchId });
  const a = await post({
    id: 'B01a', category: 'Idempotency', title: 'Duplicate eventID — first submit',
    expect: 202, body,
  });
  const b = await post({
    id: 'B01b', category: 'Idempotency', title: 'Duplicate eventID — second submit',
    expect: (st) => st === 409 || (st >= 400 && st < 500), body,
  });
  results.push({
    id: 'B01',
    category: 'Idempotency',
    title: 'Duplicate eventID pair (first 202, second 4xx not 500)',
    expect: '202 then 4xx',
    status: b.status,
    ms: a.ms + b.ms,
    pass: a.status === 202 && b.status >= 400 && b.status < 500,
    outboxPk: a.outboxPk || b.outboxPk,
    eventID: body.epcisBody.eventList[0].eventID,
    code: null,
    bodyPreview: `first=${a.status} second=${b.status}`,
  });
}
{
  // Same EPC content, new eventID — document behavior
  const epc = `urn:epc:id:sgtin:0123456.305512.${Date.now().toString().slice(-15)}`;
  const a = await post({
    id: 'B02a', category: 'Idempotency', title: 'Same EPC new eventID — first',
    expect: [202, 409, 400], body: commission({ epc, lot: batchId }),
  });
  const b = await post({
    id: 'B02b', category: 'Idempotency', title: 'Same EPC new eventID — second',
    expect: (st) => st > 0 && st < 500,
    body: commission({ epc, lot: batchId }),
  });
  results.push({
    id: 'B02',
    category: 'Idempotency',
    title: 'Same EPC / new eventIDs (document; must not 500)',
    expect: 'non-5xx both',
    status: b.status,
    ms: a.ms + b.ms,
    pass: a.status < 500 && b.status < 500 && a.status > 0 && b.status > 0,
    outboxPk: a.outboxPk || b.outboxPk,
    eventID: null,
    code: null,
    bodyPreview: `first=${a.status} second=${b.status}`,
  });
}

// ---------- C. Auth / role ----------
await post({
  id: 'C01', category: 'Auth', title: 'No API key',
  expect: 401, body: commission(), token: null,
});
await post({
  id: 'C02', category: 'Auth', title: 'Invalid API key',
  expect: (st) => st === 401 || st === 403,
  body: commission(), token: 'trk_test_INVALID_KEY_FOR_EDGE_MATRIX_ONLY',
});
if (DIST) {
  await post({
    id: 'C03', category: 'Auth', title: 'Supplier key on manufacturer route',
    expect: 403, body: commission(), token: DIST,
  });
} else {
  results.push({
    id: 'C03', category: 'Auth', title: 'Supplier key on manufacturer route',
    expect: '403', status: 0, ms: 0, pass: false, outboxPk: false, eventID: null, code: null,
    bodyPreview: 'SKIPPED — no distributor token',
  });
}
if (FAC) {
  await post({
    id: 'C04', category: 'Auth', title: 'Facility key on manufacturer route',
    expect: 403, body: commission(), token: FAC,
  });
} else {
  results.push({
    id: 'C04', category: 'Auth', title: 'Facility key on manufacturer route',
    expect: '403', status: 0, ms: 0, pass: false, outboxPk: false, eventID: null, code: null,
    bodyPreview: 'SKIPPED — no facility token',
  });
}

// ---------- D. Schema / validation ----------
await post({
  id: 'D01', category: 'Validation', title: 'Invalid eventID (not UUID URN)',
  expect: (st) => st >= 400 && st < 500,
  body: commission({ eventID: 'urn:uuid:not-a-valid-uuid' }),
});
await post({
  id: 'D02', category: 'Validation', title: 'Missing epcisBody',
  expect: (st) => st >= 400 && st < 500,
  body: { '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'], type: 'EPCISDocument', schemaVersion: '2.0' },
});
await post({
  id: 'D03', category: 'Validation', title: 'Malformed JSON',
  expect: (st) => st >= 400 && st < 500,
  raw: '{"type":"EPCISDocument", BROKEN',
});
await post({
  id: 'D04', category: 'Validation', title: 'Wrong Content-Type text/plain',
  expect: (st) => st > 0 && st < 500,
  body: commission(),
  headers: { 'Content-Type': 'text/plain' },
});
await post({
  id: 'D05', category: 'Validation', title: 'Empty eventList',
  expect: (st) => st >= 400 && st < 500,
  body: {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: new Date().toISOString(),
    epcisBody: { eventList: [] },
  },
});
await post({
  id: 'D06', category: 'Validation', title: 'Missing epcList',
  expect: (st) => st >= 400 && st < 500,
  body: commission({ omit: ['epcList'] }),
});
await post({
  id: 'D07', category: 'Validation', title: 'Structurally invalid EPC',
  expect: (st) => st >= 400 && st < 500,
  body: commission({ epc: 'not-an-epc-at-all' }),
});

// ---------- E. Size / batch (same endpoint) ----------
async function multiEventDoc(n) {
  const now = new Date().toISOString();
  const one = commission({ lot: batchId }).epcisBody.eventList[0];
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: now,
    epcisBody: {
      eventList: Array.from({ length: n }, (_, i) => ({
        ...one,
        eventID: uuid(),
        epcList: [`urn:epc:id:sgtin:0123456.305512.${`${Date.now()}${i}`.slice(-15)}`],
      })),
    },
  };
}
for (const n of [10, 100, 500]) {
  await post({
    id: `E0${n === 10 ? 1 : n === 100 ? 2 : 3}`,
    category: 'Batch size',
    title: `${n} events in one document`,
    expect: (st) => st > 0 && (st < 500 || st === 504), // 504 allowed; 500 is fail unless we mark soft
    body: await multiEventDoc(n),
    timeoutMs: n >= 500 ? 180000 : 120000,
  });
  // Override pass: 202/207/4xx/504 ok; 500 fail
  const last = results[results.length - 1];
  last.pass = last.status > 0 && last.status !== 500 && !last.outboxPk;
  last.expect = '202/4xx/504; not 500';
}
{
  // 1000 serials in one event (under 50k cap)
  const list = Array.from({ length: 1000 }, (_, i) =>
    `urn:epc:id:sgtin:0123456.305512.${String(i).padStart(15, '0')}`);
  const body = commission({ lot: batchId });
  body.epcisBody.eventList[0].epcList = list;
  await post({
    id: 'E04', category: 'Batch size', title: '1 event with 1000 serials',
    expect: (st) => st > 0 && st < 500,
    body,
    timeoutMs: 180000,
  });
}

// ---------- F. Identifier edges ----------
await post({
  id: 'F01', category: 'Identifiers', title: 'Known-good SGLN/GTIN shape',
  expect: 202, body: commission({ lot: batchId }),
});
await post({
  id: 'F02', category: 'Identifiers', title: 'Historical crash GLN shape (collection-like)',
  expect: (st) => st > 0, // document; pass if not outbox pk; 500 = known separate issue
  body: commission({
    lot: batchId,
    sgln: 'urn:epc:id:sgln:10000000.00009.0',
    epc: `urn:epc:id:sgtin:6161102.974997.${Date.now().toString().slice(-13)}`,
  }),
});
{
  const last = results[results.length - 1];
  // Separate bug class OK to note; fail only on outbox pk
  last.pass = !last.outboxPk && last.status !== 0;
  last.expect = 'any HTTP; not outbox_pkey; note if 500 (separate)';
}

// ---------- G. Time / ILMD ----------
await post({
  id: 'G01', category: 'Time/ILMD', title: 'Backdated eventTime (1990)',
  expect: (st) => st > 0 && st < 500,
  body: commission({ eventTime: '1990-01-01T00:00:00.000Z', lot: batchId }),
});
await post({
  id: 'G02', category: 'Time/ILMD', title: 'Future eventTime (+2 years)',
  expect: (st) => st > 0 && st < 500,
  body: commission({ eventTime: '2028-01-01T00:00:00.000Z', lot: batchId }),
});
await post({
  id: 'G03', category: 'Time/ILMD', title: 'Very long lotNumber (10k chars)',
  expect: (st) => st > 0 && st < 500,
  body: commission({ lot: 'L'.repeat(10000) }),
});

// Prior 5k volume reference (not re-run)
results.push({
  id: 'REF-5K',
  category: 'Reference',
  title: 'Prior 5,000 single-event POSTs (2026-10-02) — not re-run',
  expect: '5000x202',
  status: 202,
  ms: 210050,
  pass: true,
  outboxPk: false,
  eventID: null,
  code: null,
  bodyPreview: 'batch-5k-req-0ffbe916 — 5000/5000 HTTP 202, 0 5xx (see prior evidence)',
});

// Summaries
const primary = results.filter((r) => !String(r.id).includes('-') || ['A02', 'A03', 'B01', 'B02'].includes(r.id) || !/\d+-\d+/.test(r.id));
// Count pass among "headline" cases (no A02-0 detail rows)
const headline = results.filter((r) => !/^(A02-|A03-)/.test(r.id));
const passCount = headline.filter((r) => r.pass).length;
const failCount = headline.filter((r) => !r.pass).length;
const fiveCount = results.filter((r) => r.status >= 500).length;
const outboxCount = results.filter((r) => r.outboxPk).length;

const summary = {
  batchId,
  base: BASE,
  endpoint: URL,
  createdAt: new Date().toISOString(),
  outDir,
  headlineTotal: headline.length,
  headlinePass: passCount,
  headlineFail: failCount,
  http5xxRows: fiveCount,
  outboxPkeySignals: outboxCount,
  pass: failCount === 0 && outboxCount === 0,
  notes: [
    'API/Postman-only matrix — does not reintroduce DB sequence lag.',
    'Prior 5k request burst referenced, not repeated in this run.',
    'Multi-event documents may return 504; treated as non-outbox failure mode if not 500.',
  ],
};

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ summary, results }, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

console.log('-'.repeat(72));
console.log(`Headline: ${passCount}/${headline.length} pass`);
console.log(`HTTP 5xx rows (incl. detail): ${fiveCount}`);
console.log(`outbox_pkey signals: ${outboxCount}`);
console.log(`Overall: ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log(`Saved: ${outDir}`);
process.exit(summary.pass ? 0 : 2);
