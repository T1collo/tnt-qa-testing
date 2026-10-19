#!/usr/bin/env node
// Build a 5,000-event EPCISDocument for the Partner API 5xx / timeout repro
// (TNT-SEC-INP-008 / TNT-PERF-014). Writes a Postman-ready payload + a manifest
// of batch id and every eventID. Optionally POSTs it.
//
//   node scripts/generate-bulk-5000.mjs
//   node scripts/generate-bulk-5000.mjs --count=5000 --send --target=trackiq
//   node scripts/generate-bulk-5000.mjs --count=1000   # ladder step (often 504)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch {
  /* .env optional */
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const COUNT = Math.max(1, Number(arg('count', '5000')) || 5000);
const TARGET = arg('target', 'tnt-demo');
const ROLE = arg('role', 'manufacturer'); // manufacturer | supplier | facility
const SEND = flag('send');
const LOT = arg('lot', `BULK5K-${new Date().toISOString().slice(0, 10)}`);

const PROFILES = {
  'tnt-demo': {
    base: (env.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, ''),
    tokens: {
      manufacturer: env.MANUFACTURER_API_TOKEN,
      supplier: env.DISTRIBUTOR_API_TOKEN,
      facility: env.FACILITY_API_TOKEN,
    },
  },
  trackiq: {
    base: (env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, ''),
    tokens: {
      manufacturer: env.TRACKIQ_MANUFACTURER_API_TOKEN || env.MANUFACTURER_API_TOKEN,
      supplier: env.TRACKIQ_DISTRIBUTOR_API_TOKEN || env.DISTRIBUTOR_API_TOKEN,
      facility: env.TRACKIQ_FACILITY_API_TOKEN || env.FACILITY_API_TOKEN,
    },
  },
};

const profile = PROFILES[TARGET];
if (!profile) {
  console.error(`Unknown --target=${TARGET}. Known: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

const ENDPOINT = { manufacturer: 'manufacturer', supplier: 'supplier', facility: 'facility' };
if (!ENDPOINT[ROLE]) {
  console.error(`Unknown --role=${ROLE}. Known: ${Object.keys(ENDPOINT).join(', ')}`);
  process.exit(1);
}

const runId = crypto.randomUUID().slice(0, 8);
const batchId = `batch-5k-${runId}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'security', 'results', `bulk-5000-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const now = new Date().toISOString();
const eventIds = [];
const eventList = [];

for (let i = 0; i < COUNT; i++) {
  const eventID = `urn:uuid:bulk-${runId}-${String(i).padStart(5, '0')}`;
  const serial = `${Date.now().toString().slice(-8)}${String(i).padStart(7, '0')}`.slice(-15);
  eventIds.push(eventID);
  eventList.push({
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
      'cbvmda:lotNumber': LOT,
      'cbvmda:itemExpirationDate': '2028-01-01',
    },
  });
}

const document = {
  '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: now,
  epcisBody: { eventList },
};

const manifest = {
  batchId,
  runId,
  lotNumber: LOT,
  eventCount: COUNT,
  role: ROLE,
  target: TARGET,
  baseUrl: profile.base,
  endpoint: `${profile.base}/api/integration/${ENDPOINT[ROLE]}/events`,
  contentType: 'application/ld+json',
  header: { 'X-API-Key': '<set from .env>' },
  expectedObserved: 'Historically 500 (Internal server error) or 504 (gateway timeout); pass criterion is non-5xx.',
  eventIds,
  sampleEventIds: {
    first: eventIds[0],
    mid: eventIds[Math.floor(COUNT / 2)],
    last: eventIds[COUNT - 1],
  },
  files: {
    payload: 'payload.json',
    eventIds: 'event-ids.txt',
    postmanBody: 'postman-body.json',
  },
  createdAt: now,
};

const payloadPath = path.join(outDir, 'payload.json');
const manifestPath = path.join(outDir, 'manifest.json');
const idsPath = path.join(outDir, 'event-ids.txt');

fs.writeFileSync(payloadPath, JSON.stringify(document));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
fs.writeFileSync(idsPath, eventIds.join('\n') + '\n');
// Same bytes as payload — handy to paste into Postman Body → raw
fs.copyFileSync(payloadPath, path.join(outDir, 'postman-body.json'));

console.log(`Batch ID:     ${batchId}`);
console.log(`Events:       ${COUNT}`);
console.log(`First ID:     ${eventIds[0]}`);
console.log(`Last ID:      ${eventIds[COUNT - 1]}`);
console.log(`Out dir:      ${outDir}`);
console.log(`Manifest:     ${manifestPath}`);
console.log(`Payload size: ${(fs.statSync(payloadPath).size / 1024 / 1024).toFixed(2)} MB`);

if (!SEND) {
  console.log(`\nDry run only. To POST:\n  node scripts/generate-bulk-5000.mjs --count=${COUNT} --send --target=${TARGET} --role=${ROLE}`);
  console.log(`\nPostman:\n  1. Import postman/TnT-Bulk-5000-Events.postman_collection.json`);
  console.log(`  2. Or paste ${path.join(outDir, 'postman-body.json')} into a POST body`);
  process.exit(0);
}

const token = profile.tokens[ROLE];
if (!token) {
  console.error(`\nNo API token for role "${ROLE}" on target "${TARGET}". Set it in .env and retry.`);
  process.exit(1);
}

const url = `${profile.base}/api/integration/${ENDPOINT[ROLE]}/events`;
console.log(`\nPOST ${url} …`);
const t0 = Date.now();
let status = 0;
let body = '';
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ld+json',
      'X-API-Key': token,
    },
    body: JSON.stringify(document),
  });
  status = res.status;
  body = await res.text();
} catch (e) {
  body = String(e);
}

const ms = Date.now() - t0;
const result = {
  batchId,
  status,
  ms,
  bodyPreview: body.slice(0, 2000),
  returnedEventIds: (() => {
    try {
      return JSON.parse(body).event_ids || [];
    } catch {
      return [];
    }
  })(),
};
fs.writeFileSync(path.join(outDir, 'response.json'), JSON.stringify(result, null, 2));
console.log(`HTTP ${status} in ${ms}ms`);
console.log(`Response saved: ${path.join(outDir, 'response.json')}`);
if (result.returnedEventIds.length) {
  console.log(`Returned event_ids: ${result.returnedEventIds.length} (first ${result.returnedEventIds[0]})`);
}
process.exit(status >= 500 || status === 0 ? 2 : 0);
