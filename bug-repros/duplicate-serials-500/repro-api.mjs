// Replays "duplicate serial numbers in one batch -> HTTP 500" straight against the API, no UI.
// Sends a batch whose serial_numbers repeat a value and prints status, body and x-request-id
// for each case. A correct server answers 4xx with a validation message (or de-duplicates);
// any 5xx is the bug.
//
// Auth is the portal session cookie, taken from (first match wins):
//   SESSION_COOKIE="name=value"          copied from DevTools > Application > Cookies
//   SESSION_FILE=<playwright storage json> e.g. playwright/.auth/portal-<host>-manufacturer.json
//
// Run:  BASE_URL=https://trackiq.apeiro-digital.com \
//       SESSION_FILE=playwright/.auth/portal-trackiq.apeiro-digital.com-manufacturer.json \
//       node bug-repros/duplicate-serials-500/repro-api.mjs
//
// PRODUCT_ID / PACKAGE_ID are environment-specific (defaults are TrackIQ's Telmicos 40 mg);
// read them off the Create Batch POST in DevTools on another environment.
// INCLUDE_CONTROL=1 also sends the same request with unique serials, which CREATES a batch.
import fs from 'node:fs';

const BASE = (process.env.BASE_URL || 'https://trackiq.apeiro-digital.com').replace(/\/$/, '');
const PRODUCT_ID = Number(process.env.PRODUCT_ID || 3449);
const PACKAGE_ID = Number(process.env.PACKAGE_ID || 5012);

function cookieHeader() {
  if (process.env.SESSION_COOKIE) return process.env.SESSION_COOKIE;
  if (process.env.SESSION_FILE) {
    const { cookies } = JSON.parse(fs.readFileSync(process.env.SESSION_FILE, 'utf8'));
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  throw new Error('Set SESSION_COOKIE or SESSION_FILE (see the header of this script)');
}

const headers = {
  'Content-Type': 'application/json',
  Cookie: cookieHeader(),
  Origin: BASE,
  Referer: `${BASE}/manufacturer/batches`,
};

const expiry = new Date(Date.now() + 730 * 86_400_000).toISOString().slice(0, 10);
const sn = `DUP${Date.now().toString(36).toUpperCase()}`;

const cases = [
  ['adjacent duplicate', [sn, sn]],
  ['non-adjacent duplicate', [`${sn}A`, `${sn}B`, `${sn}A`]],
];
if (process.env.INCLUDE_CONTROL === '1') cases.push(['CONTROL unique serials (creates a batch)', [`${sn}X`, `${sn}Y`]]);

let bug = false;
for (const [name, serials] of cases) {
  const body = { product_id: PRODUCT_ID, package_id: PACKAGE_ID, expiry, qty: serials.length, serial_numbers: serials };
  const res = await fetch(`${BASE}/api/manufacturer/batches`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`Session rejected (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const isDup = !name.startsWith('CONTROL');
  const verdict = !isDup ? (res.ok ? 'control OK' : 'control FAILED') : res.status >= 500 ? 'BUG (5xx)' : res.status >= 400 ? 'OK (validation error)' : 'accepted - check de-duplication';
  if (isDup && res.status >= 500) bug = true;
  console.log(`\n[${verdict}] ${name}`);
  console.log(`  POST ${BASE}/api/manufacturer/batches`);
  console.log(`  ${JSON.stringify(body)}`);
  console.log(`  -> HTTP ${res.status}  x-request-id: ${res.headers.get('x-request-id')}`);
  console.log(`  ${text.slice(0, 300)}`);
}
process.exitCode = bug ? 1 : 0;
