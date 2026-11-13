#!/usr/bin/env node
// TL-1794 — eventTimeZoneOffset boundary retest (tnt-demo only).
// Rule under test: accept ±00:00–±13:59, or exactly ±14:00; reject beyond.
//
//   node scripts/verify-tz-offset-tl1794.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* optional */ }

const BASE = (env.API_BASE_URL || env.BASE_URL || 'https://tnt-demo.apeiro-digital.com').replace(/\/+$/, '');
const TOKEN = env.MANUFACTURER_API_TOKEN;
const URL = `${BASE}/api/integration/manufacturer/events`;

if (!TOKEN) {
  console.error('Missing MANUFACTURER_API_TOKEN in .env');
  process.exit(1);
}
if (/trackiq/i.test(BASE)) {
  console.error('Refusing TrackIQ host — TL-1794 retest is tnt-demo only. BASE=', BASE);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(ROOT, 'security', 'results', `tl1794-tz-offset-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const CASES = [
  { id: 'MID_PLUS', offset: '+03:00', expect: 'accept' },
  { id: 'MID_MINUS', offset: '-05:00', expect: 'accept' },
  { id: 'ZERO', offset: '+00:00', expect: 'accept' },
  { id: 'UPPER_PLUS', offset: '+13:59', expect: 'accept' },
  { id: 'UPPER_MINUS', offset: '-13:59', expect: 'accept' },
  { id: 'EXACT_PLUS_14', offset: '+14:00', expect: 'accept' },
  { id: 'EXACT_MINUS_14', offset: '-14:00', expect: 'accept' },
  { id: 'JUST_OVER_PLUS', offset: '+14:01', expect: 'reject' },
  { id: 'JUST_OVER_MINUS', offset: '-14:01', expect: 'reject' },
  { id: 'OVER_PLUS_1430', offset: '+14:30', expect: 'reject' },
  { id: 'OVER_PLUS_15', offset: '+15:00', expect: 'reject' },
  { id: 'OVER_MINUS_15', offset: '-15:00', expect: 'reject' },
  { id: 'EC_C04_PLUS_25', offset: '+25:00', expect: 'reject' },
  // spot-checks (informational; do not block boundary verdict)
  { id: 'SPOT_EMPTY', offset: '', expect: 'spot' },
  { id: 'SPOT_MISSING', offset: undefined, expect: 'spot' },
  { id: 'SPOT_Z', offset: 'Z', expect: 'spot' },
  { id: 'SPOT_PLUS_14_SECONDS', offset: '+14:00:00', expect: 'spot' },
];

function doc(offset) {
  const now = new Date().toISOString();
  const serial = String(Date.now()).slice(-7) + crypto.randomBytes(2).toString('hex');
  const event = {
    type: 'ObjectEvent',
    eventID: `urn:uuid:${crypto.randomUUID()}`,
    eventTime: now,
    epcList: [`urn:epc:id:sgtin:0614141.000111.${serial}`],
    action: 'ADD',
    bizStep: 'commissioning',
    disposition: 'active',
    readPoint: { id: 'urn:epc:id:sgln:0614141.00001.0' },
    bizLocation: { id: 'urn:epc:id:sgln:0614141.00001.0' },
    ilmd: {
      'cbvmda:lotNumber': `TL1794-${stamp.slice(0, 10)}`,
      'cbvmda:itemExpirationDate': '2028-12-31',
    },
  };
  if (offset !== undefined) event.eventTimeZoneOffset = offset;
  return {
    '@context': ['https://ref.gs1.org/standards/epcis/epcis-context.jsonld'],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: now,
    epcisBody: { eventList: [event] },
  };
}

function extractCodes(j) {
  const codes = [];
  if (j?.code) codes.push(j.code);
  for (const k of ['errors', 'warnings', 'violations']) {
    for (const e of j?.[k] || []) if (e.code) codes.push(e.code);
  }
  return [...new Set(codes)];
}

async function post(body) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        'X-API-Key': TOKEN,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let j = {};
    try { j = JSON.parse(text); } catch { /* ignore */ }
    return {
      status: res.status,
      ms: Date.now() - t0,
      codes: extractCodes(j),
      message: j.message || '',
      success: j.success,
      processed: j.events_processed,
      bodyPreview: text.replace(/\s+/g, ' ').slice(0, 400),
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, codes: [], message: String(e), bodyPreview: String(e) };
  }
}

function verdict(expect, res) {
  const accepted = res.status >= 200 && res.status < 300;
  if (expect === 'accept') {
    return accepted ? 'PASS' : 'FAIL';
  }
  if (expect === 'reject') {
    return !accepted ? 'PASS' : 'FAIL';
  }
  return 'INFO';
}

const results = [];
console.log(`TL-1794 eventTimeZoneOffset retest`);
console.log(`env: ${BASE}`);
console.log(`endpoint: ${URL}`);
console.log(`out: ${outDir}`);
console.log('');

for (const c of CASES) {
  const res = await post(doc(c.offset));
  const v = verdict(c.expect, res);
  const row = {
    id: c.id,
    offset: c.offset === undefined ? '(missing)' : JSON.stringify(c.offset),
    expect: c.expect,
    verdict: v,
    status: res.status,
    codes: res.codes,
    message: res.message,
    processed: res.processed,
    ms: res.ms,
    bodyPreview: res.bodyPreview,
  };
  results.push(row);
  const offsetLabel = c.offset === undefined ? '(missing)' : c.offset;
  console.log(
    `${v.padEnd(4)} ${c.id.padEnd(22)} offset=${String(offsetLabel).padEnd(10)} ` +
    `expect=${c.expect.padEnd(6)} status=${res.status} codes=${res.codes.join(',') || '-'} msg=${(res.message || '').slice(0, 80)}`,
  );
  await new Promise((r) => setTimeout(r, 400));
}

const boundary = results.filter((r) => r.expect !== 'spot');
const pass = boundary.filter((r) => r.verdict === 'PASS').length;
const fail = boundary.filter((r) => r.verdict === 'FAIL').length;
const summary = {
  ticket: 'TL-1794',
  env: BASE,
  endpoint: URL,
  rule: 'Accept ±00:00–±13:59 or exactly ±14:00; reject beyond',
  ranAt: new Date().toISOString(),
  boundary: { total: boundary.length, pass, fail, overall: fail === 0 ? 'PASS' : 'FAIL' },
  spotChecks: results.filter((r) => r.expect === 'spot').map((r) => ({
    id: r.id, offset: r.offset, status: r.status, codes: r.codes, message: r.message,
  })),
  results,
};

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

const commentLines = [
  `h3. TL-1794 Retest — eventTimeZoneOffset boundaries`,
  ``,
  `*Env:* ${BASE}`,
  `*Endpoint:* {{POST /api/integration/manufacturer/events}}`,
  `*Rule under test:* accept ±00:00–±13:59, or exactly ±14:00; reject anything beyond`,
  `*Ran:* ${summary.ranAt}`,
  `*Boundary verdict:* *${summary.boundary.overall}* (${pass}/${boundary.length} cases)`,
  ``,
  `||Case||Offset||Expect||HTTP||Codes||Result||`,
  ...boundary.map((r) =>
    `|${r.id}|${r.offset}|${r.expect}|${r.status}|${r.codes.join(', ') || '-'}|${r.verdict}|`,
  ),
  ``,
  `*Spot checks (informational):*`,
  ...summary.spotChecks.map((r) =>
    `* ${r.id} offset=${r.offset} → HTTP ${r.status} codes=${(r.codes || []).join(',') || '-'} msg=${(r.message || '').slice(0, 120)}`,
  ),
  ``,
  fail === 0
    ? `Boundary matrix matches the new rule on tnt-demo.`
    : `Failures remain on the boundary matrix — see FAIL rows above.`,
  ``,
  `Evidence: {{security/results/tl1794-tz-offset-${stamp}/}}`,
];
fs.writeFileSync(path.join(outDir, 'jira-comment.txt'), commentLines.join('\n'));

console.log('');
console.log(`Boundary: ${summary.boundary.overall} (${pass}/${boundary.length})`);
console.log(`Wrote ${outDir}`);
process.exit(fail === 0 ? 0 : 2);
