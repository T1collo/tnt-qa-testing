#!/usr/bin/env node
// Black-box check: outbox sequence fix (no DB/code changes).
// 25 unique manufacturer POSTs + light concurrency + duplicate-ID control.
//
//   node scripts/verify-outbox-fix.mjs
//   node scripts/verify-outbox-fix.mjs --target=trackiq
//   node scripts/verify-outbox-fix.mjs --target=both

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

const targetArg = (process.argv.find((a) => a.startsWith('--target=')) || '--target=both').split('=')[1];
const PROFILES = {
  'tnt-demo': {
    base: (env.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, ''),
    token: env.MANUFACTURER_API_TOKEN,
  },
  trackiq: {
    base: (env.TRACKIQ_BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/+$/, ''),
    token: env.TRACKIQ_MANUFACTURER_API_TOKEN || env.MANUFACTURER_API_TOKEN,
  },
};

const targets = targetArg === 'both' ? Object.keys(PROFILES) : [targetArg];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'security', 'results', `outbox-fix-verify-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

function commission(eventID, serialSuffix) {
  const now = new Date().toISOString();
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
        epcList: [`urn:epc:id:sgtin:0123456.305512.${serialSuffix}`],
        action: 'ADD',
        bizStep: 'commissioning',
        disposition: 'active',
        readPoint: { id: 'urn:epc:id:sgln:0123456.22222.0' },
        bizLocation: { id: 'urn:epc:id:sgln:0123456.22222.0' },
        ilmd: {
          'cbvmda:lotNumber': `OUTBOXFIX-${stamp.slice(0, 10)}`,
          'cbvmda:itemExpirationDate': '2028-01-01',
        },
      }],
    },
  };
}

async function post(base, token, body) {
  const url = `${base}/api/integration/manufacturer/events`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        'X-API-Key': token,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, body: text.slice(0, 500) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: String(e) };
  }
}

function classify(status, body) {
  const outboxPk = /epcis_outbox_pkey|duplicate key value/i.test(body);
  if (status >= 500) return outboxPk ? 'FAIL_OUTBOX_PK' : 'FAIL_5XX';
  if (status === 0) return 'FAIL_TRANSPORT';
  if (status >= 200 && status < 300) return 'OK_2XX';
  if (status === 409) return 'OK_409_DEDUP';
  return `OTHER_${status}`;
}

async function runTarget(name) {
  const { base, token } = PROFILES[name] || {};
  if (!base || !token) {
    return { name, skipped: true, reason: 'missing base or manufacturer token' };
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const results = [];
  console.log(`\n=== ${name} (${base}) ===`);

  // Phase 1: 25 sequential unique eventIDs (must be RFC UUID URNs)
  for (let i = 0; i < 25; i++) {
    const eventID = `urn:uuid:${crypto.randomUUID()}`;
    const serial = `${Date.now().toString().slice(-8)}${String(i).padStart(7, '0')}`.slice(-15);
    const r = await post(base, token, commission(eventID, serial));
    const outcome = classify(r.status, r.body);
    results.push({ phase: 'sequential', i, eventID, ...r, outcome });
    console.log(`  seq[${String(i).padStart(2)}] ${r.status} ${r.ms}ms ${outcome}`);
  }

  // Phase 2: 5 concurrent unique eventIDs
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, async (_, i) => {
      const eventID = `urn:uuid:${crypto.randomUUID()}`;
      const serial = `${Date.now().toString().slice(-7)}${String(100 + i).padStart(8, '0')}`.slice(-15);
      const r = await post(base, token, commission(eventID, serial));
      return { phase: 'concurrent', i, eventID, ...r, outcome: classify(r.status, r.body) };
    }),
  );
  for (const r of concurrent) {
    results.push(r);
    console.log(`  conc[${r.i}] ${r.status} ${r.ms}ms ${r.outcome}`);
  }

  // Phase 3: duplicate eventID control (second should not be 500)
  const dupId = `urn:uuid:${crypto.randomUUID()}`;
  const dupSerial = `${Date.now().toString().slice(-8)}9999999`.slice(-15);
  const first = await post(base, token, commission(dupId, dupSerial));
  const second = await post(base, token, commission(dupId, dupSerial));
  results.push({
    phase: 'duplicate-first', eventID: dupId, ...first, outcome: classify(first.status, first.body),
  });
  results.push({
    phase: 'duplicate-second', eventID: dupId, ...second, outcome: classify(second.status, second.body),
  });
  console.log(`  dup[1] ${first.status} ${first.ms}ms ${classify(first.status, first.body)}`);
  console.log(`  dup[2] ${second.status} ${second.ms}ms ${classify(second.status, second.body)}`);

  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const fiveHundred = results.filter((r) => r.status >= 500);
  const outboxHits = results.filter((r) => r.outcome === 'FAIL_OUTBOX_PK');
  const uniqueOk = results.filter((r) => r.phase === 'sequential' || r.phase === 'concurrent');
  const unique2xx = uniqueOk.filter((r) => r.status >= 200 && r.status < 300);

  const summary = {
    target: name,
    base,
    runId,
    totalRequests: results.length,
    outcomeCounts: counts,
    uniqueEventRequests: uniqueOk.length,
    uniqueEvent2xx: unique2xx.length,
    http5xx: fiveHundred.length,
    outboxPkeySignals: outboxHits.length,
    duplicateSecondStatus: second.status,
    pass:
      fiveHundred.length === 0 &&
      unique2xx.length === uniqueOk.length &&
      second.status < 500 &&
      second.status !== 0,
  };

  return { name, summary, results };
}

const all = [];
for (const t of targets) {
  if (!PROFILES[t]) {
    console.error(`Unknown target ${t}`);
    continue;
  }
  all.push(await runTarget(t));
}

const report = {
  createdAt: new Date().toISOString(),
  hypothesis: 'epcis_outbox_id_seq setval fix — Partner manufacturer events should not intermittent-500 on outbox PK',
  targets: all.map((a) => a.summary || { target: a.name, skipped: a.skipped, reason: a.reason }),
  overallPass: all.every((a) => a.skipped || a.summary?.pass),
};
fs.writeFileSync(path.join(outDir, 'findings.json'), JSON.stringify({ report, detail: all }, null, 2));

console.log('\n' + '='.repeat(72));
console.log('FINDINGS');
console.log('='.repeat(72));
for (const a of all) {
  if (a.skipped) {
    console.log(`${a.name}: SKIPPED — ${a.reason}`);
    continue;
  }
  const s = a.summary;
  console.log(`${s.target}: ${s.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  unique 2xx: ${s.uniqueEvent2xx}/${s.uniqueEventRequests}`);
  console.log(`  HTTP 5xx:   ${s.http5xx}  (outbox_pkey signals in body: ${s.outboxPkeySignals})`);
  console.log(`  dup #2:     HTTP ${s.duplicateSecondStatus}`);
  console.log(`  outcomes:   ${JSON.stringify(s.outcomeCounts)}`);
}
console.log(`\noverall: ${report.overallPass ? 'PASS' : 'FAIL'}`);
console.log(`saved:   ${path.join(outDir, 'findings.json')}`);
process.exit(report.overallPass ? 0 : 2);
