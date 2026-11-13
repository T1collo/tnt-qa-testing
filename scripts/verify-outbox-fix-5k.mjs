#!/usr/bin/env node
// TrackIQ black-box: 5,000 individual manufacturer event POSTs (one event per request).
// Not a single 5,000-event document (that path often 504s).
//
//   node scripts/verify-outbox-fix-5k.mjs
//   node scripts/verify-outbox-fix-5k.mjs --count=5000 --concurrency=5

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

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const COUNT = Math.max(1, Number(arg('count', '5000')) || 5000);
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '5')) || 5);
const BASE = (env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, '');
const TOKEN = env.TRACKIQ_MANUFACTURER_API_TOKEN || env.MANUFACTURER_API_TOKEN;

if (!TOKEN) {
  console.error('Missing TRACKIQ_MANUFACTURER_API_TOKEN (or MANUFACTURER_API_TOKEN).');
  process.exit(1);
}

const runId = crypto.randomUUID().slice(0, 8);
const batchId = `batch-5k-req-${runId}`;
const lotNumber = `OUTBOX5K-${new Date().toISOString().slice(0, 10)}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'security', 'results', `outbox-fix-5k-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const url = `${BASE}/api/integration/manufacturer/events`;
console.log(`TrackIQ 5,000-request outbox verify`);
console.log(`Base:         ${BASE}`);
console.log(`Batch ID:     ${batchId}`);
console.log(`Count:        ${COUNT}`);
console.log(`Concurrency:  ${CONCURRENCY}`);
console.log(`Out:          ${outDir}`);
console.log('-'.repeat(72));

function commission(eventID, i) {
  const now = new Date().toISOString();
  const serial = `${Date.now().toString().slice(-8)}${String(i).padStart(7, '0')}`.slice(-15);
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: now,
    epcisBody: {
      eventList: [{
        type: 'ObjectEvent',
        eventID,
        eventTime: now,
        eventTimeZoneOffset: '+03:00',
        epcList: [`urn:epc:id:sgtin:0123456.305512.${serial}`],
        action: 'ADD',
        bizStep: 'commissioning',
        disposition: 'active',
        readPoint: { id: 'urn:epc:id:sgln:0123456.22222.0' },
        bizLocation: { id: 'urn:epc:id:sgln:0123456.22222.0' },
        ilmd: {
          'cbvmda:lotNumber': lotNumber,
          'cbvmda:itemExpirationDate': '2028-01-01',
        },
      }],
    },
  };
}

async function postOne(i) {
  const eventID = `urn:uuid:${crypto.randomUUID()}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        'X-API-Key': TOKEN,
      },
      body: JSON.stringify(commission(eventID, i)),
    });
    const text = await res.text();
    const outboxPk = /epcis_outbox_pkey|duplicate key value/i.test(text);
    return {
      i,
      eventID,
      status: res.status,
      ms: Date.now() - t0,
      outboxPk,
      bodyPreview: text.slice(0, 180),
    };
  } catch (e) {
    return {
      i,
      eventID,
      status: 0,
      ms: Date.now() - t0,
      outboxPk: false,
      bodyPreview: String(e),
    };
  }
}

async function mapPool(n, concurrency, worker) {
  const results = new Array(n);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(i);
      if ((i + 1) % 100 === 0 || i + 1 === n) {
        const done = results.filter(Boolean).length;
        const five = results.filter((r) => r && r.status >= 500).length;
        const ok = results.filter((r) => r && r.status >= 200 && r.status < 300).length;
        process.stdout.write(`\r  progress ${done}/${n}  2xx=${ok}  5xx=${five}   `);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  process.stdout.write('\n');
  return results;
}

const tStart = Date.now();
const results = await mapPool(COUNT, CONCURRENCY, postOne);
const elapsedMs = Date.now() - tStart;

const statusCounts = {};
let outboxPk = 0;
let ok2xx = 0;
let http5xx = 0;
const eventIds = [];
for (const r of results) {
  statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  eventIds.push(r.eventID);
  if (r.outboxPk) outboxPk++;
  if (r.status >= 200 && r.status < 300) ok2xx++;
  if (r.status >= 500) http5xx++;
}

const msSorted = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => msSorted[Math.min(msSorted.length - 1, Math.floor(msSorted.length * p))];

const summary = {
  target: 'trackiq',
  base: BASE,
  batchId,
  lotNumber,
  runId,
  count: COUNT,
  concurrency: CONCURRENCY,
  elapsedMs,
  elapsedSec: Math.round(elapsedMs / 1000),
  ok2xx,
  http5xx,
  outboxPkeySignals: outboxPk,
  statusCounts,
  latencyMs: {
    min: msSorted[0],
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: msSorted[msSorted.length - 1],
  },
  pass: http5xx === 0 && ok2xx === COUNT,
  sampleEventIds: {
    first: eventIds[0],
    mid: eventIds[Math.floor(COUNT / 2)],
    last: eventIds[COUNT - 1],
  },
  createdAt: new Date().toISOString(),
  files: {
    eventIds: 'event-ids.txt',
    results: 'results.jsonl',
    summary: 'summary.json',
  },
};

fs.writeFileSync(path.join(outDir, 'event-ids.txt'), eventIds.join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const jsonl = results.map((r) => JSON.stringify({
  i: r.i, eventID: r.eventID, status: r.status, ms: r.ms, outboxPk: r.outboxPk,
})).join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'results.jsonl'), jsonl);
// Compact manifest for the report generator
fs.writeFileSync(path.join(outDir, 'report-manifest.json'), JSON.stringify({
  ...summary,
  eventIds,
}, null, 2));

console.log('-'.repeat(72));
console.log(`Batch ID:     ${batchId}`);
console.log(`2xx:          ${ok2xx}/${COUNT}`);
console.log(`5xx:          ${http5xx}`);
console.log(`outbox_pkey:  ${outboxPk}`);
console.log(`statuses:     ${JSON.stringify(statusCounts)}`);
console.log(`latency ms:   min=${summary.latencyMs.min} p50=${summary.latencyMs.p50} p95=${summary.latencyMs.p95} max=${summary.latencyMs.max}`);
console.log(`elapsed:      ${summary.elapsedSec}s`);
console.log(`pass:         ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log(`saved:        ${outDir}`);
process.exit(summary.pass ? 0 : 2);
